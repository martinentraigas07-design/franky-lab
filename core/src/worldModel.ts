/**
 * FRANKY LAB — Core / World Model
 *
 * Representación del escenario físico. 100% agnóstica de robot, de placa y
 * de microcontrolador — nunca conoce GPIO con nombre de canal, motores, ni
 * nada que no sea física/geometría/tiempo (ADR-002 §6, corrección de la fuga
 * que tenía "motors: {A1,A2,B1,B2}").
 *
 * Los "pines" que expone son crudos: analog/digital/pwm por número de pin.
 * La traducción "el pin 5 es el motor izquierdo hacia adelante" es
 * conocimiento de Board, nunca de World.
 */

export interface Vector2 {
  x: number;
  y: number;
}

/**
 * Propiedades físicas compartidas. Las masas son PROPORCIONES creíbles,
 * no gramos exactos de datasheet — lo que importa es que un Microsumo
 * (~100g) no empuje una caja pesada con la misma facilidad que un
 * Minisumo (~500g), no un valor de laboratorio.
 */
export interface PhysicsProps {
  massG: number;
  friction: number; // 0-1
  restitution: number; // 0-1, rebote
  movable: boolean;
}

export function defaultRobotPhysics(): PhysicsProps {
  return { massG: 500, friction: 0.5, restitution: 0.1, movable: true }; // Minisumo
}
export function defaultOpponentPhysics(): PhysicsProps {
  return { massG: 500, friction: 0.5, restitution: 0.1, movable: true };
}
export function defaultCajaPhysics(): PhysicsProps {
  return { massG: 300, friction: 0.5, restitution: 0.2, movable: true };
}
export function defaultCilindroPhysics(): PhysicsProps {
  return { massG: 150, friction: 0.2, restitution: 0.4, movable: true }; // rueda con facilidad
}
export function defaultParedPhysics(): PhysicsProps {
  return { massG: Infinity, friction: 1, restitution: 0.1, movable: false };
}
export function defaultBallPhysics(): PhysicsProps {
  return { massG: 15, friction: 0.3, restitution: 0.8, movable: true };
}

export interface RawPinState {
  analog: Record<number, number>; // pin -> valor crudo 0-4095
  digital: Record<number, number>; // pin -> 0 | 1
  pwm: Record<number, number>; // pin -> duty 0-255
}

export interface WorldRobot {
  id: string;
  position: Vector2;
  headingRad: number;
  pins: RawPinState;
  physics: PhysicsProps;
}

/** Comportamiento simple del Robot Oponente (sin firmware, patrones fijos). */
export type OpponentPattern = "quieto" | "avance_lento" | "giro_aleatorio";

/** Estados de la IA de combate simplificada del oponente (Punto 2). */
export type OpponentCombatState = "retardo" | "buscando" | "atacando" | "recuperando" | "evade_back" | "evade_turn";

export interface OpponentBehavior {
  pattern: OpponentPattern;
  speedCmS: number;
  headingChangeIntervalMs: number;
  nextChangeAt: number; // simTime (ms) del próximo cambio de dirección
  // Combate (Punto 2): igual que el robot principal, el oponente respeta
  // el retardo reglamentario de 5s y alterna entre buscar/atacar/recuperar
  // — sin ejecutar firmware completo, solo un puñado de patrones creíbles.
  combatEnabled: boolean;
  combatState: OpponentCombatState;
  combatStateTimer: number; // simTime del último cambio de estado
  startDelayMs: number; // 5000, igual al retardo reglamentario del robot principal
  bornAt: number; // simTime de creación real (-1 = todavía no se fijó)
  evadeDirRight: boolean; // hacia qué lado gira al evadir (igual que el robot principal)
  evadeBoth: boolean; // ambos sensores de borde detectaron a la vez (giro más largo)
}

/**
 * Robot Oponente — entidad física del World Model, SIN firmware ni MCU.
 * Existe para dar un objetivo real a la IA de combate (búsqueda/ataque),
 * no para simular otro FRANKY. Ver criterio permanente: cada entidad del
 * mundo aporta su propia lógica/propiedades, el Simulation Engine no
 * cambia por agregar una entidad nueva.
 */
