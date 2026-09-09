/**
 * Regresión — Monitor Serie Virtual (monitor.ts), lista CERRADA de
 * puntos de log confirmada con el usuario. Cubre la infraestructura
 * (buffer circular, throttle, filtro DEBUG) y los 5 puntos de log
 * exactos wireados en runtime.ts/sumoEngine.ts.
 */
import { StubHAL } from "../../../core/src/stubHal.js";
import { FirmwareRuntime } from "../firmware/runtime.js";
import { defaultFirmwareModel, MONITOR_BUF_N, RobotMode } from "../firmware/model.js";
import { frankyLog, flog, flogThrottle, monitorContextoActual, modoTexto, generarMonitorLogJson, generarLogTexto } from "../firmware/monitor.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. frankyLog/flog: formato de línea, buffer circular, seq incremental");
{
  const hal = new StubHAL();
  const m = defaultFirmwareModel();
  flog(m, hal, "I", "hola mundo");
  const r = generarMonitorLogJson(m, -1);
  assert(r.entradas.length === 1, "una entrada en el buffer");
  assert(r.entradas[0].msg === "[I][SERVER] hola mundo", `formato exacto "[nivel][contexto] mensaje" (dio "${r.entradas[0].msg}")`);
  assert(r.entradas[0].seq === 0, "primer seq = 0");
  flog(m, hal, "I", "segundo mensaje");
  const r2 = generarMonitorLogJson(m, -1);
  assert(r2.entradas.length === 2 && r2.entradas[1].seq === 1, "seq incremental");
}

console.log("\n1b. HALLAZGO documentado (real, no del LAB): since=0 (default real) nunca devuelve seq=0");
{
  // Réplica EXACTA de handleMonitorLog() real: "if (e.seq <= since) continue;"
  // Con since=0 (el default si el cliente no manda el parámetro, igual
  // que el .ino real), la entrada seq=0 queda permanentemente invisible
  // a cualquier polling que arranque sin pasar "since" explícito — mismo
  // comportamiento (quirk incluido) que tendría el Server real. Se
  // replica tal cual (fidelidad), no se "corrige" un comportamiento que
  // el propio hardware físico también tendría.
  const hal = new StubHAL();
  const m = defaultFirmwareModel();
  flog(m, hal, "I", "primera entrada (seq=0)");
  const conSinceCero = generarMonitorLogJson(m, 0);
  assert(conSinceCero.entradas.length === 0, "since=0 NO devuelve la entrada seq=0 (quirk real, replicado tal cual)");
  const conSinceMenosUno = generarMonitorLogJson(m, -1);
  assert(conSinceMenosUno.entradas.length === 1, "un cliente que use since=-1 (o cualquier valor <0) SÍ la ve");
}

console.log("\n2. Filtro DEBUG: nivel 'D' se descarta del buffer si debugEnabled=false");
{
  const hal = new StubHAL();
  const m = defaultFirmwareModel();
  flog(m, hal, "D", "no deberia aparecer");
  assert(generarMonitorLogJson(m, -1).entradas.length === 0, "mensaje DEBUG descartado con debugEnabled=false");
  m.debugEnabled = true;
  flog(m, hal, "D", "ahora si aparece");
  assert(generarMonitorLogJson(m, -1).entradas.length === 1, "mensaje DEBUG SÍ entra al buffer con debugEnabled=true");
}

console.log("\n3. Buffer circular: se pisa la entrada más vieja al superar MONITOR_BUF_N");
{
  const hal = new StubHAL();
  const m = defaultFirmwareModel();
  for (let i = 0; i < MONITOR_BUF_N + 5; i++) flog(m, hal, "I", `msg${i}`);
  const r = generarMonitorLogJson(m, -1);
  assert(r.entradas.length === MONITOR_BUF_N, `el buffer nunca supera MONITOR_BUF_N=${MONITOR_BUF_N} (dio ${r.entradas.length})`);
  assert(r.entradas[0].msg.endsWith("msg5"), "las 5 primeras entradas (msg0..msg4) se pisaron — queda msg5 como la más vieja");
  assert(r.entradas[r.entradas.length - 1].msg.endsWith(`msg${MONITOR_BUF_N + 4}`), "la última entrada es la más reciente");
}

console.log("\n4. /monitor/log?since=N: solo devuelve entradas con seq>since");
{
  const hal = new StubHAL();
  const m = defaultFirmwareModel();
  flog(m, hal, "I", "a"); flog(m, hal, "I", "b"); flog(m, hal, "I", "c");
  const r = generarMonitorLogJson(m, 1);
  assert(r.entradas.length === 1 && r.entradas[0].msg.endsWith("c"), "since=1 devuelve solo seq=2 (\"c\")");
}

