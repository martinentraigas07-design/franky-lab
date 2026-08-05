export const PIN = {
    motorIzqFwd: 5,
    motorIzqRev: 4,
    motorDerFwd: 3,
    motorDerRev: 2,
    led: 8,
    boton: 9,
};
/** Réplica de move(dir, spd) real: dirección con letra, trim aplicado. */
export function moveDirLetter(model, hal, dir, spd) {
    const sA = Math.round((spd * model.trimA) / 255);
    const sB = Math.round((spd * model.trimB) / 255);
    hal.pwmWrite(PIN.motorIzqFwd, 0);
    hal.pwmWrite(PIN.motorIzqRev, 0);
    hal.pwmWrite(PIN.motorDerFwd, 0);
    hal.pwmWrite(PIN.motorDerRev, 0);
    switch (dir) {
        case "f":
            hal.pwmWrite(PIN.motorIzqFwd, sA);
            hal.pwmWrite(PIN.motorDerFwd, sB);
            model.pwmA = sA;
            model.pwmB = sB;
            break;
        case "b":
            hal.pwmWrite(PIN.motorIzqRev, sA);
            hal.pwmWrite(PIN.motorDerRev, sB);
            model.pwmA = sA;
            model.pwmB = sB;
            break;
        case "l":
            hal.pwmWrite(PIN.motorIzqRev, sA);
            hal.pwmWrite(PIN.motorDerFwd, sB);
            model.pwmA = sA;
            model.pwmB = sB;
            break;
        case "r":
            hal.pwmWrite(PIN.motorIzqFwd, sA);
            hal.pwmWrite(PIN.motorDerRev, sB);
            model.pwmA = sA;
            model.pwmB = sB;
            break;
        default: break;
    }
}
/** Réplica de moveDiff(spdA, spdB) real: velocidades independientes con signo. */
export function moveDiff(model, hal, spdA, spdB) {
    const rA = Math.round((Math.abs(spdA) * model.trimA) / 255);
    const rB = Math.round((Math.abs(spdB) * model.trimB) / 255);
    hal.pwmWrite(PIN.motorIzqFwd, spdA > 0 ? rA : 0);
    hal.pwmWrite(PIN.motorIzqRev, spdA < 0 ? rA : 0);
    hal.pwmWrite(PIN.motorDerFwd, spdB > 0 ? rB : 0);
    hal.pwmWrite(PIN.motorDerRev, spdB < 0 ? rB : 0);
    model.pwmA = rA;
    model.pwmB = rB;
}
export function stopMotorsShared(model, hal) {
    hal.pwmWrite(PIN.motorIzqFwd, 0);
    hal.pwmWrite(PIN.motorIzqRev, 0);
    hal.pwmWrite(PIN.motorDerFwd, 0);
    hal.pwmWrite(PIN.motorDerRev, 0);
    model.pwmA = 0;
    model.pwmB = 0;
}
