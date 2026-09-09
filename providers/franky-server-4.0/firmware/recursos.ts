/**
 * FRANKY LAB — Provider franky-server-4.0 / Conflicto de recursos
 *
 * Puerto de hayConflictoRecurso() real (.ino): un recurso (OLED, motor,
 * puerto serie) está "en conflicto" si un programa Blockly lo usa Y
 * está corriendo en este momento — en ese caso, una acción manual del
 * Panel Industrial pisaría lo que Blockly está haciendo.
 *
 * DIFERENCIA DE IMPLEMENTACIÓN (no de comportamiento): el real cachea
 * `progUsaOled` como variable global, actualizada cuando se compila el
 * programa. Acá se calcula al vuelo escaneando `model.programa` — mismo
 * resultado, sin el riesgo de una caché desincronizada tras
 * bloquesAdd()/bloquesDel()/bloquesClear().
 */
import { FirmwareModel, RobotMode } from "./model.js";

/** Réplica de la detección real: progUsaOled se marca cuando el programa contiene cualquier opcode OLED (101-109). */
export function progUsaOled(model: FirmwareModel): boolean {
  return model.programa.some((i) => i.op >= 101 && i.op <= 109);
}

/** Réplica de progUsaMotores real: ADE/ATR/IZQ/DER/STOP/FRENO (opcodes 1-5 y 11). NOTA: el real también marca progUsaMotores=true para OP_PWM_OUT (caso especial, GPIO3 hardcodeado) — el LAB no lo replica todavía por no tener ese opcode mapeado 1:1; simplificación documentada. */
export function progUsaMotores(model: FirmwareModel): boolean {
  return model.programa.some((i) => (i.op >= 1 && i.op <= 5) || i.op === 11);
}

/** Réplica de progUsaSerial real: OP_SERIAL_PRINT (122). */
export function progUsaSerial(model: FirmwareModel): boolean {
  return model.programa.some((i) => i.op === 122);
}

/** Réplica de hayConflictoRecurso(recursoUsadoPorPrograma) real. */
export function hayConflictoRecurso(model: FirmwareModel, recursoUsadoPorPrograma: boolean): boolean {
  return model.currentMode === RobotMode.BLOQUES && model.modeRunning && recursoUsadoPorPrograma;
}