export interface OpponentRobot {
  id: string;
  position: Vector2;
  headingRad: number;
  radius: number; // footprint circular para colisión/raycast
  behavior: OpponentBehavior;
  physics: PhysicsProps;
}

export function createOpponent(
  id: string,
  position: Vector2,
  pattern: OpponentPattern = "giro_aleatorio",
  massG = 500,
  combatEnabled = false,
): OpponentRobot {
  return {
    id,
    position,
    headingRad: Math.random() * Math.PI * 2,
    radius: 7,
    behavior: {
      pattern, speedCmS: pattern === "quieto" ? 0 : 12, headingChangeIntervalMs: 2500, nextChangeAt: 0,
      combatState: "retardo", combatStateTimer: 0, startDelayMs: 5000, combatEnabled, bornAt: -1,
      evadeDirRight: true, evadeBoth: false,
    },
    physics: { ...defaultOpponentPhysics(), massG },
  };
}

export interface Wall {
  id: string;
  from: Vector2;
  to: Vector2;
}
export interface WorldLine {
  id: string;
  points: Vector2[];
  color: string;
}
export interface Zone {
  id: string;
  kind: string;
  polygon: Vector2[];
}
export interface WorldObject {
  id: string;
  kind: string;
  position: Vector2;
}
/**
 * Geometría diferenciada — ya no todo es un círculo. "cilindro" (poste,
 * lata) usa radio; "caja" (bloque, pared corta) usa ancho/alto axis-aligned
 * (sin rotación todavía, ver deuda reconocida en el Simulation Engine).
 */
export type ObstacleShape = "cilindro" | "caja";
export interface Obstacle {
  id: string;
  position: Vector2;
  shape: ObstacleShape;
  radius: number; // usado cuando shape="cilindro"
  width: number; // usado cuando shape="caja"
  height: number; // usado cuando shape="caja"
  physics: PhysicsProps;
}

/**
 * Pelota — entidad física propia (no un WorldObject genérico). Hoy sin
 * física real (velocity siempre en 0, nadie la integra todavía), pero el
 * modelo ya tiene los campos para que el Simulation Engine evolucione
 * hacia rebote/rozamiento/colisión sin volver a rediseñar el World Model.
 */
export interface Ball {
  id: string;
  position: Vector2;
  velocity: Vector2; // cm/s — el Simulation Engine ya lo integra (stepBall)
  radius: number;
  mass: number;
  friction: number; // 0-1, coeficiente de rozamiento
  restitution: number; // 0-1, rebote contra paredes
}

/**
 * Arco (Fútbol) — entidad propia, no una pared genérica. Representa la
 * línea de gol entre dos postes; los postes en sí siguen siendo paredes
 * cortas (sólidas, para colisión), pero el Arco es la zona de gol que el
 * Simulation Engine podrá usar más adelante para detectar "pelota adentro".
 */
/**
 * Celda de llegada de Laberinto — entidad propia (no un color inventado).
 * Reglamento LNR: "La llegada será una única celda, marcada con piso de
 * color blanco." Zona rectangular; el cronómetro se detiene solo cuando
 * el robot ENTERO (no el centro, no un sensor) queda dentro de ella.
 */
