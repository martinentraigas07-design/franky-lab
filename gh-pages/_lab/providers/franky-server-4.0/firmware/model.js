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
/**
 * FASE "CIERRE SUMO" — memoria de última dirección del oponente, usada
 * para sesgar la recuperación cuando el oponente deja de detectarse.
 * Réplica exacta del enum DireccionOponente real (.ino, junto a
 * GpioMotivo/RobotMode). Valores idénticos: se exponen tal cual en el
 * campo "s_dir" de /api.
 */
export var DireccionOponente;
(function (DireccionOponente) {
    DireccionOponente[DireccionOponente["DESCONOCIDA"] = 0] = "DESCONOCIDA";
    DireccionOponente[DireccionOponente["IZQUIERDA"] = 1] = "IZQUIERDA";
    DireccionOponente[DireccionOponente["DERECHA"] = 2] = "DERECHA";
    DireccionOponente[DireccionOponente["CENTRO"] = 3] = "CENTRO";
})(DireccionOponente || (DireccionOponente = {}));
/**
 * FASE GPIO/I2C — réplica de GpioMotivo (.ino, junto a DireccionOponente/
 * RobotMode/SumoConfig — mismo motivo HALLAZGO_CTAGS que esos tres).
 */
export var GpioMotivo;
(function (GpioMotivo) {
    GpioMotivo[GpioMotivo["LIBRE"] = 0] = "LIBRE";
    GpioMotivo[GpioMotivo["MOTOR"] = 1] = "MOTOR";
    GpioMotivo[GpioMotivo["LED"] = 2] = "LED";
    GpioMotivo[GpioMotivo["BOTON"] = 3] = "BOTON";
    GpioMotivo[GpioMotivo["ADC_FIJO"] = 4] = "ADC_FIJO";
    GpioMotivo[GpioMotivo["I2C"] = 5] = "I2C";
    GpioMotivo[GpioMotivo["BUS_ALT"] = 6] = "BUS_ALT";
    GpioMotivo[GpioMotivo["SENSOR_SUMO"] = 7] = "SENSOR_SUMO";
})(GpioMotivo || (GpioMotivo = {}));
/** Réplica de GPIO_EXPUESTOS[13] real — los 13 GPIO físicos del ESP32-C3 SuperMini. */
export const GPIO_EXPUESTOS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21];
/**
 * Reservas de fábrica — motor(4)/led/botón/adc_fijo(2), permanentes.
 * Réplica de gpioInicializarReservasDeFabrica() real. Los 5 pines
 * restantes (6,7,10,20,21) arrancan LIBRE — I2C/bus_alt los reservan
 * dinámicamente (ver gpio.ts) recién cuando el usuario habilita esos
 * buses, igual que gpioSincronizarBuses() real.
 */
export function defaultGpioReserva() {
    const r = new Array(GPIO_EXPUESTOS.length).fill(GpioMotivo.LIBRE);
    const idx = (pin) => GPIO_EXPUESTOS.indexOf(pin);
    r[idx(5)] = GpioMotivo.MOTOR; // PIN_MA_IN1
    r[idx(4)] = GpioMotivo.MOTOR; // PIN_MA_IN2
    r[idx(3)] = GpioMotivo.MOTOR; // PIN_MB_IN1
    r[idx(2)] = GpioMotivo.MOTOR; // PIN_MB_IN2
    r[idx(8)] = GpioMotivo.LED;
    r[idx(9)] = GpioMotivo.BOTON;
    r[idx(0)] = GpioMotivo.ADC_FIJO;
    r[idx(1)] = GpioMotivo.ADC_FIJO;
    return r;
}
export const MONITOR_BUF_N = 40;
export const MONITOR_MSG_LEN = 96;
/** Mismas 8 categorías fijas que monitorCats[] real. */
export const MONITOR_CAT_NOMBRES = [
    "sumo_estado", "sumo_sensor", "blockly_bloque",
    "manual_cmd", "lab_pd", "gen1", "gen2", "gen3",
];
export function defaultMonitorBuf() {
    return Array.from({ length: MONITOR_BUF_N }, () => ({ seq: 0, ms: 0, msg: "" }));
}
export function defaultMonitorCats() {
    return MONITOR_CAT_NOMBRES.map((nombre) => ({ nombre, ultimoMs: 0 }));
}
/**
 * SPRITE_SCALE — réplica de la constante real (dibujarSpriteEscalado()):
 * cada pixel LÓGICO del sprite (16x16) se dibuja como un bloque de
 * SPRITE_SCALE×SPRITE_SCALE pixeles físicos (16px*4=64px, el máximo que
 * entra en el alto real de 64px del OLED 128x64).
 */
export const SPRITE_SCALE = 4;
export function defaultOledState() {
    return { on: false, cursorX: 0, cursorY: 0, draft: [], shown: [], panelDetectado: false, panelAncho: 128, panelAlto: 64, panelAddr: 0x3c };
}
export const MAX_INST = 64;
/**
 * TABLA_BITMAP_MAX — réplica del límite real (TABLA_BITMAP_MAX=8, Fase
 * 4.4): máximo de sprites (instrucciones OP_OLED_SPRITE con bitmap
 * propio) por programa compilado.
 */
