// Extrae OP/parseBlock/compileIf/compileWhile TAL COMO ESTÁN en el
// bloques.html real (no una copia a mano que se pueda desincronizar), los
// ejecuta contra bloques Blockly falsos, y alimenta el resultado al
// intérprete real compilado — mismo rigor que el resto de la Fase 3.
import { readFileSync } from "node:fs";
import { createProviderServer } from "../../../dist/providers/franky-server-4.0/server/virtualServer.js";
import { StubHAL } from "../../../dist/core/src/stubHal.js";

const html = readFileSync(new URL("../assets/bloques.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// El segundo <script> del archivo es el que define OP/parseBlock/etc (el
// primero solo carga los chunks de Blockly desde SPIFFS).
const targetScript = scripts.find((s) => s.includes("function parseBlock"));
if (!targetScript) throw new Error("No se encontró parseBlock en bloques.html — ¿cambió la estructura del archivo?");

// Sandbox mínimo: solo lo que este script realmente toca en su nivel
// superior antes de definir las funciones que nos interesan.
// FRANKY_BASE/resolveUrl: el script real llama a FRANKY_BASE.rewriteDom()
// y resolveUrl() a nivel superior (infraestructura de portabilidad de
// despliegue, ver base.js) — acá no importa el resultado, solo que no
// revienten fuera de un navegador real.
const sandbox = {
  console,
  FRANKY_BASE: { rewriteDom: () => {}, resolveUrl: (s) => s, resolvePath: (s) => s, root: "/" },
  resolveUrl: (s) => s,
};
const fn = new Function(...Object.keys(sandbox), targetScript + "\nreturn { OP, parseBlock, compileIf, compileWhile, wsToInstructions };");
// El script real llama a workspace.getTopBlocks(...) dentro de wsToInstructions,
// y algunas funciones tocan `document`/`workspace` globales fuera de lo que
// nos interesa testear — como new Function ejecuta en su propio scope y
// esas partes no se llaman en nuestros tests, alcanza con exponer un
// `workspace` mínimo si hiciera falta más adelante.
let extracted;
try {
  extracted = fn.call(sandbox, ...Object.values(sandbox));
} catch (e) {
  throw new Error("No se pudo extraer/ejecutar el script de bloques.html: " + e.message);
}
const { OP, parseBlock, compileIf } = extracted;

function fakeBlock(type, fields, doBlock, nextBlock) {
  return {
    type,
    getFieldValue: (name) => fields[name],
    getInputTargetBlock: (name) => (name === "DO" ? doBlock || null : null),
    getNextBlock: () => nextBlock || null,
  };
}

let ok = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { ok++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗", msg); }
}

function runOnRealInterpreter(insts, ticks) {
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  for (const i of insts) server.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val) });
  server.handle("GET", "/bloques/run", {});
  for (let t = 0; t < ticks; t++) server.tick();
  return { hal, lab: server.handle("GET", "/lab/state", {}).body };
}

console.log("1. FIX real de bloques.html: 'si ADC0>umbral entonces [A,B]' — AMBAS instrucciones deben condicionarse");
{
  // Cuerpo de DOS instrucciones: VAR_SET 111, VAR_ADD 1 (antes del fix,
  // solo VAR_SET se condicionaba; VAR_ADD se ejecutaba siempre).
  const varSet = fakeBlock("f_var_set", { VAR: "x", VAL: 111 });
  const varAdd = fakeBlock("f_var_add", { VAR: "x", VAL: 1 });
  varSet.getNextBlock = () => varAdd; // encadena dentro del "entonces"
  const ifBlock = fakeBlock("f_if_gt", { UMBRAL: 5000 }, varSet); // ADC0 default (StubHAL) no supera 5000 -> condición FALSA
  const insts = [];
  parseBlock(ifBlock, insts);
  insts.push({ op: OP.FIN, val: 0 });

  const { lab } = runOnRealInterpreter(insts, insts.length + 1);
  assert(lab.varGlobal === 0, `condición falsa -> NINGUNA instrucción del cuerpo corrió (varGlobal=${lab.varGlobal}, antes del fix hubiera dado algo distinto de 0 solo si VAR_SET se saltaba pero VAR_ADD igual corría)`);
}
{
  const varSet = fakeBlock("f_var_set", { VAR: "x", VAL: 100 });
  const varAdd = fakeBlock("f_var_add", { VAR: "x", VAL: 1 });
  varSet.getNextBlock = () => varAdd;
  const ifBlock = fakeBlock("f_if_gt", { UMBRAL: 100 }); // umbral bajo -> con StubHAL default (ADC0=0) sigue sin cumplirse; forzamos con setAnalog
  ifBlock.getInputTargetBlock = (n) => (n === "DO" ? varSet : null);
  const insts = [];
  compileIf(ifBlock, OP.IF_GT, insts);
  insts.push({ op: OP.FIN, val: 0 });

  const hal = new StubHAL();
  hal.setAnalog(0, 5000); // ahora SÍ supera el umbral
  const server = createProviderServer(hal);
  for (const i of insts) server.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val) });
  server.handle("GET", "/bloques/run", {});
  for (let t = 0; t < 3; t++) server.tick(); // exactos: IF_GT, VAR_SET, VAR_ADD — sin llegar a FIN (que reinicia el programa)
  const lab = server.handle("GET", "/lab/state", {}).body;
  assert(lab.varGlobal === 101, `condición verdadera -> AMBAS instrucciones del cuerpo corrieron (100 luego +1 = 101, dio ${lab.varGlobal}) — antes del fix la segunda se hubiera ejecutado SIEMPRE de todas formas, pero acá probamos que ahora corren juntas, condicionadas de verdad`);
}

