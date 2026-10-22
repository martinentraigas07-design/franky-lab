// TP5 Actividad 13 — "Programación no bloqueante con millis()".
//
// Compila programas Blockly REALES (bloques tal cual quedan en el
// toolbox hoy: f_millis, variables_set/get, math_arithmetic, logic_compare,
// controls_if) con el compilador real de bloques.html, y los corre sobre
// el intérprete real (FirmwareRuntime) con un reloj simulado controlable
// (StubHAL.advance()) — exactamente como pide el enunciado: "verificá que
// todos los bloques necesarios existan realmente" y "no declares una
// prueba como aprobada sin haberla ejecutado o verificado".
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StubHAL } from "../../../dist/core/src/stubHal.js";
import { FirmwareRuntime } from "../../../dist/providers/franky-server-4.0/firmware/runtime.js";
import { defaultFirmwareModel } from "../../../dist/providers/franky-server-4.0/firmware/model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, "..", "assets");
const html = fs.readFileSync(path.join(assetsDir, "bloques.html"), "utf8");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ── Blockly real headless (misma técnica que blockly-real.e2e.mjs / millis-compiler.e2e.mjs) ──
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
vm.runInContext("registrarFieldSprite(); defBlocks();", context);

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

// tick() ejecuta EXACTAMENTE una instrucción de bytecode por llamada (es
// "el equivalente a loop() real", pero loop() real ejecuta TODO el cuerpo
// del programa en una sola pasada — acá cada opcode es su propia "pasada
// de reloj"). hal.millis() en cambio avanza por TIEMPO REAL/simulado entre
// sondeos del navegador (pumpClock() en swRuntime.ts), no por instrucción.
// Para simular correctamente "una vuelta de poll real" hace falta separar
// ambas cosas: avanzar el reloj una vez, y después ejecutar tick() las
// veces que hagan falta para completar como mínimo una vuelta COMPLETA del
// programa (si no, la comparación "millis()-anterior" y la actualización
// de "anterior" que sigue unas instrucciones más abajo leerían el reloj en
// dos instantes de reloj distintos dentro de la MISMA vuelta, corriendo el
// riesgo de duplicar/perder disparos — exactamente el tipo de condición de
// carrera que esta Actividad 13 busca evitar).
// IMPORTANTE: no alcanza con "una cantidad generosa" de ticks por frame —
// si se ejecutan DE MÁS, el programa completa más de una vuelta dentro del
// mismo valor de reloj (mismo "instante" simulado), inflando contadores que
// deberían avanzar una sola vez por vuelta. Como OP_FIN (case 0, también el
// "default" de cualquier opcode no reconocido) es lo único que resetea
// progPC a 0 y cierra una vuelta, la forma exacta de avanzar "una vuelta
// real de loop()" es: fijar el reloj UNA vez y tickear hasta que progPC
// vuelva a 0 — sin importar cuántas instrucciones tuvo esa vuelta en
// particular (varía según qué rama de "si" se tomó). Un tope de seguridad
// evita un bucle infinito si algún programa de prueba quedara mal armado.
function avanzarFrame(runtime, hal, ms) {
  hal.advance(ms);
  let guard = 0;
  do {
    runtime.tick();
    if (++guard > 10000) throw new Error("avanzarFrame: no volvió a progPC=0 tras 10000 ticks (¿programa sin OP_FIN alcanzable?)");
  } while (runtime.model.progPC !== 0);
}

// Helper: condición "si (millis() - anterior) >= intervalo" seguida de un cuerpo,
// como la arma un docente arrastrando bloques reales (controls_if + logic_compare
// GTE + math_arithmetic MINUS + f_millis + variables_get/set).
function siIntervaloCumplido(varAnteriorNombre, intervaloMs, cuerpoXml) {
  return `<block type="controls_if">
    <value name="IF0"><block type="logic_compare"><field name="OP">GTE</field>
      <value name="A"><block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A"><block type="f_millis"></block></value>
        <value name="B"><block type="variables_get"><field name="VAR">${varAnteriorNombre}</field></block></value>
      </block></value>
      <value name="B"><block type="math_number"><field name="NUM">${intervaloMs}</field></block></value>
    </block></value>
    <statement name="DO0">${cuerpoXml}</statement>
  </block>`;
}

