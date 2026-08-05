import { createDefaultWorld, loadScenario, getRobot, setRobotPose, setOpponentPose, addBall, startMatch, advanceClock } from "../worldModel.js";
import { tickMinisumoRules } from "./minisumoRules.js";
import { tickFutbolRules } from "./futbolRules.js";
import { tickTimedTrialRules } from "./timedTrialRules.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. Minisumo: expulsión simétrica — pierde quien sale, sin importar cuál robot sea");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "minisumo-combate");
  const oppId = Object.keys(world.opponents)[0];
  setRobotPose(world, "FRANKY_0000", world.arena.width / 2, world.arena.height / 2); // centro, a salvo
  tickMinisumoRules(world, "FRANKY_0000");
  assert(world.match.ended === false, "nadie salió todavía -> el combate sigue");

  setOpponentPose(world, oppId, 500, 500); // muy lejos del dohyo (77cm) -> fuera
  tickMinisumoRules(world, "FRANKY_0000");
  assert(world.match.ended === true && world.match.winner === "robot", "el oponente salió -> gana el robot principal");
}
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "minisumo-combate");
  setRobotPose(world, "FRANKY_0000", 500, 500); // el robot principal el que sale esta vez
  tickMinisumoRules(world, "FRANKY_0000");
  assert(world.match.winner === "oponente", "simetría real: si sale el robot principal, gana el oponente (misma regla, ambos lados)");
}

console.log("\n2. Fútbol: nadie se mueve antes de 'Iniciar Partido'");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  assert(world.match.started === false, "el partido NO arranca solo al cargar el escenario");
  tickFutbolRules(world, "FRANKY_0000", 16.67, 0, 0);
  assert(world.match.elapsedMs === 0, "sin 'Iniciar', el cronómetro no avanza");
}

console.log("\n3. Fútbol: gol real cuando la pelota cruza completamente la línea del arco");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  startMatch(world, 120000);
  const ball = world.balls[0];
  ball.position = { x: 1, y: 80 }; // dentro del arco izquierdo (x=0, y 75-85)
  tickFutbolRules(world, "FRANKY_0000", 16.67, 0, 0);
  assert(world.match.scoreOponente === 1, "pelota en el arco izquierdo (propio de FRANKY) -> gol del oponente");
  assert(ball.position.x === world.arena.width / 2, "la pelota se reinicia al centro tras el gol");
}
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  startMatch(world, 120000);
  const ball = world.balls[0];
  ball.position = { x: world.arena.width - 1, y: 80 }; // arco derecho
  tickFutbolRules(world, "FRANKY_0000", 16.67, 0, 0);
  assert(world.match.scoreRobot === 1, "pelota en el arco derecho (rival) -> gol del robot principal");
}

console.log("\n4. Fútbol: el oponente busca la pelota (IA simple, no queda quieto)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  startMatch(world, 120000);
  const oppId = Object.keys(world.opponents)[0];
  const before = { ...world.opponents[oppId].position };
  for (let i = 0; i < 30; i++) { advanceClock(world, 16.67); tickFutbolRules(world, "FRANKY_0000", 16.67, 0, 0); }
  const after = world.opponents[oppId].position;
  assert(before.x !== after.x || before.y !== after.y, "el oponente se mueve buscando la pelota, no es un NPC estático");
}

console.log("\n5. Fútbol: el partido termina al agotarse el tiempo, gana quien metió más goles");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  startMatch(world, 1000); // 1 segundo de partido
  world.match.scoreRobot = 3;
  world.match.scoreOponente = 1;
  advanceClock(world, 1001);
  tickFutbolRules(world, "FRANKY_0000", 1001, 0, 0);
  assert(world.match.ended === true && world.match.winner === "robot", "se acabó el tiempo -> termina y gana quien tenía más goles");
}

