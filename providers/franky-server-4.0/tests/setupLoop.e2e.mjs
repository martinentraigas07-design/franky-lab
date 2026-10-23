// "CORRECCIÓN DE INICIALIZACIÓN Y CICLO PRINCIPAL EN BLOCKLY" — separación
// funcional entre "setup()" (una sola vez) y "loop()" (se repite), con los
// bloques reales "f_al_iniciar" ("Al iniciar") y "f_repetir_siempre"
// ("Repetir continuamente"). Misma técnica que millis-compiler.e2e.mjs /
// millisNoBloqueante.e2e.mjs: carga el bundle real de Blockly + el script
// real de bloques.html en un Workspace headless, compila con el compilador
// REAL (wsToInstructions()) y ejecuta sobre el intérprete REAL
// (FirmwareRuntime) con un reloj simulado controlable (StubHAL.advance()).
//
// Cubre, en este archivo: Pruebas A, B, C, D, E, F, G y H del enunciado.
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

console.log("0. El toolbox tiene 'f_al_iniciar' y 'f_repetir_siempre' en la categoría Control");
{
  const controlCat = html.match(/<category name="Control"[\s\S]*?<\/category>/);
  assert(!!controlCat && controlCat[0].includes('type="f_al_iniciar"'), "la categoría Control contiene f_al_iniciar");
  assert(!!controlCat && controlCat[0].includes('type="f_repetir_siempre"'), "la categoría Control contiene f_repetir_siempre");
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
// defGenerators() registra los reg(type,fn) del generador de texto C++ de
// referencia (Blockly.JavaScript.forBlock[...]) — las pruebas de
// compilador reales (millis-compiler.e2e.mjs, etc.) no lo necesitan
// porque solo ejercitan wsToInstructions(), pero la Prueba G de este
// archivo sí usa ese generador (cadenaACodigo/clasificarBloquesTopLevel),
// así que hace falta llamarlo acá también.
vm.runInContext("registrarFieldSprite(); defBlocks(); defGenerators();", context);

/** Compila un XML real con wsToInstructions() y devuelve las instrucciones. */
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

/** Carga un XML, genera el texto C++ de referencia con el MISMO clasificador
 *  (clasificarBloquesTopLevel) que usa el compilador real, y lo devuelve. */
function textoCppDeXml(xml) {
  context.__xmlActual = xml;
  return vm.runInContext(
    `(function(){
       workspace = new Blockly.Workspace();
       var dom = (Blockly.utils.xml.textToDom || Blockly.Xml.textToDom)(__xmlActual);
       Blockly.Xml.domToWorkspace(dom, workspace);
       var gen = Blockly.JavaScript;
       gen.init(workspace); // ver comentario en _doUpdateCode() de bloques.html
       var clasif = clasificarBloquesTopLevel(workspace);
       var setupCode = clasif.setupHeads.map(function(h){ return cadenaACodigo(gen, h); }).join("");
       var loopCode = clasif.loopHeads.map(function(h){ return cadenaACodigo(gen, h); }).join("");
       return {setupCode: setupCode, loopCode: loopCode};
     })()`,
    context,
  );
}

/** Ida y vuelta XML (Prueba H): workspace -> XML -> workspace nuevo -> instrucciones. */
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

// A diferencia de avanzarFrame() en millisNoBloqueante.e2e.mjs (que espera
// a que progPC vuelva a 0 — válido SOLO en modo "legacy", donde OP_FIN
// siempre apunta a 0 y por lo tanto "progPC===0" solo puede darse justo
// DESPUÉS de ejecutar OP_FIN), acá el programa puede estar en modo
// ESTRUCTURADO (usa "Al iniciar"/"Repetir continuamente"), donde OP_FIN
// apunta a loopStartIdx en vez de a 0 — y progPC pasa por loopStartIdx de
// forma perfectamente normal, avanzando instrucción por instrucción, la
// PRIMERA vez que el programa entra al ciclo (al salir de "Al iniciar"),
// sin que eso signifique que se completó una vuelta todavía. Por eso acá
// se detecta el cierre de vuelta de otra forma, sin ambigüedad: la
// instrucción OP_FIN SIEMPRE es la ÚLTIMA del array compilado (ver
// wsToInstructions()) — "progPC === instrs.length-1" solo puede
// significar "estoy a punto de ejecutar el OP_FIN real", nunca una
// posición de paso.
function avanzarFrame(runtime, hal, ms, instrs) {
  const finIdx = instrs.length - 1;
  hal.advance(ms);
  let guard = 0;
  while (true) {
    const pcAntesDeTick = runtime.model.progPC;
    runtime.tick();
    if (++guard > 10000) throw new Error("avanzarFrame: OP_FIN nunca se ejecutó tras 10000 ticks");
    if (pcAntesDeTick === finIdx) break; // acabamos de ejecutar el OP_FIN real -> vuelta completa
  }
}

// ── Helpers de armado de XML (mismo patrón que millisNoBloqueante.e2e.mjs) ──
function encadenar(...bloques) {
  let resultado = "";
  for (let i = bloques.length - 1; i >= 0; i--) {
    const cierre = resultado ? `<next>${resultado}</next></block>` : "</block>";
    resultado = bloques[i].replace(/<\/block>\s*$/, cierre);
  }
  return resultado;
}
function alIniciar(...asignaciones) {
  return `<block type="f_al_iniciar"><statement name="DO">${encadenar(...asignaciones)}</statement></block>`;
}
function repetirSiempre(...instrucciones) {
  return `<block type="f_repetir_siempre"><statement name="DO">${encadenar(...instrucciones)}</statement></block>`;
}
function varSet(nombre, valorXml) {
  return `<block type="variables_set"><field name="VAR">${nombre}</field><value name="VALUE">${valorXml}</value></block>`;
}
function num(n) { return `<block type="math_number"><field name="NUM">${n}</field></block>`; }
function varGet(nombre) { return `<block type="variables_get"><field name="VAR">${nombre}</field></block>`; }
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

console.log("\n=== Programa de validación obligatorio — LED intermitente con millis(), con 'Al iniciar'/'Repetir continuamente' ===");
{
  // AL INICIAR: tiempoAnterior=0; estadoLED=0 (falso)
  // REPETIR CONTINUAMENTE:
  //   si (millis()-tiempoAnterior)>=500:
  //     tiempoAnterior=millis(); estadoLED=1-estadoLED
  //     si estadoLED: encender LED  sino: apagar LED
  const ifLed = `<block type="controls_if">
    <mutation else="1"></mutation>
    <value name="IF0"><block type="logic_compare"><field name="OP">NEQ</field>
      <value name="A">${varGet("estadoLED")}</value>
      <value name="B">${num(0)}</value>
    </block></value>
    <statement name="DO0"><block type="f_led_on"></block></statement>
    <statement name="ELSE"><block type="f_led_off"></block></statement>
  </block>`;
  const cuerpoSi = encadenar(
    varSet("tiempoAnterior", `<block type="f_millis"></block>`),
    varSet("estadoLED", `<block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A">${num(1)}</value><value name="B">${varGet("estadoLED")}</value></block>`),
    ifLed,
  );
  const xml = `<xml>${alIniciar(
      varSet("tiempoAnterior", num(0)),
      varSet("estadoLED", num(0)),
    )}${repetirSiempre(siIntervaloCumplido("tiempoAnterior", 500, cuerpoSi))}</xml>`;

  const instrs = compilarXml(xml);
  const finInstr = instrs[instrs.length - 1];
  assert(finInstr.op === 0, "la última instrucción compilada es OP_FIN (0)");
  assert(finInstr.val > 0, `OP_FIN NO apunta a 0 (modo estructurado real, no legacy) — val=${finInstr.val}`);
  assert(instrs.some((i) => i.op === 94), "el programa compilado usa PUSH_MILLIS (opcode real)");

  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  assert(runtime.model.progPC === 0, "tras 'Ejecutar', progPC arranca en 0 (en 'Al iniciar')");

  let cambiosLed = 0, ledAnterior = null;
  for (let i = 0; i < 20; i++) {
    avanzarFrame(runtime, hal, 50, instrs); // 20 vueltas * 50ms = 1000ms simulados
    const ledAhora = hal.getDigital(PIN.led ?? 9);
    if (ledAnterior !== null && ledAhora !== ledAnterior) cambiosLed++;
    ledAnterior = ledAhora;
  }
  assert(cambiosLed === 2, `el LED cambió de estado 2 veces en 1000ms a intervalos de 500ms (dio ${cambiosLed})`);
  assert(runtime.model.varTabla.some((v) => v !== 0), "las variables (tiempoAnterior/estadoLED) NO quedaron todas en 0 — 'tiempoAnterior' se actualizó de verdad, no se reinició cada vuelta");
}

console.log("\n=== Prueba A — inicialización única: 'contador' se inicializa en 'Al iniciar' y se incrementa en 'Repetir continuamente', sin volver nunca a 0 ===");
{
  const xml = `<xml>${alIniciar(varSet("contador", num(0)))}${repetirSiempre(
      varSet("contador", `<block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A">${varGet("contador")}</value><value name="B">${num(1)}</value></block>`),
    )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  for (let i = 0; i < 10; i++) avanzarFrame(runtime, hal, 10, instrs);
  // No asumimos el slot exacto que slotForVar() le asignó a 'contador':
  // leemos las 4 variables y verificamos que AL MENOS una llegó a valer
  // 10 tras 10 vueltas (jamás volvió a 0 en el medio).
  const llegoA10 = runtime.model.varTabla.some((v) => v === 10);
  assert(llegoA10, `'contador' llegó a 10 tras 10 vueltas sin resetearse — varTabla=${JSON.stringify(runtime.model.varTabla)}`);
}