export interface MazeFinish {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Goal {
  id: string;
  team: "izquierdo" | "derecho";
  from: Vector2;
  to: Vector2;
}

/**
 * Estado de partido/ronda — GENÉRICO, el World Model no sabe qué modalidad
 * lo está usando. Cada modalidad (Fútbol, Laberinto, Línea, Minisumo)
 * tiene su propio módulo de reglas (ver core/src/rules/) que interpreta
 * estos mismos campos a su manera — el Simulation Engine nunca decide
 * estrategias ni reglas, solo física/sensores/movimiento.
 */
export interface MatchState {
  started: boolean;
  startedAt: number; // simTime
  durationMs: number | null; // null = sin límite de tiempo (ej. Minisumo)
  elapsedMs: number;
  ended: boolean;
  winner: string | null; // "robot" | "oponente" | "empate" | null
  scoreRobot: number;
  scoreOponente: number;
}

export function defaultMatchState(): MatchState {
  return { started: false, startedAt: 0, durationMs: null, elapsedMs: 0, ended: false, winner: null, scoreRobot: 0, scoreOponente: 0 };
}

export interface Surface {
  id: string;
  kind: "dohyo" | "borde" | "piso";
  polygon: Vector2[];
}
export interface CompetitionState {
  id: string;
  kind: "sumo" | "seguidor_linea" | "libre";
  active: boolean;
}
export interface AmbientSensors {
  temperatureC: number;
  humidityPct: number;
  lightLux: number;
}
export interface WorldEvent {
  t: number;
  type: string;
  data?: unknown;
}
export interface WorldClock {
  simTime: number;
}

/** Área de juego (cm). MVP de la Fase 2/4: "Área libre" — rectángulo vacío. */
export interface Arena {
  width: number;
  height: number;
  margin: number;
  shape: "rect" | "circle";
}

export interface WorldModel {
  scenarioId: string;
  clock: WorldClock;
  arena: Arena;
  robots: Record<string, WorldRobot>;
  opponents: Record<string, OpponentRobot>;
  obstacles: Obstacle[];
  walls: Wall[];
  lines: WorldLine[];
  zones: Zone[];
  objects: WorldObject[];
  balls: Ball[];
  goals: Goal[];
  mazeFinish: MazeFinish | null;
  match: MatchState;
  competition: CompetitionState | null;
  ambient: AmbientSensors;
  surfaces: Surface[];
  events: WorldEvent[];
}

function defaultPinState(): RawPinState {
  return {
    // Pines analógicos sin conducir arrancan en 0 (no en 4095/alta
    // impedancia como en una versión anterior): tanto la detección Sharp
    // como la de borde disparan con ADC ALTO, así que un default alto
    // generaba falsos positivos permanentes en ambos sensores — el robot
    // "veía" un oponente y "sentía" el borde todo el tiempo, incluso sin
    // que el Motor de Simulación hubiera calculado nada todavía. Esto fue
    // la causa de que la IA de combate nunca llegara a buscar/atacar de
    // verdad. El raycast real (cuando corre) sigue sobrescribiendo este
    // valor con la lectura física correcta en cada tick.
    analog: { 0: 0, 1: 0 },
    digital: { 8: 1, 9: 1 },
    pwm: {},
  };
}

export function createRobot(id: string, position: Vector2 = { x: 0, y: 0 }): WorldRobot {
  return { id, position, headingRad: 0, pins: defaultPinState(), physics: defaultRobotPhysics() };
}

export function createDefaultWorld(scenarioId = "area-libre"): WorldModel {
  const arena: Arena = { width: 200, height: 150, margin: 8, shape: "rect" };
  return {
    scenarioId,
    clock: { simTime: 0 },
    arena,
    robots: { FRANKY_0000: createRobot("FRANKY_0000", { x: arena.width / 2, y: arena.height / 2 }) },
    opponents: {},
    obstacles: [],
    walls: [],
    lines: [],
    zones: [],
    objects: [],
    balls: [],
    goals: [],
    mazeFinish: null,
    match: defaultMatchState(),
    competition: null,
    ambient: { temperatureC: 22, humidityPct: 45, lightLux: 500 },
    surfaces: [],
    events: [],
  };
}

// Mutadores explícitos — SOLO el (futuro) Motor de Simulación y los tests
// deberían llamar a estos. Nadie más muta World Model directamente
// (principio Model-Runtime, ADR-003 §1).
export function advanceClock(world: WorldModel, ms: number): void {
  world.clock.simTime += ms;
}
export function pushEvent(world: WorldModel, type: string, data?: unknown): void {
  world.events.push({ t: world.clock.simTime, type, data });
}
export function getRobot(world: WorldModel, robotId: string): WorldRobot {
  const robot = world.robots[robotId];
  if (!robot) throw new Error(`World Model: robot '${robotId}' no existe en el escenario.`);
  return robot;
}
export function setAnalogPin(world: WorldModel, robotId: string, pin: number, value: number): void {
  getRobot(world, robotId).pins.analog[pin] = Math.max(0, Math.min(4095, value));
}
export function setDigitalPin(world: WorldModel, robotId: string, pin: number, value: 0 | 1): void {
  getRobot(world, robotId).pins.digital[pin] = value;
}

// --- Objetos del escenario (Fase 3/5: agregar, mover, quitar, reiniciar) ---
let obstacleCounter = 0;
export function addObstacle(
  world: WorldModel,
  x: number,
  y: number,
  shape: ObstacleShape = "cilindro",
  size = 8,
  physicsOverride?: Partial<PhysicsProps>,
): Obstacle {
  const id = `${shape}-${Date.now().toString(36)}-${obstacleCounter++}`;
  const physics = { ...(shape === "caja" ? defaultCajaPhysics() : defaultCilindroPhysics()), ...physicsOverride };
  const obstacle: Obstacle =
    shape === "caja"
      ? { id, position: { x, y }, shape, radius: 0, width: size, height: size, physics }
      : { id, position: { x, y }, shape, radius: size, width: 0, height: 0, physics };
  world.obstacles.push(obstacle);
  return obstacle;
}
export function moveObstacle(world: WorldModel, id: string, x: number, y: number): void {
  const obstacle = world.obstacles.find((o) => o.id === id);
  if (obstacle) {
    obstacle.position.x = x;
    obstacle.position.y = y;
  }
}
export function removeObstacle(world: WorldModel, id: string): void {
  world.obstacles = world.obstacles.filter((o) => o.id !== id);
}
export function resetScenario(world: WorldModel, robotId: string): void {
  loadScenario(world, robotId, (world.scenarioId as ScenarioId) || "area-libre");
}

/** Permite cambiar posición/orientación inicial del robot (Punto 3: facilita pruebas). */
export function setRobotPose(world: WorldModel, robotId: string, x: number, y: number, headingRad?: number): void {
  const robot = getRobot(world, robotId);
  robot.position = { x, y };
  if (headingRad !== undefined) robot.headingRad = headingRad;
}

// --- Robot Oponente (sin firmware, comportamiento simple) ---
export function addOpponent(
  world: WorldModel,
  id: string,
  x: number,
  y: number,
  pattern: OpponentPattern = "giro_aleatorio",
  massG = 500,
  combatEnabled = false,
): OpponentRobot {
  const opponent = createOpponent(id, { x, y }, pattern, massG, combatEnabled);
  world.opponents[id] = opponent;
  return opponent;
}
export function removeOpponent(world: WorldModel, id: string): void {
  delete world.opponents[id];
}
export function setOpponentPose(world: WorldModel, id: string, x: number, y: number, headingRad?: number): void {
  const opponent = world.opponents[id];
  if (opponent) {
    opponent.position = { x, y };
    if (headingRad !== undefined) opponent.headingRad = headingRad;
  }
}

// --- Pelota (Fútbol) ---
let ballCounter = 0;
export function addBall(world: WorldModel, x: number, y: number, radius = 3.5): Ball {
  const phys = defaultBallPhysics();
  const ball: Ball = { id: `pelota-${ballCounter++}`, position: { x, y }, velocity: { x: 0, y: 0 }, radius, mass: phys.massG, friction: phys.friction, restitution: phys.restitution };
  world.balls.push(ball);
  return ball;
}
/** Aplica un impulso (patada) a la pelota — cm/s en cada eje. */
export function impulseBall(world: WorldModel, ballId: string, vx: number, vy: number): void {
  const ball = world.balls.find((b) => b.id === ballId);
  if (ball) {
    ball.velocity.x = vx;
    ball.velocity.y = vy;
  }
}

let goalCounter = 0;
export function addGoal(world: WorldModel, team: "izquierdo" | "derecho", from: Vector2, to: Vector2): Goal {
  const goal: Goal = { id: `arco-${team}-${goalCounter++}`, team, from, to };
  world.goals.push(goal);
  return goal;
}

// --- Control de partido/ronda (genérico — ver MatchState) ---
export function startMatch(world: WorldModel, durationMs: number | null = null): void {
  world.match = { ...defaultMatchState(), started: true, startedAt: world.clock.simTime, durationMs };
}
export function endMatch(world: WorldModel, winner: string): void {
  world.match.ended = true;
  world.match.winner = winner;
}

let wallCounter = 0;
export function addWall(world: WorldModel, from: Vector2, to: Vector2): Wall {
  const wall: Wall = { id: `pared-${Date.now().toString(36)}-${wallCounter++}`, from, to };
  world.walls.push(wall);
  return wall;
}
export function removeWall(world: WorldModel, id: string): void {
  world.walls = world.walls.filter((w) => w.id !== id);
}

/**
 * Escenarios (Fase 4): cada uno define forma de arena + obstáculos/paredes
 * preexistentes. "area-libre" ya existía como default; se agregan
 * "minisumo" (tatami circular reglamentario, ø77cm) y "laberinto" (paredes
 * formando pasillos). Seguidor de línea queda para una próxima sesión —
 * necesita geometría de pista + sensores de línea reales, no solo bordes.
 */
/**
 * Genera una pista tipo "rectángulo redondeado" con radio de curva real
 * (no esquinas a 90° rectas) — reglamento LNR Argentina / categoría
 * Carreras confirmado por captura del usuario: radio mínimo R40 (40cm),
 * línea de 2cm, robot máximo 14x23cm. Los valores 10/16 visibles en el
 * mismo diagrama (separación entre carriles / margen) no se transcriben
 * con certeza — esta pista es de UN solo carril (uso educativo individual,
 * no carrera de dos robots en paralelo), así que esa medida no aplica acá.
 */
function roundedRectTrack(x0: number, y0: number, x1: number, y1: number, radius: number): Vector2[] {
  const pts: Vector2[] = [];
  const segmentsPerArc = 12;
  const arc = (cx: number, cy: number, startDeg: number, endDeg: number) => {
    for (let i = 0; i <= segmentsPerArc; i++) {
      const t = startDeg + ((endDeg - startDeg) * i) / segmentsPerArc;
      const rad = (t * Math.PI) / 180;
      pts.push({ x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) });
    }
  };
  arc(x0 + radius, y0 + radius, 180, 270);
  arc(x1 - radius, y0 + radius, 270, 360);
  arc(x1 - radius, y1 - radius, 0, 90);
  arc(x0 + radius, y1 - radius, 90, 180);
  pts.push(pts[0]);
  return pts;
}

