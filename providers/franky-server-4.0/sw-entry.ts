/**
 * FRANKY LAB — Punto de entrada del Service Worker para ESTE Provider.
 * Conecta World -> MCU -> Firmware -> Virtual Server -> Core.swRuntime, y
 * el Motor de Simulación (física + raycast de sensores, ahora también
 * contra paredes) + edición/carga de escenarios.
 *
 * El mapeo de pines de motor (GPIO5/4/3/2) es conocimiento de la Board
 * (boards/franky-board-4x/manifest.json) — vive acá porque es el único
 * punto de "cableado" real del sistema; ver deuda reconocida en
 * firmware/runtime.ts sobre leerlo del manifest en vez de hardcodearlo.
 */
import {
  createDefaultWorld, getRobot, addObstacle, moveObstacle, removeObstacle,
  addWall, removeWall, resetScenario, loadScenario, ScenarioId, advanceClock, setAnalogPin, setRobotPose,
  setOpponentPose, impulseBall, startMatch,
} from "../../core/src/worldModel.js";
import { WorldModelHAL } from "../../core/src/worldModelHAL.js";
import { startServiceWorker } from "../../core/src/swRuntime.js";
import { DifferentialDrive, raycastDistance, distanceToSharpADC, isOverLine, stepOpponent, stepBall, dohyoBorderADC, isOutsideDohyo } from "../../core/src/simulationEngine.js";
import { tickMinisumoRules } from "../../core/src/rules/minisumoRules.js";
import { tickFutbolRules } from "../../core/src/rules/futbolRules.js";
import { tickTimedTrialRules } from "../../core/src/rules/timedTrialRules.js";
import { createProviderServer } from "./server/virtualServer.js";
import { RobotMode } from "./firmware/model.js";
import { API_ROUTES, LAB_ROUTES } from "./routes.js";

declare const self: ServiceWorkerGlobalScope;

const ROBOT_ID = "FRANKY_0000";

// Configuración temporal de Seguidor de Línea (3 sensores, uso educativo —
// ver evolución futura a MCP3208/SPI + QTR-8A). Izquierdo y derecho
// reutilizan los 2 únicos ADC reales de FRANKY (GPIO0/GPIO1); central es
// puramente digital (GPIO6, mismo pin que "óptico" en Sumo). Convención:
// ADC bajo / digital LOW = SOBRE la línea negra (baja reflectancia).
const LINE_PIN_IZQ = 0;
const LINE_PIN_DER = 1;
const LINE_PIN_CENTRO = 6;
const LINE_SENSOR_OFFSET_CM = 4; // separación lateral izq/der desde el centro del robot
const LINE_SENSOR_AHEAD_CM = 8; // qué tan adelante del centro están montados

const world = createDefaultWorld("area-libre");
const hal = new WorldModelHAL(world, ROBOT_ID);
const server = createProviderServer(hal);
const drive = new DifferentialDrive();
let lastMode: RobotMode | undefined;
let lastButtonState = 1; // HIGH (pull-up, libre) por defecto

/** GPIO5=motorIzqFwd, GPIO4=motorIzqRev, GPIO3=motorDerFwd, GPIO2=motorDerRev. */
function motorSpeedsFromPins(): { left: number; right: number } {
  const pwm = getRobot(world, ROBOT_ID).pins.pwm;
  const left = (pwm[5] || 0) - (pwm[4] || 0);
  const right = (pwm[3] || 0) - (pwm[2] || 0);
  return { left: left / 255, right: right / 255 };
}

