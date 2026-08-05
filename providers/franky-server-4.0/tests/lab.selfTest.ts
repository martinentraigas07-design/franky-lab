/** Verifica que /lab/state refleje el estado real (no valores inventados). */
import { StubHAL } from "../../../core/src/stubHal.js";
import { createProviderServer } from "../server/virtualServer.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. /lab/state refleja movimiento real aplicado vía /mv");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/spd", { val: "180" });
  server.handle("GET", "/mv", { d: "f" });
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.pwmA === 180 && lab.pwmB === 180, "pwmA/pwmB del Workspace coinciden con lo aplicado por /mv");
}

console.log("\n2. /lab/state.ledOn refleja digitalWrite real (lógica invertida)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  let lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.ledOn === false, "LED apagado por defecto (GPIO8=HIGH)");
  server.handle("GET", "/led/on", {});
  lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.ledOn === true, "tras /led/on, ledOn=true (GPIO8=LOW real)");
}

console.log("\n3. /lab/state.borde usa la misma lectura que la máquina de evasión (sin duplicar estado)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const cfgRes = server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numDist: "1", numBorde: "1", bordeI: "1", umbral_borde: "2000" });
  assert((cfgRes.body as any).ok === true, "la config se aceptó de verdad (si esto falla, el resto del test mide el default, no lo configurado)");
  hal.setAnalog(1, 500);
  let lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.borde.izq === false, "sin superar umbral -> borde.izq=false");
  hal.setAnalog(1, 2500);
  lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.borde.izq === true, "superando umbral -> borde.izq=true, en vivo, sin polling extra del firmware");
}

console.log("\n4. Botón START funcional (setDigitalInput -> loopAcceso real)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/auto/acceso", {});
  let lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.btn === false, "botón libre por defecto (pull-up, GPIO9=HIGH)");
  assert(lab.accesoAbierto === false, "acceso cerrado por defecto");

  (server as any).setDigitalInput?.(9, 0); // simula presionar el botón físico
  server.tick();
  lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.btn === true, "botón presionado se refleja en /lab/state");
  assert(lab.accesoAbierto === true, "loopAcceso() real: botón LOW en MODE_ACCESO abre el acceso");
}

console.log("\n5. oponenteSensor refleja EXACTAMENTE lo configurado — 1 Sharp, no 2, no genérico");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const cfgRes = server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numDist: "1", numBorde: "0", sharpI: "0", umbral_sharp: "1800" });
  assert((cfgRes.body as any).ok === true, "la config se aceptó de verdad (si no, el resto mide el default)");
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.oponenteSensor.tipoLabel === "sharp", "tipoLabel refleja 'sharp', configurado por el usuario");
  assert(lab.oponenteSensor.numDist === 1, "numDist=1: el Workspace NO debe inventar un segundo sensor");
  assert(lab.oponenteSensor.sensores.length === 1, "sensores[] trae exactamente 1 elemento, no 2 fijos");
}

console.log("\n6. Reconfigurar a 2 HC-SR04 (sonar) cambia el bloque dinámicamente, sin reiniciar nada");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sonar", numDist: "2", trigI: "20", echoI: "21", trigD: "6", echoD: "7" });
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.oponenteSensor.tipoLabel === "sonar", "tipoLabel cambió a 'sonar' (HC-SR04) tras reconfigurar");
  assert(lab.oponenteSensor.numDist === 2, "numDist=2: ahora sí corresponden 2 sensores");
  assert(lab.oponenteSensor.sensores.length === 2, "sensores[] trae 2 elementos, izq Y der");
}

console.log("\n7. Reconfigurar a JS40 (óptico digital) refleja lectura digital, no ADC");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "optico", numDist: "1", optI: "6" });
  hal.digitalWrite(6, 0); // JS40 detectando (activo en LOW)
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.oponenteSensor.tipoLabel === "optico", "tipoLabel refleja 'optico' (JS40)");
  assert(lab.oponenteSensor.sensores[0].detectado === true, "JS40 detecta correctamente por lectura digital (no ADC)");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