console.log("\n=== Prueba B — persistencia de variables entre vueltas del ciclo principal ===");
{
  // AL INICIAR: acumulado = 5
  // REPETIR CONTINUAMENTE: acumulado += 3
  // Si NO persistiera entre vueltas (p.ej. si 'Al iniciar' se repitiera),
  // 'acumulado' quedaría siempre en 8 (5+3) en vez de crecer sin límite.
  const xml = `<xml>${alIniciar(varSet("acumulado", num(5)))}${repetirSiempre(
      varSet("acumulado", `<block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A">${varGet("acumulado")}</value><value name="B">${num(3)}</value></block>`),
    )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  avanzarFrame(runtime, hal, 10, instrs);
  const trasUnaVuelta = [...runtime.model.varTabla];
  avanzarFrame(runtime, hal, 10, instrs);
  avanzarFrame(runtime, hal, 10, instrs);
  const trasTresVueltas = [...runtime.model.varTabla];
  assert(trasUnaVuelta.some((v) => v === 8), `tras 1 vuelta, 'acumulado' = 5(init)+3 = 8 — varTabla=${JSON.stringify(trasUnaVuelta)}`);
  assert(trasTresVueltas.some((v) => v === 14), `tras 3 vueltas, 'acumulado' = 5+3+3+3 = 14 (jamás volvió a 5) — varTabla=${JSON.stringify(trasTresVueltas)}`);
}

