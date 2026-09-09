/**
 * Regresión — sincronización de Sumo con el firmware real (fase "Cierre
 * Sumo"): velBusqueda/intGiro/durBarrido, velExterna()/velInterna(),
 * searchSweep() como curva (no pivote), memoria de última dirección del
 * oponente y recuperación acotada de 500ms. Todos los valores están
 * verificados contra esp32c3_franky_SPIFFS.ino (fuente de verdad), no
 * solo contra el informe de auditoría.
 */
import { StubHAL } from "../../../core/src/stubHal.js";
import { FirmwareRuntime } from "../firmware/runtime.js";
import { defaultFirmwareModel, defaultSumoConfigMini, defaultSumoConfigMicro, DireccionOponente, CABECEO_MS } from "../firmware/model.js";
import { velExterna, velInterna, RECUPERACION_MS } from "../firmware/sumoEngine.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
// Funciones opacas para el chequeador de tipos: evitan que TS "recuerde" el
// literal asignado unas líneas antes y marque la comparación como redundante.
function readDir(runtime: FirmwareRuntime): DireccionOponente { return runtime.model.ultimaDirOponente; }
function readRecuperacion(runtime: FirmwareRuntime): boolean { return runtime.model.enRecuperacion; }

console.log("1. Defaults de fábrica reconstruyen exactamente ext/int del .ino real");
{
  const mini = defaultSumoConfigMini();
  const micro = defaultSumoConfigMicro();
  assert(mini.velBusqueda === 145 && mini.intGiro === 130, "Mini: velBusqueda=145, intGiro=130 (ext=210/int=80)");
  assert(velExterna(mini) === 210 && velInterna(mini) === 80, "Mini: velExterna()=210, velInterna()=80");
  assert(micro.velBusqueda === 130 && micro.intGiro === 140, "Micro: velBusqueda=130, intGiro=140 (ext=200/int=60)");
  assert(velExterna(micro) === 200 && velInterna(micro) === 60, "Micro: velExterna()=200, velInterna()=60");
  assert(mini.durBarrido === CABECEO_MS && CABECEO_MS === 250, "durBarrido de fábrica = CABECEO_MS = 250ms");
}

console.log("\n2. velExterna/velInterna: recorte a [0,255], interna nunca negativa");
{
  const cfg = { ...defaultSumoConfigMini(), velBusqueda: 255, intGiro: 255 };
  assert(velExterna(cfg) === 255, "velExterna se recorta a 255");
  assert(velInterna(cfg) === 128, "velInterna = 255 - 127 = 128 (nunca reversa)");
  const cfg2 = { ...defaultSumoConfigMini(), velBusqueda: 0, intGiro: 200 };
  assert(velInterna(cfg2) === 0, "velInterna nunca baja de 0");
}

console.log("\n3. configureSumo: compatibilidad spdBuscExt/spdBuscInt (legado) -> velBusqueda/intGiro");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  const r = runtime.configureSumo({ perfil: "mini", spdBuscExt: 210, spdBuscInt: 80 });
  assert(r.ok === true, "acepta nombres legados sin error");
  assert(runtime.model.cfgMini.velBusqueda === 145 && runtime.model.cfgMini.intGiro === 130,
    "spdBuscExt=210/spdBuscInt=80 -> velBusqueda=145/intGiro=130 (misma fórmula que loadSumoConfig() real)");
}

console.log("\n4. configureSumo: si llegan ambos estilos en la misma petición, gana el nuevo");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "mini", velBusqueda: 200, spdBuscExt: 50, spdBuscInt: 10 });
  assert(runtime.model.cfgMini.velBusqueda === 200, "velBusqueda explícito no es sobreescrito por el par viejo");
}

console.log("\n5. configureSumo: durBarrido se acepta y se recorta a [50,3000]");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "mini", durBarrido: 9999 });
  assert(runtime.model.cfgMini.durBarrido === 3000, "durBarrido se recorta al máximo (3000ms)");
  runtime.configureSumo({ perfil: "mini", durBarrido: 1 });
  assert(runtime.model.cfgMini.durBarrido === 50, "durBarrido se recorta al mínimo (50ms)");
}

console.log("\n6. searchSweep(): curva alternada (ninguna rueda invierte sentido), no pivote");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "mini", estrategia: 1, velBusqueda: 145, intGiro: 130, durBarrido: 250, numBorde: 0 });
  runtime.startSumo("mini");
  hal.advance(5001);
  runtime.tick(); // primer tick post-retardo: fija dirección inicial de barrido
  const pwmA1 = hal.getPwm(5), pwmB1 = hal.getPwm(3);
  assert(pwmA1 > 0 && pwmB1 > 0, "ambas ruedas giran hacia adelante durante el barrido (curva, no pivote)");
  hal.advance(300); // supera durBarrido=250 -> cambia de pierna
  runtime.tick();
  assert(hal.getPwm(5) > 0 && hal.getPwm(3) > 0, "tras alternar de pierna, ambas ruedas siguen hacia adelante (nunca reversa)");
}

console.log("\n7. Memoria de última dirección: solo con 2 sensores independientes");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "mini", tipo: "sharp", numDist: 2, sharpI: 0, sharpD: 1, umbralSharp: 1000, numBorde: 0 });
  runtime.startSumo("mini");
  hal.advance(5001);
  hal.setAnalog(0, 2000); // solo el sensor izquierdo detecta
  runtime.tick();
  assert(runtime.model.ultimaDirOponente === DireccionOponente.IZQUIERDA, "IZQ=1/DER=0 -> DIR_IZQUIERDA (tabla de verdad real)");
}

console.log("\n8. Recuperación acotada hacia la última dirección conocida (500ms = RECUPERACION_MS)");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  assert(RECUPERACION_MS === 500, "RECUPERACION_MS = CABECEO_MS*2 = 500ms (no configurable)");
  runtime.configureSumo({ perfil: "mini", tipo: "sharp", numDist: 2, sharpI: 0, sharpD: 1, umbralSharp: 1000, numBorde: 0 });
  runtime.startSumo("mini");
  hal.advance(5001);
  hal.setAnalog(0, 2000); // oponente detectado a la izquierda
  runtime.tick();
  hal.setAnalog(0, 0); // oponente perdido
  runtime.tick();
  assert(runtime.model.enRecuperacion === true, "al perder al oponente con última dirección IZQUIERDA -> arranca recuperación");
  assert(runtime.model.recuperacionHaciaIzquierda === true, "recuperación sesgada hacia la izquierda");
  hal.advance(RECUPERACION_MS + 1);
  runtime.tick();
  assert(runtime.model.enRecuperacion === false, "la recuperación se agota a los 500ms y vuelve a búsqueda normal");
}

console.log("\n9. Un combate nuevo no hereda la memoria del combate anterior (reiniciarMemoriaSumo)");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.model.ultimaDirOponente = DireccionOponente.DERECHA;
  runtime.model.enRecuperacion = true;
  runtime.startSumo("mini");
  assert(readDir(runtime) === DireccionOponente.DESCONOCIDA, "startSumo() reinicia ultimaDirOponente a DESCONOCIDA");
  assert(readRecuperacion(runtime) === false, "startSumo() reinicia enRecuperacion a false");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