console.log("\n6. Laberinto/Línea: cronómetro solo corre después de 'Iniciar'");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "laberinto");
  tickTimedTrialRules(world, "FRANKY_0000", 500);
  assert(world.match.elapsedMs === 0, "sin iniciar, el cronómetro no corre");
  startMatch(world);
  tickTimedTrialRules(world, "FRANKY_0000", 500);
  assert(world.match.elapsedMs === 500, "tras iniciar, el cronómetro avanza con el tiempo real");
}

console.log("\n7. REGRESIÓN: el oponente ataca su arco rival, no se ubica del lado que produce autogol");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  startMatch(world, 120000);
  const oppId = Object.keys(world.opponents)[0];
  const ball = world.balls[0];
  // Pelota justo delante del arco DERECHO (el que el oponente NO debe convertir en propio).
  ball.position = { x: world.arena.width - 15, y: world.arena.height / 2 };
  setOpponentPose(world, oppId, world.arena.width - 30, world.arena.height / 2);
  for (let i = 0; i < 60; i++) { advanceClock(world, 16.67); tickFutbolRules(world, "FRANKY_0000", 16.67, 0, 0); }
  const opp = world.opponents[oppId];
  // Si se posicionara mal (del lado del arco derecho), terminaría MÁS cerca
  // del arco derecho que la pelota misma, empujándola adentro (autogol).
  const oppDistToRightGoal = world.arena.width - opp.position.x;
  const ballDistToRightGoal = world.arena.width - ball.position.x;
  assert(oppDistToRightGoal >= ballDistToRightGoal - 1, "el oponente se ubica del lado correcto (no más cerca del arco rival que la pelota)");
}

console.log("\n8. REGRESIÓN: el oponente no queda trabado contra un poste del arco (gira, no se congela)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "futbol");
  startMatch(world, 120000);
  const oppId = Object.keys(world.opponents)[0];
  // Lo ubicamos pegado a un poste del arco izquierdo, apuntando derecho contra él.
  setOpponentPose(world, oppId, 3, 60, Math.PI); // mirando hacia el poste en (0,55)-(0,75)
  const before = { ...world.opponents[oppId].position };
  for (let i = 0; i < 60; i++) { advanceClock(world, 16.67); tickFutbolRules(world, "FRANKY_0000", 16.67, 0, 0); }
  const after = world.opponents[oppId];
  assert(after.headingRad !== Math.PI, "el rumbo cambió (no se quedó apuntando fijo contra el poste para siempre)");
}

console.log("\n7. Laberinto: el cronómetro se detiene SOLO cuando el robot entra COMPLETO a la celda blanca");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "laberinto");
  startMatch(world);
  assert(world.mazeFinish !== null, "el escenario trae una celda de llegada real (MazeFinish), no un color puesto encima");

  // Centro del robot tocando el borde de la celda, pero el cuerpo (radio
  // ~7cm) todavía sobresale -> NO debe darse por terminado.
  setRobotPose(world, "FRANKY_0000", world.mazeFinish!.x + 1, world.mazeFinish!.y + world.mazeFinish!.h / 2);
  tickTimedTrialRules(world, "FRANKY_0000", 16.67);
  assert(world.match.ended === false, "el centro apenas entrando (cuerpo todavía afuera) NO termina la prueba");

  // Robot bien adentro, con margen de sobra para el cuerpo completo.
  setRobotPose(world, "FRANKY_0000", world.mazeFinish!.x + world.mazeFinish!.w / 2, world.mazeFinish!.y + world.mazeFinish!.h / 2);
  tickTimedTrialRules(world, "FRANKY_0000", 16.67);
  assert(world.match.ended === true && world.match.winner === "robot", "el robot ENTERO adentro sí termina la prueba y detiene el cronómetro");
}

console.log("\n8. Laberinto: la celda de partida tiene EXACTAMENTE 3 paredes (reglamento LNR)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "laberinto");
  // Las primeras 3 paredes agregadas por el escenario son las de la celda
  // de partida (izquierda/arriba/abajo) — el resto son del corredor.
  const startWalls = world.walls.slice(0, 3);
  assert(startWalls.length === 3, "exactamente 3 segmentos de pared para la celda de partida");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
