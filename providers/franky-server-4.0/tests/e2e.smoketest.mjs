// FRANKY LAB — Smoke test END-TO-END sobre el bundle COMPILADO real.
//
// Por qué existe este archivo (no es redundante con los *.selfTest.ts):
// los tests unitarios usan StubHAL, cuyo reloj se avanza a mano con
// hal.advance(). Eso NO ejercita el mismo camino que el Service Worker
// real, donde el reloj viene de WorldModelHAL -> world.clock.simTime,
// avanzado únicamente si algo llama a advanceClock() dentro del onTick
// real de sw-entry.ts. Un bug ahí (el reloj real nunca avanzaba) pasó
// 88/88 tests unitarios sin detectarse, y solo lo encontró este tipo de
// prueba. A partir de ahora, un comportamiento no se considera terminado
// hasta que pasa ACÁ, no solo en los *.selfTest.ts.
//
// Requiere que `npm run build:sw` (y por lo tanto `public/sw.js`) ya esté
// generado. Se ejecuta con Node, simulando el entorno mínimo de un
// Service Worker (self.addEventListener, self.clients, etc.).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..", "..");
const publicDir = join(root, "public");

globalThis.self = globalThis;
self.addEventListener = (evt, fn) => {
  self[`_${evt}`] = self[`_${evt}`] || [];
  self[`_${evt}`].push(fn);
};
self.skipWaiting = () => {};
self.clients = { claim: async () => {} };
self.location = { origin: "http://127.0.0.1:4173" };

const swjs = await readFile(join(publicDir, "sw.js"), "utf8");
const importPath = swjs.match(/import "\.\/(.*)";/)[1].replace(/^_lab\//, "");
await import(join(publicDir, "_lab", importPath));

class FakeRequest {
  constructor(url) { this.url = url; this.method = "GET"; }
  async text() { return ""; }
}
async function fetchSim(path) {
  let captured = null;
  for (const fn of self._fetch) {
    await fn({ request: new FakeRequest("http://127.0.0.1:4173" + path), respondWith: (p) => { captured = p; } });
  }
  const res = await captured;
  return { status: res.status, body: await res.text() };
}
async function messageSim(data) {
  let posted = null;
  const fakeClient = { postMessage: (msg) => { posted = msg; } };
  for (const fn of self._message) await fn({ data, source: fakeClient });
  return posted;
}
async function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 16));
    await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" });
  }
}

let ok = 0, fail = 0;
function check(cond, msg) {
  if (cond) { ok++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗", msg); }
}

console.log("=== E2E: Minisumo — flujo completo Servidor Web -> ... -> Workspace ===\n");

await fetchSim("/sumo/mini"); // exactamente el botón real de sumo.html
await tick(2);
let s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.scenarioId === "minisumo-combate", "1. Servidor Web -> Virtual Server -> Provider: tatami cargado automáticamente");
check(s.mode === 2, "2. Firmware Runtime: modo MINI activo");
check(s.pwmA === 0 && s.pwmB === 0, "3. Antes del retardo de 5s el robot está quieto (fiel al firmware real)");
check(s.opponents.length === 1, "3b. El tatami trae un Robot Oponente real (antes: vacío, no se podía validar nada)");

await tick(320); // ~5.1s reales de reloj de mundo
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.retardoOK !== false, "4. El contador de 5s SÍ termina (regresión del bug de reloj congelado)");

// El oponente deambula al azar (giro_aleatorio) — para verificar el patrón
// de BÚSQUEDA de forma determinística (sin que por casualidad haya
// deambulado cerca y disparado un ataque), lo alejamos explícitamente
// antes de este chequeo puntual.
await messageSim({ type: "FRANKY_LAB_SET_OPPONENT_POSE", id: s.opponents[0].id, x: 5, y: 5 });
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.pwmA !== 0 || s.pwmB !== 0, "5. ejecutarSumo() se ejecuta: el robot BUSCA solo (patrón circular/cabeceo), Simulation Engine recibe PWM");
check(s.pwmA !== s.pwmB, "5b. Durante la búsqueda (oponente lejos), pwmA y pwmB son distintos (círculo/cabeceo, no avance recto)");

const p0 = s.position;
await tick(20);
const p1 = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload.position;
check(Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0.1 || p1.headingRad !== p0.headingRad, "6. Simulation Engine actualiza posición/orientación con el tiempo");

