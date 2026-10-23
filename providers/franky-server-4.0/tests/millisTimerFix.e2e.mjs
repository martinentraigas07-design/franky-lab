// "CLAUDE — DIAGNÓSTICO Y CORRECCIÓN DE TEMPORIZADORES millis() EN
// FRANKY-LAB Y FRANKY SERVER" — Pruebas 1 a 9 del enunciado.
//
// Compila programas Blockly REALES con el compilador real
// (wsToInstructions()) y los corre sobre el intérprete real
// (FirmwareRuntime) con un reloj simulado controlable (StubHAL.advance()),
// misma técnica que setupLoop.e2e.mjs / millisNoBloqueante.e2e.mjs /
// millis-compiler.e2e.mjs. Cubre la corrección de las causas raíz
// confirmadas de los Síntomas A, B, C y D (ver informe técnico):
//   - OP_POP_SUB_T (89): "millis() - variable" ahora ENVUELVE en 16 bits
//     en vez de SATURAR (Síntomas A/B) — case 89 en runtime.ts/.ino.
//   - parsePostBody() en swRuntime.ts: parsea el body de POST según el
//     Content-Type real (Síntoma D, /bloques/xml -> 400) — probado por
//     separado en swRuntime.selfTest.ts (no requiere Blockly).
//   - actualizarEstadoWorkspace() en bloques.html: fallback a /api
//     cuando /runtime/estado no existe (Síntoma D, 404) — probado acá
//     como verificación ESTRUCTURAL del código fuente (no hay DOM/fetch
//     real en este archivo).
//   - Heartbeat dedicado (~20ms) en bloques.html, independiente del
//     polling de UI (Síntoma C) — probado acá como verificación
//     ESTRUCTURAL (el mecanismo en sí depende de un Service Worker real
//     en un navegador real, fuera del alcance de este harness Node).
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StubHAL } from "../../../dist/core/src/stubHal.js";
import { FirmwareRuntime } from "../../../dist/providers/franky-server-4.0/firmware/runtime.js";
import { defaultFirmwareModel } from "../../../dist/providers/franky-server-4.0/firmware/model.js";
import { PIN } from "../../../dist/providers/franky-server-4.0/firmware/motorControl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "..", "assets");
const html = fs.readFileSync(path.join(assetsDir, "bloques.html"), "utf8");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ── Blockly real headless (misma técnica que los demás *.e2e.mjs) ──
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
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const targetScript = scripts.find((s) => s.includes("function defBlocks") && s.includes("var EJEMPLOS="));
const spriteScript = scripts.find((s) => s.includes("function registrarFieldSprite") && s !== targetScript);
vm.runInContext(targetScript, context, { filename: "bloques.html#script" });
vm.runInContext(spriteScript, context, { filename: "bloques.html#script(sprite)" });
vm.runInContext("registrarFieldSprite(); defBlocks(); defGenerators();", context);

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
function guardarYRecuperar(xml) {
  context.__xmlActual = xml;
  return vm.runInContext(
    `(function(){
       workspace = new Blockly.Workspace();
       var dom1 = (Blockly.utils.xml.textToDom || Blockly.Xml.textToDom)(__xmlActual);
       Blockly.Xml.domToWorkspace(dom1, workspace);
       var xmlGuardado = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
       workspace = new Blockly.Workspace();
       var dom2 = (Blockly.utils.xml.textToDom || Blockly.Xml.textToDom)(xmlGuardado);
       Blockly.Xml.domToWorkspace(dom2, workspace);
       return {xmlGuardado: xmlGuardado, instrs: wsToInstructions()};
     })()`,
    context,
  );
}
function nuevoRuntime() {
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  return { runtime, hal };
}
function cargarYArrancar(runtime, instrs) {
  for (const i of instrs) {
    const r = runtime.bloquesAdd(i.op, i.val, i.txt, i.bitmap);
    if (!r.ok) throw new Error("bloquesAdd() falló: " + r.error);
  }
  const r = runtime.bloquesRun();
  if (!r.ok) throw new Error("bloquesRun() falló: " + r.error);
}
// Ver comentario completo en setupLoop.e2e.mjs: progPC vuelve a 0 solo en
// modo "legacy" (sin Al iniciar/Repetir continuamente); en modo
// estructurado OP_FIN apunta a loopStartIdx, así que una "vuelta
// completa" se detecta por progPC === finIdx justo ANTES de ejecutar esa
// instrucción (OP_FIN siempre es la última del array compilado).
function avanzarFrame(runtime, hal, ms, instrs) {
  const finIdx = instrs.length - 1;
  hal.advance(ms);
  let guard = 0;
  while (true) {
    const pcAntesDeTick = runtime.model.progPC;
    runtime.tick();
    if (++guard > 20000) throw new Error("avanzarFrame: OP_FIN nunca se ejecutó tras 20000 ticks");
    if (pcAntesDeTick === finIdx) break;
  }
}
function encadenar(...bloques) {
  let resultado = "";
  for (let i = bloques.length - 1; i >= 0; i--) {
    const cierre = resultado ? `<next>${resultado}</next></block>` : "</block>";
    resultado = bloques[i].replace(/<\/block>\s*$/, cierre);
  }
  return resultado;
}
function alIniciar(...a) { return `<block type="f_al_iniciar"><statement name="DO">${encadenar(...a)}</statement></block>`; }
function repetirSiempre(...a) { return `<block type="f_repetir_siempre"><statement name="DO">${encadenar(...a)}</statement></block>`; }
function varSet(n, v) { return `<block type="variables_set"><field name="VAR">${n}</field><value name="VALUE">${v}</value></block>`; }
function num(n) { return `<block type="math_number"><field name="NUM">${n}</field></block>`; }
function varGet(n) { return `<block type="variables_get"><field name="VAR">${n}</field></block>`; }
function serialPrintVar(v) { return `<block type="f_serial_print_var"><value name="VAL">${v}</value></block>`; }
function siIntervaloCumplido(varAnteriorNombre, intervaloMs, cuerpoXml) {
  return `<block type="controls_if">
    <value name="IF0"><block type="logic_compare"><field name="OP">GTE</field>
      <value name="A"><block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A"><block type="f_millis"></block></value>
        <value name="B">${varGet(varAnteriorNombre)}</value>
      </block></value>
      <value name="B">${num(intervaloMs)}</value>
    </block></value>
    <statement name="DO0">${cuerpoXml}</statement>
  </block>`;
}
function ifLedDesdeEstado() {
  return `<block type="controls_if">
    <mutation else="1"></mutation>
    <value name="IF0"><block type="logic_compare"><field name="OP">NEQ</field>
      <value name="A">${varGet("estadoLED")}</value>
      <value name="B">${num(0)}</value>
    </block></value>
    <statement name="DO0"><block type="f_led_on"></block></statement>
    <statement name="ELSE"><block type="f_led_off"></block></statement>
  </block>`;
}