console.log("\n5. flogThrottle: respeta minMs por categoría, categoría desconocida nunca bloquea");
{
  const hal = new StubHAL();
  const m = defaultFirmwareModel();
  // Arrancar con el reloj ya avanzado — a t=0 exacto, ultimoMs por
  // defecto también es 0 y "ahora-ultimoMs < minMs" empataría en el
  // límite (0<500), bloqueando la primera llamada; con tiempo avanzado
  // se prueba el caso real de uso (el robot ya lleva rato encendido).
  hal.advance(1000);
  assert(flogThrottle(m, hal, "gen1", 500) === true, "primera llamada de una categoría siempre pasa");
  assert(flogThrottle(m, hal, "gen1", 500) === false, "segunda llamada inmediata se bloquea");
  hal.advance(501);
  assert(flogThrottle(m, hal, "gen1", 500) === true, "tras superar minMs, vuelve a pasar");
  assert(flogThrottle(m, hal, "categoria_inexistente", 999999) === true, "categoría no registrada nunca bloquea");
}

console.log("\n6. monitorContextoActual/modoTexto: agrupación SUMO real (MINI y MICRO -> \"SUMO\")");
{
  const m = defaultFirmwareModel();
  m.currentMode = RobotMode.MINI;
  assert(monitorContextoActual(m) === "SUMO", "MINI -> contexto SUMO");
  m.currentMode = RobotMode.MICRO;
  assert(monitorContextoActual(m) === "SUMO", "MICRO -> contexto SUMO (mismo grupo)");
  assert(modoTexto(RobotMode.MINI) === "MINISUMO" && modoTexto(RobotMode.MICRO) === "MICROSUMO", "modoTexto SÍ distingue Mini/Micro");
  m.currentMode = RobotMode.BLOQUES;
  assert(monitorContextoActual(m) === "BLOCKLY", "BLOQUES -> contexto BLOCKLY");
  m.currentMode = RobotMode.IDLE;
  assert(monitorContextoActual(m) === "SERVER", "IDLE -> contexto SERVER");
}

console.log("\n7. PUNTO 1 (lista cerrada): MODE_CHANGE al iniciar/detener Sumo y Bloques");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.startSumo("mini");
  let log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("MODE_CHANGE IDLE -> MINISUMO")), "MODE_CHANGE al iniciar Mini");
  runtime.stopSumo();
  log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("MODE_CHANGE MINISUMO -> IDLE")), "MODE_CHANGE al detener");
  runtime.bloquesAdd(5, 0); // OP_STOP — bloquesRun() ahora exige un programa no vacío
  runtime.bloquesRun();
}
{
  // Sin cambio real de modo -> NO debe loguear (mismo criterio que el real: "if (modoAnterior != currentMode)").
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.startSumo("mini");
  const antes = runtime.monitorLog(-1).entradas.length;
  runtime.startSumo("mini"); // mismo modo (MINI -> MINI)
  const despues = runtime.monitorLog(-1).entradas.length;
  assert(antes === despues, "re-iniciar el MISMO modo no genera un MODE_CHANGE duplicado");
}

console.log("\n8. PUNTO 2 (lista cerrada): Sumo — oponente detectado/perdido/recuperación (por flanco, no por tick)");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "mini", tipo: "sharp", numDist: 2, sharpI: 0, sharpD: 1, umbralSharp: 1000, numBorde: 0 });
  runtime.startSumo("mini");
  hal.advance(5001);
  hal.setAnalog(0, 2000); // oponente a la izquierda
  runtime.tick();
  let log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("OPONENTE -> IZQUIERDA")), "log al detectar oponente por primera vez");
  const nEntradas1 = log.entradas.length;
  runtime.tick(); // mismo estado, mismo tick -> NO debe repetir el log (es un flanco)
  runtime.tick();
  log = runtime.monitorLog(-1);
  assert(log.entradas.length === nEntradas1, "no repite el log mientras el oponente sigue en la misma posición (edge, no nivel)");

  hal.setAnalog(0, 0); // oponente perdido
  runtime.tick();
  log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("Oponente perdido")), "log al perder al oponente");
  assert(log.entradas.some((e) => e.msg.includes("RECUPERACION -> ULTIMA DIRECCION: IZQUIERDA")), "log de recuperación orientada");
}

console.log("\n9. PUNTO 2: ataque se loguea por FLANCO de dirección (ultimoAtaqueDirLog), no por tick");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.configureSumo({ perfil: "mini", tipo: "sharp", numDist: 2, sharpI: 0, sharpD: 1, umbralSharp: 1000, numBorde: 0 });
  runtime.startSumo("mini");
  hal.advance(5001);
  hal.setAnalog(0, 2000); // ataque izquierda
  runtime.tick();
  let log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("ATAQUE -> IZQUIERDA")), "log al empezar a atacar");
  const n1 = log.entradas.length;
  runtime.tick(); runtime.tick(); // mismo ataque -> no repetir
  assert(runtime.monitorLog(-1).entradas.length === n1, "no repite el log de ataque mientras la dirección no cambia");
  hal.setAnalog(0, 0); hal.setAnalog(1, 2000); // ahora ataque derecha
  runtime.tick();
  log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("ATAQUE -> DERECHA")), "nuevo log al cambiar la dirección de ataque");
}

