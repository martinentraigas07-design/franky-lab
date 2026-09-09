/**
 * FRANKY LAB — Provider franky-server-4.0 / Monitor Serie Virtual
 *
 * Puerto de la infraestructura transversal real (frankyLog()/flog()/
 * flogThrottle()/monitorContextoActual(), buffer circular de 40
 * entradas) — SOLO la infraestructura y una lista CERRADA de puntos de
 * log (ver runtime.ts/sumoEngine.ts), no los ~30 call-sites completos
 * del `.ino`.
 *
 * DIFERENCIAS DOCUMENTADAS (confirmadas explícitamente antes de
 * implementar):
 * - Sin `Serial.println()` — no hay puerto serie físico en el LAB.
 * - Sin estadísticas de timing OLED en microsegundos, sin
 *   `I2C_ANOMALY`/`SYSTEM_RECOVERY` — dependen de medir un bus I2C
 *   físico real; una llamada simulada es esencialmente instantánea, y
 *   cualquier número acá sería inventado, no medido.
 * - `generarLogTexto()` es una versión REDUCIDA del real: incluye solo
 *   lo que el LAB puede conocer de verdad (firmware virtual, uptime
 *   simulado, modo, programa Blockly, buffer de eventos) y declara
 *   explícitamente qué datos existen SOLO en hardware físico (reset
 *   reason, heap libre, clientes WiFi) en vez de inventarlos.
 */
import { FirmwareModel, RobotMode, MONITOR_BUF_N, MONITOR_MSG_LEN } from "./model.js";
import { RobotHAL } from "../../../core/src/robotHal.js";

export type NivelLog = "I" | "D" | "W" | "E";

/** Réplica de modoTexto() real — nombre completo de cada RobotMode. */
export function modoTexto(m: RobotMode): string {
  switch (m) {
    case RobotMode.IDLE: return "IDLE";
    case RobotMode.MICRO: return "MICROSUMO";
    case RobotMode.MINI: return "MINISUMO";
    case RobotMode.VIVERO: return "VIVERO";
    case RobotMode.METEO: return "METEO";
    case RobotMode.ALARMA: return "ALARMA";
    case RobotMode.ACCESO: return "ACCESO";
    case RobotMode.BLOQUES: return "BLOQUES";
    default: return "?";
  }
}

/** Réplica de monitorContextoActual() real — agrupa MINI/MICRO en "SUMO". */
export function monitorContextoActual(model: FirmwareModel): string {
  switch (model.currentMode) {
    case RobotMode.MINI:
    case RobotMode.MICRO: return "SUMO";
    case RobotMode.BLOQUES: return "BLOCKLY";
    case RobotMode.VIVERO: return "VIVERO";
    case RobotMode.METEO: return "METEO";
    case RobotMode.ALARMA: return "ALARMA";
    case RobotMode.ACCESO: return "ACCESO";
    default: return "SERVER";
  }
}

/**
 * Réplica de frankyLog() real, SIN el `Serial.println()` a USB (sin
 * equivalente físico en el LAB, diferencia documentada). Los mensajes
 * DEBUG se descartan del buffer si `debugEnabled==false`, igual que el
 * real (el real igual los manda por USB; acá no hay a dónde mandarlos).
 */
export function frankyLog(model: FirmwareModel, hal: RobotHAL, nivel: NivelLog, contexto: string, msg: string): void {
  if (nivel === "D" && !model.debugEnabled) return;
  const linea = `[${nivel}][${contexto}] ${msg}`;
  const entry = model.monitorBuf[model.monitorHead];
  entry.seq = model.monitorSeq++;
  entry.ms = hal.millis();
  entry.msg = linea.length > MONITOR_MSG_LEN - 1 ? linea.slice(0, MONITOR_MSG_LEN - 1) : linea;
  model.monitorHead = (model.monitorHead + 1) % MONITOR_BUF_N;
}

/** Atajo — usa el contexto automático del modo activo, igual que flog() real. */
export function flog(model: FirmwareModel, hal: RobotHAL, nivel: NivelLog, msg: string): void {
  frankyLog(model, hal, nivel, monitorContextoActual(model), msg);
}

