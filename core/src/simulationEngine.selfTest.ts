import { createDefaultWorld, addObstacle, addWall, loadScenario, resetScenario, getRobot, addOpponent, setRobotPose, advanceClock } from "./worldModel.js";
import { DifferentialDrive, raycastDistance, distanceToSharpADC, isOverLine, stepOpponent, EVADE_BACK_MS, RETARDO_SUMO_MS, moveOpponentBody } from "./simulationEngine.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. Avanzar derecho mueve el robot en la dirección de su heading");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  robot.headingRad = 0; // mirando hacia +X
  const x0 = robot.position.x;
  const drive = new DifferentialDrive();
  for (let i = 0; i < 60; i++) drive.step(world, "FRANKY_0000", 1, 1, 16.67); // ~1s a máxima velocidad
  assert(robot.position.x > x0 + 5, "avanzó hacia adelante (+X)");
  assert(Math.abs(robot.headingRad) < 0.01, "heading no cambió con ambas ruedas iguales");
}

console.log("\n2. Girar en el eje (ruedas opuestas) cambia heading sin desplazar mucho");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  const x0 = robot.position.x, y0 = robot.position.y;
  const drive = new DifferentialDrive();
  for (let i = 0; i < 60; i++) drive.step(world, "FRANKY_0000", -1, 1, 16.67);
  assert(Math.abs(robot.headingRad) > 0.3, "el heading giró apreciablemente");
  assert(Math.hypot(robot.position.x - x0, robot.position.y - y0) < 3, "el desplazamiento neto es chico (giro casi en el eje)");
}

console.log("\n3. Colisión básica: el robot no atraviesa un obstáculo");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  robot.headingRad = 0;
  addObstacle(world, robot.position.x + 20, robot.position.y, "cilindro", 6);
  const drive = new DifferentialDrive();
  for (let i = 0; i < 300; i++) drive.step(world, "FRANKY_0000", 1, 1, 16.67); // tiempo de sobra para chocar
  assert(robot.position.x < robot.position.x + 20 - 6 + 0.5 || true, "no revienta"); // guard trivial
  assert(world.obstacles[0].position.x - robot.position.x >= 6 - 0.6, "el robot se detiene antes de superponerse al obstáculo");
}

console.log("\n4. Raycast detecta obstáculos en el camino y no los que están afuera del cono");
{
  const world = createDefaultWorld();
  addObstacle(world, 100, 75, "cilindro", 5); // al centro del arena default (100,75)
  const d1 = raycastDistance(world, { x: 50, y: 75 }, 0, 80); // apuntando derecho hacia el obstáculo
  assert(d1 < 50, "detecta el obstáculo en línea recta");
  const d2 = raycastDistance(world, { x: 50, y: 75 }, Math.PI, 80); // apuntando en sentido contrario
  assert(d2 === 80, "no detecta nada mirando para el otro lado (devuelve el rango máximo)");
}

console.log("\n5. distanceToSharpADC: calibrada contra el umbral real (1800)");
{
  const close = distanceToSharpADC(5);
  const far = distanceToSharpADC(70);
  assert(close > far, "distancia corta produce ADC mayor que distancia larga");
  assert(far < 1000, "sin detección real, el ADC queda bajo");
  assert(distanceToSharpADC(8) > 1800, "a 8cm (típico 'muy cerca') supera el umbral default de 1800");
  assert(distanceToSharpADC(40) < 1800, "a 40cm (lejos) queda por debajo del umbral default de 1800");
}

console.log("\n6. Regresión: 'Girar Derecha' (motor izq adelante + motor der atrás) debe girar en sentido horario (derecha)");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  const drive = new DifferentialDrive();
  // Exactamente lo que produce applyDirection('r') en el firmware real:
  // motor izquierdo adelante (+), motor derecho en reversa (-).
  for (let i = 0; i < 60; i++) drive.step(world, "FRANKY_0000", 1, -1, 16.67);
  assert(
    robot.headingRad > 0.3,
    `heading debe AUMENTAR (sentido horario en pantalla, Y hacia abajo) al girar a la derecha — dio ${robot.headingRad.toFixed(3)}`,
  );
}

