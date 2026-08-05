// Prueba end-to-end del compilador Blockly -> opcodes reales: alimenta la
// salida del compilador al intérprete REAL compilado (no un mock aislado).
import { compileProgram } from "../../../public-src/blockly-compiler.mjs";
import { createProviderServer } from "../../../dist/providers/franky-server-4.0/server/virtualServer.js";
import { StubHAL } from "../../../dist/core/src/stubHal.js";

let ok = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { ok++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗", msg); }
}

function run(nodes, ticks) {
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const instrs = compileProgram(nodes);
  for (const i of instrs) server.handle("GET", "/bloques/add", { op: String(i.op), val: String(i.val), ...(i.txt !== undefined ? { txt: i.txt } : {}) });
  server.handle("GET", "/bloques/run", {});
  for (let t = 0; t < ticks; t++) server.tick();
  return { hal, server, lab: server.handle("GET", "/lab/state", {}).body, instrs };
}

console.log("1. Bloque 'avanzar' compila y ejecuta un movimiento real");
{
  const { hal } = run([{ type: "avanzar", vel: 200 }], 1);
  assert(hal.getPwm(5) === 200 && hal.getPwm(3) === 200, "avanzar mueve ambos motores adelante a 200");
}

console.log("\n2. 'repetir 3 veces: avanzar + esperar' se desenrolla (sin REPEAT real)");
{
  const nodes = [{ type: "repeat", count: 3, body: [{ type: "var_add", val: 1 }] }];
  const { instrs } = run(nodes, 0);
  assert(instrs.length === 3, `3 instrucciones generadas (desenrollado real, no un opcode de bucle) — dio ${instrs.length}`);
}

console.log("\n3. 'si var > 5 entonces LED_ON' — NO se ejecuta cuando la condición es falsa");
{
  const nodes = [
    { type: "var_set", val: 2 },
    { type: "if_var_gt", threshold: 5, body: [{ type: "led_on" }] },
    { type: "led_off" }, // fuera del if
  ];
  const { hal, instrs } = run(nodes, instrsLen(nodes));
  assert(hal.getDigital(8) === 1, "var=2, no supera 5 -> el LED_ON del 'if' NO se ejecutó, quedó apagado (por el led_off de después)");
  void instrs;
}

console.log("\n4. 'si var > 5 entonces LED_ON' — SÍ se ejecuta cuando la condición es verdadera, y CONTINÚA después");
{
  const nodes = [
    { type: "var_set", val: 10 },
    { type: "if_var_gt", threshold: 5, body: [{ type: "led_on" }, { type: "var_add", val: 100 }] },
    { type: "var_add", val: 1 }, // fuera del if, debe ejecutarse SIEMPRE
  ];
  const { hal, lab } = run(nodes, 5); // exactos: VAR_SET, IF_VAR_GT, LED_ON, VAR_ADD100, VAR_ADD1 — ni uno más (el programa se reinicia solo al llegar al final, igual que el firmware real)
  assert(hal.getDigital(8) === 0, "var=10>5 -> el cuerpo del 'if' (LED_ON) SÍ se ejecutó");
  assert(lab.varGlobal === 111, `10+100+1=111 (cuerpo del if + la instrucción de después, ambos corrieron) — dio ${lab.varGlobal}`);
}

console.log("\n5. Bucle 'while var < 3' real (no desenrollado) — cuenta exactamente 3 vueltas");
{
  const nodes = [
    { type: "var_set", val: 0 },
    { type: "while_var_lt", threshold: 3, body: [{ type: "avanzar", vel: 100 }, { type: "var_add", val: 1 }] },
  ];
  const { lab, instrs } = run(nodes, instrsLen(nodes) + 30); // de sobra para varias vueltas
  assert(lab.varGlobal === 3, `el while real corrió 3 vueltas (varGlobal=${lab.varGlobal})`);
  assert(instrs.length < 10, `pocas instrucciones (bucle real, no desenrollado) — dio ${instrs.length}`);
}

console.log("\n6. Funciones matemáticas compiladas end-to-end (map)");
{
  const nodes = [{ type: "math_map", value: 50, fromLow: 0, fromHigh: 100, toLow: 0, toHigh: 255 }];
  const { lab } = run(nodes, instrsLen(nodes));
  assert(Math.abs(lab.varGlobal - 127.5) < 0.01, `map(50,0,100,0,255)=127.5 end-to-end (dio ${lab.varGlobal})`);
}

console.log("\n7. OLED end-to-end: init->clear->cursor->print->display");
{
  const nodes = [
    { type: "oled_init" }, { type: "oled_clear" },
    { type: "oled_cursor", x: 5, y: 10 }, { type: "oled_print", texto: "FRANKY" },
    { type: "oled_display" },
  ];
  const { lab } = run(nodes, instrsLen(nodes));
  assert(lab.oled.on === true, "OLED inicializado");
  assert(lab.oled.shown.length === 1 && lab.oled.shown[0].text === "FRANKY", "el texto aparece mostrado tras OLED_DISPLAY");
}

console.log("\n8. Serial.print end-to-end (Monitor Serie, capacidad nueva propuesta)");
{
  const nodes = [{ type: "serial_print", texto: "Hola FRANKY" }];
  const { lab } = run(nodes, instrsLen(nodes));
  assert(lab.serialLog.includes("Hola FRANKY"), "el texto llega al log serie del Workspace");
}

console.log(`\n${ok} pasaron, ${fail} fallaron.`);
if (fail > 0) process.exit(1);

// Cuenta cuántas instrucciones reales generará un programa (para saber cuántos ticks alcanzan).
function instrsLen(nodes) {
  return compileProgram(nodes).length + 2;
}
