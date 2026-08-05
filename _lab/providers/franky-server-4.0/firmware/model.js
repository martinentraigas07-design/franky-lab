/**
 * FRANKY LAB — Provider franky-server-4.0 / Firmware Model
 *
 * Estado puro del firmware v3.2-LNR. Sin comportamiento, sin I/O — el mismo
 * principio que World Model (ADR-003 §1). Solo firmware/runtime.ts está
 * autorizado a mutarlo.
 *
 * Campos y valores por defecto confirmados contra esp32c3_franky_SPIFFS.ino
 * (fuente de verdad real, no solo el informe — ver hallazgos de Etapa 2).
 */
export var RobotMode;
(function (RobotMode) {
    RobotMode[RobotMode["IDLE"] = 0] = "IDLE";
    RobotMode[RobotMode["MICRO"] = 1] = "MICRO";
    RobotMode[RobotMode["MINI"] = 2] = "MINI";
    RobotMode[RobotMode["VIVERO"] = 3] = "VIVERO";
    RobotMode[RobotMode["METEO"] = 4] = "METEO";
    RobotMode[RobotMode["ALARMA"] = 5] = "ALARMA";
    RobotMode[RobotMode["ACCESO"] = 6] = "ACCESO";
    RobotMode[RobotMode["BLOQUES"] = 7] = "BLOQUES";
})(RobotMode || (RobotMode = {}));
export var EvadeState;
(function (EvadeState) {
    EvadeState[EvadeState["IDLE"] = 0] = "IDLE";
    EvadeState[EvadeState["BACK"] = 1] = "BACK";
    EvadeState[EvadeState["TURN"] = 2] = "TURN";
})(EvadeState || (EvadeState = {}));
export var TipoDistSensor;
(function (TipoDistSensor) {
    TipoDistSensor[TipoDistSensor["SONAR"] = 0] = "SONAR";
    TipoDistSensor[TipoDistSensor["OPTICO"] = 1] = "OPTICO";
    TipoDistSensor[TipoDistSensor["SHARP"] = 2] = "SHARP";
})(TipoDistSensor || (TipoDistSensor = {}));
export function defaultOledState() {
    return { on: false, cursorX: 0, cursorY: 0, draft: [], shown: [] };
}
export const MAX_INST = 64;
/** Réplica EXACTA del struct initializer real de cfgMini (.ino líneas 177-186). */
export function defaultSumoConfigMini() {
    return {
        perfil: 0,
        tipoDistSensor: TipoDistSensor.SONAR,
        numDistSensores: 2,
        trigI: 20,
        echoI: 21,
        trigD: 6,
        echoD: 7,
        sharpPinI: 0,
        sharpPinD: 1,
        umbralSharp: 1800,
        optPinI: 9,
        optPinD: 6,
        numBorde: 2,
        bordePinI: 0,
        bordePinD: 1,
        umbralBorde: 1500,
        umbralDistCm: 30,
        spdAtaque: 255,
        spdBuscExt: 210,
        spdBuscInt: 80,
        spdEvasion: 220,
        estrategia: 0,
    };
}
/** Réplica EXACTA del struct initializer real de cfgMicro (.ino líneas 188-197) — NO era "cfgMini con perfil=1", tenía valores propios. */
export function defaultSumoConfigMicro() {
    return {
        perfil: 1,
        tipoDistSensor: TipoDistSensor.SONAR,
        numDistSensores: 1,
        trigI: 20,
        echoI: 21,
        trigD: 0,
        echoD: 0,
        sharpPinI: 0,
        sharpPinD: 1,
        umbralSharp: 1800,
        optPinI: 9,
        optPinD: 0,
        numBorde: 1,
        bordePinI: 0,
        bordePinD: 1,
        umbralBorde: 1500,
        umbralDistCm: 25,
        spdAtaque: 255,
        spdBuscExt: 200,
        spdBuscInt: 60,
        spdEvasion: 200,
        estrategia: 0,
    };
}
export function defaultFirmwareModel() {
    return {
        currentMode: RobotMode.IDLE,
        modeRunning: false,
        motorSpeed: 200,
        trimA: 255,
        trimB: 255,
        pwmA: 0,
        pwmB: 0,
        cfgMicro: defaultSumoConfigMicro(),
        cfgMini: defaultSumoConfigMini(),
        cfgActivaKey: "mini",
        evadeState: EvadeState.IDLE,
        evadeTimer: 0,
        evadeBoth: false,
        evadeDirRight: true,
        tCabeceo: 0,
        cabeceoDirDer: true,
        tInicioModo: 0,
        retardoOK: false,
        programa: [],
        progPC: 0,
        bEsperando: false,
        tBloque: 0,
        bEsperaMs: 0,
        varGlobal: 0,
        adcLast: 0,
        servoGPIO: -1,
        servoAngle: 0,
        pila: [],
        callStack: [],
        oled: defaultOledState(),
        serialLog: [],
        buzzerFreqHz: 0,
        buzzerDurationMs: 0,
        buzzerLastPlayedAt: 0,
        i2cEnabled: false,
        spiEnabled: false,
        sensorTemp: 0,
        sensorHum: 0,
        dhtOK: false,
        alarmaActiva: false,
        accesoAbierto: false,
        sharpAdcValI: 0,
        sharpAdcValD: 0,
        sharpDetI: false,
        sharpDetD: false,
    };
}