console.log("=== Prueba 0 — Verificación estructural de las correcciones de Síntomas C y D en bloques.html ===");
{
  assert(
    /fetch\("\/runtime\/estado"\)[\s\S]{0,40}function\(r\)\{\s*if\(!r\.ok\)/.test(html),
    "actualizarEstadoWorkspace(): /runtime/estado se intenta primero y se detecta explícitamente si NO responde bien (r.ok)",
  );
  assert(
    /\.catch\(function\(\)\{\s*return fetch\("\/api"\)/.test(html),
    "...y cae a /api como fallback cuando /runtime/estado falla (Síntoma D, 404 en el LAB) — sin tocar el camino real del hardware",
  );
  assert(
    /progLen:\s*d\.proglen,\s*ejecutando:\s*!!d\.running,\s*modoTexto:\s*d\.modoTexto === "BLOQUES" \? "BLOCKLY"/.test(html),
    "el fallback adapta los nombres de campo de /api (proglen/running/modoTexto='BLOQUES') al mismo shape que ya espera el resto de la función",
  );
  assert(
    /setInterval\(function\(\)\{\s*var controller = \("serviceWorker" in navigator\) && navigator\.serviceWorker\.controller;\s*if \(controller\) controller\.postMessage\(\{ type: "FRANKY_LAB_REQUEST_STATE" \}\);\s*\}, 20\);/.test(html),
    "existe un heartbeat dedicado de ~20ms (independiente del polling de UI existente) que dispara pumpClock() vía postMessage — corrección de Síntoma C",
  );
}

console.log("\n=== Prueba 1 — Alternancia simple de variable (sin LED, sin millis()) ===");
{
  const xml = `<xml>${alIniciar(varSet("estadoLED", num(0)))}${repetirSiempre(
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
    serialPrintVar(varGet("estadoLED")),
  )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  const secuencia = [];
  for (let i = 0; i < 6; i++) {
    avanzarFrame(runtime, hal, 10, instrs);
    secuencia.push(runtime.model.serialLog[runtime.model.serialLog.length - 1]);
  }
  assert(JSON.stringify(secuencia) === JSON.stringify(["1", "0", "1", "0", "1", "0"]), `secuencia 1,0,1,0,... (dio ${JSON.stringify(secuencia)})`);
}

console.log("\n=== Prueba 2 — Temporizador de 3000ms con millis() (tiempos reales y desviación) ===");
{
  const cuerpoSi = encadenar(
    varSet("tiempoAnterior", `<block type="f_millis"></block>`),
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
    serialPrintVar(varGet("tiempoAnterior")),
    serialPrintVar(varGet("estadoLED")),
    ifLedDesdeEstado(),
  );
  const xml = `<xml>${alIniciar(varSet("tiempoAnterior", num(0)), varSet("estadoLED", num(0)))}${repetirSiempre(
    siIntervaloCumplido("tiempoAnterior", 3000, cuerpoSi),
  )}</xml>`;
  const instrs = compilarXml(xml);
  assert(instrs.some((i) => i.op === 89), "la resta 'millis() - tiempoAnterior' compila a POP_SUB_T(89), no POP_SUB(79)");
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  let ultimoT = 0;
  const deltas = [];
  let ultimoLed = null;
  for (let t = 0; t < 15000; ) {
    avanzarFrame(runtime, hal, 20, instrs);
    t += 20;
    const led = hal.getDigital(PIN.led ?? 8);
    if (ultimoLed !== null && led !== ultimoLed) {
      deltas.push(t - ultimoT);
      ultimoT = t;
    }
    ultimoLed = led;
  }
  assert(deltas.length >= 4, `al menos 4 cambios de LED en 15s a ~3000ms (dio ${deltas.length}: ${JSON.stringify(deltas)})`);
  const desviacionMax = Math.max(...deltas.slice(1).map((d) => Math.abs(d - 3000)));
  assert(desviacionMax <= 100, `desviación respecto a 3000ms <= 100ms, uno o dos ticks de 20ms (máxima desviación medida: ${desviacionMax}ms, deltas=${JSON.stringify(deltas)})`);
}

console.log("\n=== Prueba 3 — El LED (físico/simulado, vía hal.digitalWrite) sigue fielmente a estadoLED ===");
{
  const cuerpoSi = encadenar(
    varSet("tiempoAnterior", `<block type="f_millis"></block>`),
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
    ifLedDesdeEstado(),
  );
  const xml = `<xml>${alIniciar(varSet("tiempoAnterior", num(0)), varSet("estadoLED", num(0)))}${repetirSiempre(
    siIntervaloCumplido("tiempoAnterior", 300, cuerpoSi),
  )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  let desincronizaciones = 0;
  for (let i = 0; i < 40; i++) {
    avanzarFrame(runtime, hal, 50, instrs);
    const estadoLED = runtime.model.varTabla[1]; // orden de declaración: tiempoAnterior=0, estadoLED=1
    const ledDigital = hal.getDigital(PIN.led ?? 8);
    // digitalWrite(PIN.led, 0) = encendido (activo bajo, ver OP_LED_ON case 7); estadoLED!=0 -> encendido -> ledDigital debe ser 0
    const esperado = estadoLED !== 0 ? 0 : 1;
    if (ledDigital !== esperado) desincronizaciones++;
  }
  assert(desincronizaciones === 0, `el pin del LED coincide con estadoLED en las 40 muestras (desincronizaciones=${desincronizaciones})`);
}

console.log("\n=== Prueba 4 — Duración prolongada (>=120s), cruzando los límites de 16 bits varias veces ===");
{
  const cuerpoSi = encadenar(
    varSet("tiempoAnterior", `<block type="f_millis"></block>`),
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
    ifLedDesdeEstado(),
  );
  const xml = `<xml>${alIniciar(varSet("tiempoAnterior", num(0)), varSet("estadoLED", num(0)))}${repetirSiempre(
    siIntervaloCumplido("tiempoAnterior", 3000, cuerpoSi),
  )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  let cambios = 0, ultimoLed = null, ultimoT = 0;
  const deltas = [];
  const DURACION_MS = 130000; // > 120s pedidos, cruza 32768/65536/98304/131072 varias veces
  for (let t = 0; t < DURACION_MS; ) {
    avanzarFrame(runtime, hal, 20, instrs);
    t += 20;
    const led = hal.getDigital(PIN.led ?? 8);
    if (ultimoLed !== null && led !== ultimoLed) {
      cambios++;
      deltas.push(t - ultimoT);
      ultimoT = t;
    }
    ultimoLed = led;
  }
  assert(cambios >= 40, `al menos 40 cambios de LED en 130s a ~3000ms sin interrupción (dio ${cambios})`);
  const sinDeltaInicial = deltas.slice(1);
  const maxDelta = Math.max(...sinDeltaInicial);
  const minDelta = Math.min(...sinDeltaInicial);
  assert(maxDelta <= 3100 && minDelta >= 2900, `todos los deltas entre 2900-3100ms incluso cruzando los límites de 16 bits (min=${minDelta}, max=${maxDelta})`);
  assert(Number.isFinite(runtime.model.varTabla[0]) && Number.isFinite(runtime.model.varTabla[1]), "varTabla sigue con valores numéricos finitos tras 130s (sin NaN/Infinity)");
}

console.log("\n=== Prueba 5 — Dos temporizadores independientes (500ms y 100ms) sin bloquearse mutuamente ===");
{
  const cuerpo1 = varSet("contadorLED", `<block type="math_arithmetic"><field name="OP">ADD</field>
      <value name="A">${varGet("contadorLED")}</value><value name="B">${num(1)}</value></block>`);
  const cuerpo2 = varSet("contadorLectura", `<block type="math_arithmetic"><field name="OP">ADD</field>
      <value name="A">${varGet("contadorLectura")}</value><value name="B">${num(1)}</value></block>`);
  const xml = `<xml>${alIniciar(
      varSet("tAnt1", num(0)), varSet("contadorLED", num(0)),
      varSet("tAnt2", num(0)), varSet("contadorLectura", num(0)),
    )}${repetirSiempre(
      siIntervaloCumplido("tAnt1", 500, encadenar(varSet("tAnt1", `<block type="f_millis"></block>`), cuerpo1)),
      siIntervaloCumplido("tAnt2", 100, encadenar(varSet("tAnt2", `<block type="f_millis"></block>`), cuerpo2)),
    )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  for (let i = 0; i < 40; i++) avanzarFrame(runtime, hal, 50, instrs); // 40*50ms = 2000ms
  // Orden de declaración de variables (slots 0-3): tAnt1, contadorLED, tAnt2, contadorLectura
  assert(runtime.model.varTabla[1] === 4, `temporizador de 500ms disparó 4 veces en 2000ms (dio ${runtime.model.varTabla[1]})`);
  assert(runtime.model.varTabla[3] === 20, `temporizador de 100ms disparó 20 veces en 2000ms, SIN que el de 500ms lo bloqueara (dio ${runtime.model.varTabla[3]})`);
}

console.log("\n=== Prueba 6 — 'Al iniciar' corre UNA sola vez; 'Repetir continuamente' no reinicializa variables ===");
{
  const cuerpoSi = encadenar(
    varSet("tiempoAnterior", `<block type="f_millis"></block>`),
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
  );
  const xml = `<xml>${alIniciar(varSet("tiempoAnterior", num(0)), varSet("estadoLED", num(0)))}${repetirSiempre(
    siIntervaloCumplido("tiempoAnterior", 100, cuerpoSi),
  )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  assert(runtime.model.progPC === 0, "tras 'Ejecutar', progPC arranca en 0 ('Al iniciar')");
  for (let i = 0; i < 30; i++) avanzarFrame(runtime, hal, 50, instrs); // 30*50=1500ms -> 15 disparos de 100ms
  assert(runtime.model.varTabla[0] >= 1400, `tiempoAnterior NO volvió a 0 en ninguna vuelta (quedó en ${runtime.model.varTabla[0]}, cercano a los 1500ms de uptime simulado) — 'Al iniciar' no se re-ejecutó`);
}

console.log("\n=== Prueba 7 — Compatibilidad: programas anteriores (con 'Esperar'/bloqueante, y resta genérica sin millis()) siguen funcionando igual ===");
{
  // Resta genérica (NO millis()) sigue usando OP_POP_SUB(79), que SATURA
  // como siempre — no se tocó ese comportamiento para nada que no sea el
  // patrón específico "millis() - variable".
  const xmlRestaGenerica = `<xml>${alIniciar()}${repetirSiempre(
    varSet("r", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(5000)}</value><value name="B">${num(40000)}</value></block>`),
  )}</xml>`;
  const instrsResta = compilarXml(xmlRestaGenerica);
  assert(instrsResta.some((i) => i.op === 79), "una resta genérica (sin f_millis como operando A) sigue emitiendo POP_SUB(79)");
  assert(!instrsResta.some((i) => i.op === 89), "...y NUNCA POP_SUB_T(89) si ninguno de los dos lados es f_millis()");
  const { runtime: rtResta, hal: halResta } = nuevoRuntime();
  cargarYArrancar(rtResta, instrsResta);
  avanzarFrame(rtResta, halResta, 10, instrsResta);
  assert(rtResta.model.varTabla[0] === -32768, `5000-40000=-35000 sigue SATURANDO a -32768 (comportamiento histórico sin cambios, dio ${rtResta.model.varTabla[0]})`);

  // Programa con bloque "Esperar" (f_esperar, bloqueante) + millis() suelto
  // (sin Al iniciar/Repetir continuamente, estilo "legacy") — mismo patrón
  // que ya cubría millisNoBloqueante.e2e.mjs, re-confirmado acá tras la
  // corrección de Síntomas A/B.
  const xmlLegacy = `<xml><block type="f_esperar"><field name="MS">10</field>
      <next>${varSet("x", `<block type="f_millis"></block>`)}</next>
    </block></xml>`;
  const instrsLegacy = compilarXml(xmlLegacy);
  const finLegacy = instrsLegacy[instrsLegacy.length - 1];
  assert(finLegacy.op === 0 && finLegacy.val === 0, "programa 'legacy' (sin Al iniciar/Repetir continuamente): OP_FIN sigue apuntando a 0, compatibilidad total");
}

console.log("\n=== Prueba 8 — Guardado/recuperación de XML de Blockly (round-trip, modo simulado) ===");
{
  const cuerpoSi = encadenar(
    varSet("tiempoAnterior", `<block type="f_millis"></block>`),
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
    ifLedDesdeEstado(),
  );
  const xml = `<xml>${alIniciar(varSet("tiempoAnterior", num(0)), varSet("estadoLED", num(0)))}${repetirSiempre(
    siIntervaloCumplido("tiempoAnterior", 3000, cuerpoSi),
  )}</xml>`;
  const { xmlGuardado, instrs: instrsRecuperados } = guardarYRecuperar(xml);
  const instrsOriginal = compilarXml(xml);
  assert(xmlGuardado.includes("f_al_iniciar") && xmlGuardado.includes("f_repetir_siempre"), "el XML guardado conserva los bloques Al iniciar/Repetir continuamente");
  assert(JSON.stringify(instrsRecuperados) === JSON.stringify(instrsOriginal), "recuperar el XML guardado compila EXACTAMENTE a las mismas instrucciones que el original (round-trip fiel)");
  assert(instrsRecuperados.some((i) => i.op === 89), "el programa recuperado sigue usando el opcode corregido POP_SUB_T(89) para el temporizador");
  // Síntoma D (400 en /bloques/xml real): se prueba aparte, sin Blockly,
  // en swRuntime.selfTest.ts (parsePostBody) — acá solo compete el
  // round-trip del propio compilador/Workspace, que no pasa por HTTP.
}

console.log("\n=== Prueba 9 — Equivalencia LAB/Server: mismo bytecode, misma semántica de OP_POP_SUB_T en los dos intérpretes ===");
{
  // No se puede compilar/ejecutar el .ino real en este entorno (sin
  // toolchain de Arduino/ESP32-C3) — se verifica la equivalencia
  // NUMÉRICA exacta de la operación que importa (OP_POP_SUB_T) replicando
  // acá, en JS puro, la MISMA expresión C que quedó en el .ino
  // (`(int16_t)(uint16_t)(a-b)`, ver case OP_POP_SUB_T) y comparándola
  // contra el wrap16() real de runtime.ts para un barrido de casos,
  // incluyendo los bordes exactos donde Síntomas A/B se manifestaban.
  function wrap16ReferenciaC(a, b) {
    // Replica BIT A BIT la expresión C real: uint16_t trunca a 16 bits
    // sin signo (0..65535), luego el cast a int16_t reinterpreta como
    // signado (-32768..32767) — exactamente lo que hace runtime.ts.
    const diff = a - b;
    const u16 = ((diff % 65536) + 65536) % 65536; // módulo matemático correcto también para diff negativo
    return u16 >= 0x8000 ? u16 - 0x10000 : u16;
  }
  const casos = [
    [3140, 0], [31040, 28180], [100, 31300], // antes/durante la zona de cruce real observada en la Prueba 4
    [32767, 0], [32768, 0], [0, 32768], [65535, 0], [65536, 0],
    [40000, 5000], [5000, 40000], [0, 0], [100000, 99000],
  ];
  const { runtime } = nuevoRuntime();
  // Ejecuta directamente OP_POP_SUB_T (89) con push(a), push(b) manuales
  // sobre el intérprete real — sin pasar por el compilador, para aislar
  // SOLO la semántica del opcode.
  let todosCoinciden = true;
  for (const [a, b] of casos) {
    runtime.bloquesClear();
    runtime.bloquesAdd(90, a); // OP_PUSH a
    runtime.bloquesAdd(90, b); // OP_PUSH b
    runtime.bloquesAdd(89, 0); // OP_POP_SUB_T
    runtime.bloquesAdd(82, 0); // OP_VAR_SET_EXPR (guarda el resultado en varTabla[0])
    runtime.bloquesRun();
    for (let i = 0; i < 4; i++) runtime.tick();
    const real = runtime.model.varTabla[0];
    const esperado = wrap16ReferenciaC(a, b);
    if (real !== esperado) {
      todosCoinciden = false;
      console.error(`    ✗ caso a=${a} b=${b}: runtime.ts dio ${real}, esperado (según el mismo cast que el .ino) ${esperado}`);
    }
  }
  assert(todosCoinciden, `OP_POP_SUB_T(89) en runtime.ts coincide EXACTAMENTE con (int16_t)(uint16_t)(a-b) (la misma expresión que quedó en el .ino) en los ${casos.length} casos probados, incluidos los bordes de 16 bits`);
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0);