/**
 * Réplica de flogThrottle() real: hasta N categorías con su propio
 * "último momento de log". Categoría no registrada -> no bloquea, deja
 * pasar (mismo criterio que el real).
 */
export function flogThrottle(model: FirmwareModel, hal: RobotHAL, categoria: string, minMs: number): boolean {
  const cat = model.monitorCats.find((c) => c.nombre === categoria);
  if (!cat) return true;
  const ahora = hal.millis();
  if (ahora - cat.ultimoMs < minMs) return false;
  cat.ultimoMs = ahora;
  return true;
}

export interface MonitorLogEntryJson {
  seq: number;
  ms: number;
  msg: string;
}
export interface MonitorLogResponse {
  debug: boolean;
  entradas: MonitorLogEntryJson[];
}

/** Réplica de handleMonitorLog() real — solo lectura, sin efectos secundarios. */
export function generarMonitorLogJson(model: FirmwareModel, since: number): MonitorLogResponse {
  const total = model.monitorSeq < MONITOR_BUF_N ? model.monitorSeq : MONITOR_BUF_N;
  const start = model.monitorSeq < MONITOR_BUF_N ? 0 : model.monitorHead;
  const entradas: MonitorLogEntryJson[] = [];
  for (let i = 0; i < total; i++) {
    const e = model.monitorBuf[(start + i) % MONITOR_BUF_N];
    if (e.seq <= since) continue;
    entradas.push({ seq: e.seq, ms: e.ms, msg: e.msg });
  }
  return { debug: model.debugEnabled, entradas };
}

function formatearUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/**
 * Réplica REDUCIDA Y HONESTA de generarLogTexto() real — ver cabecera
 * del archivo. Declara explícitamente, con su propia sección, qué datos
 * del real NO están acá porque solo existen en hardware físico, en vez
 * de completarlos con valores inventados.
 */
export function generarLogTexto(model: FirmwareModel, hal: RobotHAL): string {
  let o = "";
  o += "FRANKY LAB -- LOG VIRTUAL (simulacion en navegador, NO es un ESP32 fisico)\n";
  o += "--------------------------------\n";
  o += "Firmware: 3.2-LNR (FRANKY LAB virtual)\n";
  o += `Uptime (simulado, tiempo del HAL virtual): ${formatearUptime(hal.millis())}\n`;
  o += `I2C: ${model.i2cEnabled ? "habilitado" : "deshabilitado"}  SDA=GPIO${model.i2cSda} SCL=GPIO${model.i2cScl}\n`;
  o += `SPI: ${model.spiEnabled ? "habilitado" : "deshabilitado"}\n`;
  o += `Modo actual: ${monitorContextoActual(model)} (${modoTexto(model.currentMode)})  ejecutando=${model.modeRunning ? "si" : "no"}\n`;
  o += `Blockly: progLen=${model.programa.length} progPC=${model.progPC}\n`;
  o += "--------------------------------\n";
  o += "DATOS QUE SOLO EXISTEN EN UN ESP32 FISICO (no simulados, deliberadamente omitidos):\n";
  o += "  - Motivo de reinicio (reset reason)\n";
  o += "  - Heap libre (RAM real)\n";
  o += "  - Clientes WiFi conectados al AP\n";
  o += "  - Timing real de OLED_DISPLAY en microsegundos / deteccion de anomalias I2C\n";
  o += "--------------------------------\n";
  o += `EVENTOS (buffer circular, hasta ${MONITOR_BUF_N} mas recientes)\n`;
  o += "--------------------------------\n";
  const total = model.monitorSeq < MONITOR_BUF_N ? model.monitorSeq : MONITOR_BUF_N;
  const start = model.monitorSeq < MONITOR_BUF_N ? 0 : model.monitorHead;
  if (total === 0) o += "(sin eventos registrados todavia)\n";
  for (let i = 0; i < total; i++) {
    const e = model.monitorBuf[(start + i) % MONITOR_BUF_N];
    o += `[SEQ=${e.seq}][T=${e.ms}ms] ${e.msg}\n`;
  }
  return o;
}
