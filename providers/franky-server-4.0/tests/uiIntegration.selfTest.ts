/** Reproduce las secuencias reales de fetch() de index.html/sumo.html/gamepad.html. */
import { StubHAL } from "../../../core/src/stubHal.js";
import { createProviderServer } from "../server/virtualServer.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const MODES = ["IDLE","MICROSUMO","MINISUMO","VIVERO","METEO","ALARMA","ACCESO","BLOQUES"];

console.log("1. index.html: polling /api");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const d = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert(MODES[d.mode as number] === "IDLE", "MODES[d.mode] resuelve a IDLE");
}

console.log("\n2. sumo.html: config -> arranque -> polling");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const cfg = server.handle("GET", "/sumo/config", {
    modo: "mini", tipo: "sharp", numDist: "1", numBorde: "1", sharpI: "0",
    umbral_sharp: "1800", umbral_borde: "2000", spdAtaque: "200",
  });
  assert((cfg.body as { ok: boolean }).ok === true, "config válida -> {ok:true}");
  server.handle("GET", "/sumo/mini", {});
  const api = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert(MODES[api.mode as number] === "MINISUMO", "polling refleja MINISUMO");
}

console.log("\n2b. SUMO-01: sumo.html 'Guardar configuración' — /sumo/config guarda sensores/estrategia/velocidades SIN arrancar el combate");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  // Misma llamada que hace guardarConfigSumo() en sumo.html (botón nuevo) —
  // a diferencia del test "2" de arriba, acá NUNCA se llama a /sumo/mini
  // ni /sumo/micro, igual que al presionar solo "💾 Guardar configuración".
  const cfg = server.handle("GET", "/sumo/config", {
    modo: "mini", tipo: "sonar", numDist: "1", numBorde: "0",
    trigI: "20", echoI: "21", umbral_dist: "25", spdAtaque: "180",
  });
  assert((cfg.body as { ok: boolean }).ok === true, "la configuración se acepta y se guarda de verdad");
  const api = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert(MODES[api.mode as number] === "IDLE", "el modo sigue IDLE — 'Guardar configuración' nunca arranca el combate");
  assert(api.modeRunning === false || api.modeRunning === undefined, "modeRunning no quedó en true por guardar la config");
  // Persiste igual que si la página se recargara (misma vía que usa
  // sumo.html al reabrirse: /proyecto/export, nunca localStorage — ver
  // PERSISTENCIA SUMO en server.selfTest.ts para la cobertura completa de
  // export/import/reload).
  const proyecto = server.handle("GET", "/proyecto/export", {}).body as { sumo: { mini: { tipoDistSensor: number; trigI: number; echoI: number; spdAtaque: number } } };
  assert(proyecto.sumo.mini.tipoDistSensor === 0, "tipoDistSensor (sonar=0) quedó guardado sin haber iniciado combate");
  assert(proyecto.sumo.mini.trigI === 20 && proyecto.sumo.mini.echoI === 21, "TRIG/ECHO guardados tal cual se configuraron");
  assert(proyecto.sumo.mini.spdAtaque === 180, "spdAtaque guardado tal cual se configuró");
}

console.log("\n3. gamepad.html: spd -> mv -> st");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/spd", { val: "220" });
  server.handle("GET", "/mv", { d: "f" });
  server.handle("GET", "/st", {});
  const api = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert(api.pwmA === 0 && api.pwmB === 0, "secuencia completa termina frenado");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
