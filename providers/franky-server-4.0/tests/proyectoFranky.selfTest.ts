/**
 * Regresión — sistema de Proyecto FRANKY (.franky), formato v2, contra el
 * firmware real (generarProyectoJson()/handleProyectoImport()/
 * proyectoValidarSumo() etc.). Incluye el alcance simplificado acordado
 * explícitamente para esta fase (I2C con SDA/SCL fijo, Blockly XML no
 * persistido del lado del "robot" — ver firmware/proyecto.ts).
 */
import { StubHAL } from "../../../core/src/stubHal.js";
import { FirmwareRuntime } from "../firmware/runtime.js";
import { defaultFirmwareModel, defaultSumoConfigMini, RobotMode } from "../firmware/model.js";
import { PROYECTO_FORMAT } from "../firmware/proyecto.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function nuevoRuntime() {
  const hal = new StubHAL();
  return new FirmwareRuntime(defaultFirmwareModel(), hal);
}

console.log("1. exportProyecto(): formato v2, forma exacta del .ino real");
{
  const runtime = nuevoRuntime();
  const r = runtime.exportProyecto();
  assert(r.ok === true, "export siempre ok");
  const p = (r as { ok: true; data: any }).data;
  assert(p.format === PROYECTO_FORMAT && p.format === "FRANKY", "format=FRANKY");
  assert(p.version === 2, `version=2 (dio ${p.version})`);
  assert(typeof p.firmware === "string", "incluye campo firmware");
  assert(p.sumo.mini.velBusqueda === 145 && p.sumo.mini.intGiro === 130, "sumo.mini trae velBusqueda/intGiro (v2)");
  assert(p.sumo.mini.spdBuscExt === 210 && p.sumo.mini.spdBuscInt === 80, "sumo.mini TAMBIÉN trae spdBuscExt/spdBuscInt reconstruidos (compat v1)");
  assert(p.sumo.mini.durBarrido !== undefined, "sumo.mini trae durBarrido (sección 'completo')");
  assert(p.sumo.micro.durBarrido === undefined, "sumo.micro NO trae durBarrido (micro no es 'completo', igual que proyectoJsonSumo() real)");
  assert(p.sumo.perfilActivo === 0, "perfilActivo refleja cfgActivaKey inicial (mini=0)");
  assert(p.i2c.sda === 6 && p.i2c.scl === 7, `i2c.sda/scl refleja el par activo del modelo (default 6/7, dio ${p.i2c.sda}/${p.i2c.scl})`);
  assert(p.trim.motorA === 255 && p.trim.motorB === 255, "trim refleja el Firmware Model");
  assert(p.blockly.xml === null, "blockly.xml siempre null en el export del LAB (ver nota de alcance)");
}

function proyectoBase(overrides: any = {}) {
  const runtime = nuevoRuntime();
  const base = (runtime.exportProyecto() as { ok: true; data: any }).data;
  return { ...base, ...overrides };
}

console.log("\n2. importProyecto(): round-trip export -> import no cambia nada (idempotente)");
{
  const runtime = nuevoRuntime();
  const exportado = (runtime.exportProyecto() as { ok: true; data: any }).data;
  const r = runtime.importProyecto(exportado);
  assert(r.ok === true, `round-trip se acepta (error: ${r.ok ? "" : r.error})`);
  assert(runtime.model.cfgMini.velBusqueda === 145, "velBusqueda de Mini no cambia tras el round-trip");
}

console.log("\n3. importProyecto(): atomicidad — un error en CUALQUIER sección no aplica NADA");
{
  const runtime = nuevoRuntime();
  const antes = JSON.stringify(runtime.model.cfgMini);
  const malo = proyectoBase();
  malo.trim.motorA = 9999; // fuera de rango 0-255 -> debe abortar TODO el import
  const r = runtime.importProyecto(malo);
  assert(r.ok === false, "se rechaza por trim.motorA fuera de rango");
  assert(JSON.stringify(runtime.model.cfgMini) === antes, "cfgMini NO se tocó a pesar de que su sección era válida (todo o nada)");
  assert(runtime.model.trimA === 255, "trimA tampoco se tocó (quedó en el default)");
}

console.log("\n4. importProyecto(): version 1 (spdBuscExt/spdBuscInt) migra correctamente a velBusqueda/intGiro");
{
  const runtime = nuevoRuntime();
  const v1 = proyectoBase({ version: 1 });
  delete v1.sumo.mini.velBusqueda;
  delete v1.sumo.mini.intGiro;
  v1.sumo.mini.spdBuscExt = 210;
  v1.sumo.mini.spdBuscInt = 80;
  const r = runtime.importProyecto(v1);
  assert(r.ok === true, `version 1 se acepta (error: ${r.ok ? "" : r.error})`);
  assert(runtime.model.cfgMini.velBusqueda === 145 && runtime.model.cfgMini.intGiro === 130,
    "spdBuscExt=210/spdBuscInt=80 migra a velBusqueda=145/intGiro=130 (misma fórmula que el firmware real)");
}

