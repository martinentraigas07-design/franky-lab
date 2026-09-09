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

export enum RobotMode {
  IDLE = 0,
  MICRO = 1,
  MINI = 2,
  VIVERO = 3,
  METEO = 4,
  ALARMA = 5,
  ACCESO = 6,
  BLOQUES = 7,
}

export enum EvadeState {
  IDLE = 0,
  BACK = 1,
  TURN = 2,
}

export enum TipoDistSensor {
  SONAR = 0,
  OPTICO = 1,
  SHARP = 2,
}

/**
 * FASE "CIERRE SUMO" — memoria de última dirección del oponente, usada
 * para sesgar la recuperación cuando el oponente deja de detectarse.
 * Réplica exacta del enum DireccionOponente real (.ino, junto a
 * GpioMotivo/RobotMode). Valores idénticos: se exponen tal cual en el
 * campo "s_dir" de /api.
 */
export enum DireccionOponente {
  DESCONOCIDA = 0,
  IZQUIERDA = 1,
  DERECHA = 2,
  CENTRO = 3,
}

export interface SumoConfig {
  perfil: 0 | 1;
  tipoDistSensor: TipoDistSensor;
  numDistSensores: 1 | 2;
  trigI: number;
  echoI: number;
  trigD: number;
  echoD: number;
  sharpPinI: 0 | 1;
  sharpPinD: 0 | 1;
  umbralSharp: number;
  optPinI: number;
  optPinD: number;
  numBorde: 0 | 1 | 2;
  bordePinI: 0 | 1;
  bordePinD: 0 | 1;
  umbralBorde: number;
  umbralDistCm: number;
  spdAtaque: number;
  // ── Abstracción pedagógica de búsqueda (fase "Cierre Sumo", real) ──
  // Reemplaza la exposición directa de "rueda externa/rueda interna"
  // (antes spdBuscExt/spdBuscInt). velExterna()/velInterna() en
  // sumoEngine.ts hacen la traducción — ver ese archivo.
  velBusqueda: number; // "Velocidad de búsqueda" (0-255)
  intGiro: number;     // "Intensidad del giro" — diferencial RELATIVO entre ruedas (0-255)
  spdEvasion: number;
  durBarrido: number;  // "Duración del barrido" (ms) — solo aplica a Mini con estrategia=1 (BARRIDO)
  estrategia: 0 | 1;
}

/**
 * FASE GPIO/I2C — réplica de GpioMotivo (.ino, junto a DireccionOponente/
 * RobotMode/SumoConfig — mismo motivo HALLAZGO_CTAGS que esos tres).
 */
export enum GpioMotivo {
  LIBRE = 0,
  MOTOR, // reservado de fábrica — soldado a RZ7899, nunca liberable
  LED, // reservado de fábrica — LED onboard
  BOTON, // reservado de fábrica — botón BOOT onboard
  ADC_FIJO, // reservado de fábrica — únicos 2 canales ADC (Sharp/borde), nunca asignable a otra función
  I2C, // reservado en runtime — bus I2C activo (par SDA/SCL)
  BUS_ALT, // reservado en runtime — grupo "spiEnabled" (CS/MOSI/SCLK)
  SENSOR_SUMO, // reservado en runtime — pin elegido por el usuario para sensor de Sumo
}

/** Réplica de GPIO_EXPUESTOS[13] real — los 13 GPIO físicos del ESP32-C3 SuperMini. */
export const GPIO_EXPUESTOS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21];

/**
 * Reservas de fábrica — motor(4)/led/botón/adc_fijo(2), permanentes.
 * Réplica de gpioInicializarReservasDeFabrica() real. Los 5 pines
 * restantes (6,7,10,20,21) arrancan LIBRE — I2C/bus_alt los reservan
 * dinámicamente (ver gpio.ts) recién cuando el usuario habilita esos
 * buses, igual que gpioSincronizarBuses() real.
 */