console.log("\n=== Prueba C — dos temporizadores independientes dentro de 'Repetir continuamente' (LED cada 500ms + lectura cada 100ms), ambos sin 'Esperar' ===");
{
  const xml = `<xml>${alIniciar(
      varSet("tAnteriorLed", num(0)),
      varSet("tAnteriorSensor", num(0)),
      varSet("vueltasLed", num(0)),
      varSet("vueltasSensor", num(0)),
    )}${repetirSiempre(
      siIntervaloCumplido("tAnteriorLed", 500, encadenar(
        varSet("tAnteriorLed", `<block type="f_millis"></block>`),
        varSet("vueltasLed", `<block type="math_arithmetic"><field name="OP">ADD</field>
          <value name="A">${varGet("vueltasLed")}</value><value name="B">${num(1)}</value></block>`),
      )),
      siIntervaloCumplido("tAnteriorSensor", 100, encadenar(
        varSet("tAnteriorSensor", `<block type="f_millis"></block>`),
        varSet("vueltasSensor", `<block type="math_arithmetic"><field name="OP">ADD</field>
          <value name="A">${varGet("vueltasSensor")}</value><value name="B">${num(1)}</value></block>`),
      )),
    )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  for (let i = 0; i < 40; i++) avanzarFrame(runtime, hal, 50, instrs); // 2000ms simulados
  assert(runtime.model.varTabla.includes(4), `el temporizador de 500ms disparó 4 veces en 2000ms — varTabla=${JSON.stringify(runtime.model.varTabla)}`);
  assert(runtime.model.varTabla.includes(20), `el temporizador de 100ms disparó 20 veces en 2000ms, sin que el de 500ms lo bloqueara — varTabla=${JSON.stringify(runtime.model.varTabla)}`);
}

console.log("\n=== Prueba D — detener y volver a ejecutar: 'Al iniciar' corre de nuevo, exactamente una vez ===");
{
  const xml = `<xml>${alIniciar(varSet("contador", num(0)))}${repetirSiempre(
      varSet("contador", `<block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A">${varGet("contador")}</value><value name="B">${num(1)}</value></block>`),
    )}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  for (let i = 0; i < 5; i++) avanzarFrame(runtime, hal, 10, instrs);
  const antesDeParar = [...runtime.model.varTabla];
  assert(antesDeParar.includes(5), `antes de parar, 'contador' llegó a 5 — varTabla=${JSON.stringify(antesDeParar)}`);

  const rStop = runtime.bloquesStop();
  assert(rStop.ok, "bloquesStop() se ejecuta sin error");
  assert(runtime.model.modeRunning === false, "tras detener, modeRunning queda en false (el ciclo no sigue corriendo)");

  // bloquesClear() + volver a cargar el MISMO programa compilado, igual
  // que hace el navegador al apretar "Ejecutar" de nuevo (recompila y
  // vuelve a subir las instrucciones) — bloquesAdd() ya reinicia progPC a
  // 0 en bloquesClear(), y bloquesRun() también lo fija en 0 (ver runtime.ts).
  runtime.bloquesClear();
  cargarYArrancar(runtime, instrs);
  assert(runtime.model.progPC === 0, "al volver a 'Ejecutar', progPC arranca de nuevo en 0 ('Al iniciar')");
  avanzarFrame(runtime, hal, 10, instrs);
  const trasReiniciar = [...runtime.model.varTabla];
  assert(trasReiniciar.includes(1), `tras reiniciar y una vuelta, 'contador' volvió a valer 1 (0 de 'Al iniciar' + 1) — NO sigue en 6 — varTabla=${JSON.stringify(trasReiniciar)}`);
}