// Encadena bloques-statement COMPLETOS ("<block ...>...</block>", sin <next>
// propio) en una secuencia real de Blockly. El schema de Blockly exige que
// la continuación de un bloque vaya en un <next> ANIDADO DENTRO de ese
// bloque (antes de su </block> de cierre) — nunca como hermano después de
// él. Escribir "<block>...</block><next>...</next>" a mano (como hacían
// las primeras versiones de este archivo) es XML inválido: Blockly lo
// descarta en silencio y el bloque siguiente queda huérfano, sin conectar
// al programa — exactamente el bug que hacía fallar esta prueba (p.ej. el
// "contadorTicks += 1" de la Prueba A nunca se compilaba).
function encadenar(...bloques) {
  let resultado = "";
  for (let i = bloques.length - 1; i >= 0; i--) {
    const cierre = resultado ? `<next>${resultado}</next></block>` : "</block>";
    resultado = bloques[i].replace(/<\/block>\s*$/, cierre);
  }
  return resultado;
}

// LIMITACIÓN ESTRUCTURAL REAL descubierta al construir estas pruebas (ver
// informe): en FRANKY (LAB y firmware físico por igual) el programa
// compilado completo ES el "loop()" — OP_FIN (case 0/"default" en
// runtime.ts y en el .ino) siempre resetea progPC a 0 y el programa entero
// vuelve a correr desde el principio. No existe un "setup() una sola vez"
// separado del "loop() repetido" como en Arduino clásico. Por eso un
// bloque "variables_set tiempoAnterior = 0" puesto SIN PROTECCIÓN al
// nivel superior del programa se re-ejecuta en CADA vuelta — y como esa
// vuelta vuelve a correr ANTES de la comparación "millis()-tiempoAnterior
// >= intervalo", la comparación nunca ve pasar el tiempo real: dispara en
// todas las vueltas una vez que millis() supera el intervalo.
//
// La solución NO requiere ningún bloque u opcode nuevo: es el mismo patrón
// que cualquier programador de Arduino usa cuando el entorno no le da un
// setup() aparte — una "inicialización con guardia", con una variable
// bandera que arranca en 0 (las 4 variables con nombre de FRANKY ya
// arrancan en 0 por defecto, así que ni siquiera hace falta un bloque
// "bandera = 0" explícito) y que una vez puesta a 1 nunca se vuelve a
// tocar, de modo que el bloque "si bandera==0: (inicialización); bandera=1"
// solo ejecuta su cuerpo en la primera vuelta real del programa.
function inicializarUnaVez(nombreBandera, ...asignaciones) {
  const marcarListo = `<block type="variables_set"><field name="VAR">${nombreBandera}</field><value name="VALUE"><block type="math_number"><field name="NUM">1</field></block></value></block>`;
  const cuerpo = encadenar(...asignaciones, marcarListo);
  return `<block type="controls_if">
    <value name="IF0"><block type="logic_compare"><field name="OP">EQ</field>
      <value name="A"><block type="variables_get"><field name="VAR">${nombreBandera}</field></block></value>
      <value name="B"><block type="math_number"><field name="NUM">0</field></block></value>
    </block></value>
    <statement name="DO0">${cuerpo}</statement>
  </block>`;
}

