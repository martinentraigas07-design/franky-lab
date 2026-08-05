import { RobotMode, EvadeState, TipoDistSensor, MAX_INST, } from "./model.js";
import { validateSumoADC, contarADCUsados, pinBloqueadoPorBus } from "./validation.js";
import { ejecutarSumo, leerBordeIzq, leerBordeDer, leerOponente } from "./sumoEngine.js";
import { moveDirLetter, stopMotorsShared, PIN } from "./motorControl.js";
function constrain(val, lo, hi) {
    if (Number.isNaN(val))
        return lo;
    return Math.max(lo, Math.min(hi, val));
}
/** Pop seguro de la pila de trabajo — 0 si está vacía (programa mal formado), nunca revienta. */
function popStack(m) {
    const v = m.pila.pop();
    return v !== undefined ? v : 0;
}
export class FirmwareRuntime {
    model;
    hal;
    constructor(model, hal) {
        this.model = model;
        this.hal = hal;
    }
    /** Debe llamarse en cada frame (equivalente a loop() del firmware real). */
    tick() {
        const cfg = this.cfgActiva();
        if (this.model.currentMode === RobotMode.MICRO || this.model.currentMode === RobotMode.MINI) {
            ejecutarSumo(this.model, this.hal, cfg);
        }
        if (this.model.currentMode === RobotMode.BLOQUES && this.model.modeRunning) {
            this.tickBloques();
        }
        if (this.model.currentMode === RobotMode.ACCESO) {
            // Réplica de loopAcceso() real (.ino línea 696): botón LOW abre el acceso.
            if (!this.model.accesoAbierto && this.hal.digitalRead(PIN.boton) === 0) {
                this.model.accesoAbierto = true;
            }
        }
    }
    // ---- Movimiento manual ----
    moveManual(direction) {
        this.exitAutoModeOnManualCommand();
        moveDirLetter(this.model, this.hal, direction, this.model.motorSpeed);
        return { ok: true, data: undefined };
    }
    stopMotors() {
        stopMotorsShared(this.model, this.hal);
        return { ok: true, data: undefined };
    }
    setSpeed(value) {
        this.model.motorSpeed = value;
        return { ok: true, data: undefined };
    }
    stopAll() {
        this.model.currentMode = RobotMode.IDLE;
        this.model.modeRunning = false;
        this.model.evadeState = EvadeState.IDLE;
        this.stopMotors();
        return { ok: true, data: undefined };
    }
    // ---- Sumo ----
    configureSumo(input) {
        const key = input.perfil;
        const cfg = { ...(key === "micro" ? this.model.cfgMicro : this.model.cfgMini) };
        if (input.tipo === "sonar")
            cfg.tipoDistSensor = TipoDistSensor.SONAR;
        else if (input.tipo === "optico")
            cfg.tipoDistSensor = TipoDistSensor.OPTICO;
        else if (input.tipo === "sharp")
            cfg.tipoDistSensor = TipoDistSensor.SHARP;
        if (input.numDist !== undefined)
            cfg.numDistSensores = constrain(input.numDist, 1, 2);
        if (input.trigI !== undefined)
            cfg.trigI = input.trigI;
        if (input.echoI !== undefined)
            cfg.echoI = input.echoI;
        if (input.trigD !== undefined)
            cfg.trigD = input.trigD;
        if (input.echoD !== undefined)
            cfg.echoD = input.echoD;
        if (input.optI !== undefined)
            cfg.optPinI = input.optI;
        if (input.optD !== undefined)
            cfg.optPinD = input.optD;
        if (input.sharpI !== undefined)
            cfg.sharpPinI = constrain(input.sharpI, 0, 1);
        if (input.sharpD !== undefined)
            cfg.sharpPinD = constrain(input.sharpD, 0, 1);
        if (input.umbralSharp !== undefined)
            cfg.umbralSharp = constrain(input.umbralSharp, 100, 4095);
        if (input.numBorde !== undefined)
            cfg.numBorde = constrain(input.numBorde, 0, 2);
        if (input.bordeI !== undefined)
            cfg.bordePinI = constrain(input.bordeI, 0, 1);
        if (input.bordeD !== undefined)
            cfg.bordePinD = constrain(input.bordeD, 0, 1);
        if (input.umbralDist !== undefined)
            cfg.umbralDistCm = constrain(input.umbralDist, 2, 200);
        if (input.umbralDistMini !== undefined)
            cfg.umbralDistCm = constrain(input.umbralDistMini, 2, 200);
        if (input.umbralBorde !== undefined)
            cfg.umbralBorde = constrain(input.umbralBorde, 100, 4095);
        if (input.umbralBordeMini !== undefined)
            cfg.umbralBorde = constrain(input.umbralBordeMini, 100, 4095);
        if (input.spdAtaque !== undefined)
            cfg.spdAtaque = constrain(input.spdAtaque, 0, 255);
        if (input.spdBuscExt !== undefined)
            cfg.spdBuscExt = constrain(input.spdBuscExt, 0, 255);
        if (input.spdBuscInt !== undefined)
            cfg.spdBuscInt = constrain(input.spdBuscInt, 0, 255);
        if (input.spdEvasion !== undefined)
            cfg.spdEvasion = constrain(input.spdEvasion, 0, 255);
        if (input.circuloExt !== undefined)
            cfg.spdBuscExt = constrain(input.circuloExt, 0, 255);
        if (input.circuloInt !== undefined)
            cfg.spdBuscInt = constrain(input.circuloInt, 0, 255);
        if (input.estrategia !== undefined)
            cfg.estrategia = constrain(input.estrategia, 0, 1);
        if (!validateSumoADC(cfg)) {
            return { ok: false, error: `ADC limit exceeded: need ${contarADCUsados(cfg)} ADC pins, only 2 available` };
        }
        if (cfg.tipoDistSensor === TipoDistSensor.SONAR) {
            const conflict = pinBloqueadoPorBus(cfg.trigI, this.model.i2cEnabled) ||
                pinBloqueadoPorBus(cfg.echoI, this.model.i2cEnabled) ||
                (cfg.numDistSensores >= 2 &&
                    (pinBloqueadoPorBus(cfg.trigD, this.model.i2cEnabled) || pinBloqueadoPorBus(cfg.echoD, this.model.i2cEnabled)));
            if (conflict)
                return { ok: false, error: "GPIO conflict: sonar pin used by active I2C/SPI bus" };
        }
        if (cfg.tipoDistSensor === TipoDistSensor.OPTICO) {
            const conflict = pinBloqueadoPorBus(cfg.optPinI, this.model.i2cEnabled) ||
                (cfg.numDistSensores >= 2 && pinBloqueadoPorBus(cfg.optPinD, this.model.i2cEnabled));
            if (conflict)
                return { ok: false, error: "GPIO conflict: optical pin used by active I2C/SPI bus" };
        }
        if (key === "micro")
            this.model.cfgMicro = cfg;
        else
            this.model.cfgMini = cfg;
        return { ok: true, data: undefined };
    }
    startSumo(which) {
        this.model.cfgActivaKey = which;
        this.model.currentMode = which === "micro" ? RobotMode.MICRO : RobotMode.MINI;
        this.model.modeRunning = true;
        this.model.retardoOK = false;
        this.model.tInicioModo = this.hal.millis();
        this.model.evadeState = EvadeState.IDLE;
        return { ok: true, data: undefined };
    }
    stopSumo() {
        this.model.currentMode = RobotMode.IDLE;
        this.model.modeRunning = false;
        this.model.evadeState = EvadeState.IDLE;
        this.stopMotors();
        return { ok: true, data: undefined };
    }
    setTrim(ma, mb) {
        if (ma !== undefined)
            this.model.trimA = constrain(ma, 0, 255);
        if (mb !== undefined)
            this.model.trimB = constrain(mb, 0, 255);
        return { ok: true, data: undefined };
    }
    // ---- Bloques ----
    bloquesAdd(op, val, txt) {
        if (this.model.programa.length >= MAX_INST) {
            return { ok: false, error: `Programa lleno (máximo ${MAX_INST} instrucciones, igual que el firmware real)` };
        }
        this.model.programa.push(txt !== undefined ? { op, val, txt } : { op, val });
        return { ok: true, data: undefined };
    }
    bloquesDel(idx) {
        if (idx >= 0 && idx < this.model.programa.length)
            this.model.programa.splice(idx, 1);
        return { ok: true, data: undefined };
    }
    bloquesRun() {
        this.model.progPC = 0;
        this.model.bEsperando = false;
        this.model.currentMode = RobotMode.BLOQUES;
        this.model.modeRunning = true;
        return { ok: true, data: undefined };
    }
    bloquesStop() {
        this.model.currentMode = RobotMode.IDLE;
        this.model.modeRunning = false;
        this.stopMotors();
        return { ok: true, data: undefined };
    }
    bloquesClear() {
        this.model.programa = [];
        this.model.progPC = 0;
        return { ok: true, data: undefined };
    }
    /**
     * Réplica FIEL de ejecutarBloque() real (.ino líneas 456-496) — el
     * intérprete de Bloques del firmware, que será la base real de Runtime
     * Blockly (Fase 3): todo programa Blockly se compila a esta MISMA
     * secuencia de opcodes, no a un intérprete paralelo.
     *
     * OP_REPEAT (74) está definido en el firmware real pero NUNCA
     * implementado — cae al "default" (para y resetea). Lo replico
     * exactamente así, sin "arreglarlo": si el firmware real no lo soporta,
     * el Laboratorio tampoco debe fingir que sí. Ver informe de
     * compatibilidad de Blockly sobre cómo se resuelve esto en el lado del
     * compilador (desenrollado, no una capacidad nueva del intérprete).
     */
    tickBloques() {
        const m = this.model;
        if (m.programa.length === 0 || m.progPC >= m.programa.length) {
            m.progPC = 0;
            return;
        }
        if (m.bEsperando) {
            if (this.hal.millis() - m.tBloque >= m.bEsperaMs) {
                m.bEsperando = false;
                m.progPC++;
            }
            return;
        }
        const ins = m.programa[m.progPC];
        switch (ins.op) {
            case 1:
                moveDirLetter(m, this.hal, "f", ins.val > 0 ? ins.val : m.motorSpeed);
                m.progPC++;
                break; // OP_ADE
            case 2:
                moveDirLetter(m, this.hal, "b", ins.val > 0 ? ins.val : m.motorSpeed);
                m.progPC++;
                break; // OP_ATR
            case 3:
                moveDirLetter(m, this.hal, "l", ins.val > 0 ? ins.val : m.motorSpeed);
                m.progPC++;
                break; // OP_IZQ
            case 4:
                moveDirLetter(m, this.hal, "r", ins.val > 0 ? ins.val : m.motorSpeed);
                m.progPC++;
                break; // OP_DER
            case 5:
                stopMotorsShared(m, this.hal);
                m.progPC++;
                break; // OP_STOP
            case 6:
                m.tBloque = this.hal.millis();
                m.bEsperaMs = ins.val;
                m.bEsperando = true;
                break; // OP_ESP (NO avanza progPC todavía)
            case 7:
                this.hal.digitalWrite(PIN.led, 0);
                m.progPC++;
                break; // OP_LED_ON
            case 8:
                this.hal.digitalWrite(PIN.led, 1);
                m.progPC++;
                break; // OP_LED_OFF
            case 9:
                m.progPC += this.hal.analogRead(0) > ins.val ? 2 : 1;
                break; // OP_IF_DIST (ADC0 fijo, salta la siguiente si NO se cumple)
            case 11: // OP_FRENO — frenado activo (los 4 canales a full duty), no es lo mismo que STOP
                this.hal.pwmWrite(PIN.motorIzqFwd, 255);
                this.hal.pwmWrite(PIN.motorIzqRev, 255);
                this.hal.pwmWrite(PIN.motorDerFwd, 255);
                this.hal.pwmWrite(PIN.motorDerRev, 255);
                m.progPC++;
                break;
            case 20: { // OP_DOUT — gpio=val/10, nivel=val%10 (empaquetado real)
                const gpio = Math.trunc(ins.val / 10), nivel = ins.val % 10;
                this.hal.digitalWrite(gpio, nivel);
                m.progPC++;
                break;
            }
            case 22:
                this.hal.pwmWrite(PIN.motorDerFwd, ins.val);
                m.progPC++;
                break; // OP_PWM_OUT (real: reengancha PWM a GPIO3)
            case 30:
                m.adcLast = this.hal.analogRead(ins.val >= 0 ? ins.val : 0);
                m.varGlobal = m.adcLast;
                m.progPC++;
                break; // OP_ADC_READ
            case 40: { // OP_SERVO — gpio=val/1000, ang=val%1000 (empaquetado real)
                const gpio = Math.trunc(ins.val / 1000), ang = ins.val % 1000;
                m.servoGPIO = gpio;
                m.servoAngle = ang;
                m.progPC++;
                break;
            }
            case 60:
                m.varGlobal = ins.val;
                m.progPC++;
                break; // OP_VAR_SET
            case 61:
                m.varGlobal += ins.val;
                m.progPC++;
                break; // OP_VAR_ADD
            case 62:
                m.varGlobal -= ins.val;
                m.progPC++;
                break; // OP_VAR_SUB
            case 70:
                m.adcLast = this.hal.analogRead(0);
                m.progPC += m.adcLast > ins.val ? 2 : 1;
                break; // OP_IF_GT
            case 71:
                m.adcLast = this.hal.analogRead(0);
                m.progPC += m.adcLast < ins.val ? 2 : 1;
                break; // OP_IF_LT
            // ── Extensión de Laboratorio (opcodes 90+, NO existen en el
            // firmware real todavía — ver informe de evolución) ──────────────
            case 90: { // OP_PUSH — apila un valor en la pila de trabajo (máx 8)
                m.pila.push(ins.val);
                if (m.pila.length > 8)
                    m.pila.shift();
                m.progPC++;
                break;
            }
            case 91:
                m.progPC = ins.val;
                break; // OP_JMP — salto incondicional (no existe en el real: sin esto, ningún while/for real es posible)
            case 92: { // OP_CALL — apila dirección de retorno, salta (para funciones)
                m.callStack.push(m.progPC + 1);
                if (m.callStack.length > 8)
                    m.callStack.shift();
                m.progPC = ins.val;
                break;
            }
            case 93: { // OP_RET — vuelve a la dirección de retorno
                const ret = m.callStack.pop();
                m.progPC = ret !== undefined ? ret : m.progPC + 1;
                break;
            }
            case 94:
                m.varGlobal = this.hal.millis();
                m.progPC++;
                break; // OP_MILLIS_READ
            case 95: { // OP_MATH_MAP — pop orden [value,fromLow,fromHigh,toLow,toHigh]
                const toHigh = popStack(m), toLow = popStack(m), fromHigh = popStack(m), fromLow = popStack(m), value = popStack(m);
                m.varGlobal = fromHigh === fromLow ? toLow : ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow) + toLow;
                m.progPC++;
                break;
            }
            case 96: { // OP_MATH_CONSTRAIN — pop [value,min,max]
                const max = popStack(m), min = popStack(m), value = popStack(m);
                m.varGlobal = Math.min(Math.max(value, min), max);
                m.progPC++;
                break;
            }
            case 97:
                m.varGlobal = Math.abs(popStack(m));
                m.progPC++;
                break; // OP_MATH_ABS
            case 98: {
                const b = popStack(m), a = popStack(m);
                m.varGlobal = Math.min(a, b);
                m.progPC++;
                break;
            } // OP_MATH_MIN
            case 99: {
                const b = popStack(m), a = popStack(m);
                m.varGlobal = Math.max(a, b);
                m.progPC++;
                break;
            } // OP_MATH_MAX
            case 100: {
                const max = popStack(m), min = popStack(m);
                m.varGlobal = Math.floor(Math.random() * (max - min + 1)) + min;
                m.progPC++;
                break;
            } // OP_MATH_RANDOM
            case 101:
                m.oled.on = true;
                m.progPC++;
                break; // OP_OLED_INIT
            case 102:
                m.oled.draft = [];
                m.oled.cursorX = 0;
                m.oled.cursorY = 0;
                m.progPC++;
                break; // OP_OLED_CLEAR
            case 103: {
                const y = popStack(m), x = popStack(m);
                m.oled.cursorX = x;
                m.oled.cursorY = y;
                m.progPC++;
                break;
            } // OP_OLED_CURSOR
            case 104: // OP_OLED_PRINT — usa ins.txt, no la pila
                m.oled.draft.push({ kind: "text", x: m.oled.cursorX, y: m.oled.cursorY, text: ins.txt ?? "" });
                m.progPC++;
                break;
            case 105: {
                const y2 = popStack(m), x2 = popStack(m), y = popStack(m), x = popStack(m);
                m.oled.draft.push({ kind: "line", x, y, x2, y2 });
                m.progPC++;
                break;
            } // OP_OLED_LINE
            case 106: {
                const h = popStack(m), w = popStack(m), y = popStack(m), x = popStack(m);
                m.oled.draft.push({ kind: "rect", x, y, w, h });
                m.progPC++;
                break;
            } // OP_OLED_RECT
            case 107: {
                const r = popStack(m), y = popStack(m), x = popStack(m);
                m.oled.draft.push({ kind: "circle", x, y, r });
                m.progPC++;
                break;
            } // OP_OLED_CIRCLE
            case 108:
                m.oled.shown = m.oled.draft.slice();
                m.progPC++;
                break; // OP_OLED_DISPLAY (doble buffer, igual que display.display() real)
            case 110:
                m.varGlobal = leerBordeIzq(this.hal, this.cfgActiva()) ? 1 : 0;
                m.progPC++;
                break; // OP_READ_BORDE_IZQ
            case 111:
                m.varGlobal = leerBordeDer(this.hal, this.cfgActiva()) ? 1 : 0;
                m.progPC++;
                break; // OP_READ_BORDE_DER
            case 112:
                m.varGlobal = this.hal.analogRead(0) < 1800 ? 1 : 0;
                m.progPC++;
                break; // OP_READ_LINEA_IZQ (mismo pin que sw-entry.ts LINE_PIN_IZQ)
            case 113:
                m.varGlobal = this.hal.digitalRead(6) === 0 ? 1 : 0;
                m.progPC++;
                break; // OP_READ_LINEA_CENTRO (LINE_PIN_CENTRO)
            case 114:
                m.varGlobal = this.hal.analogRead(1) < 1800 ? 1 : 0;
                m.progPC++;
                break; // OP_READ_LINEA_DER (LINE_PIN_DER)
            // OP_IF_GT/OP_IF_LT reales (70/71) están hardcodeados a analogRead(ADC0)
            // — no sirven para "repetir N veces" ni ningún bucle basado en
            // contador/variable. Propuesta de Laboratorio: la misma semántica de
            // salto (verdadero=saltea, falso=ejecuta), pero comparando varGlobal.
            case 120:
                m.progPC += m.varGlobal > ins.val ? 2 : 1;
                break; // OP_IF_VAR_GT
            case 121:
                m.progPC += m.varGlobal < ins.val ? 2 : 1;
                break; // OP_IF_VAR_LT
            case 122: // OP_SERIAL_PRINT — "Monitor Serie" no existe en el firmware real
                // (HTTP no tiene concepto de puerto serie) — propuesta de Lab: guarda
                // en un log acotado (últimas 50 líneas), consumido por el Workspace.
                m.serialLog.push(ins.txt ?? "");
                if (m.serialLog.length > 50)
                    m.serialLog.shift();
                m.progPC++;
                break;
            case 123: // OP_BUZZER — no existe en el firmware real (ni el pin está
                // definido). Toma frecuencia (Hz) y duración (ms) de la pila de
                // trabajo — empaquetarlo en un solo `val` no alcanza para valores
                // reales de frecuencia. Orden de push: [freq, duracion].
                m.buzzerDurationMs = popStack(m); // se pusheó último -> sale primero
                m.buzzerFreqHz = popStack(m);
                m.buzzerLastPlayedAt = this.hal.millis();
                m.progPC++;
                break;
            case 0:
            default:
                stopMotorsShared(m, this.hal);
                m.progPC = 0;
                break; // OP_FIN / cualquier opcode desconocido
        }
    }
    // ---- Automatizaciones / panel / led / gpio / sonar ----
    autoSet(mode) {
        this.model.currentMode = mode;
        this.model.modeRunning = true;
        return { ok: true, data: undefined };
    }
    autoAlarmaReset() {
        this.model.alarmaActiva = false;
        return { ok: true, data: undefined };
    }
    autoStop() {
        this.model.currentMode = RobotMode.IDLE;
        this.model.modeRunning = false;
        this.stopMotors();
        return { ok: true, data: undefined };
    }
    panelSave(i2c, spi) {
        this.model.i2cEnabled = i2c;
        this.model.spiEnabled = spi;
        return { ok: true, data: undefined };
    }
    ledOn() { this.hal.digitalWrite(PIN.led, 0); return { ok: true, data: undefined }; }
    ledOff() { this.hal.digitalWrite(PIN.led, 1); return { ok: true, data: undefined }; }
    ledBrillo(val) { this.hal.digitalWrite(PIN.led, val); return { ok: true, data: undefined }; }
    gpioOut(pin, val) {
        if ([2, 3, 4, 5].includes(pin))
            return { ok: false, error: "Pin ocupado por motor" };
        this.hal.digitalWrite(pin, val ? 1 : 0);
        return { ok: true, data: undefined };
    }
    gpioRead(pin) {
        if ([2, 3, 4, 5].includes(pin))
            return { ok: false, error: "Pin motor" };
        return { ok: true, data: { pin, val: this.hal.digitalRead(pin) } };
    }
    sonarRead() {
        // Sin Motor de Simulación con física todavía: el firmware real devuelve
        // 999 cuando no hay eco. Ver ADR-002 §3 (Motor de Simulación pendiente).
        return { ok: true, data: { cm: 999 } };
    }
    /**
     * Snapshot para el Workspace del laboratorio (NO forma parte del contrato
     * real del firmware — es exclusivo de FRANKY LAB). Todo lo que devuelve
     * sale de lecturas reales del Firmware Model / MCU en este mismo instante,
     * nunca de valores inventados.
     */
    getLabTelemetry() {
        const cfg = this.cfgActiva();
        const sharpRawI = this.hal.analogRead(cfg.sharpPinI === 0 ? 0 : 1);
        const sharpRawD = this.hal.analogRead(cfg.sharpPinD === 0 ? 0 : 1);
        return {
            mode: this.model.currentMode,
            modeRunning: this.model.modeRunning,
            motorSpeed: this.model.motorSpeed,
            trimA: this.model.trimA,
            trimB: this.model.trimB,
            pwmA: this.model.pwmA,
            pwmB: this.model.pwmB,
            ledOn: this.hal.digitalRead(PIN.led) === 0, // lógica invertida real: LOW = encendido
            btn: this.hal.digitalRead(PIN.boton) === 0, // pull-up: LOW = presionado
            accesoAbierto: this.model.accesoAbierto,
            evadeState: this.model.evadeState,
            progPC: this.model.progPC,
            progLen: this.model.programa.length,
            varGlobal: this.model.varGlobal,
            adcLast: this.model.adcLast,
            servoGPIO: this.model.servoGPIO,
            servoAngle: this.model.servoAngle,
            pila: this.model.pila,
            callStackDepth: this.model.callStack.length,
            oled: this.model.oled,
            serialLog: this.model.serialLog,
            buzzerFreqHz: this.model.buzzerFreqHz,
            buzzerDurationMs: this.model.buzzerDurationMs,
            buzzerLastPlayedAt: this.model.buzzerLastPlayedAt,
            programaOpcodes: this.model.programa.map((i) => i.op),
            sharp: {
                // Lectura EN VIVO del MCU (no el caché de FirmwareModel, que solo
                // se refresca dentro del handler de /api) — el canal postMessage
                // del Workspace no pasa por ahí, así que tenía que leerse acá.
                adcI: sharpRawI,
                detI: sharpRawI > cfg.umbralSharp,
                adcD: sharpRawD,
                detD: sharpRawD > cfg.umbralSharp,
                umbral: cfg.umbralSharp,
            },
            borde: {
                izq: leerBordeIzq(this.hal, cfg),
                der: leerBordeDer(this.hal, cfg),
                umbral: cfg.umbralBorde,
                numBorde: cfg.numBorde,
            },
            // Bloque GENÉRICO (criterio permanente del proyecto: el Workspace
            // nunca decide qué sensores existen, solo refleja la configuración
            // real). tipoLabel/numDist/sensores describen EXACTAMENTE lo que el
            // usuario configuró desde sumo.html — 1 o 2 unidades de Sharp,
            // HC-SR04 (sonar) o JS40 (óptico digital), nunca fijo. Reusa
            // leerOponente() en vez de duplicar la lógica de detección.
            oponenteSensor: (() => {
                const { oI, oD } = leerOponente(this.hal, cfg);
                const tipoLabel = cfg.tipoDistSensor === TipoDistSensor.SHARP ? "sharp"
                    : cfg.tipoDistSensor === TipoDistSensor.SONAR ? "sonar" : "optico";
                const valorDe = (izq) => {
                    if (cfg.tipoDistSensor === TipoDistSensor.SHARP)
                        return this.hal.analogRead(izq ? cfg.sharpPinI : cfg.sharpPinD);
                    if (cfg.tipoDistSensor === TipoDistSensor.OPTICO)
                        return this.hal.digitalRead(izq ? cfg.optPinI : cfg.optPinD);
                    return this.hal.analogRead(izq ? cfg.echoI : cfg.echoD); // sonar: distancia real en cm (ver sw-entry.ts)
                };
                const sensores = [
                    { lado: "izq", detectado: oI, valor: valorDe(true) },
                ];
                if (cfg.numDistSensores >= 2)
                    sensores.push({ lado: "der", detectado: oD, valor: valorDe(false) });
                return { tipo: cfg.tipoDistSensor, tipoLabel, numDist: cfg.numDistSensores, sensores };
            })(),
        };
    }
    // ---- Helpers ----
    cfgActiva() {
        return this.model.cfgActivaKey === "micro" ? this.model.cfgMicro : this.model.cfgMini;
    }
    /** Refresca la telemetría Sharp cacheada — llamado por Virtual Server antes de leer /api. */
    refreshTelemetry() {
        const cfg = this.cfgActiva();
        const a0 = this.hal.analogRead(0);
        const a1 = this.model.spiEnabled ? 0 : this.hal.analogRead(1);
        if (cfg.tipoDistSensor === TipoDistSensor.SHARP) {
            this.model.sharpAdcValI = cfg.sharpPinI === 0 ? a0 : a1;
            this.model.sharpDetI = this.model.sharpAdcValI > cfg.umbralSharp;
            if (cfg.numDistSensores >= 2) {
                this.model.sharpAdcValD = cfg.sharpPinD === 0 ? a0 : a1;
                this.model.sharpDetD = this.model.sharpAdcValD > cfg.umbralSharp;
            }
        }
    }
    exitAutoModeOnManualCommand() {
        if (this.model.currentMode !== RobotMode.IDLE) {
            this.model.currentMode = RobotMode.IDLE;
            this.model.modeRunning = false;
        }
    }
}