export type ScenarioId = "area-libre" | "minisumo-navegacion" | "minisumo-combate" | "laberinto" | "linea" | "futbol";

export function loadScenario(world: WorldModel, robotId: string, scenarioId: ScenarioId): void {
  world.scenarioId = scenarioId;
  world.obstacles = [];
  world.walls = [];
  world.lines = [];
  world.objects = [];
  world.opponents = {};
  world.balls = [];
  world.goals = [];
  world.match = defaultMatchState();
  world.mazeFinish = null;
  const robot = getRobot(world, robotId);

  switch (scenarioId) {
    case "minisumo-navegacion": {
      // Sin oponente: probar búsqueda, evasión de borde y colisiones,
      // sin la variable extra del combate.
      const diameter = 77;
      world.arena = { width: diameter, height: diameter, margin: 2.5, shape: "circle" };
      robot.position = { x: diameter / 2 - 15, y: diameter / 2 };
      robot.headingRad = 0;
      addObstacle(world, diameter / 2 + 15, diameter / 2, "caja", 8);
      break;
    }
    case "minisumo-combate": {
      // Dohyo reglamentario: ø77cm, borde blanco 2.5cm — estándar que LNR
      // Argentina adopta (confirmado contra múltiples reglamentos
      // latinoamericanos derivados de la misma base; el PDF propio de LNR
      // no estaba accesible al momento de implementar esto).
      const diameter = 77;
      world.arena = { width: diameter, height: diameter, margin: 2.5, shape: "circle" };
      robot.position = { x: diameter / 2 - 15, y: diameter / 2 };
      robot.headingRad = 0;
      // Robot Oponente real, con combate habilitado (retardo 5s + IA
      // simple de búsqueda/ataque/recuperación) — da un objetivo genuino
      // que también respeta las reglas del combate, no solo un blanco fijo.
      addOpponent(world, "OPONENTE_1", diameter / 2 + 15, diameter / 2, "giro_aleatorio", 500, true);
      break;
    }
    case "laberinto": {
      // Grilla de celdas de 30cm (tamaño no confirmado contra el
      // reglamento oficial — valor razonable de referencia, documentado
      // como pendiente de confirmar en el informe). Celda de partida con
      // EXACTAMENTE 3 paredes (reglamento LNR: "la partida será una celda
      // de tres paredes"), sin inventar marcas de piso. Celda de llegada
      // como entidad propia con piso blanco real (reglamento: "la llegada
      // será una única celda, marcada con piso de color blanco").
      const CELL = 30;
      world.arena = { width: 210, height: 180, margin: 15, shape: "rect" };

      // Celda de partida: esquina inferior izquierda del área jugable.
      // Paredes en izquierda/arriba/abajo; el lado derecho queda ABIERTO
      // (por ahí sale el robot hacia el laberinto) — exactamente 3 paredes.
      const sx = 15, sy = 15;
      addWall(world, { x: sx, y: sy }, { x: sx, y: sy + CELL }); // izquierda
      addWall(world, { x: sx, y: sy }, { x: sx + CELL, y: sy }); // arriba
      addWall(world, { x: sx, y: sy + CELL }, { x: sx + CELL, y: sy + CELL }); // abajo
      robot.position = { x: sx + CELL / 2, y: sy + CELL / 2 };
      robot.headingRad = 0; // mirando hacia el lado abierto

      // Corredor simple entre partida y llegada (no impone el algoritmo,
      // solo da un recorrido plausible con un par de giros).
      addWall(world, { x: sx + CELL, y: sy + CELL * 2 }, { x: sx + CELL * 3, y: sy + CELL * 2 });
      addWall(world, { x: sx + CELL * 3, y: sy }, { x: sx + CELL * 3, y: sy + CELL * 2 });
      addWall(world, { x: sx + CELL * 2, y: sy + CELL * 3 }, { x: sx + CELL * 5, y: sy + CELL * 3 });

      // Celda de llegada: piso blanco real, entidad propia del World
      // Model — no un color puesto encima de una celda cualquiera.
      world.mazeFinish = { x: sx + CELL * 5, y: sy + CELL * 4, w: CELL, h: CELL };
      break;
    }
    case "linea": {
      // Circuito con curvas de radio real R40 (40cm) — reglamento LNR
      // Argentina / Carreras, confirmado por captura del usuario. Línea
      // negra 2cm. Arena dimensionada para que el radio de 40cm entre
      // cómodo con margen.
      const R = 40;
      world.arena = { width: 320, height: 220, margin: 20, shape: "rect" };
      world.lines.push({
        id: "pista-1",
        color: "#000000",
        points: roundedRectTrack(40, 40, 280, 180, R),
      });
      robot.position = { x: 40 + R, y: 40 };
      robot.headingRad = 0;
      break;
    }
    case "futbol": {
      // "Cancha de fútbol a escala" (categoría Fútbol RC de LNR) — dimensión
      // oficial exacta no confirmada (PDF de reglamento no accesible al
      // implementar esto); se usa una cancha a escala razonable de 3:2,
      // fácil de ajustar cuando se confirmen las medidas reales.
      world.arena = { width: 240, height: 160, margin: 6, shape: "rect" };
      robot.position = { x: 40, y: 80 };
      robot.headingRad = 0;
      // Arcos: representados como paredes cortas a cada lado con hueco central.
      addWall(world, { x: 0, y: 55 }, { x: 0, y: 75 });
      addWall(world, { x: 0, y: 85 }, { x: 0, y: 105 });
      addWall(world, { x: 240, y: 55 }, { x: 240, y: 75 });
      addWall(world, { x: 240, y: 85 }, { x: 240, y: 105 });
      addGoal(world, "izquierdo", { x: 0, y: 75 }, { x: 0, y: 85 });
      addGoal(world, "derecho", { x: 240, y: 75 }, { x: 240, y: 85 });
      addBall(world, 120, 80); // entidad física propia, no un WorldObject genérico
      // El oponente también juega — busca la pelota y la empuja (ver
      // core/src/rules/futbolRules.ts), no un NPC decorativo.
      addOpponent(world, "OPONENTE_FUTBOL", 200, 80, "quieto", 500, false);
      break;
    }
    case "area-libre":
    default: {
      world.arena = { width: 200, height: 150, margin: 8, shape: "rect" };
      robot.position = { x: world.arena.width / 2, y: world.arena.height / 2 };
      robot.headingRad = -Math.PI / 2;
      break;
    }
  }
}