console.log("\n5. importProyecto(): rechaza version no soportada");
{
  const runtime = nuevoRuntime();
  const malo = proyectoBase({ version: 99 });
  const r = runtime.importProyecto(malo);
  assert(r.ok === false && /[Vv]ersion/.test(r.ok ? "" : r.error), "version 99 se rechaza explícitamente");
}

console.log("\n6. importProyecto(): I2C ahora acepta cualquier par válido del pool {6,7,10,20,21} (FASE GPIO/I2C cerró la limitación anterior)");
{
  const runtime = nuevoRuntime();
  const malo = proyectoBase();
  malo.i2c.sda = 99; malo.i2c.scl = 21; malo.i2c.enabled = true; // 99 no pertenece al pool real
  const r = runtime.importProyecto(malo);
  assert(r.ok === false, "GPIO fuera del pool I2C real se rechaza");
  assert(runtime.model.i2cEnabled === false, "i2cEnabled no se tocó tras el rechazo");
}
{
  const runtime = nuevoRuntime();
  const malo = proyectoBase();
  malo.i2c.sda = 10; malo.i2c.scl = 10; malo.i2c.enabled = true; // sda===scl
  const r = runtime.importProyecto(malo);
  assert(r.ok === false, "SDA=SCL se rechaza");
}
{
  const runtime = nuevoRuntime();
  const ok = proyectoBase();
  ok.i2c.sda = 10; ok.i2c.scl = 20; ok.i2c.enabled = true; // par válido distinto del default 6/7
  const r = runtime.importProyecto(ok);
  assert(r.ok === true, `i2c con un par válido del pool se acepta (error: ${r.ok ? "" : r.error})`);
  assert(runtime.model.i2cEnabled === true && runtime.model.i2cSda === 10 && runtime.model.i2cScl === 20, "i2cEnabled/i2cSda/i2cScl se aplicaron");
}

console.log("\n7. importProyecto(): perfilActivo cambia cfgActivaKey (solo si el robot está IDLE)");
{
  const runtime = nuevoRuntime();
  const p = proyectoBase();
  p.sumo.perfilActivo = 1; // micro
  const r = runtime.importProyecto(p);
  assert(r.ok === true, "import válido con perfilActivo=1");
  assert(runtime.model.cfgActivaKey === "micro", "cfgActivaKey pasó a 'micro'");
}
{
  const runtime = nuevoRuntime();
  runtime.startSumo("mini"); // robot NO está IDLE
  const p = proyectoBase();
  p.sumo.perfilActivo = 1;
  runtime.importProyecto(p);
  assert(runtime.model.cfgActivaKey === "mini", "con Sumo corriendo, el perfil activo NO se reasigna en caliente (mismo criterio que configureSumo())");
}

console.log("\n8. importProyecto(): blockly.xml se valida pero NUNCA se aplica al Firmware Model (ver nota de alcance)");
{
  const runtime = nuevoRuntime();
  const p = proyectoBase();
  p.blockly.xml = "<xml><block type=\"f_adelante\"></block></xml>";
  const r = runtime.importProyecto(p);
  assert(r.ok === true, "XML bien formado se acepta");
  assert(r.ok === true && r.data.blocklyXml === p.blockly.xml, "el XML validado se devuelve al caller (para que el navegador lo aplique)");
  assert(runtime.model.programa.length === 0, "el XML NO se compiló ni se cargó al programa del Firmware Model (responsabilidad del navegador)");
}
{
  const runtime = nuevoRuntime();
  const p = proyectoBase();
  p.blockly.xml = "esto no es XML de Blockly";
  const r = runtime.importProyecto(p);
  assert(r.ok === false, "XML mal formado se rechaza (aborta TODO el import, igual que el firmware real)");
}
{
  const runtime = nuevoRuntime();
  const p = proyectoBase();
  p.blockly.xml = null;
  const r = runtime.importProyecto(p);
  assert(r.ok === true, "blockly.xml=null es válido (proyecto sin programa Blockly todavía)");
}

console.log("\n9. importProyecto(): secciones faltantes se rechazan (no hay aplicación parcial)");
{
  const runtime = nuevoRuntime();
  const sinI2c = proyectoBase();
  delete sinI2c.i2c;
  const r = runtime.importProyecto(sinI2c);
  assert(r.ok === false, 'falta la sección "i2c" -> se rechaza');
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