startServiceWorker(server, [...API_ROUTES, ...LAB_ROUTES], (dtMs) => {
  // CAUSA RAÍZ del bug "Minisumo no inicia" (encontrada instrumentando el
  // flujo paso a paso, no por hipótesis): world.clock.simTime — la fuente
  // real de hal.millis() vía WorldModelHAL — nunca avanzaba en el flujo
  // real del Service Worker. Los tests unitarios usaban StubHAL con
  // hal.advance() manual, así que nunca lo detectaron: retardoOK jamás se
  // cumplía porque el reloj real quedaba congelado en 0 para siempre.
  advanceClock(world, dtMs);

  // Arranque manual (Fútbol/Laberinto/Línea): nadie se mueve hasta que el
  // usuario presione "Iniciar" — ni el robot principal ni el oponente.
  // Minisumo NO usa esta compuerta: su propio retardo reglamentario de 5s
  // ya cumple ese rol (arranca solo al cambiar de modo, no con un botón).
  const needsManualStart = world.scenarioId === "futbol" || world.scenarioId === "laberinto" || world.scenarioId === "linea";
  const framePhysicsAllowed = !needsManualStart || world.match.started;

  if (framePhysicsAllowed) {
    const { left, right } = motorSpeedsFromPins();
    drive.step(world, ROBOT_ID, left, right, dtMs);

    // En Fútbol la IA del oponente (buscar la pelota) la maneja
    // tickFutbolRules — no el stepOpponent genérico de combate Sumo.
    if (world.scenarioId !== "futbol") {
      for (const opponentId of Object.keys(world.opponents)) {
        stepOpponent(world, opponentId, dtMs);
      }
    }
    for (const ball of world.balls) {
      stepBall(world, ball, dtMs, drive.currentSpeedCmS());
    }
  }

  // Sensor de oponente: raycast REAL, dual izquierdo/derecho, escrito en
  // los pines que el usuario haya configurado desde el Servidor Web — no
  // asume Sharp fijo. Ángulo de montaje ±12° respecto del frente (dos
  // sensores separados en el chasis, comportamiento creíble).
  const robot = getRobot(world, ROBOT_ID);
  const sensorConfig = server.getActiveSensorConfig ? (server.getActiveSensorConfig() as {
    tipo: number; numDist: number; sharpPinI: number; sharpPinD: number; echoI: number; echoD: number;
    numBorde: number; bordePinI: number; bordePinD: number;
  }) : null;
  if (sensorConfig) {
    const MOUNT_ANGLE_RAD = 0.21; // ~12°
    const distIzq = raycastDistance(world, robot.position, robot.headingRad - MOUNT_ANGLE_RAD, 200);
    const distDer = raycastDistance(world, robot.position, robot.headingRad + MOUNT_ANGLE_RAD, 200);
    if (sensorConfig.tipo === 2 /* SHARP */) {
      robot.pins.analog[sensorConfig.sharpPinI] = distanceToSharpADC(distIzq, 80);
      if (sensorConfig.numDist >= 2) robot.pins.analog[sensorConfig.sharpPinD] = distanceToSharpADC(distDer, 80);
    } else if (sensorConfig.tipo === 0 /* SONAR */) {
      // Convención: el canal "analógico" del pin de echo transporta la
      // distancia real en cm (no un valor ADC) — reutiliza RobotHAL
      // genérico en vez de inventar un método específico de sonar.
      robot.pins.analog[sensorConfig.echoI] = Math.round(distIzq);
      if (sensorConfig.numDist >= 2) robot.pins.analog[sensorConfig.echoD] = Math.round(distDer);
    }
    // tipo OPTICO (JS40): sensor de contacto/proximidad muy cercana, sin
    // geometría de raycast todavía — se mantiene como entrada manual
    // (setDigitalInput), igual que antes.

    // Sensores de BORDE: geometría real del dohyo, nunca frenan al robot
    // (ver DifferentialDrive.step) — solo escriben lo que el firmware va
    // a leer para decidir. Montados cerca del frente del chasis, ligeramente
    // separados izq/der, igual que los de oponente.
    if (sensorConfig.numBorde >= 1) {
      const fwd = { x: Math.cos(robot.headingRad), y: Math.sin(robot.headingRad) };
      const lat = { x: -Math.sin(robot.headingRad), y: Math.cos(robot.headingRad) };
      const mountIzq = { x: robot.position.x + fwd.x * 6 - lat.x * 4, y: robot.position.y + fwd.y * 6 - lat.y * 4 };
      robot.pins.analog[sensorConfig.bordePinI] = dohyoBorderADC(world, mountIzq);
      if (sensorConfig.numBorde >= 2) {
        const mountDer = { x: robot.position.x + fwd.x * 6 + lat.x * 4, y: robot.position.y + fwd.y * 6 + lat.y * 4 };
        robot.pins.analog[sensorConfig.bordePinD] = dohyoBorderADC(world, mountDer);
      }
    }
  }

  // Seguidor de Línea: 3 sensores reales muestreando la pista bajo el
  // chasis (solo tiene sentido físico en el escenario "linea").
  if (world.scenarioId === "linea") {
    const fwd = { x: Math.cos(robot.headingRad), y: Math.sin(robot.headingRad) };
    const lat = { x: -Math.sin(robot.headingRad), y: Math.cos(robot.headingRad) };
    const base = {
      x: robot.position.x + fwd.x * LINE_SENSOR_AHEAD_CM,
      y: robot.position.y + fwd.y * LINE_SENSOR_AHEAD_CM,
    };
    const left = { x: base.x - lat.x * LINE_SENSOR_OFFSET_CM, y: base.y - lat.y * LINE_SENSOR_OFFSET_CM };
    const right = { x: base.x + lat.x * LINE_SENSOR_OFFSET_CM, y: base.y + lat.y * LINE_SENSOR_OFFSET_CM };
    robot.pins.analog[LINE_PIN_IZQ] = isOverLine(world, left) ? 300 : 3500;
    robot.pins.analog[LINE_PIN_DER] = isOverLine(world, right) ? 300 : 3500;
    robot.pins.digital[LINE_PIN_CENTRO] = isOverLine(world, base) ? 0 : 1;
  }

  // PUENTE MODO -> ESCENARIO (bug crítico corregido esta sesión): hasta
  // ahora currentMode del Firmware Model y scenarioId del World Model
  // vivían completamente desconectados — iniciar Minisumo desde
  // sumo.html jamás cargaba el tatami. Se detecta la TRANSICIÓN de modo
  // (no se fuerza en cada tick) para no pelear con el usuario si después
  // cambia de escenario a mano mientras sigue en modo Minisumo.
  // Nota de alcance: Fútbol y Línea no tienen modo propio en el firmware
  // real (RobotMode solo define IDLE/MICRO/MINI/VIVERO/METEO/ALARMA/
  // ACCESO/BLOQUES) — por eso solo Minisumo puede auto-cargarse desde acá;
  // los otros dos siguen siendo selección manual en el Workspace.
  //
  // IMPORTANTE (bug real corregido): antes, salir del modo Sumo (ej. el
  // usuario presiona "Detener" en sumo.html después de un combate) volvía
  // automáticamente el escenario a "área libre" — descartando posiciones,
  // marcador y todo el estado. El Workspace debe comportarse como un
  // laboratorio real: el fin de una competencia SOLO cambia el estado de
  // la modalidad (match.ended), nunca reconstruye el entorno. El único
  // camino de reinicio ahora es explícito (Reiniciar / Nueva partida /
  // Cambiar modalidad, todos disparados a mano desde el Workspace).
  const mode = server.getLiveState ? (server.getLiveState() as { mode: RobotMode }).mode : undefined;
  const isSumoMode = mode === RobotMode.MICRO || mode === RobotMode.MINI;
  if (isSumoMode && lastMode !== mode && world.scenarioId !== "minisumo-combate") {
    loadScenario(world, ROBOT_ID, "minisumo-combate");
  }
  lastMode = mode;

  // Sincronización del retardo reglamentario (Punto 2): el oponente NUNCA
  // tiene un temporizador propio — cada tick se alinea con el mismo
  // tInicioModo real del Firmware Model. Sin esto, un desfasaje de un
  // solo tick entre "el robot arrancó su cuenta" y "se creó el oponente"
  // bastaría para que no empezaran exactamente juntos.
  if (isSumoMode && server.getCombatTiming) {
    const timing = server.getCombatTiming() as { tInicioModo: number; retardoOK: boolean };
    for (const opp of Object.values(world.opponents)) {
      if (opp.behavior.combatEnabled) opp.behavior.bornAt = timing.tInicioModo;
    }
  }

  // Reglas por modalidad — cada una en su propio módulo (core/src/rules/),
  // NUNCA distribuidas dentro del Simulation Engine. Este archivo solo
  // despacha según el escenario activo; la lógica de cada regla vive en
  // su módulo correspondiente.
  if (world.scenarioId === "minisumo-combate") {
    tickMinisumoRules(world, ROBOT_ID);
  } else if (world.scenarioId === "futbol") {
    const robotNow = getRobot(world, ROBOT_ID);
    tickFutbolRules(world, ROBOT_ID, dtMs, drive.currentSpeedCmS(), robotNow.headingRad);
  } else if (world.scenarioId === "laberinto" || world.scenarioId === "linea") {
    tickTimedTrialRules(world, ROBOT_ID, dtMs);
  }

  // Botón físico START (GPIO9) unificado (Punto 1 de la consolidación):
  // el botón de la placa dispara EXACTAMENTE el mismo procedimiento
  // interno que el botón web correspondiente — nunca una implementación
  // paralela. Flanco descendente (recién presionado), no nivel sostenido.
  const buttonNow = hal.digitalRead(9);
  const buttonJustPressed = lastButtonState === 1 && buttonNow === 0;
  lastButtonState = buttonNow;
  if (buttonJustPressed) {
    if (world.scenarioId === "minisumo-combate" && mode === RobotMode.IDLE) {
      // MISMA función interna que el botón "Iniciar Minisumo" del
      // Servidor Web — se llama a la ruta real, no una copia.
      server.handle("GET", "/sumo/mini", {});
    } else if (
      (world.scenarioId === "futbol" || world.scenarioId === "laberinto" || world.scenarioId === "linea") &&
      !world.match.started
    ) {
      // MISMA función interna que "Iniciar Partido"/"Iniciar" del Workspace.
      startMatch(world, world.scenarioId === "futbol" ? world.match.durationMs ?? 120000 : null);
    }
  }
});

