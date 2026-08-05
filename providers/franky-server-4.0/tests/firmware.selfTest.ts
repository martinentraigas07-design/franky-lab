/**
 * Prueba Firmware Runtime + Firmware Model en AISLAMIENTO — sin construir
 * un solo HttpResponse. Esto es lo que ADR-003 §6 prometía como ganancia
 * concreta de separar Runtime de Virtual Server.
 */
import { StubHAL } from "../../../core/src/stubHal.js";
import { FirmwareRuntime } from "../firmware/runtime.js";
import { defaultFirmwareModel, RobotMode, EvadeState } from "../firmware/model.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. Comandos de dominio no conocen HTTP");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  const r = runtime.setSpeed(150);
  assert(r.ok === true, "setSpeed devuelve CommandResult, no un HttpResponse");
  assert(runtime.model.motorSpeed === 150, "setSpeed muta el Firmware Model");
}

console.log("\n2. Regla de los 2 ADC vive en Runtime, no en Virtual Server");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  const bad = runtime.configureSumo({ perfil: "micro", tipo: "sharp", numDist: 2, numBorde: 1 });
  assert(bad.ok === false, "sharp(2)+borde(1)=3 ADC -> CommandResult de error, sin código HTTP involucrado");
  assert((bad as { error: string }).error.includes("ADC limit exceeded"), "mensaje de error correcto");
}

console.log("\n3. Retardo normativo + evasión, dirigido por el reloj de la MCU (StubHAL)");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "micro", tipo: "sharp", numBorde: 1, bordeI: 1, umbralBorde: 2000 });
  runtime.startSumo("micro");
  hal.advance(5001);
  runtime.tick();
  assert(runtime.model.retardoOK === true, "retardo de 5000ms se cumple");
  hal.setAnalog(1, 2500);
  runtime.tick();
  assert(runtime.model.evadeState === EvadeState.BACK, "borde detectado -> EVADE_BACK");
}

console.log("\n4. moveManual mueve PWM crudo por pin (Board = GPIO5/4/3/2), no por 'canal'");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.setSpeed(200);
  runtime.moveManual("f");
  assert(hal.getPwm(5) > 0 && hal.getPwm(3) > 0, "avanzar escribe PWM en GPIO5 (izq fwd) y GPIO3 (der fwd)");
  assert(hal.getPwm(4) === 0 && hal.getPwm(2) === 0, "los pines reverse quedan en 0");
}

console.log("\n5. Modo por defecto es RobotMode.IDLE (0), numérico");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  assert(runtime.model.currentMode === RobotMode.IDLE, "arranca en IDLE");
  assert(typeof runtime.model.currentMode === "number", "es numérico, no string");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