// --- VALIDACIÓN DE COMBATE (punto explícito del usuario): el robot debe
// ABANDONAR la búsqueda y ATACAR (embestir, no esquivar) apenas detecta al
// oponente REAL del escenario — no un obstáculo genérico agregado a mano.
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
const opponent = s.opponents[0];
// Reposicionamos al oponente real justo adelante del robot (determinístico para el test).
const heading = s.position.headingRad;
await messageSim({
  type: "FRANKY_LAB_SET_OPPONENT_POSE",
  id: opponent.id,
  x: s.position.x + Math.cos(heading) * 10,
  y: s.position.y + Math.sin(heading) * 10,
});
await tick(3);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.pwmA > 0 && s.pwmB > 0 && Math.abs(s.pwmA - s.pwmB) < 5, "7. Oponente REAL detectado -> abandona la búsqueda, ataca recto (embiste, no esquiva)");

// Reacción a borde: config con borde activo, y esta vez el robot se
// posiciona REALMENTE cerca del borde del dohyo — el sensor debe
// dispararse por geometría real, no por inyección manual (que ahora queda
// correctamente sobrescrita cada tick por la física real, como debe ser).
await messageSim({ type: "FRANKY_LAB_RESET_SCENARIO" });
await fetchSim("/sumo/config?modo=mini&tipo=sharp&numBorde=1&bordeI=1&numDist=1&sharpI=0&umbral_borde=1500");
await fetchSim("/sumo/mini");
await tick(320); // pasa el retardo
await messageSim({ type: "FRANKY_LAB_SET_ROBOT_POSE", x: 38.5 + 36, y: 38.5, headingRad: 0 }); // cerca del borde real, mirando hacia afuera
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.evadeState === 1, "8. Borde detectado por geometría real end-to-end -> EVADE_BACK, la máquina de evasión reacciona");
await tick(15); // 150ms de retroceso + margen
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.evadeState === 2, "9. Tras ~150ms reales, pasa a EVADE_TURN (girando)");

console.log(`\n=== E2E RESULTADO (Minisumo): ${ok} OK, ${fail} fallaron ===\n`);

console.log("=== E2E: inicio de combate sincronizado (Punto 2) — un solo instante compartido ===\n");
await fetchSim("/sumo/stop"); // fuerza una transición limpia IDLE->MINI (si ya estaba en MINI, el puente no recarga nada)
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "area-libre" });
await tick(1);
await fetchSim("/sumo/mini"); // arranca el combate real
await tick(2); // un par de ticks — el oponente recién se está creando
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
const oppId0 = s.opponents[0].id;
// Justo antes de los 5s: NINGUNO de los dos debe haber arrancado a moverse.
await tick(295); // ~4.9s
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.pwmA === 0 && s.pwmB === 0, "15. A los ~4.9s, el robot principal SIGUE esperando");
check(s.opponents[0].combatState === "retardo", "16. A los ~4.9s, el oponente TAMBIÉN sigue esperando (mismo instante, no un timer propio)");
// Cruzando los 5s: ambos deben arrancar prácticamente en el mismo tick.
await tick(15); // ~5.15s
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check((s.pwmA !== 0 || s.pwmB !== 0) && s.opponents[0].combatState !== "retardo", "17. Pasados los 5s, AMBOS empezaron a moverse — arranque sincronizado, no independiente");

console.log("\n=== E2E: el oponente también evade el borde (misma lógica que el robot principal) ===\n");
await messageSim({ type: "FRANKY_LAB_RESET_SCENARIO" });
await tick(320);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
const opp = s.opponents[0];
await messageSim({
  type: "FRANKY_LAB_SET_OPPONENT_POSE",
  id: opp.id,
  x: (s.arena.width / 2) + 33,
  y: s.arena.height / 2,
  headingRad: 0, // mirando hacia afuera — determinístico, no depende de hacia dónde haya derivado por azar
});
await tick(3);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(["evade_back", "evade_turn"].includes(s.opponents[0].combatState), "18. El oponente detecta el borde por geometría real y evade — ya no es un NPC que se escapa del tatami");

console.log(`\n=== E2E RESULTADO (Sincronización y evasión del oponente): ${ok} OK, ${fail} fallaron ===\n`);

