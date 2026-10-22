// TP5 Actividad 13 (programación no bloqueante con millis()) — prueba de
// EJECUCIÓN REAL de Blockly, misma técnica que blockly-real.e2e.mjs: carga
// el bundle real de Blockly + el script real de bloques.html (defBlocks(),
// wsToInstructions()) en un Workspace headless, y compila un programa real
// armado con los bloques tal cual quedan en el toolbox hoy.
//
// Esto es justo lo que faltaba antes de esta corrección: todas las pruebas
// anteriores de "millis()" habrían podido pasar igual con el bug real
// (compileExpr sin case para "f_millis" -> push 0 constante), porque
// probaban el intérprete con instrucciones armadas a mano, nunca el
// COMPILADOR real. Este archivo compila de verdad.
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

console.log("1. El toolbox tiene 'f_millis' en la categoría Tiempo, no en Sensores");
{
  const sensoresCat = html.match(/<category name="Sensores"[\s\S]*?<\/category>/);
  const tiempoCat = html.match(/<category name="Tiempo"[\s\S]*?<\/category>/);
  assert(!!sensoresCat && !sensoresCat[0].includes('type="f_millis"'), "la categoría Sensores ya NO contiene f_millis");
  assert(!!tiempoCat && tiempoCat[0].includes('type="f_millis"'), "la categoría Tiempo SÍ contiene f_millis");
}

// ── Levantar Blockly real + el script real de bloques.html (misma técnica que blockly-real.e2e.mjs) ──
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only" });
const context = dom.getInternalVMContext();
const window = dom.window;
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
window.FRANKY_BASE = { rewriteDom() {} };
window.resolveUrl = (x) => x;

const coreChunks = ["bly_core_1.js", "bly_core_2.js", "bly_core_3.js", "bly_core_4.js", "bly_core_5.js"]
  .map((f) => fs.readFileSync(path.join(assetsDir, f), "utf8"));
vm.runInContext("(new Function(" + JSON.stringify(coreChunks.join("")) + "))()", context);
for (const f of ["bly_blocks.js", "bly_js.js", "bly_msg.js"]) {
  vm.runInContext(fs.readFileSync(path.join(assetsDir, f), "utf8"), context, { filename: f });
}
const Blockly = window.Blockly;

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const targetScript = scripts.find((s) => s.includes("function defBlocks") && s.includes("var EJEMPLOS="));
const spriteScript = scripts.find((s) => s.includes("function registrarFieldSprite") && s !== targetScript);
vm.runInContext(targetScript, context, { filename: "bloques.html#script" });
vm.runInContext(spriteScript, context, { filename: "bloques.html#script(sprite)" });
vm.runInContext("registrarFieldSprite(); defBlocks();", context);

/** Compila un XML de Blockly real con el compilador real (wsToInstructions) y devuelve las instrucciones. */
function compilarXml(xml) {
  context.__xmlActual = xml;
  return vm.runInContext(
    `(function(){
       workspace = new Blockly.Workspace();
       var dom = (Blockly.utils.xml.textToDom || Blockly.Xml.textToDom)(__xmlActual);
       Blockly.Xml.domToWorkspace(dom, workspace);
       return wsToInstructions();
     })()`,
    context,
  );
}

console.log("\n2. 'millis()' suelto (variables_set tiempoActual = millis()) compila al opcode real (94), NO a la constante 0 del bug reportado");
{
  const xml = '<xml><block type="variables_set"><field name="VAR">tiempoActual</field><value name="VALUE"><block type="f_millis"></block></value></block></xml>';
  const instrs = compilarXml(xml);
  const push94 = instrs.find((i) => i.op === 94);
  assert(!!push94, `el programa compilado contiene el opcode 94 (PUSH_MILLIS) — instrucciones: ${JSON.stringify(instrs)}`);
  const push0Fijo = instrs.some((i) => i.op === 90 && i.val === 0);
  assert(!push0Fijo, "NO aparece un PUSH(90) de valor 0 en lugar de millis() (ese era el bug: compileExpr() sin case -> default -> push 0)");
}

console.log("\n3. 'millis()' se conecta dentro de una expresión completa: variables_set tiempoActual = millis() - tiempoAnterior, comparada con intervalo (controls_if + logic_compare GTE)");
{
  const xml = `<xml>
    <block type="variables_set" id="b1"><field name="VAR">tiempoAnterior</field><value name="VALUE"><block type="math_number"><field name="NUM">0</field></block></value>
    <next><block type="controls_if" id="b2">
      <value name="IF0"><block type="logic_compare"><field name="OP">GTE</field>
        <value name="A"><block type="math_arithmetic"><field name="OP">MINUS</field>
          <value name="A"><block type="f_millis"></block></value>
          <value name="B"><block type="variables_get"><field name="VAR">tiempoAnterior</field></block></value>
        </block></value>
        <value name="B"><block type="math_number"><field name="NUM">500</field></block></value>
      </block></value>
      <statement name="DO0"><block type="f_led_on"></block></statement>
    </block></next>
    </block>
  </xml>`;
  const instrs = compilarXml(xml);
  assert(instrs.some((i) => i.op === 94), "la expresión 'millis() - tiempoAnterior >= 500' emite PUSH_MILLIS(94)");
  assert(instrs.some((i) => i.op === 79), "...y POP_SUB(79) para la resta");
  assert(instrs.some((i) => i.op === 126), "...y el salto condicional IF_GE_EXPR(126) para el '>=' directo del 'si'");
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0);
