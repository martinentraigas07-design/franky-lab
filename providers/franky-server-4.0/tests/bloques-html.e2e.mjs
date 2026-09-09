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
const fn = new Function(...Object.keys(sandbox), targetScript + "\nreturn { OP, parseBlock, compileIf, compileWhile, wsToInstructions, EJEMPLOS };");
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
const { OP, parseBlock, compileIf, EJEMPLOS } = extracted;

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

console.log("\n6. FASE 2 (OLED+Blockly): f_oled_sprite genera PUSH x, PUSH y, OP.OLED_SPRITE con bitmap");
{
  const bitmap64 = "f".repeat(64); // sprite lleno (256 px pintados) — fácil de verificar
  const spriteBlock = fakeBlock("f_oled_sprite", { BITMAP: bitmap64, X: 32, Y: 0 });
  const insts = [];
  parseBlock(spriteBlock, insts);
  assert(insts.length === 3, `genera 3 instrucciones: PUSH x, PUSH y, OLED_SPRITE (dio ${insts.length})`);
  assert(insts[0].op === OP.PUSH && insts[0].val === 32, "PUSH x=32");
  assert(insts[1].op === OP.PUSH && insts[1].val === 0, "PUSH y=0");
  assert(insts[2].op === OP.OLED_SPRITE && insts[2].bitmap === bitmap64, "OLED_SPRITE lleva el bitmap del campo BITMAP");
  assert(OP.OLED_SPRITE === 109, `OP.OLED_SPRITE = 109, igual que el firmware real (dio ${OP.OLED_SPRITE})`);
}
{
  const bitmap64 = "8".repeat(64); // 0b1000 en cada nibble -> 1 pixel pintado por fila (col=0), 16 px en total
  const spriteBlock = fakeBlock("f_oled_sprite", { BITMAP: bitmap64, X: 10, Y: 5 });
  const insts = [];
  parseBlock(spriteBlock, insts);
  insts.push({ op: OP.OLED_DISPLAY, val: 0 }); // display.display() real — sin esto, draft nunca pasa a shown
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  for (const i of insts) {
    server.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val), ...(i.bitmap !== undefined ? { bitmap: i.bitmap } : {}) });
  }
  server.handle("GET", "/bloques/run", {});
  for (let t = 0; t < insts.length; t++) server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body;
  assert(lab.oled.shown.length === 1 && lab.oled.shown[0].kind === "sprite", `el sprite llega al framebuffer real (kind=sprite), shown.length=${lab.oled.shown.length}`);
  assert(lab.oled.shown[0].x === 10 && lab.oled.shown[0].y === 5, `coordenadas x/y reales llegan por la pila (dio x=${lab.oled.shown[0].x},y=${lab.oled.shown[0].y})`);
  assert(lab.oled.shown[0].bitmap === bitmap64, "el bitmap (32 bytes / 64 chars hex) llega intacto, no truncado ni reindexado");
}

console.log("\n7. FASE 2: límite real de 8 sprites por programa (TABLA_BITMAP_MAX)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const bitmap = "1".repeat(64);
  for (let i = 0; i < 8; i++) {
    const r = server.handle("GET", "/bloques/add", { op: String(OP.OLED_SPRITE), val: "0", bitmap });
    assert(r.status === 200, `sprite #${i + 1} de 8 se acepta`);
  }
  const r9 = server.handle("GET", "/bloques/add", { op: String(OP.OLED_SPRITE), val: "0", bitmap });
  assert(r9.status === 400, "el sprite #9 se rechaza (400) — mismo límite que tablaBitmap[8] real");
  server.handle("GET", "/bloques/clear", {});
  const rAfterClear = server.handle("GET", "/bloques/add", { op: String(OP.OLED_SPRITE), val: "0", bitmap });
  assert(rAfterClear.status === 200, "tras /bloques/clear la tabla de sprites vuelve a arrancar de cero");
}