console.log("=== E2E: Fútbol — partido completo (arranque manual, gol, cronómetro) ===\n");
await fetchSim("/st");
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "futbol" });
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.match.started === false, "19. El partido NO arranca solo al cargar el escenario");
await fetchSim("/spd?val=200");
await fetchSim("/mv?d=f");
const posBefore = s.position;
await tick(5);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.position.x === posBefore.x && s.position.y === posBefore.y, "20. Antes de 'Iniciar Partido', el robot NO se desplaza ni un cm (la física está congelada, aunque el firmware sí registre el comando)");

await messageSim({ type: "FRANKY_LAB_START_MATCH", value: 1 }); // 1 minuto
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.match.started === true, "21. 'Iniciar Partido' arranca el cronómetro oficial");
await fetchSim("/mv?d=f");
await tick(3);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.pwmA > 0, "22. Recién ahora el robot responde a los comandos de movimiento");

// La detección de gol en sí ya está cubierta a fondo en rules.selfTest.ts
// (unitario, determinístico). Acá solo confirmamos que el marcador viaja
// correctamente hasta el Workspace a través de todo el camino real.
const ballId = s.balls[0].id;
check(typeof s.match.scoreRobot === "number" && typeof s.match.scoreOponente === "number", "23. El marcador viaja correctamente al Workspace end-to-end");
void ballId;

await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "laberinto" });
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.match.started === false, "24. Laberinto tampoco arranca el cronómetro solo");
await messageSim({ type: "FRANKY_LAB_START_MATCH" });
await tick(5);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.match.elapsedMs > 0, "25. Laberinto: el cronómetro corre después de 'Iniciar'");

console.log(`\n=== E2E RESULTADO (Fútbol/Laberinto): ${ok} OK, ${fail} fallaron ===\n`);

console.log("=== E2E: persistencia del Workspace — 'Detener' no debe reconstruir el escenario ===\n");
await fetchSim("/sumo/stop"); // por si quedó algo corriendo de secciones anteriores
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "area-libre" });
await tick(1);
await fetchSim("/sumo/mini"); // arranca combate real
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.scenarioId === "minisumo-combate", "26. El tatami se cargó al iniciar Minisumo (comportamiento ya conocido)");
// Movemos al robot a una posición reconocible, para confirmar después que sigue ahí.
await messageSim({ type: "FRANKY_LAB_SET_ROBOT_POSE", x: 55, y: 20, headingRad: 1.2 });
await tick(1);
await fetchSim("/sumo/stop"); // el usuario presiona "Detener" en sumo.html — antes esto reconstruía todo
await tick(3);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.scenarioId === "minisumo-combate", "27. Tras 'Detener', el escenario NO vuelve solo a 'área libre' — se preserva");
check(Math.abs(s.position.x - 55) < 1 && Math.abs(s.position.y - 20) < 1, "28. La posición del robot se mantiene exactamente donde quedó, sin reconstruir el entorno");

console.log(`\n=== E2E RESULTADO (Persistencia): ${ok} OK, ${fail} fallaron ===\n`);

console.log("=== E2E: botón físico START unificado (misma función que el botón web) ===\n");
await fetchSim("/sumo/stop");
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "area-libre" });
await fetchSim("/sumo/mini"); // deja el modo en MINI, pero SIN arrancar por botón — usamos esto solo para setear el modo
await fetchSim("/sumo/stop"); // volvemos a IDLE con el modo ya "armado" conceptualmente vía escenario
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "minisumo-combate" });
await fetchSim("/sumo/stop");
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.mode === 0, "29. Antes de presionar START, el modo sigue en IDLE (no arrancó solo)");
await messageSim({ type: "FRANKY_LAB_SET_INPUT", pin: 9, value: 0 }); // presiona el botón físico START
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.mode === 2, "30. El botón físico START arrancó Minisumo — misma función interna que /sumo/mini (el botón web)");
await messageSim({ type: "FRANKY_LAB_SET_INPUT", pin: 9, value: 1 }); // suelta el botón

await fetchSim("/sumo/stop");
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "laberinto" });
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.match.started === false, "31. Laberinto tampoco arranca el cronómetro solo, esperando START");
await messageSim({ type: "FRANKY_LAB_SET_INPUT", pin: 9, value: 0 });
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.match.started === true, "32. El botón físico START también arranca el cronómetro de Laberinto — misma función interna que 'Iniciar'");
await messageSim({ type: "FRANKY_LAB_SET_INPUT", pin: 9, value: 1 });

console.log(`\n=== E2E RESULTADO (Botón START unificado): ${ok} OK, ${fail} fallaron ===\n`);

