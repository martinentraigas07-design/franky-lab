// FRANKY LAB — Integración END-TO-END de portabilidad de despliegue.
//
// No alcanza con probar toCanonicalPath()/reprefixLocation() aisladas
// (swRuntime.selfTest.ts) ni con probar el Service Worker real solo en
// la raíz (e2e.smoketest.mjs, self.location.origin sin subpath). Este
// archivo instancia el bundle COMPILADO real (el mismo sw.js que se
// publica) con self.registration.scope apuntando a un subdirectorio
// real (el caso GitHub Project Pages: usuario.github.io/franky-lab/),
// y confirma que el fetch handler real — tal como quedó cableado en
// startServiceWorker(), no una reimplementación — sirve /api, procesa
// POSTs, y reescribe redirects (Location) correctamente bajo ese
// subpath. Si algún día alguien cambia el cableado interno sin romper
// swRuntime.selfTest.ts (que prueba las funciones puras, no el
// addEventListener real), esto lo va a agarrar.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..", "..");
const publicDir = join(root, "public");

const ORIGIN = "https://usuario.github.io";
const SUBPATH = "/franky-lab/"; // caso GitHub Project Pages real

globalThis.self = globalThis;
self.addEventListener = (evt, fn) => {
  self[`_${evt}`] = self[`_${evt}`] || [];
  self[`_${evt}`].push(fn);
};
self.skipWaiting = () => {};
self.clients = { claim: async () => {} };
// La página vive bajo el subdirectorio -> location.origin sigue siendo
// solo el origin (así lo define la spec), pero el SCOPE (que es lo que
// esta prueba ejercita) queda bajo /franky-lab/.
self.location = { origin: ORIGIN };
self.registration = { scope: ORIGIN + SUBPATH };

const swjs = await readFile(join(publicDir, "sw.js"), "utf8");
const importPath = swjs.match(/import "\.\/(.*)";/)[1].replace(/^_lab\//, "");
await import(join(publicDir, "_lab", importPath));

class FakeRequest {
  constructor(url, method = "GET", body = "") {
    this.url = url;
    this.method = method;
    this._body = body;
  }
  async text() { return this._body; }
}

/** Simula un fetch real a una ruta YA desplegada bajo el subpath (lo que el navegador realmente pide). */
async function fetchSim(deployedPath, method = "GET", body = "") {
  let captured = null;
  for (const fn of self._fetch) {
    await fn({
      request: new FakeRequest(ORIGIN + deployedPath, method, body),
      respondWith: (p) => { captured = p; },
    });
  }
  if (captured === null) return null; // el handler no interceptó -> "estático, lo sirve el host"
  const res = await captured;
  return { status: res.status, body: await res.text(), location: res.headers.get("Location") };
}

let ok = 0, fail = 0;
function check(cond, msg) {
  if (cond) { ok++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗", msg); }
}

console.log("=== Integración: Service Worker real, publicado bajo /franky-lab/ (GitHub Project Pages) ===\n");

const apiRes = await fetchSim(SUBPATH + "api");
check(apiRes !== null, "GET /franky-lab/api fue interceptado por el SW (no cayó a 'estático')");
check(apiRes && apiRes.status === 200, "GET /franky-lab/api respondió 200");
check(apiRes && JSON.parse(apiRes.body).mode === 0, "el body es el JSON real de /api (mode=IDLE al arrancar)");

const wrongScope = await fetchSim("/api"); // pedido SIN el prefijo del subpath -> no pertenece a este scope
check(wrongScope === null, "GET /api (sin el prefijo /franky-lab/) NO es interceptado — fuera del scope real de este SW");

const sumoRes = await fetchSim(SUBPATH + "sumo/mini");
check(sumoRes !== null && sumoRes.status === 200, "GET /franky-lab/sumo/mini (botón real de sumo.html) respondió 200 bajo el subpath");
const apiAfter = await fetchSim(SUBPATH + "api");
check(JSON.parse(apiAfter.body).mode === 2, "tras sumo/mini, /franky-lab/api ya refleja MODE_MINI (mode=2) — el estado real, no solo el 200");

const stopRes = await fetchSim(SUBPATH + "stopall");
check(stopRes !== null, "GET /franky-lab/stopall interceptado");
check(stopRes && stopRes.status === 303, "stopall responde 303 (redirect real del firmware)");
check(stopRes && stopRes.location === SUBPATH, `Location del redirect quedó re-prefijado a '${SUBPATH}' (canónico interno era '/') — vuelve adentro de la app, no a la raíz del dominio (dio '${stopRes && stopRes.location}')`);

const bloquesAddRes = await fetchSim(SUBPATH + "bloques/add?op=90&val=5", "POST");
check(bloquesAddRes !== null && bloquesAddRes.status === 200, "POST /franky-lab/bloques/add (agregar instrucción real) respondió 200 bajo el subpath");

console.log(`\n${ok} pasaron, ${fail} fallaron.`);
if (fail > 0) process.exit(1);
