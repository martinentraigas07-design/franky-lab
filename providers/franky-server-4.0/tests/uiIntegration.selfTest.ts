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