console.log("=== E2E: el dohyo NO es una pared física (fidelidad al combate real) ===\n");
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "minisumo-navegacion" });
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.fueraDelTatami === false, "9. El robot arranca dentro del tatami");
// Lo empujamos manualmente bien afuera y confirmamos que la física NO lo frena.
await messageSim({ type: "FRANKY_LAB_SET_ROBOT_POSE", x: 200, y: 200, headingRad: 0 }); // muy lejos del dohyo (ø77)
await fetchSim("/spd?val=200");
await fetchSim("/mv?d=f");
await tick(10);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.fueraDelTatami === true, "10. El robot puede terminar fuera del tatami de verdad — ninguna fuerza invisible lo frena");
check(s.pwmA > 0, "11. El robot sigue moviéndose libremente estando afuera (la física nunca lo bloqueó)");

// Sensores de borde: deben reflejar la geometría real SIN frenar nada.
await messageSim({ type: "FRANKY_LAB_RESET_SCENARIO" });
await fetchSim("/sumo/config?modo=mini&tipo=sharp&numDist=1&numBorde=1&sharpI=0&bordeI=1&umbral_borde=1500");
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.borde.izq === false, "12. Cerca del centro del dohyo, el sensor de borde no detecta nada (geometría real)");
// Empujamos el robot cerca del borde (radio ~38.5cm) y confirmamos que el sensor SÍ reacciona, por geometría.
await messageSim({ type: "FRANKY_LAB_SET_ROBOT_POSE", x: 38.5 + 36, y: 38.5, headingRad: 0 }); // apuntando hacia afuera
await tick(2);
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.borde.izq === true, "13. Cerca del borde real, el sensor detecta por geometría — nadie se lo dijo a mano");
check(s.fueraDelTatami === false, "14. Detectar el borde no significa haber salido — el firmware todavía puede reaccionar a tiempo");

console.log(`\n=== E2E RESULTADO (Fidelidad del dohyo): ${ok} OK, ${fail} fallaron ===\n`);

console.log("=== E2E: Fútbol — pelota como entidad física real ===\n");
await fetchSim("/st"); // el robot no debe arrastrar movimiento de la sección anterior
await messageSim({ type: "FRANKY_LAB_LOAD_SCENARIO", scenarioId: "futbol" });
await messageSim({ type: "FRANKY_LAB_START_MATCH", value: 2 }); // sin esto, la física de la pelota también queda congelada (correcto: nada se mueve antes del saque)
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.balls.length === 1, "10. Fútbol carga con una pelota real");
const ball = s.balls[0];
await messageSim({ type: "FRANKY_LAB_IMPULSE_BALL", id: ball.id, x: 40, y: 0 }); // patada: 40cm/s hacia +X
await tick(5);
const ballAfterKick = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload.balls[0];
check(ballAfterKick.x > ball.x, "11. La pelota se desplaza tras recibir un impulso (patada)");
await tick(200); // suficiente tiempo para que el rozamiento la frene
const ballAfterFriction = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload.balls[0];
check(Math.hypot(ballAfterFriction.vx, ballAfterFriction.vy) < Math.hypot(ballAfterKick.vx, ballAfterKick.vy), "12. El rozamiento frena la pelota progresivamente");

console.log("\n=== E2E: Sensores dinámicos — reconfigurar vía HTTP real cambia el Workspace ===\n");
await fetchSim("/sumo/config?modo=mini&tipo=sharp&numDist=1&numBorde=0&sharpI=0&umbral_sharp=1800");
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.oponenteSensor.tipoLabel === "sharp" && s.oponenteSensor.sensores.length === 1, "13. Config real vía /sumo/config (1 Sharp) se refleja en el Workspace");
await fetchSim("/sumo/config?modo=mini&tipo=sonar&numDist=2&numBorde=0&trigI=20&echoI=21&trigD=6&echoD=7");
s = (await messageSim({ type: "FRANKY_LAB_REQUEST_STATE" })).payload;
check(s.oponenteSensor.tipoLabel === "sonar" && s.oponenteSensor.sensores.length === 2, "14. Reconfigurar a 2 HC-SR04 vía HTTP real cambia el Workspace SIN reiniciar nada");

console.log(`\n=== E2E RESULTADO FINAL: ${ok} OK, ${fail} fallaron ===`);
if (fail > 0) process.exit(1);