console.log("\n=== Prueba E — compatibilidad: un programa SIN 'Al iniciar'/'Repetir continuamente' (bloques sueltos, como ANTES de esta corrección) sigue compilando y corriendo exactamente igual ===");
{
  // Mismo patrón "bandera de inicialización con guardia" usado en
  // millisNoBloqueante.e2e.mjs — la forma en que YA se armaban estos
  // programas antes de que existieran "Al iniciar"/"Repetir continuamente".
  const programa = encadenar(
    varSet("contador", `<block type="math_arithmetic"><field name="OP">ADD</field>
      <value name="A">${varGet("contador")}</value><value name="B">${num(1)}</value></block>`),
  );
  const xml = `<xml>${programa}</xml>`;
  const instrs = compilarXml(xml);
  const finInstr = instrs[instrs.length - 1];
  assert(finInstr.op === 0 && finInstr.val === 0, `un programa sin bloques nuevos compila con OP_FIN val=0 (modo legacy, idéntico a antes de esta corrección) — FIN=${JSON.stringify(finInstr)}`);

  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  for (let i = 0; i < 7; i++) avanzarFrame(runtime, hal, 10, instrs);
  assert(runtime.model.varTabla.includes(7), `el programa 'legacy' (sin los bloques nuevos) sigue incrementando 'contador' en cada vuelta, igual que antes — varTabla=${JSON.stringify(runtime.model.varTabla)}`);
}