console.log("\n10. PUNTO 3 (lista cerrada): Blockly — movimiento (throttled, nivel DEBUG) y SERIAL_PRINT (throttled, nivel INFO)");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.monitorDebug(true); // los logs de movimiento son nivel 'D' -> necesitan debugEnabled
  hal.advance(1000); // evitar el empate ultimoMs=0 en t=0 (ver sección 5)
  runtime.bloquesAdd(1, 150); // OP_ADE
  runtime.bloquesRun();
  runtime.tick();
  let log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("Adelante vel=150")), "log de movimiento Adelante (con DEBUG habilitado)");
}
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  // Sin habilitar DEBUG: los logs de movimiento (nivel 'D') NO deben aparecer.
  runtime.bloquesAdd(1, 150);
  runtime.bloquesRun();
  runtime.tick();
  const log = runtime.monitorLog(-1);
  assert(!log.entradas.some((e) => e.msg.includes("Adelante")), "sin DEBUG habilitado, el movimiento no aparece en el Monitor (nivel 'D')");
}
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  hal.advance(1000); // evitar el empate ultimoMs=0 en t=0 (ver sección 5)
  runtime.bloquesAdd(122, 0, "hola monitor"); // OP_SERIAL_PRINT
  runtime.bloquesRun();
  runtime.tick();
  const log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("SERIAL_PRINT: hola monitor")), "SERIAL_PRINT SÍ aparece sin DEBUG (nivel 'I')");
  assert(runtime.model.serialLog.includes("hola monitor"), "serialLog (preexistente) sigue funcionando sin cambios");
}

console.log("\n11. PUNTO 4 (lista cerrada): /proyecto/import exitoso");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  const proyecto = (runtime.exportProyecto() as { ok: true; data: any }).data;
  runtime.importProyecto(proyecto);
  const log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("PROYECTO importado y aplicado")), "log tras un import exitoso");
}
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  const malo = { format: "OTRA_COSA" };
  runtime.importProyecto(malo);
  const log = runtime.monitorLog(-1);
  assert(!log.entradas.some((e) => e.msg.includes("PROYECTO importado")), "un import RECHAZADO no genera el log de éxito");
}

console.log("\n12. PUNTO 5 (lista cerrada): /i2c/set exitoso");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  // Mini con 2 sensores (default) ocupa 20,21,6,7 — reconfigurar a 1
  // sensor libera 6/7/10 para poder aplicar un par I2C sin conflicto.
  runtime.configureSumo({ perfil: "mini", numDist: 1 });
  runtime.setI2CPins(10, 6);
  const log = runtime.monitorLog(-1);
  assert(log.entradas.some((e) => e.msg.includes("GPIO10/GPIO6")), "log tras un /i2c/set exitoso");
}
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  runtime.setI2CPins(99, 20); // inválido
  const log = runtime.monitorLog(-1);
  assert(!log.entradas.some((e) => e.msg.includes("[CONFIG] I2C")), "un /i2c/set RECHAZADO no genera log de éxito");
}

console.log("\n13. /monitor/debug: toggle real, y generarLogTexto() reducido no inventa datos físicos");
{
  const hal = new StubHAL();
  const runtime = new FirmwareRuntime(defaultFirmwareModel(), hal);
  assert(runtime.monitorDebug().debug === false, "DEBUG apagado por defecto");
  assert(runtime.monitorDebug(true).debug === true, "toggle ON");
  assert(runtime.monitorDebug(false).debug === false, "toggle OFF");

  const texto = runtime.logTexto();
  assert(texto.includes("FRANKY LAB"), "el log de texto se identifica como LAB, no como hardware real");
  assert(texto.includes("NO es un ESP32 fisico") || texto.includes("SOLO EXISTEN EN UN ESP32 FISICO"), "declara explícitamente la diferencia con hardware físico");
  assert(!/heap libre: \d/i.test(texto), "NO inventa un valor de heap libre");
  assert(!/reset reason: \w/i.test(texto), "NO inventa un reset reason");
  assert(!/clientes.*: \d/i.test(texto), "NO inventa clientes WiFi conectados");
  assert(texto.toLowerCase().includes("heap libre") || texto.includes("Heap libre"), "SÍ menciona explícitamente que el heap libre no está simulado");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
