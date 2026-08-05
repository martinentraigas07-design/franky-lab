import { createDefaultWorld, createRobot, setAnalogPin, advanceClock } from "./worldModel.js";
import { WorldModelHAL } from "./worldModelHAL.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. WorldModelHAL lee/escribe contra World Model (pines crudos, sin nombre de canal)");
{
  const world = createDefaultWorld();
  const hal = new WorldModelHAL(world, "FRANKY_0000");
  assert(hal.analogRead(0) === 0, "sin obstáculo -> ADC0 en 0 (sin conducir, default seguro sin falsos positivos)");
  setAnalogPin(world, "FRANKY_0000", 0, 1200);
  assert(hal.analogRead(0) === 1200, "el valor cambia al modificar el World Model");
  hal.pwmWrite(5, 200);
  assert(world.robots["FRANKY_0000"].pins.pwm[5] === 200, "pwmWrite(pin,duty) escribe por número de pin crudo, sin canal con nombre");
}

console.log("\n2. Reloj compartido");
{
  const world = createDefaultWorld();
  const hal = new WorldModelHAL(world, "FRANKY_0000");
  advanceClock(world, 5000);
  assert(hal.millis() === 5000, "avanzar el reloj del mundo avanza millis() de la HAL");
}

console.log("\n3. Múltiples robots no interfieren");
{
  const world = createDefaultWorld();
  world.robots["FRANKY_AAAA"] = createRobot("FRANKY_AAAA", { x: 10, y: 0 });
  const halA = new WorldModelHAL(world, "FRANKY_0000");
  const halB = new WorldModelHAL(world, "FRANKY_AAAA");
  setAnalogPin(world, "FRANKY_0000", 0, 500);
  setAnalogPin(world, "FRANKY_AAAA", 0, 3000);
  assert(halA.analogRead(0) === 500 && halB.analogRead(0) === 3000, "cada robot lee su propio sensor");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