console.log("\n2. FIX real: 'mientras ADC0>umbral' ahora SÍ genera instrucciones (antes: caía en 'default', se ignoraba)");
{
  const body = fakeBlock("f_adelante", { VEL: 100 });
  const whileBlock = fakeBlock("f_while_gt", { UMBRAL: 100 });
  whileBlock.getInputTargetBlock = (n) => (n === "DO" ? body : null);
  const insts = [];
  parseBlock(whileBlock, insts);
  assert(insts.length > 0, `antes del fix esto daba 0 instrucciones (bloque ignorado) — ahora genera ${insts.length}`);
}

console.log("\n3. FIX real: f_oled_text ahora SÍ genera opcodes reales (antes: solo C++, 'Ejecutar' no hacía nada)");
{
  const oledClear = fakeBlock("f_oled_clear", {});
  const oledText = fakeBlock("f_oled_text", { COL: 0, FILA: 0, TXT: "FRANKY" });
  const oledShow = fakeBlock("f_oled_show", {});
  oledClear.getNextBlock = () => oledText;
  oledText.getNextBlock = () => oledShow;
  const insts = [];
  parseBlock(oledClear, insts);
  assert(insts.length > 0, `antes del fix esto daba 0 instrucciones (bloque OLED ignorado al 'Ejecutar') — ahora genera ${insts.length}`);
}
{
  const oledClear = fakeBlock("f_oled_clear", {});
  const oledText = fakeBlock("f_oled_text", { COL: 2, FILA: 1, TXT: "FRANKY" });
  const oledShow = fakeBlock("f_oled_show", {});
  oledClear.getNextBlock = () => oledText;
  oledText.getNextBlock = () => oledShow;
  const insts = [];
  parseBlock(oledClear, insts);

  const hal2 = new StubHAL();
  const server2 = createProviderServer(hal2);
  for (const i of insts) server2.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val), ...(i.txt !== undefined ? { txt: i.txt } : {}) });
  server2.handle("GET", "/bloques/run", {});
  for (let t = 0; t < insts.length; t++) server2.tick();
  const lab2 = server2.handle("GET", "/lab/state", {}).body;
  assert(lab2.oled.on === true, "OLED se inicializó de verdad");
  assert(lab2.oled.shown.length === 1 && lab2.oled.shown[0].text === "FRANKY", "el texto llega al framebuffer real, con la posición correcta (col*6, fila*8)");
  assert(lab2.oled.shown[0].x === 12 && lab2.oled.shown[0].y === 8, `posición exacta col=2*6=12, fila=1*8=8 (dio x=${lab2.oled.shown[0].x},y=${lab2.oled.shown[0].y})`);
}

console.log("\n4. FIX real: f_serial_print ahora SÍ genera un opcode real (antes: solo C++)");
{
  const serialBlock = fakeBlock("f_serial_print", { MSG: "Hola FRANKY" });
  const insts = [];
  parseBlock(serialBlock, insts);
  assert(insts.length === 1 && insts[0].op === OP.SERIAL_PRINT, "genera exactamente OP.SERIAL_PRINT");

  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/bloques/add", { op: String(insts[0].op), val: "0", txt: insts[0].txt });
  server.handle("GET", "/bloques/run", {});
  server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body;
  assert(lab.serialLog.includes("Hola FRANKY"), "el mensaje llega al Monitor Serie real");
}

console.log("\n5. Bloque nuevo: f_buzzer genera el opcode real con frecuencia/duración correctas");
{
  const buzzerBlock = fakeBlock("f_buzzer", { FREQ: 880, DUR: 300 });
  const insts = [];
  parseBlock(buzzerBlock, insts);
  const { lab } = runOnRealInterpreter(insts, insts.length);
  assert(lab.buzzerFreqHz === 880 && lab.buzzerDurationMs === 300, `freq=880Hz dur=300ms (dio ${lab.buzzerFreqHz}/${lab.buzzerDurationMs})`);
}

console.log(`\n${ok} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0); // el script extraído incluye un setInterval real (monitor de sensores) que mantendría vivo el proceso para siempre si no forzamos la salida
