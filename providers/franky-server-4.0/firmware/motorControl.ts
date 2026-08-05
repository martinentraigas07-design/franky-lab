/**
 * FRANKY LAB — Provider franky-server-4.0 / Control de motores compartido
 *
 * Primitivas de movimiento reutilizadas tanto por comandos manuales
 * (Firmware Runtime) como por la IA de combate Sumo (sumoEngine). Extraídas
 * a un módulo propio para no duplicar la lógica de mapeo de pines entre
 * ambos — son, literalmente, move() y moveDiff() del firmware real.
 */
import { RobotHAL } from "../../../core/src/robotHal.js";
import { FirmwareModel } from "./model.js";

export const PIN = {
  motorIzqFwd: 5,
  motorIzqRev: 4,
  motorDerFwd: 3,
  motorDerRev: 2,
  led: 8,
  boton: 9,
};

/** Réplica de move(dir, spd) real: dirección con letra, trim aplicado. */
export function moveDirLetter(model: FirmwareModel, hal: RobotHAL, dir: string, spd: number): void {
  const sA = Math.round((spd * model.trimA) / 255);
  const sB = Math.round((spd * model.trimB) / 255);
  hal.pwmWrite(PIN.motorIzqFwd, 0);
  hal.pwmWrite(PIN.motorIzqRev, 0);
  hal.pwmWrite(PIN.motorDerFwd, 0);
  hal.pwmWrite(PIN.motorDerRev, 0);
  switch (dir) {
    case "f": hal.pwmWrite(PIN.motorIzqFwd, sA); hal.pwmWrite(PIN.motorDerFwd, sB); model.pwmA = sA; model.pwmB = sB; break;
    case "b": hal.pwmWrite(PIN.motorIzqRev, sA); hal.pwmWrite(PIN.motorDerRev, sB); model.pwmA = sA; model.pwmB = sB; break;
    case "l": hal.pwmWrite(PIN.motorIzqRev, sA); hal.pwmWrite(PIN.motorDerFwd, sB); model.pwmA = sA; model.pwmB = sB; break;
    case "r": hal.pwmWrite(PIN.motorIzqFwd, sA); hal.pwmWrite(PIN.motorDerRev, sB); model.pwmA = sA; model.pwmB = sB; break;
    default: break;
  }
}

/** Réplica de moveDiff(spdA, spdB) real: velocidades independientes con signo. */
export function moveDiff(model: FirmwareModel, hal: RobotHAL, spdA: number, spdB: number): void {
  const rA = Math.round((Math.abs(spdA) * model.trimA) / 255);
  const rB = Math.round((Math.abs(spdB) * model.trimB) / 255);
  hal.pwmWrite(PIN.motorIzqFwd, spdA > 0 ? rA : 0);
  hal.pwmWrite(PIN.motorIzqRev, spdA < 0 ? rA : 0);
  hal.pwmWrite(PIN.motorDerFwd, spdB > 0 ? rB : 0);
  hal.pwmWrite(PIN.motorDerRev, spdB < 0 ? rB : 0);
  model.pwmA = rA;
  model.pwmB = rB;
}

export function stopMotorsShared(model: FirmwareModel, hal: RobotHAL): void {
  hal.pwmWrite(PIN.motorIzqFwd, 0);
  hal.pwmWrite(PIN.motorIzqRev, 0);
  hal.pwmWrite(PIN.motorDerFwd, 0);
  hal.pwmWrite(PIN.motorDerRev, 0);
  model.pwmA = 0;
  model.pwmB = 0;
}
