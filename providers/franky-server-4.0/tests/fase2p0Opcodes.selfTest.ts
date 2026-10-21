/**
 * Pruebas dedicadas a los opcodes de Fase 2 P0 (Unidades 2, 4, 5, 6, 7) que
 * bloques.html ya emitía desde la Fase 2 P0 pero que tickBloques() todavía
 * no ejecutaba — causa raíz reportada en Informe_Causa_Raiz_y_Plan_Correccion_Fase2P0.md:
 * variables con nombre, expresiones aritméticas/booleanas, decisiones,
 * repetición ("repetir N veces"), impresión dinámica por Serial/OLED, y la
 * correspondencia sonar TRIG/ECHO <-> sensor Sumo configurado (SENS-01).
 *
 * Ejercita FirmwareRuntime end-to-end vía bloquesAdd()+bloquesRun()+tick()
 * público (no el switch en aislamiento), para probar también el orden real
 * de pop/push de la pila y el avance de progPC — igual que lo haría
 * bloques.html al compilar y ejecutar un programa real.
 */
import { StubHAL } from "../../../core/src/stubHal.js";
import { FirmwareRuntime } from "../firmware/runtime.js";
import { defaultFirmwareModel, TipoDistSensor } from "../firmware/model.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

interface Ins { op: number; val: number; txt?: string; bitmap?: string }

function nuevoRuntime(): { runtime: FirmwareRuntime; hal: StubHAL } {
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  return { runtime, hal };
}

/** Carga el programa en el Workspace y corre exactamente `ticks` pasos de tickBloques() (vía tick() público). */
function correr(runtime: FirmwareRuntime, ops: Ins[], ticks: number): void {
  for (const i of ops) {
    const r = runtime.bloquesAdd(i.op, i.val, i.txt, i.bitmap);
    if (!r.ok) throw new Error("bloquesAdd() falló: " + (r as { error: string }).error);
  }
  const r = runtime.bloquesRun();
  if (!r.ok) throw new Error("bloquesRun() falló: " + (r as { error: string }).error);
  for (let i = 0; i < ticks; i++) runtime.tick();
}

console.log("1. Variables con nombre: contador = 5+3 = 8 (OP_PUSH, OP_POP_ADD, OP_VAR_SET_EXPR, OP_PUSH_VAR, OP_SERIAL_PRINT_VAR)");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 90, val: 5 },  // PUSH 5
    { op: 90, val: 3 },  // PUSH 3
    { op: 78, val: 0 },  // POP_ADD -> 8
    { op: 82, val: 0 },  // VAR_SET_EXPR varTabla[0] = pop() = 8
    { op: 75, val: 0 },  // PUSH_VAR varTabla[0]
    { op: 124, val: 0 }, // SERIAL_PRINT_VAR
  ], 6);
  assert(runtime.model.varTabla[0] === 8, `varTabla[0] quedó en 8 (dio ${runtime.model.varTabla[0]})`);
  const ultimo = runtime.model.serialLog[runtime.model.serialLog.length - 1];
  assert(ultimo === "8", `Monitor Serie imprimió "8" (dio "${ultimo}")`);
}

console.log("\n2. varGlobal y varTabla[0] son la MISMA celda (réplica exacta de '#define varGlobal varTabla[0]' del .ino)");
{
  const { runtime } = nuevoRuntime();
  runtime.model.varGlobal = 42;
  assert(runtime.model.varTabla[0] === 42, "escribir varGlobal también cambia varTabla[0]");
  runtime.model.varTabla[0] = 99;
  assert(runtime.model.varGlobal === 99, "escribir varTabla[0] también cambia varGlobal (mismo accessor, no una copia)");
}

console.log("\n3. Expresión matemática: resta, multiplicación y división con protección contra /0 (OP_POP_SUB/MUL/DIV)");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 90, val: 10 }, { op: 90, val: 4 }, { op: 79, val: 0 }, // 10-4=6
    { op: 90, val: 2 }, { op: 80, val: 0 },                      // 6*2=12
    { op: 90, val: 0 }, { op: 81, val: 0 },                      // 12/0 -> 0 (no revienta, igual que el .ino)
    { op: 82, val: 1 },                                          // varTabla[1] = 0
  ], 8);
  assert(runtime.model.varTabla[1] === 0, "división por 0 satura a 0, igual que el firmware real (nunca revienta)");
}

console.log("\n4. Decisión SI/SINO con expresión (OP_IF_GT_EXPR) — rama verdadera: 5 > 3");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 90, val: 5 }, { op: 90, val: 3 }, // a=5, b=3
    { op: 85, val: 0 },                      // IF_GT_EXPR: 5>3 -> true -> salta la rama 'sino'
    { op: 60, val: 111 },                    // rama 'sino' (NO debería ejecutarse)
    { op: 60, val: 222 },                    // rama 'si' (debería ejecutarse)
  ], 4);
  assert(runtime.model.varGlobal === 222, `rama verdadera ejecutada (varGlobal dio ${runtime.model.varGlobal}, esperado 222)`);
}

console.log("\n5. Decisión SI/SINO con expresión (OP_IF_LT_EXPR) — rama falsa: 5 < 3 es falso");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 90, val: 5 }, { op: 90, val: 3 }, // a=5, b=3
    { op: 86, val: 0 },                      // IF_LT_EXPR: 5<3 -> false -> NO salta
    { op: 60, val: 111 },                    // rama 'sino' (debería ejecutarse)
    { op: 60, val: 222 },                    // rama 'si' (NO debería ejecutarse)
  ], 4);
  assert(runtime.model.varGlobal === 111, `rama falsa ejecutada (varGlobal dio ${runtime.model.varGlobal}, esperado 111)`);
}