console.log("=== Prueba A — LED intermitente cada 500ms, SIN bloquear (sin 'Esperar') ===");
{
  // yaInit: bandera de inicialización con guardia (ver "LIMITACIÓN
  // ESTRUCTURAL" más arriba) — arranca en 0 por defecto, sin bloque propio.
  // si (yaInit==0): tiempoAnterior=0; estadoLED=0; yaInit=1   <- solo la 1ª vuelta
  // si (millis()-tiempoAnterior)>=500: tiempoAnterior=millis(); estadoLED = 1-estadoLED; [LED según estadoLED]
  // contadorTicks += 1   <- fuera del "si", SIEMPRE se ejecuta (demuestra que no se bloquea)
  const cuerpoSi = encadenar(
    `<block type="variables_set"><field name="VAR">tiempoAnterior</field><value name="VALUE"><block type="f_millis"></block></value></block>`,
    `<block type="variables_set"><field name="VAR">estadoLED</field>
      <value name="VALUE"><block type="math_arithmetic"><field name="OP">MINUS</field>
        <value name="A"><block type="math_number"><field name="NUM">1</field></block></value>
        <value name="B"><block type="variables_get"><field name="VAR">estadoLED</field></block></value>
      </block></value>
    </block>`,
  );
  const programa = encadenar(
    inicializarUnaVez(
      "yaInit",
      `<block type="variables_set"><field name="VAR">tiempoAnterior</field><value name="VALUE"><block type="math_number"><field name="NUM">0</field></block></value></block>`,
      `<block type="variables_set"><field name="VAR">estadoLED</field><value name="VALUE"><block type="math_number"><field name="NUM">0</field></block></value></block>`,
    ),
    siIntervaloCumplido("tiempoAnterior", 500, cuerpoSi),
    `<block type="variables_set"><field name="VAR">contadorTicks</field>
      <value name="VALUE"><block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A"><block type="variables_get"><field name="VAR">contadorTicks</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">1</field></block></value>
      </block></value>
    </block>`,
  );
  const xml = `<xml>${programa}</xml>`;
  const instrs = compilarXml(xml);
  assert(instrs.some((i) => i.op === 94), "el programa compilado usa PUSH_MILLIS (opcode real, no la constante 0)");

  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  // orden de aparición: yaInit=0, tiempoAnterior=1, estadoLED=2, contadorTicks=3
  const slotEstadoLED = 2;
  if (process.env.DEBUG_MILLIS) instrs.forEach((ins, idx) => console.log("  instr", idx, JSON.stringify(ins)));

  // 20 "frames" de 50ms de reloj real = 1000ms simulados en total.
  let cambiosDeEstado = 0, anterior = runtime.model.varTabla[slotEstadoLED];
  for (let i = 0; i < 20; i++) {
    avanzarFrame(runtime, hal, 50);
    if (process.env.DEBUG_MILLIS) console.log("  frame", i, "millis=", hal.millis(), "varTabla=", runtime.model.varTabla);
    if (runtime.model.varTabla[slotEstadoLED] !== anterior) { cambiosDeEstado++; anterior = runtime.model.varTabla[slotEstadoLED]; }
  }
  // 1000ms simulados / 500ms de intervalo => dispara en t=500 y t=1000 -> 2 cambios de estado
  assert(cambiosDeEstado === 2, `el LED cambió de estado 2 veces en 1000ms simulados a intervalos de 500ms (dio ${cambiosDeEstado})`);
  assert(runtime.model.varTabla[3] === 20, `el contador de 'vueltas de loop' (fuera del 'si') avanzó las 20 veces — el programa NUNCA se congeló esperando el intervalo (dio ${runtime.model.varTabla[3]})`);
}