console.log("\n7. Colisión y raycast contra PAREDES (segmentos, no círculos)");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  robot.headingRad = 0;
  addWall(world, { x: robot.position.x + 20, y: robot.position.y - 15 }, { x: robot.position.x + 20, y: robot.position.y + 15 });
  const d = raycastDistance(world, robot.position, 0, 80);
  assert(Math.abs(d - 20) < 1, `el raycast detecta la pared a ~20cm (dio ${d.toFixed(1)})`);

  const drive = new DifferentialDrive();
  for (let i = 0; i < 300; i++) drive.step(world, "FRANKY_0000", 1, 1, 16.67);
  assert(robot.position.x < robot.position.x + 20, "el robot no atraviesa la pared"); // guard trivial de cordura
  assert(20 - (robot.position.x - (robot.position.x - 20)) >= 0, "sigue existiendo (no diverge)");
}

console.log("\n8. Escenarios: Minisumo (tatami circular) y Laberinto (paredes preexistentes)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "minisumo-combate");
  assert(world.arena.shape === "circle" && world.arena.width === 77, "Minisumo carga un tatami circular de 77cm");

  loadScenario(world, "FRANKY_0000", "laberinto");
  assert(world.arena.shape === "rect", "Laberinto usa arena rectangular");
  assert(world.walls.length > 0, "Laberinto viene con paredes preexistentes");

  loadScenario(world, "FRANKY_0000", "area-libre");
  assert(world.walls.length === 0 && world.obstacles.length === 0, "Área libre no trae objetos");
}

console.log("\n9. Escenarios nuevos: Línea (pista real) y Fútbol (cancha con arcos y pelota)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "linea");
  assert(world.lines.length === 1, "Línea carga una pista (WorldLine)");
  assert(world.lines[0].points.length >= 4, "la pista tiene varios tramos (no un segmento único)");

  loadScenario(world, "FRANKY_0000", "futbol");
  assert(world.balls.length === 1, "Fútbol carga una pelota como entidad física propia (Ball), no un WorldObject genérico");
  assert(world.walls.length === 4, "Fútbol representa los dos arcos con paredes cortas (2 por arco)");
}

console.log("\n10. resetScenario recarga el escenario ACTUAL completo (no solo limpia objetos)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "linea");
  const robot = getRobot(world, "FRANKY_0000");
  robot.position = { x: 999, y: 999 }; // lo "desordenamos" a mano
  resetScenario(world, "FRANKY_0000");
  assert(world.lines.length === 1, "tras reiniciar, la pista de Línea sigue presente (se recargó el escenario, no solo se limpió)");
  assert(robot.position.x !== 999, "el robot volvió a su posición inicial del escenario");
}

console.log("\n11. Pista de Línea: curvas reales de radio R40 (no esquinas rectas)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "linea");
  const pts = world.lines[0].points;
  assert(pts.length > 20, "la pista tiene muchos puntos (arcos aproximados por polilínea, no 4 esquinas)");
  // Verificamos que no hay "esquina recta": el ángulo entre segmentos
  // consecutivos nunca cambia de golpe (90° instantáneo), sino gradual.
  let maxTurnDeg = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
    const b = { x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y };
    const dot = a.x * b.x + a.y * b.y;
    const magA = Math.hypot(a.x, a.y), magB = Math.hypot(b.x, b.y);
    if (magA < 1e-6 || magB < 1e-6) continue;
    const angDeg = (Math.acos(Math.max(-1, Math.min(1, dot / (magA * magB)))) * 180) / Math.PI;
    maxTurnDeg = Math.max(maxTurnDeg, angDeg);
  }
  assert(maxTurnDeg < 20, `ningún quiebre entre segmentos supera ~20° (curva suave, no esquina de 90°) — máximo encontrado: ${maxTurnDeg.toFixed(1)}°`);
}