console.log("\n=== Prueba F — seguridad: detener el programa sigue deteniendo los motores (mecanismo de seguridad existente, sin cambios) ===");
{
  const xml = `<xml>${repetirSiempre(`<block type="f_adelante"><field name="VEL">200</field></block>`)}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  // Un solo tick() (NO avanzarFrame completo): avanzarFrame corre hasta
  // justo DESPUÉS de que se ejecute el OP_FIN de la vuelta, y OP_FIN
  // llama a stopMotorsShared() ANTES de volver a repetir (mecanismo de
  // seguridad existente, sin cambios) — si se mide el PWM en ese punto
  // SIEMPRE da 0, sin importar qué hizo el cuerpo del programa. Para
  // comprobar "el robot está avanzando mientras el programa corre" hay
  // que mirar el PWM a mitad de vuelta, justo después de ejecutar
  // 'f_adelante' y antes de llegar al OP_FIN.
  runtime.tick();
  const pwmCorriendo = hal.getPwm(PIN.motorIzqFwd) + hal.getPwm(PIN.motorDerFwd);
  assert(pwmCorriendo > 0, `con el robot avanzando dentro de 'Repetir continuamente', el PWM de los motores es > 0 (dio ${pwmCorriendo})`);
  runtime.bloquesStop();
  const pwmIzq = hal.getPwm(PIN.motorIzqFwd), pwmDer = hal.getPwm(PIN.motorDerFwd);
  assert(pwmIzq === 0 && pwmDer === 0, `bloquesStop() deja los motores en PWM 0 (izq=${pwmIzq}, der=${pwmDer}) — el mecanismo de seguridad sigue intacto`);
}

console.log("\n=== Prueba G — código C++ de referencia respeta la separación setup()/loop(), sin duplicar bloques ===");
{
  const xml = `<xml>${alIniciar(varSet("tiempoAnterior", num(0)))}${repetirSiempre(varSet("tiempoAnterior", `<block type="f_millis"></block>`))}</xml>`;
  const { setupCode, loopCode } = textoCppDeXml(xml);
  assert(setupCode.includes("tiempoAnterior"), `el código de 'Al iniciar' aparece en el bloque de setup — setupCode=${JSON.stringify(setupCode)}`);
  assert(!loopCode.includes("= 0"), `la asignación 'tiempoAnterior = 0' de 'Al iniciar' NO aparece en el código de loop (no se duplica) — loopCode=${JSON.stringify(loopCode)}`);
  assert(loopCode.includes("millis"), `el código de 'Repetir continuamente' (que usa millis()) aparece en el bloque de loop — loopCode=${JSON.stringify(loopCode)}`);
}

console.log("\n=== Prueba H — guardar y recuperar un programa con 'Al iniciar' + 'Repetir continuamente' preserva estructura y variables ===");
{
  const xml = `<xml>${alIniciar(varSet("contador", num(0)), varSet("estadoLED", num(0)))}${repetirSiempre(
      varSet("contador", `<block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A">${varGet("contador")}</value><value name="B">${num(1)}</value></block>`),
    )}</xml>`;
  const original = compilarXml(xml);
  const { xmlGuardado, instrs: recuperados } = guardarYRecuperar(xml);
  assert(xmlGuardado.includes("f_al_iniciar"), "el XML guardado conserva el bloque 'f_al_iniciar'");
  assert(xmlGuardado.includes("f_repetir_siempre"), "el XML guardado conserva el bloque 'f_repetir_siempre'");
  assert(JSON.stringify(original) === JSON.stringify(recuperados), `tras guardar y recuperar, el programa compila a las MISMAS instrucciones — original=${JSON.stringify(original)} recuperado=${JSON.stringify(recuperados)}`);
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0);