console.log("\n6. REPEAT exactamente 3 veces (OP_REPEAT / OP_REPEAT_END con repeatStack propia, separada de pila[]/callStack)");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 82, val: 0 }, // varTabla[0] = 0 (pila vacía -> popStack devuelve 0, init explícito del contador)
    { op: 74, val: 3 }, // REPEAT 3 -> repeatStack=[3]
    { op: 90, val: 1 }, // PUSH 1          (idx 2, inicio del cuerpo)
    { op: 83, val: 0 }, // VAR_ADD_EXPR varTabla[0] += pop()
    { op: 88, val: 2 }, // REPEAT_END -> si repeatStack.top>0 vuelve al idx 2
  ], 1 + 1 + 3 * 3 /* init + REPEAT + 3 vueltas de (PUSH,ADD,END) */);
  assert(runtime.model.varTabla[0] === 3, `el cuerpo se ejecutó exactamente 3 veces (varTabla[0] dio ${runtime.model.varTabla[0]}, esperado 3)`);
  assert(runtime.model.repeatStack.length === 0, "repeatStack queda vacía al terminar el ciclo (no deja basura apilada para el próximo REPEAT)");
}

console.log("\n7. OLED: texto fijo + texto dinámico conviven en el mismo draft (OP_OLED_PRINT + OP_OLED_PRINT_VAR)");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 101, val: 0 },                                        // OLED_INIT
    { op: 90, val: 0 }, { op: 90, val: 0 }, { op: 103, val: 0 }, // cursor (0,0)
    { op: 104, val: 0, txt: "Dist:" },                           // texto fijo
    { op: 90, val: 20 }, { op: 90, val: 10 }, { op: 103, val: 0 }, // cursor (20,10)
    { op: 90, val: 55 }, { op: 125, val: 0 },                     // valor dinámico 55
  ], 10);
  const textos = runtime.model.oled.draft
    .filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text);
  assert(textos.includes("Dist:"), `el texto fijo "Dist:" quedó dibujado (dio [${textos.join(",")}])`);
  assert(textos.includes("55"), `el valor dinámico "55" quedó dibujado (dio [${textos.join(",")}])`);
}

console.log("\n8. Sonar por Blockly (OP_PUSH_SONAR) — SENS-01: TRIG/ECHO configurados en Sumo (Mini: izq 20/21) devuelven SU lectura simulada");
{
  const { runtime, hal } = nuevoRuntime();
  // El perfil Mini activo por defecto usa SONAR, 1 sensor, trigI=20/echoI=21 (ver defaultSumoConfigMini() en model.ts).
  assert(runtime.model.cfgMini.tipoDistSensor === TipoDistSensor.SONAR, "precondición: el perfil Mini usa sonar por defecto");
  assert(runtime.model.cfgMini.trigI === 20 && runtime.model.cfgMini.echoI === 21, "precondición: TRIG20/ECHO21 es el sonar izq configurado en Mini");
  hal.setAnalog(21, 37); // simula 37cm en el eco izquierdo (misma convención que getLabTelemetry().oponenteSensor)
  correr(runtime, [
    { op: 77, val: 20 * 100 + 21 }, // PUSH_SONAR TRIG=20/ECHO=21 -> coincide con el sonar izq configurado
    { op: 82, val: 2 },             // varTabla[2] = pop()
  ], 2);
  assert(runtime.model.varTabla[2] === 37, `PUSH_SONAR devolvió la lectura simulada del sonar izq (dio ${runtime.model.varTabla[2]}, esperado 37)`);
}

console.log("\n9. Sonar por Blockly — un par TRIG/ECHO que NO corresponde a ningún sonar configurado no inventa un sensor: devuelve 999 (sin eco)");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 77, val: 8 * 100 + 9 }, // TRIG=8/ECHO=9 — no es ninguno de los configurados en Mini (20/21)
    { op: 82, val: 2 },
  ], 2);
  assert(runtime.model.varTabla[2] === 999, `par TRIG/ECHO no configurado devuelve 999 (igual que "sin eco" del firmware real), no inventa un tercer sensor (dio ${runtime.model.varTabla[2]})`);
}

console.log("\n10. Comparación como valor (OP_PUSH_CMP_GT/EQ) + lógica booleana (OP_POP_AND/OP_POP_NOT) + OP_IF_TRUE");
{
  const { runtime } = nuevoRuntime();
  correr(runtime, [
    { op: 90, val: 5 }, { op: 90, val: 3 }, { op: 129, val: 0 }, // PUSH_CMP_GT: 5>3 -> empuja 1
    { op: 90, val: 4 }, { op: 90, val: 4 }, { op: 131, val: 0 }, // PUSH_CMP_EQ: 4==4 -> empuja 1
    { op: 116, val: 0 },                                         // POP_AND: 1 AND 1 -> 1
    { op: 118, val: 0 },                                         // POP_NOT: NOT 1 -> 0
    { op: 119, val: 0 },                                         // IF_TRUE: 0 -> falso -> NO salta
    { op: 60, val: 777 },                                        // se ejecuta porque IF_TRUE no saltó
  ], 10);
  assert(runtime.model.varGlobal === 777, `(5>3) AND (4==4) = verdadero; NOT verdadero = falso; IF_TRUE con 0 no salta (varGlobal dio ${runtime.model.varGlobal}, esperado 777)`);
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