export function defaultGpioReserva(): GpioMotivo[] {
  const r = new Array<GpioMotivo>(GPIO_EXPUESTOS.length).fill(GpioMotivo.LIBRE);
  const idx = (pin: number) => GPIO_EXPUESTOS.indexOf(pin);
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

/**
 * FASE MONITOR/DEBUG — réplica de la infraestructura transversal real
 * (buffer circular + throttle por categoría). El estado vive acá
 * (mismo criterio que gpioReserva/SumoConfig); el comportamiento vive en
 * monitor.ts.
 */
export interface LogEntry {
  seq: number;
  ms: number;
  msg: string; // ya formateado: "[nivel][contexto] mensaje", igual que el real
}
export const MONITOR_BUF_N = 40;
export const MONITOR_MSG_LEN = 96;

export interface ThrottleCat {
  nombre: string;
  ultimoMs: number;
}
/** Mismas 8 categorías fijas que monitorCats[] real. */
export const MONITOR_CAT_NOMBRES = [
  "sumo_estado", "sumo_sensor", "blockly_bloque",
  "manual_cmd", "lab_pd", "gen1", "gen2", "gen3",
] as const;

export function defaultMonitorBuf(): LogEntry[] {
  return Array.from({ length: MONITOR_BUF_N }, () => ({ seq: 0, ms: 0, msg: "" }));
}
export function defaultMonitorCats(): ThrottleCat[] {
  return MONITOR_CAT_NOMBRES.map((nombre) => ({ nombre, ultimoMs: 0 }));
}

export interface Instruccion {
  op: number;
  val: number;
  txt?: string; // solo para OP_OLED_PRINT/OP_SERIAL_PRINT (Lab, opcodes 104/122)
  bitmap?: string; // solo para OP_OLED_SPRITE (Lab, opcode 109) — 64 chars hex = 32 bytes = 16x16 1bpp
}

/**
 * OLED I²C 128x64 — la librería (Adafruit_SSD1306) y el objeto ya existen
 * en el firmware real, pero nunca se llegó a usar (sin display.begin() ni
 * un solo draw call). El Laboratorio simula el framebuffer completo con
 * elementos vectoriales (no bits monocromos reales) — decisión consciente:
 * el objetivo educativo es igual de válido y muchísimo más simple que
 * simular un buffer de 1024 bytes pixel a pixel. Doble buffer como el
 * SSD1306 real: las operaciones dibujan en `draft`, OP_OLED_DISPLAY copia
 * draft -> shown (igual que display.display() en el firmware real).
 */
export interface OledElement {
  kind: "text" | "line" | "rect" | "circle" | "sprite" | "bitmap";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  r?: number;
  text?: string;
  bitmap?: string; // solo kind="sprite" — 64 chars hex (32 bytes), 16x16, 1 bit/pixel
  // kind="bitmap" — logo MDE real (Panel Industrial): bitmap de pantalla
  // completa (128xN, 1 bit/pixel, empaquetado MSB-primero por byte,
  // igual convención que un bitmap SSD1306 estándar). Distinto del
  // "sprite" de 16x16 de Blockly — este es el logo real, no un
  // placeholder de texto.
  anchoBits?: number;
  altoBits?: number;
}
/**
 * SPRITE_SCALE — réplica de la constante real (dibujarSpriteEscalado()):
 * cada pixel LÓGICO del sprite (16x16) se dibuja como un bloque de
 * SPRITE_SCALE×SPRITE_SCALE pixeles físicos (16px*4=64px, el máximo que
 * entra en el alto real de 64px del OLED 128x64).
 */
export const SPRITE_SCALE = 4;
export interface OledState {
  on: boolean;
  cursorX: number;
  cursorY: number;
  draft: OledElement[];
  shown: OledElement[];
  // FASE PANEL INDUSTRIAL (Sesión 1, auditoría Server-vs-LAB) — estado
  // de "Probar" del Panel. El LAB NO escanea I2C real (no hay chip
  // físico que detectar): "Probar" solo confirma la única precondición
  // que sí es real en un mundo virtual (I2C habilitado) y aplica el
  // tamaño que el usuario eligió. panelAddr queda fijo en 0x3C — nunca
  // se "encuentra" una dirección real.
  panelDetectado: boolean;
  panelAncho: number;
  panelAlto: number;
  panelAddr: number;
}
export function defaultOledState(): OledState {
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

export interface FirmwareModel {
  currentMode: RobotMode;
  modeRunning: boolean;

  motorSpeed: number;
  trimA: number;
  trimB: number;
  pwmA: number;
  pwmB: number;

  cfgMicro: SumoConfig;
  cfgMini: SumoConfig;
  cfgActivaKey: "micro" | "mini";

  evadeState: EvadeState;
  evadeTimer: number;
  evadeBoth: boolean;
  evadeDirRight: boolean;
  tCabeceo: number;
  cabeceoDirDer: boolean;

  // ── Memoria de última dirección del oponente + recuperación acotada
  // (fase "Cierre Sumo", real) — ver ejecutarSumo() en sumoEngine.ts.
  ultimaDirOponente: DireccionOponente;
  oponentePresenteAnt: boolean;
  enRecuperacion: boolean;
  recuperacionHaciaIzquierda: boolean;
  tRecuperacion: number;
  ultimoAtaqueDirLog: number; // FASE MONITOR/DEBUG — -1=sin ataque, 0=ambos, 1=izq, 2=der (log por flanco, no por tick)

  tInicioModo: number;
  retardoOK: boolean;

  programa: Instruccion[];
  progPC: number;
  bEsperando: boolean;
  tBloque: number;
  bEsperaMs: number;
  varGlobal: number;
  adcLast: number;
  servoGPIO: number; // -1 = ningún servo enganchado todavía
  servoAngle: number;

  // ── Extensión de Laboratorio (Fase 3, opcodes 90+) ──────────────────
  // Nada de esto existe en el firmware real todavía — ver informe de
  // evolución. Aislado del rango 0-74 (real) para garantizar que portar
  // esto al firmware oficial más adelante sea un agregado, no un cambio.
  pila: number[]; // pila de trabajo (máx 8) — parámetros para dibujo/math
  callStack: number[]; // pila de retorno (máx 8) — para OP_CALL/OP_RET
  oled: OledState;
  serialLog: string[]; // "Monitor Serie" — no existe en el firmware real, ver informe de evolución
  // FASE "PROGRAMA FUENTE" VIRTUAL (Sesión 1, auditoría Server-vs-LAB) —
  // equivalente al XML guardado en SPIFFS real, PERO en memoria del
  // proceso (misma fidelidad que el resto del "NVS" del LAB — ver
  // core/src/persistence.ts: InMemoryNVS tampoco persiste entre
  // sesiones). Diferencia documentada explícitamente: en el robot
  // físico esto sobrevive un apagado; acá NO — vive solo mientras el
  // Service Worker de esta pestaña siga corriendo.
  programaFuenteXml: string | null;
  programaFuenteXmlHash: number | null; // hash del XML guardado más recientemente
  programaCompiladoHash: number | null; // hash del XML que corresponde al programa[] YA compilado (marcado tras un /bloques/run exitoso)
  // FASE MONITOR/DEBUG — Monitor Serie Virtual real (frankyLog/flog),
  // distinto de serialLog de arriba (que es solo el historial de
  // OP_SERIAL_PRINT). Ver monitor.ts.
  debugEnabled: boolean;
  monitorBuf: LogEntry[];
  monitorHead: number;
  monitorSeq: number;
  monitorCats: ThrottleCat[];
  buzzerFreqHz: number;
  buzzerDurationMs: number;
  buzzerLastPlayedAt: number;
  // Réplica del límite real de tablaBitmap[] (TABLA_BITMAP_MAX=8, Fase
  // 4.4): cuenta cuántas instrucciones OP_OLED_SPRITE con bitmap propio
  // ya se agregaron al programa actual — se resetea en bloquesClear(),
  // igual que el firmware real resetea tablaBitmapLen en cada recompilación.
  tablaBitmapLen: number;

  i2cEnabled: boolean;
  spiEnabled: boolean;
  // FASE GPIO/I2C — SDA/SCL configurables (antes fijos 6/7) + mapa
  // central de reservas (fuente de verdad del modelo virtual, ver gpio.ts).
  i2cSda: number;
  i2cScl: number;
  gpioReserva: GpioMotivo[];

  sensorTemp: number;
  sensorHum: number;
  dhtOK: boolean;
  alarmaActiva: boolean;
  accesoAbierto: boolean;

  sharpAdcValI: number;
  sharpAdcValD: number;
  sharpDetI: boolean;
  sharpDetD: boolean;
}

/** Réplica EXACTA del struct initializer real de cfgMini (.ino líneas 177-186). */
export function defaultSumoConfigMini(): SumoConfig {
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
export function defaultSumoConfigMicro(): SumoConfig {
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

export function defaultFirmwareModel(): FirmwareModel {
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
export const LOGO_MDE_128x64_HEX =
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007f0000001f807fffffc00fffffff80007f8000003fc07ffffff80fffffff8000ff8000007fe07ffffff80fffffff8001ff800000fff07ffffffc0fffffff8001ffe00001fff07ffffffc0fffffff8001fff00001fff07ffffffe0ffffffe0001fff00003fff000000ffe000000000001fff80007fff0000003ff000000000001fff80007ffe0000001ff800000000001fff8000fffc0000001ff800000000003fffc003fffc1fe0000ff9ffffff80003fdfe007fffc1fe0000ff9ffffff80003f9fe00ffbfc3fe0000ff9ffffff80003fdff01ff3fc3fe0000ff9ffffff80003f8ff81fe3fc3fe0000ff1ffffff80003f07f83fc3fc3fe0001fe3ffffff80007f07fc3f83f83fe0001fe3ffffff00007f03fcff03f83fc0001fe3fe000000007f03ffff03f83fc0003fe3fc000000007f01fffe07f83fc0007fe3fc000000007f00fffc07f87fc000ffc3fc000000007f007ff807f87fc003ffc3f8000000f07e007ff007f87fffffff83ffffff9f00fe003fe007f07fffffff07ffffffc000fe003fc007f07ffffffe07ffffffc000fe003f8007f07ffffffc07ffffff8000fe001f0007f07ffffff007ffffff0000fe0006001ff0ffffffc007ffffff000000000000000000000000000000000010000000000000000000000000000003f0000000000000000000000000000007f00000000000000000000000000003fff000000000000000000000000001fffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
export const LOGO_MDE_128x32_HEX =
  "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f800001f03ffffe01fffffc000000001fc00003f83fffff81fffffc000000003fc00007fc3fffffc1fffffc000000003fe0000ffc3fffffc1fffffc000000003ff0000ffc3fffffe1fffff8000000003ff0001ffc00003fe0000000000000003ff8003ffc00000ff0000000000000003ff8007ff800000ff0000000000000007ffc00fff87e0007f3ffffe0000000007efe01fff87e0007f3ffffe0000000007efe03fbf8fe0007f3ffffe0000000007e7f07f3f8fe0007f3ffffe0000000007c3f0fe3f8fe000fe7ffffe000000000fc3f8fc3f0fe000fe7ffffc000000000fc1f9f83f0fc000fe7f0000000000000fc1fff83f0fc001fe7f0000000000000fc0fff07f1fc003fc7f0000000000000fc07fe07f1fc00ffc7e0000070000000f807fc07f1ffffff87ffffe780000001f803f807e1ffffff0ffffff000000001f803f007e1fffffe0fffffe000000001f801e007e1fffff80fffffc000000001f800c00fe3ffffe00fffffc00000000000000000000000000000000010000000000000000000000000000001f000000000000000000000000000007ff0000000000000000000000000001ffff000";