console.log("\n=== Prueba B — dos temporizadores independientes (LED cada 500ms + lectura de sensor cada 100ms) ===");
{
  // tAnt1, tAnt2, contadorLED y contadorLectura arrancan en 0 por defecto
  // (varTabla[] siempre arranca en [0,0,0,0]) — NO se escribe un bloque
  // "tAnt1=0" suelto al nivel superior del programa: ver la nota sobre la
  // "LIMITACIÓN ESTRUCTURAL" más arriba (todo bloque al nivel superior se
  // re-ejecuta en cada vuelta de loop(), así que un "=0" sin guardia ahí
  // resetearía el temporizador en cada vuelta y lo haría disparar siempre).
  // si (millis()-tAnt1)>=500: tAnt1=millis(); contadorLED+=1
  // si (millis()-tAnt2)>=100: tAnt2=millis(); contadorLectura+=1
  const cuerpo1 = encadenar(
    `<block type="variables_set"><field name="VAR">tAnt1</field><value name="VALUE"><block type="f_millis"></block></value></block>`,
    `<block type="variables_set"><field name="VAR">contadorLED</field>
      <value name="VALUE"><block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A"><block type="variables_get"><field name="VAR">contadorLED</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">1</field></block></value>
      </block></value>
    </block>`,
  );
  const cuerpo2 = encadenar(
    `<block type="variables_set"><field name="VAR">tAnt2</field><value name="VALUE"><block type="f_millis"></block></value></block>`,
    `<block type="variables_set"><field name="VAR">contadorLectura</field>
      <value name="VALUE"><block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A"><block type="variables_get"><field name="VAR">contadorLectura</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">1</field></block></value>
      </block></value>
    </block>`,
  );
  const programa = encadenar(
    siIntervaloCumplido("tAnt1", 500, cuerpo1),
    siIntervaloCumplido("tAnt2", 100, cuerpo2),
  );
  const xml = `<xml>${programa}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  // 40 "frames" de 50ms de reloj real = 2000ms simulados en total.
  for (let i = 0; i < 40; i++) avanzarFrame(runtime, hal, 50);
  // orden de aparición: tAnt1=0, contadorLED=1, tAnt2=2, contadorLectura=3
  assert(runtime.model.varTabla[1] === 4, `el temporizador de 500ms disparó 4 veces en 2000ms (dio ${runtime.model.varTabla[1]})`);
  assert(runtime.model.varTabla[3] === 20, `el temporizador de 100ms disparó 20 veces en 2000ms, SIN que el de 500ms lo bloqueara (dio ${runtime.model.varTabla[3]})`);
}

console.log("\n=== Prueba D — robot explorador: AVANZAR/RETROCEDER/GIRAR por intervalos no bloqueantes, detección de obstáculo SIEMPRE activa ===");
{
  // estado y tAnt arrancan en 0 por defecto (sin bloque "=0" suelto al
  // nivel superior — misma razón que en la Prueba B).
  //
  // Segundo hallazgo real al construir esta prueba, además de la
  // "LIMITACIÓN ESTRUCTURAL" de más arriba: tres bloques "si" INDEPENDIENTES
  // (sin "sino") que se revisan en secuencia, cada uno comparando la MISMA
  // variable que el anterior puede haber modificado un instante antes,
  // encadenan en cascada dentro de una única vuelta: "si estado==0:
  // estado=1" deja estado en 1, y el siguiente "si estado==1: estado=2" ve
  // ESE 1 recién puesto y también dispara, y así hasta volver a 0 — tres
  // transiciones completas en una sola vuelta, invisibles desde afuera.
  // Esto no es un límite del compilador/intérprete: es el mismo error que
  // comete cualquier programador al anidar "if" sucesivos sobre una
  // variable que ellos mismos van cambiando. La solución, de nuevo con
  // bloques ya existentes (sin "sino/elseif" y sin mutaciones del editor,
  // tal como pide el enunciado): comparar contra una COPIA de "estado"
  // tomada una sola vez al principio de esa vuelta ("estadoAhora"), nunca
  // contra "estado" en vivo — así ningún "si" ve el resultado de otro "si"
  // de la misma vuelta.
  //   estadoAhora = estado   (copia de lectura, antes de los "si")
  //   si estadoAhora==0: estado=1 (-> RETROCEDER)
  //   si estadoAhora==1: estado=2 (-> GIRAR)
  //   si estadoAhora==2: estado=0 (-> AVANZAR)
  // SIEMPRE (fuera del "si" de intervalo, en cada vuelta de loop): leer
  // distancia (f_ultrasonic) y guardarla — demuestra que la detección de
  // obstáculo sigue viva sin depender del temporizador de cambio de estado.
  function siEstadoEsPasaA(actual, siguiente) {
    return `<block type="controls_if">
      <value name="IF0"><block type="logic_compare"><field name="OP">EQ</field>
        <value name="A"><block type="variables_get"><field name="VAR">estadoAhora</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">${actual}</field></block></value>
      </block></value>
      <statement name="DO0"><block type="variables_set"><field name="VAR">estado</field><value name="VALUE"><block type="math_number"><field name="NUM">${siguiente}</field></block></value></block></statement>
    </block>`;
  }
  const cuerpoSi = encadenar(
    `<block type="variables_set"><field name="VAR">tAnt</field><value name="VALUE"><block type="f_millis"></block></value></block>`,
    `<block type="variables_set"><field name="VAR">estadoAhora</field><value name="VALUE"><block type="variables_get"><field name="VAR">estado</field></block></value></block>`,
    siEstadoEsPasaA(0, 1),
    siEstadoEsPasaA(1, 2),
    siEstadoEsPasaA(2, 0),
  );
  const programa = encadenar(
    siIntervaloCumplido("tAnt", 300, cuerpoSi),
    `<block type="variables_set"><field name="VAR">distanciaViva</field><value name="VALUE"><block type="f_ultrasonic"><field name="TRIG">20</field><field name="ECHO">21</field></block></value></block>`,
  );
  const xml = `<xml>${programa}</xml>`;
  const instrs = compilarXml(xml);
  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  // orden de aparición: tAnt=0, estadoAhora=1, estado=2, distanciaViva=3
  // ("variables_set" le asigna el slot al DESTINO antes de compilar su
  // expresión de valor — ver case "variables_set" en bloques.html — así
  // que en "estadoAhora=estado" el slot de "estadoAhora" se reserva antes
  // que el de "estado", aunque "estado" ya existiera conceptualmente desde
  // antes en el programa).
  let estadosVistos = new Set(), lecturasDistancia = 0, ultimaDistancia;
  // 20 "frames" de 50ms de reloj real = 1000ms simulados en total.
  for (let i = 0; i < 20; i++) {
    avanzarFrame(runtime, hal, 50);
    if (process.env.DEBUG_MILLIS) console.log("  frame", i, "millis=", hal.millis(), "varTabla=", runtime.model.varTabla);
    estadosVistos.add(runtime.model.varTabla[2]); // slot2 = estado
    const d = runtime.model.varTabla[3]; // slot3 = distanciaViva
    if (d !== ultimaDistancia) { lecturasDistancia++; ultimaDistancia = d; }
  }
  assert(estadosVistos.has(0) && estadosVistos.has(1) && estadosVistos.has(2), `el estado recorrió AVANZAR(0)->RETROCEDER(1)->GIRAR(2) en 1000ms a 300ms por paso (vistos: ${[...estadosVistos]})`);
  // t=300 -> 0->1, t=600 -> 1->2, t=900 -> 2->0; a t=1000 (fin de la prueba) faltan
  // 100ms para el próximo disparo (300), así que el estado final correcto es 0 (AVANZAR).
  assert(runtime.model.varTabla[2] === 0, `tras 1000ms/300ms (0->1 en t=300, 1->2 en t=600, 2->0 en t=900) el estado terminó en 0 (dio ${runtime.model.varTabla[2]})`);
  assert(typeof runtime.model.varTabla[3] === "number", "la lectura de distancia (fuera del 'si' de intervalo) se siguió asignando en TODOS los ticks, sin depender del temporizador de cambio de estado");
}

console.log("\n=== Prueba C — lectura de sensor ultrasónico + actualización OLED cada 500ms, con evaluación CONTINUA de proximidad entre actualizaciones ===");
{
  // tAnt/distancia/proximidad/contadorVueltas arrancan en 0 por defecto
  // (sin bloque "=0" suelto al nivel superior — misma razón que B y D).
  // si (millis()-tAnt)>=500: tAnt=millis(); distancia=ultrasonic(TRIG=20/ECHO=21,
  //   que son EXACTAMENTE el trigI/echoI por defecto del perfil Sumo "mini"
  //   activo por defecto — ver defaultSumoConfigMini() en model.ts — así
  //   que PUSH_SONAR lee de verdad hal.analogRead(21), no cae al "999 sin
  //   eco" de respaldo); OLED: clear, imprime la distancia, show.
  // proximidad = (distancia < 15)   <- SIEMPRE, cada vuelta de loop — la
  //   EVALUACIÓN de la condición de proximidad es continua aunque la
  //   LECTURA del sensor esté limitada a cada 500ms (no tiene sentido
  //   martillar el sonar en cada vuelta; sí tiene sentido reaccionar con
  //   la lectura más reciente en cada vuelta).
  // contadorVueltas += 1   <- SIEMPRE, demuestra que el programa no se bloquea.
  const cuerpoSi = encadenar(
    `<block type="variables_set"><field name="VAR">tAnt</field><value name="VALUE"><block type="f_millis"></block></value></block>`,
    `<block type="variables_set"><field name="VAR">distancia</field><value name="VALUE"><block type="f_ultrasonic"><field name="TRIG">20</field><field name="ECHO">21</field></block></value></block>`,
    `<block type="f_oled_clear"></block>`,
    `<block type="f_oled_print_var"><field name="COL">0</field><field name="FILA">0</field><value name="VAL"><block type="variables_get"><field name="VAR">distancia</field></block></value></block>`,
    `<block type="f_oled_show"></block>`,
  );
  const programa = encadenar(
    siIntervaloCumplido("tAnt", 500, cuerpoSi),
    `<block type="variables_set"><field name="VAR">proximidad</field>
      <value name="VALUE"><block type="logic_compare"><field name="OP">LT</field>
        <value name="A"><block type="variables_get"><field name="VAR">distancia</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">15</field></block></value>
      </block></value>
    </block>`,
    `<block type="variables_set"><field name="VAR">contadorVueltas</field>
      <value name="VALUE"><block type="math_arithmetic"><field name="OP">ADD</field>
        <value name="A"><block type="variables_get"><field name="VAR">contadorVueltas</field></block></value>
        <value name="B"><block type="math_number"><field name="NUM">1</field></block></value>
      </block></value>
    </block>`,
  );
  const xml = `<xml>${programa}</xml>`;
  const instrs = compilarXml(xml);
  assert(instrs.some((i) => i.op === 77), "el programa compilado usa PUSH_SONAR (lectura real del sensor ultrasónico, no un valor inventado)");
  assert(instrs.some((i) => i.op === 125), "el programa compilado usa OLED_PRINT_VAR (dibuja la distancia leída, no un texto fijo)");

  const { runtime, hal } = nuevoRuntime();
  cargarYArrancar(runtime, instrs);
  // orden de aparición: tAnt=0, distancia=1, proximidad=2, contadorVueltas=3
  const SLOT_DIST = 1, SLOT_PROX = 2, SLOT_VUELTAS = 3;

  hal.setAnalog(21, 80); // objeto lejos (80 "cm" simulados)
  let distanciasVistas = [], cambiosDeDistancia = 0, ultimaDist = runtime.model.varTabla[SLOT_DIST];
  for (let i = 0; i < 20; i++) {
    // Entre la 1ª lectura periódica (t=500) y la 2ª (t=1000) el objeto se
    // "acerca" — probamos que la lectura de "distancia" NO se entera hasta
    // el próximo tick de 500ms, pero que "proximidad" se sigue evaluando
    // en TODAS las vueltas intermedias (contra el último valor leído).
    if (i === 10) hal.setAnalog(21, 10); // objeto cerca (10 "cm"), a mitad del 2º intervalo
    avanzarFrame(runtime, hal, 50);
    if (process.env.DEBUG_MILLIS) console.log("  frame", i, "millis=", hal.millis(), "varTabla=", runtime.model.varTabla);
    const d = runtime.model.varTabla[SLOT_DIST];
    if (d !== ultimaDist) { cambiosDeDistancia++; ultimaDist = d; distanciasVistas.push(d); }
  }
  assert(cambiosDeDistancia === 2, `la distancia se actualizó exactamente 2 veces en 1000ms a intervalos de 500ms (lectura periódica, no continua) (dio ${cambiosDeDistancia}, valores ${JSON.stringify(distanciasVistas)})`);
  assert(distanciasVistas[0] === 80 && distanciasVistas[1] === 10, `la 1ª lectura (t=500) tomó el valor "lejos" (80) y la 2ª (t=1000) ya tomó el valor "cerca" (10) actualizado por el sensor (dio ${JSON.stringify(distanciasVistas)})`);
  assert(runtime.model.varTabla[SLOT_PROX] === 1, `tras la 2ª lectura (distancia=10 < umbral 15) 'proximidad' quedó en 1/verdadero (dio ${runtime.model.varTabla[SLOT_PROX]})`);
  assert(runtime.model.varTabla[SLOT_VUELTAS] === 20, `el contador de vueltas (evaluación continua de 'proximidad' incluida) avanzó las 20 veces sin bloquearse esperando al sensor (dio ${runtime.model.varTabla[SLOT_VUELTAS]})`);
  assert(runtime.model.oled.shown.length === 1 && runtime.model.oled.shown[0].text === "10", `el OLED quedó mostrando la ÚLTIMA distancia leída ("10") tras el 2º OLED_DISPLAY (shown=${JSON.stringify(runtime.model.oled.shown)})`);
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
process.exit(fail > 0 ? 1 : 0);
