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
  spdBuscExt: number;
  spdBuscInt: number;
  spdEvasion: number;
  estrategia: 0 | 1;
}

export interface Instruccion {
  op: number;
  val: number;
  txt?: string; // solo para OP_OLED_PRINT (Lab, opcode 104) — el firmware real no lo usa
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
  kind: "text" | "line" | "rect" | "circle";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  r?: number;
  text?: string;
}
export interface OledState {
  on: boolean;
  cursorX: number;
  cursorY: number;
  draft: OledElement[];
  shown: OledElement[];
}
export function defaultOledState(): OledState {
  return { on: false, cursorX: 0, cursorY: 0, draft: [], shown: [] };
}

export const MAX_INST = 64;

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
  buzzerFreqHz: number;
  buzzerDurationMs: number;
  buzzerLastPlayedAt: number;

  i2cEnabled: boolean;
  spiEnabled: boolean;

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
    spdBuscExt: 210,
    spdBuscInt: 80,
    spdEvasion: 220,
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
    spdBuscExt: 200,
    spdBuscInt: 60,
    spdEvasion: 200,
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