const baseGetLiveState = server.getLiveState!.bind(server);
server.getLiveState = () => {
  const robot = getRobot(world, ROBOT_ID);
  return {
    ...(baseGetLiveState() as Record<string, unknown>),
    position: { x: robot.position.x, y: robot.position.y, headingRad: robot.headingRad },
    fueraDelTatami: isOutsideDohyo(world, robot.position),
    retardoOK: (server.getCombatTiming ? (server.getCombatTiming() as { retardoOK: boolean }).retardoOK : true),
    linearSpeedCmS: drive.currentSpeedCmS(),
    angularSpeedRadS: drive.currentAngularSpeedRadS(),
    arena: world.arena,
    scenarioId: world.scenarioId,
    obstacles: world.obstacles.map((o) => ({
      id: o.id, x: o.position.x, y: o.position.y, shape: o.shape, radius: o.radius, width: o.width, height: o.height,
    })),
    walls: world.walls.map((w) => ({ id: w.id, fromX: w.from.x, fromY: w.from.y, toX: w.to.x, toY: w.to.y })),
    lines: world.lines.map((l) => ({ id: l.id, color: l.color, points: l.points.map((p) => ({ x: p.x, y: p.y })) })),
    objects: world.objects.map((o) => ({ id: o.id, kind: o.kind, x: o.position.x, y: o.position.y })),
    opponents: Object.values(world.opponents).map((o) => ({
      id: o.id, x: o.position.x, y: o.position.y, headingRad: o.headingRad, radius: o.radius, pattern: o.behavior.pattern,
      combatState: o.behavior.combatState, fueraDelTatami: isOutsideDohyo(world, o.position),
    })),
    balls: world.balls.map((b) => ({ id: b.id, x: b.position.x, y: b.position.y, radius: b.radius, vx: b.velocity.x, vy: b.velocity.y })),
    goals: world.goals.map((g) => ({ id: g.id, team: g.team, fromX: g.from.x, fromY: g.from.y, toX: g.to.x, toY: g.to.y })),
    mazeFinish: world.mazeFinish,
    match: { ...world.match },
    lineSensors:
      world.scenarioId === "linea"
        ? {
            izq: robot.pins.analog[LINE_PIN_IZQ] < 1800,
            centro: robot.pins.digital[LINE_PIN_CENTRO] === 0,
            der: robot.pins.analog[LINE_PIN_DER] < 1800,
          }
        : null,
  };
};

