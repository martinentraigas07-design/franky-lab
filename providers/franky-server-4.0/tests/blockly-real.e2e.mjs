// FRANKY LAB — Test de EJECUCIÓN REAL de Blockly (no un compilador
// propio, no una simulación): carga el bundle REAL de Blockly (los
// mismos bly_core_*.js/bly_blocks.js/bly_js.js/bly_msg.js que sirve el
// LAB), lo ejecuta en un Workspace headless (sin SVG — no hace falta
// para verificar que el XML de cada ejemplo realmente forma bloques),
// registra los bloques FRANKY reales (defBlocks() de bloques.html tal
// cual), y confirma que los 8 ejemplos:
//   1. cargan sin lanzar excepción (Blockly.Xml.domToWorkspace real);
//   2. producen bloques reales en el Workspace (getAllBlocks().length>0);
//   3. cada bloque usado es un tipo realmente definido.
//
// Esto es EXACTAMENTE la prueba que faltaba: las suites anteriores
// probaban el compilador (parseBlock) escrito a mano contra un XML
// parseado a mano — nunca ejecutaban Blockly de verdad. Este archivo sí.
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "..", "assets");
const html = fs.readFileSync(path.join(assetsDir, "bloques.html"), "utf8");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ── 1. Levantar un DOM headless y cargar el Blockly REAL ──────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
const context = dom.getInternalVMContext();
const window = dom.window;
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); // stub — refrescarEstadoOled()/PAGE_ENTER no deben romper el arranque
window.FRANKY_BASE = { rewriteDom() {} };
window.resolveUrl = (x) => x;

const coreChunks = ["bly_core_1.js", "bly_core_2.js", "bly_core_3.js", "bly_core_4.js", "bly_core_5.js"]
  .map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8"));
// Misma técnica EXACTA que fetchChunks() en bloques.html: concatenar los
// 5 fragmentos de 200KB y ejecutarlos como UN SOLO script — cada
// fragmento por separado NO es JS válido (corta a mitad de una cadena),
// por diseño (el Server real los sirve así para caber en SPIFFS).
vm.runInContext("(new Function(" + JSON.stringify(coreChunks.join("")) + "))()", context);
for (const f of ["bly_blocks.js", "bly_js.js", "bly_msg.js"]) {
  vm.runInContext(fs.readFileSync(path.join(assetsDir, f), "utf8"), context, { filename: f });
}
const Blockly = window.Blockly;
assert(typeof Blockly === "object", "el bundle real de Blockly carga y expone window.Blockly");
assert(typeof Blockly.utils.xml.textToDom === "function", "Blockly.utils.xml.textToDom existe (API real de este bundle)");
assert(Blockly.Xml.textToDom === undefined, "Blockly.Xml.textToDom NO existe en este bundle — confirma la causa real del bug reportado");

// ── 2. Extraer y ejecutar el script de bloques.html que define los
//       bloques FRANKY (defBlocks/registrarFieldSprite) y EJEMPLOS ──────
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const targetScript = scripts.find((s) => s.includes("function defBlocks") && s.includes("var EJEMPLOS="));
if (!targetScript) { console.error("No se encontró el script con defBlocks/EJEMPLOS"); process.exit(1); }
vm.runInContext(targetScript, context, { filename: "bloques.html#script" });

// registrarFieldSprite() + defBlocks() — mismo orden que initBlockly() real.
vm.runInContext("registrarFieldSprite(); defBlocks();", context);
const EJEMPLOS = vm.runInContext("EJEMPLOS", context);
assert(EJEMPLOS && Object.keys(EJEMPLOS).length === 8, `EJEMPLOS tiene las 8 claves esperadas (dio ${EJEMPLOS ? Object.keys(EJEMPLOS).length : 0})`);

// ── 3. Para cada ejemplo: cargarlo en un Workspace REAL (headless) con
//       la MISMA función corregida que usa loadEjemplo() en producción ──
const CLAVES = ["vayvuelve", "evasion", "cuadrado", "parpadeo", "holaoled", "spriteoled", "serialsaludo", "combatesimple"];
for (const k of CLAVES) {
  window.__xmlActual = EJEMPLOS[k];
  let nBloques = -1, error = null;
  try {
    nBloques = vm.runInContext(
      `(function(){
         var ws = new Blockly.Workspace();
         var dom = (Blockly.utils.xml.textToDom || Blockly.Xml.textToDom)(window.__xmlActual);
         Blockly.Xml.domToWorkspace(dom, ws);
         return ws.getAllBlocks(false).length;
       })()`,
      context,
    );
  } catch (e) { error = e; }
  assert(error === null, `"${k}": Blockly.Xml.domToWorkspace() NO lanza excepción (error: ${error ? error.message : "ninguno"})`);
  assert(nBloques > 0, `"${k}": el Workspace REAL recibe bloques de verdad (getAllBlocks=${nBloques})`);
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0);