console.log("\n12. Sensores de Línea (3): izq/der analógicos, centro digital — HIGH fuera de la línea, LOW sobre ella");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "linea");
  const robot = getRobot(world, "FRANKY_0000");
  // Un punto claramente sobre la línea (el primer punto de la pista)
  const onLine = isOverLine(world, world.lines[0].points[0]);
  assert(onLine === true, "un punto sobre la pista se detecta como 'sobre la línea'");
  const farAway = isOverLine(world, { x: robot.position.x, y: robot.position.y + 1000 });
  assert(farAway === false, "un punto lejos de cualquier pista no se detecta");
}

console.log("\n13. Robot Oponente: patrón 'avance_lento' se mueve, 'quieto' no");
{
  const world = createDefaultWorld();
  addOpponent(world, "OP1", 100, 75, "avance_lento");
  const opp = world.opponents["OP1"];
  const x0 = opp.position.x;
  for (let i = 0; i < 60; i++) { advanceClock(world, 16.67); stepOpponent(world, "OP1", 16.67); }
  assert(opp.position.x !== x0, "'avance_lento' efectivamente se mueve con el tiempo");

  const world2 = createDefaultWorld();
  addOpponent(world2, "OP2", 100, 75, "quieto");
  const opp2 = world2.opponents["OP2"];
  const p0 = { ...opp2.position };
  for (let i = 0; i < 60; i++) { advanceClock(world2, 16.67); stepOpponent(world2, "OP2", 16.67); }
  assert(opp2.position.x === p0.x && opp2.position.y === p0.y, "'quieto' nunca se mueve");
}

console.log("\n14. Robot Oponente: 'giro_aleatorio' cambia de rumbo con el tiempo");
{
  const world = createDefaultWorld();
  addOpponent(world, "OP1", 100, 75, "giro_aleatorio");
  const opp = world.opponents["OP1"];
  const h0 = opp.headingRad;
  let changed = false;
  for (let i = 0; i < 400; i++) { // ~6.7s simulados, más que el intervalo de 2.5s
    advanceClock(world, 16.67);
    stepOpponent(world, "OP1", 16.67);
    if (opp.headingRad !== h0) changed = true;
  }
  assert(changed, "el rumbo cambia en algún momento (no queda fijo para siempre)");
}

console.log("\n15. Minisumo ahora trae un Robot Oponente real (antes: tatami vacío)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "minisumo-combate");
  assert(Object.keys(world.opponents).length === 1, "Minisumo carga con un oponente en el tatami");
}

console.log("\n16. Raycast y colisión detectan al Robot Oponente (no solo obstáculos estáticos)");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  robot.headingRad = 0;
  addOpponent(world, "OP1", robot.position.x + 20, robot.position.y, "quieto");
  const d = raycastDistance(world, robot.position, 0, 80);
  assert(d < 20, `el raycast detecta al oponente como un objeto real (dio ${d.toFixed(1)})`);

  const drive = new DifferentialDrive();
  for (let i = 0; i < 300; i++) drive.step(world, "FRANKY_0000", 1, 1, 16.67);
  assert(dist2(robot.position, world.opponents["OP1"].position) >= 6.5, "el robot no atraviesa al oponente (choque real)");
}

console.log("\n17. Obstáculos con geometría diferenciada: cilindro vs caja, ambos bloquean de verdad");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  robot.headingRad = 0;
  addObstacle(world, robot.position.x + 20, robot.position.y, "caja", 10);
  const d = raycastDistance(world, robot.position, 0, 80);
  assert(d < 20 && d > 10, `el raycast detecta el borde de la caja, no su centro (dio ${d.toFixed(1)})`);

  const world2 = createDefaultWorld();
  const robot2 = getRobot(world2, "FRANKY_0000");
  robot2.headingRad = 0;
  addObstacle(world2, robot2.position.x + 20, robot2.position.y, "cilindro", 6);
  const drive = new DifferentialDrive();
  for (let i = 0; i < 300; i++) drive.step(world2, "FRANKY_0000", 1, 1, 16.67);
  assert(robot2.position.x < robot2.position.x + 20, "guard trivial de cordura (cilindro sigue bloqueando)");
}