// Edición del escenario (Fase 3/4/5): agregar/mover/quitar objetos, cargar
// escenarios predefinidos, reiniciar. Vive acá (no en Core) porque opera
// directamente sobre el World Model, que solo este archivo compone.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as {
    type?: string; id?: string; x?: number; y?: number; radius?: number; kind?: string;
    fromX?: number; fromY?: number; toX?: number; toY?: number; scenarioId?: string;
    pin?: number; value?: number; headingRad?: number;
  } | undefined;
  switch (data?.type) {
    case "FRANKY_LAB_SET_ROBOT_POSE":
      if (data.x !== undefined && data.y !== undefined) setRobotPose(world, ROBOT_ID, data.x, data.y, data.headingRad);
      break;
    case "FRANKY_LAB_SET_OPPONENT_POSE":
      if (data.id && data.x !== undefined && data.y !== undefined) setOpponentPose(world, data.id, data.x, data.y, data.headingRad);
      break;
    case "FRANKY_LAB_IMPULSE_BALL":
      if (data.id && data.x !== undefined && data.y !== undefined) impulseBall(world, data.id, data.x, data.y);
      break;
    case "FRANKY_LAB_START_MATCH":
      startMatch(world, data.value !== undefined ? data.value * 60000 : null); // value = minutos
      break;
    case "FRANKY_LAB_ADD_OBSTACLE":
      if (data.x !== undefined && data.y !== undefined) {
        const shape = data.kind === "caja" ? "caja" : "cilindro";
        addObstacle(world, data.x, data.y, shape, data.radius ?? 8);
      }
      break;
    case "FRANKY_LAB_MOVE_OBSTACLE":
      if (data.id && data.x !== undefined && data.y !== undefined) moveObstacle(world, data.id, data.x, data.y);
      break;
    case "FRANKY_LAB_REMOVE_OBSTACLE":
      if (data.id) removeObstacle(world, data.id);
      break;
    case "FRANKY_LAB_ADD_WALL":
      if (data.fromX !== undefined && data.fromY !== undefined && data.toX !== undefined && data.toY !== undefined) {
        addWall(world, { x: data.fromX, y: data.fromY }, { x: data.toX, y: data.toY });
      }
      break;
    case "FRANKY_LAB_REMOVE_WALL":
      if (data.id) removeWall(world, data.id);
      break;
    case "FRANKY_LAB_LOAD_SCENARIO":
      if (data.scenarioId) loadScenario(world, ROBOT_ID, data.scenarioId as ScenarioId);
      break;
    case "FRANKY_LAB_RESET_SCENARIO":
      resetScenario(world, ROBOT_ID);
      break;
    case "FRANKY_LAB_SET_ANALOG_INPUT":
      // Herramienta de depuración/testing: inyecta un valor ADC directo en
      // el World Model. No pasa por RobotHAL (que no expone "escritura" de
      // un pin analógico de entrada — sería incoherente con hardware real).
      // Útil para probar reacción a borde end-to-end sin necesitar
      // geometría de tatami con detección de color todavía.
      if (data.pin !== undefined && data.value !== undefined) setAnalogPin(world, ROBOT_ID, data.pin, data.value);
      break;
  }
});