console.log("\n8. SESIÓN 1 (auditoría Server-vs-LAB) — los 8 ejemplos de Blockly existen, son XML válido y compilan sin error");
{
  const CLAVES_ESPERADAS = ["vayvuelve", "evasion", "cuadrado", "parpadeo", "holaoled", "spriteoled", "serialsaludo", "combatesimple"];
  assert(EJEMPLOS && typeof EJEMPLOS === "object", "EJEMPLOS existe en bloques.html");
  for (const k of CLAVES_ESPERADAS) {
    assert(typeof EJEMPLOS[k] === "string" && EJEMPLOS[k].length > 0, `el ejemplo "${k}" existe`);
  }

  // Parser mínimo a medida (NO de propósito general) para el subconjunto
  // exacto de XML que usan estos ejemplos: <xml><block><field>...</field>
  // <next><block>...</block></next><statement name="DO"><block>...</block>
  // </statement></block></xml>. Alcanza para convertir el XML real a la
  // misma forma que fakeBlock() ya usa en el resto de este archivo.
  function parsearBloqueXml(xml) {
    let i = 0;
    function leerTag() {
      const m = /^<(\/?)([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/.exec(xml.slice(i));
      if (!m) throw new Error("XML mal formado cerca de: " + xml.slice(i, i + 40));
      i += m[0].length;
      const attrs = {};
      for (const am of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[am[1]] = am[2];
      return { cierre: m[1] === "/", nombre: m[2], attrs, autocerrado: m[4] === "/" };
    }
    function leerTexto() {
      const j = xml.indexOf("<", i);
      const t = xml.slice(i, j);
      i = j;
      return t;
    }
    function parsearBlock() {
      const abre = leerTag(); // <block type="..." ...>
      if (abre.nombre !== "block") throw new Error("se esperaba <block>, vino <" + abre.nombre + ">");
      const fields = {};
      let doBlock = null, nextBlock = null;
      if (!abre.autocerrado) {
        for (;;) {
          if (xml.slice(i, i + 2) === "</") { leerTag(); break; } // </block>
          const t = leerTag();
          if (t.nombre === "field") {
            const texto = leerTexto();
            leerTag(); // </field>
            fields[t.attrs.name] = texto;
          } else if (t.nombre === "next") {
            nextBlock = parsearBlock();
            leerTag(); // </next>
          } else if (t.nombre === "statement") {
            doBlock = parsearBlock();
            leerTag(); // </statement>
          } else {
            throw new Error("tag inesperado: <" + t.nombre + ">");
          }
        }
      }
      return fakeBlock(abre.attrs.type, fields, doBlock, nextBlock);
    }
    leerTag(); // <xml>
    const raiz = parsearBlock();
    return raiz;
  }

  // Tipos de bloque realmente definidos en este bloques.html (evita que
  // un ejemplo referencie un bloque que no existe en ESTE Blockly).
  const tiposDefinidos = new Set([...html.matchAll(/\{type:"(f_[a-z0-9_]+)"/g)].map((m) => m[1]));

  for (const k of CLAVES_ESPERADAS) {
    if (!EJEMPLOS[k]) continue;
    let raiz;
    try {
      raiz = parsearBloqueXml(EJEMPLOS[k]);
    } catch (e) {
      assert(false, `"${k}": XML parseable con la gramática esperada (error: ${e.message})`);
      continue;
    }
    assert(true, `"${k}": XML bien formado (gramática block/field/next/statement)`);

    // Recorrer todo el árbol y verificar que cada "type" exista.
    let faltantes = [];
    (function recorrer(b) {
      if (!b) return;
      if (!tiposDefinidos.has(b.type)) faltantes.push(b.type);
      recorrer(b.getNextBlock());
      recorrer(b.getInputTargetBlock("DO"));
    })(raiz);
    assert(faltantes.length === 0, `"${k}": todos los bloques usados existen en este bloques.html (faltantes: ${faltantes.join(",") || "ninguno"})`);

    // Compilar de punta a punta con el compilador REAL (parseBlock) —
    // no debe tirar excepción, y debe producir al menos una instrucción.
    const insts = [];
    try {
      let b = raiz;
      while (b) { parseBlock(b, insts); b = b.getNextBlock(); }
    } catch (e) {
      assert(false, `"${k}": compila con parseBlock() sin excepción (error: ${e.message})`);
      continue;
    }
    assert(insts.length > 0, `"${k}": genera al menos una instrucción real`);
  }

  // Caso especial: spriteoled debe usar el campo BITMAP (no SPRITE, que
  // es el nombre del Server real — el LAB adaptó el nombre del campo al
  // definir su propio bloque f_oled_sprite en la Fase 2; ver auditoría).
  assert(EJEMPLOS.spriteoled.includes('name="BITMAP"'), 'spriteoled usa el campo "BITMAP" (nombre real del campo en el LAB, no "SPRITE" del Server)');
  assert(!EJEMPLOS.spriteoled.includes('name="SPRITE"'), 'spriteoled NO usa el nombre de campo del Server (evita el mismatch detectado en la auditoría)');
}

console.log("\n9. CORRECCIÓN — TEST A: Blockly vacío NO debe bloquear OLED con un falso conflicto");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/panel/save", { i2c: "1" });
  // Estado fresco: nunca se cargó ni ejecutó nada en Bloques.
  const r = server.handle("GET", "/oled/test", { size: "96" });
  assert(r.status === 200, "con Bloques nunca usado, /oled/test NO da falso conflicto (workspace vacío = sin programa)");
}

console.log("\n10. CORRECCIÓN — TEST F: detener/limpiar Blockly libera el recurso OLED (sin estado stale)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/panel/save", { i2c: "1" });
  // Cargar y ejecutar un programa que usa OLED (simula holaoled).
  server.handle("GET", "/bloques/add", { op: String(OP.OLED_CLEAR), val: "0" });
  server.handle("GET", "/bloques/run", {});
  const conConflicto = server.handle("GET", "/oled/test", { size: "96" });
  assert(conConflicto.status === 409, "con Bloques REALMENTE corriendo un programa OLED, SÍ hay conflicto (esto es correcto, no es un bug)");
  // Detener Y limpiar (mismo flujo que ahora hace clearWs()/Detener en bloques.html).
  server.handle("GET", "/bloques/stop", {});
  server.handle("GET", "/bloques/clear", {});
  const sinConflicto = server.handle("GET", "/oled/test", { size: "96" });
  assert(sinConflicto.status === 200, "tras detener+limpiar, el recurso OLED queda liberado — sin estado stale");
}

console.log("\n11. CORRECCIÓN — bloquesRun() rechaza un programa vacío (nunca queda 'ejecutando' sin nada real)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const r = server.handle("GET", "/bloques/run", {});
  assert(r.status === 400, "/bloques/run con programa vacío responde 400, no arranca una ejecución fantasma");
}

console.log("\n12. CORRECCIÓN — TEST C/D: cargar y EJECUTAR holaoled/spriteoled produce respuesta real en el OLED virtual");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/panel/save", { i2c: "1" });
  const holaoled = fakeBlock("f_oled_clear", {}, null, fakeBlock("f_oled_text", { COL: "0", FILA: "0", TXT: "FRANKY 4.0" }, null, fakeBlock("f_oled_text", { COL: "0", FILA: "1", TXT: "Hola Mundo" }, null, fakeBlock("f_oled_show", {}, null, null))));
  const insts1 = [];
  let b = holaoled; while (b) { parseBlock(b, insts1); b = b.getNextBlock(); }
  for (const i of insts1) server.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val), ...(i.txt !== undefined ? { txt: i.txt } : {}) });
  server.handle("GET", "/bloques/run", {});
  for (let i = 0; i < insts1.length + 2; i++) server.tick();
  const lab1 = server.handle("GET", "/lab/state", {}).body;
  assert(lab1.oled.shown.some((e) => e.kind === "text" && e.text === "Hola Mundo"), "holaoled: el texto real aparece en el OLED virtual tras Ejecutar");
  server.handle("GET", "/bloques/stop", {}); server.handle("GET", "/bloques/clear", {});

  const bitmap = "f".repeat(64);
  const spriteoled = fakeBlock("f_oled_clear", {}, null, fakeBlock("f_oled_sprite", { X: "32", Y: "0", BITMAP: bitmap }, null, fakeBlock("f_oled_show", {}, null, null)));
  const insts2 = [];
  b = spriteoled; while (b) { parseBlock(b, insts2); b = b.getNextBlock(); }
  for (const i of insts2) server.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val), ...(i.bitmap !== undefined ? { bitmap: i.bitmap } : {}) });
  server.handle("GET", "/bloques/run", {});
  for (let i = 0; i < insts2.length + 2; i++) server.tick();
  const lab2 = server.handle("GET", "/lab/state", {}).body;
  assert(lab2.oled.shown.some((e) => e.kind === "sprite" && e.bitmap === bitmap), "spriteoled: el sprite real aparece en el OLED virtual tras Ejecutar");
}

console.log(`\n${ok} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0); // el script extraído incluye un setInterval real (monitor de sensores) que mantendría vivo el proceso para siempre si no forzamos la salida