export const TABLA_BITMAP_MAX = 8;
/**
 * CABECEO_MS — duración de fábrica de cada "pierna" del barrido de
 * búsqueda (searchSweep(), ver sumoEngine.ts), y valor de resguardo si
 * durBarrido llegara en 0. Réplica exacta de la constante real (.ino).
 */
export const CABECEO_MS = 250;
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
        // velBusqueda=145, intGiro=130 reconstruyen exactamente ext=210/int=80
        // de fábrica (velBusqueda=(ext+int)/2, intGiro=ext-int). Ver .ino líneas 439-443.
        velBusqueda: 145,
        intGiro: 130,
        spdEvasion: 220,
        durBarrido: CABECEO_MS,
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
        // velBusqueda=130, intGiro=140 reconstruyen exactamente ext=200/int=60
        // de fábrica. Ver .ino líneas 439-443.
        velBusqueda: 130,
        intGiro: 140,
        spdEvasion: 200,
        durBarrido: CABECEO_MS, // no usado por Micro (siempre CÍRCULO), se mantiene por simetría de struct
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
        ultimaDirOponente: DireccionOponente.DESCONOCIDA,
        oponentePresenteAnt: false,
        enRecuperacion: false,
        recuperacionHaciaIzquierda: true,
        tRecuperacion: 0,
        ultimoAtaqueDirLog: -1,
        sumoInicioServidor: true,
        sumoInicioBoton: false,
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
        programaFuenteXml: null,
        programaFuenteXmlHash: null,
        programaCompiladoHash: null,
        debugEnabled: false,
        monitorBuf: defaultMonitorBuf(),
        monitorHead: 0,
        monitorSeq: 0,
        monitorCats: defaultMonitorCats(),
        buzzerFreqHz: 0,
        buzzerDurationMs: 0,
        buzzerLastPlayedAt: 0,
        tablaBitmapLen: 0,
        i2cEnabled: false,
        spiEnabled: false,
        i2cSda: 6,
        i2cScl: 7,
        gpioReserva: defaultGpioReserva(),
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
/**
 * Logo MDE REAL (no placeholder de texto) — convertido desde la imagen
 * oficial provista por el usuario a bitmap 1bpp, empaquetado MSB-primero
 * por byte (fila por fila, 128 bits = 16 bytes por fila). Usado por
 * handleOledLogo() virtual (Panel Industrial, botón "Logo MDE").
 */
export const LOGO_MDE_128x64_HEX = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007f0000001f807fffffc00fffffff80007f8000003fc07ffffff80fffffff8000ff8000007fe07ffffff80fffffff8001ff800000fff07ffffffc0fffffff8001ffe00001fff07ffffffc0fffffff8001fff00001fff07ffffffe0ffffffe0001fff00003fff000000ffe000000000001fff80007fff0000003ff000000000001fff80007ffe0000001ff800000000001fff8000fffc0000001ff800000000003fffc003fffc1fe0000ff9ffffff80003fdfe007fffc1fe0000ff9ffffff80003f9fe00ffbfc3fe0000ff9ffffff80003fdff01ff3fc3fe0000ff9ffffff80003f8ff81fe3fc3fe0000ff1ffffff80003f07f83fc3fc3fe0001fe3ffffff80007f07fc3f83f83fe0001fe3ffffff00007f03fcff03f83fc0001fe3fe000000007f03ffff03f83fc0003fe3fc000000007f01fffe07f83fc0007fe3fc000000007f00fffc07f87fc000ffc3fc000000007f007ff807f87fc003ffc3f8000000f07e007ff007f87fffffff83ffffff9f00fe003fe007f07fffffff07ffffffc000fe003fc007f07ffffffe07ffffffc000fe003f8007f07ffffffc07ffffff8000fe001f0007f07ffffff007ffffff0000fe0006001ff0ffffffc007ffffff000000000000000000000000000000000010000000000000000000000000000003f0000000000000000000000000000007f00000000000000000000000000003fff000000000000000000000000001fffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
export const LOGO_MDE_128x32_HEX = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f800001f03ffffe01fffffc000000001fc00003f83fffff81fffffc000000003fc00007fc3fffffc1fffffc000000003fe0000ffc3fffffc1fffffc000000003ff0000ffc3fffffe1fffff8000000003ff0001ffc00003fe0000000000000003ff8003ffc00000ff0000000000000003ff8007ff800000ff0000000000000007ffc00fff87e0007f3ffffe0000000007efe01fff87e0007f3ffffe0000000007efe03fbf8fe0007f3ffffe0000000007e7f07f3f8fe0007f3ffffe0000000007c3f0fe3f8fe000fe7ffffe000000000fc3f8fc3f0fe000fe7ffffc000000000fc1f9f83f0fc000fe7f0000000000000fc1fff83f0fc001fe7f0000000000000fc0fff07f1fc003fc7f0000000000000fc07fe07f1fc00ffc7e0000070000000f807fc07f1ffffff87ffffe780000001f803f807e1ffffff0ffffff000000001f803f007e1fffffe0fffffe000000001f801e007e1fffff80fffffc000000001f800c00fe3ffffe00fffffc00000000000000000000000000000000010000000000000000000000000000001f000000000000000000000000000007ff0000000000000000000000000001ffff000";