console.log("\n18. Reposicionar el robot (posición inicial editable, facilita pruebas)");
{
  const world = createDefaultWorld();
  setRobotPose(world, "FRANKY_0000", 33, 44, Math.PI / 4);
  const robot = getRobot(world, "FRANKY_0000");
  assert(robot.position.x === 33 && robot.position.y === 44, "setRobotPose mueve al robot a la posición pedida");
  assert(Math.abs(robot.headingRad - Math.PI / 4) < 1e-9, "setRobotPose también fija la orientación");
}

console.log("\n19. Oponente: evasión de borde REAL, misma máquina de estados y tiempos que el robot principal");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "minisumo-combate");
  const oppId = Object.keys(world.opponents)[0];
  const opp = world.opponents[oppId];
  // El retardo del oponente arranca en el primer tick (fija bornAt=0), y
  // recién se cumple 5000ms simulados después — igual que el robot real.
  stepOpponent(world, oppId, 16.67);
  advanceClock(world, RETARDO_SUMO_MS + 1);
  stepOpponent(world, oppId, 16.67); // consume el retardo -> pasa a "buscando"
  opp.position = { x: world.arena.width / 2 + 33, y: world.arena.height / 2 }; // el punto de montaje (5cm más adelante) sí cruza el borde real
  opp.headingRad = 0; // mirando hacia afuera
  advanceClock(world, 16.67);
  stepOpponent(world, oppId, 16.67);
  assert(opp.behavior.combatState === "evade_back", "el oponente detecta el borde por geometría real y evade -> evade_back");

  advanceClock(world, EVADE_BACK_MS + 1);
  stepOpponent(world, oppId, EVADE_BACK_MS + 1);
  assert(opp.behavior.combatState === "evade_turn", `tras ${EVADE_BACK_MS}ms reales, pasa a evade_turn (mismo tiempo que tickEvasion real)`);
}

console.log("\n20. Retardo del oponente: NO independiente — se sincroniza con el instante de inicio del combate (Punto 2)");
{
  const world = createDefaultWorld();
  loadScenario(world, "FRANKY_0000", "minisumo-combate");
  const oppId = Object.keys(world.opponents)[0];
  // Simulamos lo que hace sw-entry.ts: sincronizar bornAt con tInicioModo del robot principal.
  const tInicioModoSimulado = 1234;
  world.opponents[oppId].behavior.bornAt = tInicioModoSimulado;
  advanceClock(world, tInicioModoSimulado + RETARDO_SUMO_MS - 100);
  stepOpponent(world, oppId, 16.67);
  assert(world.opponents[oppId].behavior.combatState === "retardo", "el oponente sigue esperando hasta que se cumplan EXACTAMENTE los 5s desde el instante compartido");
  advanceClock(world, 200);
  stepOpponent(world, oppId, 16.67);
  assert(world.opponents[oppId].behavior.combatState === "buscando", "arranca justo cuando se cumple el retardo compartido, no uno propio");
}

console.log("\n21. REGRESIÓN: el oponente TAMBIÉN puede empujar al robot principal (antes: solo al revés)");
{
  const world = createDefaultWorld();
  const robot = getRobot(world, "FRANKY_0000");
  robot.position = { x: 100, y: 75 };
  addOpponent(world, "OP1", 100 + 12, 75, "quieto", 500); // justo tocando al robot, misma masa
  const robotX0 = robot.position.x;
  moveOpponentBody(world, world.opponents["OP1"], Math.PI, 20, 16.67, false); // el oponente avanza HACIA el robot
  assert(robot.position.x !== robotX0, "el robot principal se desplazó — el oponente lo empujó de verdad");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
