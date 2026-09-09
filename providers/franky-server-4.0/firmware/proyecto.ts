/**
 * FRANKY LAB — Provider franky-server-4.0 / Proyecto FRANKY (.franky)
 *
 * Puerto FIEL de generarProyectoJson()/handleProyectoImport()/
 * proyectoValidarSumo()/proyectoValidarI2C()/proyectoValidarSpi()/
 * proyectoValidarTrim()/proyectoValidarBlockly() del firmware real
 * (fase "Sistema de Proyectos FRANKY" + "Cierre Sumo" — formato v2).
 * Import ATÓMICO: se valida TODO contra variables de staging antes de
 * aplicar nada — si cualquier sección falla, no se toca ningún estado
 * real (mismo criterio que el .ino).
 *
 * ALCANCE DE ESTA FASE (confirmado explícitamente con el usuario):
 * - I2C: FASE GPIO/I2C (posterior) cerró la limitación original de esta
 *   sección — SDA/SCL ya son configurables (pool {6,7,10,20,21}, ver
 *   gpio.ts). validarI2C() valida contra ese pool real, no un par fijo.
 * - "Modo de inicio" (servidor/botón): el LAB no modela esta restricción
 *   (fase "Persistencia Sumo" del Server real, no portada). Se exporta
 *   un valor fijo (ambos habilitados) — no hay campo real que actualizar
 *   al importar.
 * - Blockly XML: el LAB no tiene un equivalente a SPIFFS ("Programa
 *   Fuente") donde persista el XML del lado del "robot" — sigue siendo
 *   responsabilidad del navegador (bloques.html/localStorage), igual
 *   que el Server real ANTES de esa fase. Se exporta siempre `null`; en
 *   el import se valida superficialmente (mismo criterio que
 *   proyectoValidarBlockly() real) pero no se aplica a ningún estado del
 *   Firmware Model — el navegador es quien debe cargarlo al Workspace.
 */
import { SumoConfig, TipoDistSensor, CABECEO_MS } from "./model.js";
import { validateSumoADC } from "./validation.js";
import { esPinI2CValido } from "./gpio.js";

export const PROYECTO_FORMAT = "FRANKY";
export const PROYECTO_VERSION = 2;
export const PROYECTO_FW_VER = "3.2-LNR (FRANKY LAB virtual)";
export const PROYECTO_BODY_MAX = 49152; // 48KB, igual que el firmware real

/** Réplica de GPIO_EXPUESTOS[] real — los 13 GPIO físicos del ESP32-C3 SuperMini. */
const GPIO_EXPUESTOS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21];
function gpioValido(pin: number): boolean {
  return GPIO_EXPUESTOS.includes(pin);
}

export class ProyectoError extends Error {}

// ---- Lectura validada (aborta con ProyectoError, igual que el "todo o nada" real) ----
function leerEntero(obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ProyectoError(`falta o invalido: ${key}`);
  if (v < min || v > max) throw new ProyectoError(`fuera de rango: ${key}=${v}`);
  return v;
}
function leerBool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new ProyectoError(`${key}: falta o invalido`);
  return v;
}
function leerObjeto(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProyectoError(`falta la seccion "${key}"`);
  return v as Record<string, unknown>;
}

// ---- Sumo: export (proyectoJsonSumo) ----
export interface ProyectoSumoJson {
  tipoDistSensor: number;
  numDistSensores?: number;
  trigI: number; echoI: number;
  trigD?: number; echoD?: number;
  sharpPinI: number; sharpPinD?: number;
  umbralSharp: number;
  optPinI: number; optPinD?: number;
  numBorde: number; bordePinI: number; bordePinD?: number;
  umbralBorde: number;
  umbralDistCm: number;
  spdAtaque: number;
  velBusqueda: number; intGiro: number;
  spdBuscExt: number; spdBuscInt: number; // legado v1 — reconstruido, no leído del struct
  spdEvasion: number;
  estrategia?: number;
  durBarrido?: number;
}

function proyectoJsonSumo(
  cfg: SumoConfig,
  completo: boolean,
  velExterna: (c: SumoConfig) => number,
  velInterna: (c: SumoConfig) => number,
): ProyectoSumoJson {
  const j: ProyectoSumoJson = {
    tipoDistSensor: cfg.tipoDistSensor,
    trigI: cfg.trigI,
    echoI: cfg.echoI,
    sharpPinI: cfg.sharpPinI,
    umbralSharp: cfg.umbralSharp,
    optPinI: cfg.optPinI,
    numBorde: cfg.numBorde,
    bordePinI: cfg.bordePinI,
    umbralBorde: cfg.umbralBorde,
    umbralDistCm: cfg.umbralDistCm,
    spdAtaque: cfg.spdAtaque,
    velBusqueda: cfg.velBusqueda,
    intGiro: cfg.intGiro,
    spdBuscExt: velExterna(cfg),
    spdBuscInt: velInterna(cfg),
    spdEvasion: cfg.spdEvasion,
  };
  if (completo) {
    j.numDistSensores = cfg.numDistSensores;
    j.trigD = cfg.trigD;
    j.echoD = cfg.echoD;
    j.sharpPinD = cfg.sharpPinD;
    j.optPinD = cfg.optPinD;
    j.bordePinD = cfg.bordePinD;
    j.estrategia = cfg.estrategia;
    j.durBarrido = cfg.durBarrido;
  }
  return j;
}

// ---- Sumo: import (proyectoValidarSumo) ----
function validarSumo(obj: Record<string, unknown>, base: SumoConfig, completo: boolean): SumoConfig {
  const destino: SumoConfig = { ...base };

  destino.tipoDistSensor = leerEntero(obj, "tipoDistSensor", 0, 2) as TipoDistSensor;

  // HALLAZGO (no un "no inventes rangos nuevos", sino una inconsistencia
  // real): proyectoJsonSumo() del .ino SOLO emite "numDistSensores" si
  // completo=true (ver esa función), pero proyectoValidarSumo() real lo
  // EXIGE incondicionalmente antes de sobreescribirlo a 1 para Micro dos
  // líneas después — el propio round-trip export->import de un Micro
  // generado por ese firmware fallaría por esta causa. Réplica FIEL del
  // resultado final (numDistSensores siempre 1 para Micro) pero el campo
  // se trata como OPCIONAL cuando !completo, para que el LAB no herede
  // una inconsistencia que rompería su propio export/import.
  let destinoNumDist = 1;
  if (completo) {
    destinoNumDist = leerEntero(obj, "numDistSensores", 1, 2);
  }
  destino.numDistSensores = destinoNumDist as 1 | 2; // micro es siempre 1 sensor — no se persiste distinto

  destino.trigI = leerEntero(obj, "trigI", 0, 255);
  destino.echoI = leerEntero(obj, "echoI", 0, 255);
  if (!gpioValido(destino.trigI) || !gpioValido(destino.echoI)) {
    throw new ProyectoError("trigI/echoI: GPIO fuera del hardware real (ESP32-C3 SuperMini)");
  }

  if (completo) {
    destino.trigD = leerEntero(obj, "trigD", 0, 255);
    destino.echoD = leerEntero(obj, "echoD", 0, 255);
    if (!gpioValido(destino.trigD) || !gpioValido(destino.echoD)) {
      throw new ProyectoError("trigD/echoD: GPIO fuera del hardware real (ESP32-C3 SuperMini)");
    }
  } else {
    destino.trigD = 0;
    destino.echoD = 0;
  }

  destino.sharpPinI = leerEntero(obj, "sharpPinI", 0, 1) as 0 | 1;
  if (completo) destino.sharpPinD = leerEntero(obj, "sharpPinD", 0, 1) as 0 | 1;
  else destino.sharpPinD = 0;

  destino.umbralSharp = leerEntero(obj, "umbralSharp", 100, 4095);

  destino.optPinI = leerEntero(obj, "optPinI", 0, 255);
  if (!gpioValido(destino.optPinI)) throw new ProyectoError("optPinI: GPIO fuera del hardware real (ESP32-C3 SuperMini)");
  if (completo) {
    destino.optPinD = leerEntero(obj, "optPinD", 0, 255);
    if (!gpioValido(destino.optPinD)) throw new ProyectoError("optPinD: GPIO fuera del hardware real (ESP32-C3 SuperMini)");
  } else {
    destino.optPinD = 0;
  }

  destino.numBorde = leerEntero(obj, "numBorde", 0, 2) as 0 | 1 | 2;
  destino.bordePinI = leerEntero(obj, "bordePinI", 0, 1) as 0 | 1;
  if (completo) destino.bordePinD = leerEntero(obj, "bordePinD", 0, 1) as 0 | 1;
  else destino.bordePinD = 0;
  destino.umbralBorde = leerEntero(obj, "umbralBorde", 100, 4095);

  destino.umbralDistCm = leerEntero(obj, "umbralDistCm", 2, 200);
  destino.spdAtaque = leerEntero(obj, "spdAtaque", 0, 255);

  // FASE "CIERRE SUMO" — velBusqueda/intGiro (v2) con migración desde
  // spdBuscExt/spdBuscInt (v1) — mismo criterio que loadSumoConfig()/
  // proyectoValidarSumo() real: ningún .franky exportado antes de esta
  // fase pierde su calibración al importarse.
  if (typeof obj["velBusqueda"] === "number") {
    destino.velBusqueda = leerEntero(obj, "velBusqueda", 0, 255);
    destino.intGiro = leerEntero(obj, "intGiro", 0, 255);
  } else {
    const ext = leerEntero(obj, "spdBuscExt", 0, 255);
    const intr = leerEntero(obj, "spdBuscInt", 0, 255);
    destino.velBusqueda = Math.floor((ext + intr) / 2);
    destino.intGiro = ext >= intr ? ext - intr : 0;
  }

  destino.spdEvasion = leerEntero(obj, "spdEvasion", 0, 255);

  if (completo) {
    destino.estrategia = leerEntero(obj, "estrategia", 0, 1) as 0 | 1;
    // "Duración del barrido" — opcional (un .franky viejo no la trae):
    // si falta, se conserva CABECEO_MS de fábrica.
    if (typeof obj["durBarrido"] === "number") {
      destino.durBarrido = leerEntero(obj, "durBarrido", 50, 3000);
    } else {
      destino.durBarrido = CABECEO_MS;
    }
  } else {
    destino.estrategia = 0; // micro siempre círculo — no configurable
    destino.durBarrido = CABECEO_MS; // micro no usa barrido — valor de fábrica, no relevante
  }

  if (!validateSumoADC(destino)) {
    throw new ProyectoError("la combinacion Sharp+Borde supera los 2 canales ADC disponibles");
  }
  return destino;
}

// ---- I2C / SPI / Trim / Blockly (import) ----
function validarI2C(obj: Record<string, unknown>): { enabled: boolean; sda: number; scl: number } {
  const sda = leerEntero(obj, "sda", 0, 255);
  const scl = leerEntero(obj, "scl", 0, 255);
  const enabled = leerBool(obj, "enabled");
  // FASE GPIO/I2C: réplica de proyectoValidarI2C() real — pool
  // {6,7,10,20,21} + SDA≠SCL, sin exigir un par fijo.
  if (!esPinI2CValido(sda) || !esPinI2CValido(scl)) {
    throw new ProyectoError("GPIO invalido para I2C (solo 6,7,10,20,21)");
  }
  if (sda === scl) throw new ProyectoError("SDA y SCL no pueden ser el mismo GPIO");
  return { enabled, sda, scl };
}
function validarSpi(obj: Record<string, unknown>): { enabled: boolean } {
  return { enabled: leerBool(obj, "enabled") };
}
function validarTrim(obj: Record<string, unknown>): { motorA: number; motorB: number } {
  return { motorA: leerEntero(obj, "motorA", 0, 255), motorB: leerEntero(obj, "motorB", 0, 255) };
}
/** Validación SUPERFICIAL de blockly.xml — mismo criterio que proyectoValidarBlockly() real: null es válido. */
function validarBlockly(obj: Record<string, unknown>): string | null {
  const xml = obj["xml"];
  if (xml === null || xml === undefined) return null;
  if (typeof xml !== "string") throw new ProyectoError("blockly.xml: falta, o no es texto ni null");
  const t = xml.trim();
  if (t.length === 0) return null; // equivalente a "sin programa"
  if (t.length > 40000) throw new ProyectoError("blockly.xml: demasiado grande (>40000 caracteres)");
  if (!t.startsWith("<xml")) throw new ProyectoError("blockly.xml: no tiene forma de XML de Blockly (debe empezar con <xml)");
  if (!t.endsWith("</xml>") && !t.endsWith("/>")) throw new ProyectoError("blockly.xml: no parece un XML de Blockly bien formado");
  return xml;
}

// ---- API pública: export ----
export function generarProyectoJson(
  cfgMini: SumoConfig,
  cfgMicro: SumoConfig,
  perfilActivo: 0 | 1,
  i2cEnabled: boolean,
  i2cSda: number,
  i2cScl: number,
  spiEnabled: boolean,
  trimA: number,
  trimB: number,
  velExterna: (c: SumoConfig) => number,
  velInterna: (c: SumoConfig) => number,
) {
  return {
    format: PROYECTO_FORMAT,
    version: PROYECTO_VERSION,
    firmware: PROYECTO_FW_VER,
    sumo: {
      mini: proyectoJsonSumo(cfgMini, true, velExterna, velInterna),
      micro: proyectoJsonSumo(cfgMicro, false, velExterna, velInterna),
      perfilActivo,
      // Ver nota de ALCANCE: el LAB no modela restricciones de "modo de
      // inicio" — valor fijo, no hay campo real que refleje.
      inicio: { servidor: true, boton: true },
    },
    i2c: { enabled: i2cEnabled, sda: i2cSda, scl: i2cScl },
    spi: { enabled: spiEnabled },
    trim: { motorA: trimA, motorB: trimB },
    // Ver nota de ALCANCE: el LAB no persiste el XML del "robot" — el
    // navegador (bloques.html) es quien debe completar este campo antes
    // de descargar el archivo, igual que proyecto.html hacía con
    // localStorage en el Server real ANTES de la fase "Programa Fuente".
    blockly: { xml: null as string | null },
  };
}

// ---- API pública: import ----
export interface ProyectoImportResult {
  cfgMini: SumoConfig;
  cfgMicro: SumoConfig;
  perfilActivo?: 0 | 1;
  i2cEnabled: boolean;
  i2cSda: number;
  i2cScl: number;
  spiEnabled: boolean;
  trimA: number;
  trimB: number;
  blocklyXml: string | null;
}

/** Lanza ProyectoError ante cualquier problema — atomicidad: el caller no debe aplicar nada si esto tira. */
export function validarProyectoImport(body: unknown, baseMini: SumoConfig, baseMicro: SumoConfig): ProyectoImportResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ProyectoError('No es un archivo de Proyecto FRANKY valido (falta "format":"FRANKY")');
  }
  const b = body as Record<string, unknown>;
  if (b["format"] !== PROYECTO_FORMAT) {
    throw new ProyectoError('No es un archivo de Proyecto FRANKY valido (falta "format":"FRANKY")');
  }
  const version = b["version"];
  if (typeof version !== "number") throw new ProyectoError('Falta "version" en el archivo');
  // FASE "CIERRE SUMO": este Laboratorio exporta version 2 pero sigue
  // aceptando version 1 en import — validarSumo() ya migra los campos
  // viejos (spdBuscExt/spdBuscInt) si los nuevos no están presentes.
  if (version !== 1 && version !== 2) {
    throw new ProyectoError(`Version de proyecto no soportada por este Laboratorio: ${version}`);
  }

  const sumoObj = leerObjeto(b, "sumo");
  const miniObj = leerObjeto(sumoObj, "mini");
  const microObj = leerObjeto(sumoObj, "micro");
  const i2cObj = leerObjeto(b, "i2c");
  const spiObj = leerObjeto(b, "spi");
  const trimObj = leerObjeto(b, "trim");
  const blocklyObj = leerObjeto(b, "blockly");

  // Todo se valida en variables de staging ANTES de que el caller aplique nada.
  const cfgMini = validarSumo(miniObj, baseMini, true);
  const cfgMicro = validarSumo(microObj, baseMicro, false);
  const { enabled: i2cEnabled, sda: i2cSda, scl: i2cScl } = validarI2C(i2cObj);
  const { enabled: spiEnabled } = validarSpi(spiObj);
  const { motorA: trimA, motorB: trimB } = validarTrim(trimObj);
  const blocklyXml = validarBlockly(blocklyObj);

  // perfilActivo — OPCIONAL a propósito (fase "Persistencia Sumo" real):
  // un .franky exportado antes no lo trae, y debe seguir importando.
  let perfilActivo: 0 | 1 | undefined;
  const perfilRaw = sumoObj["perfilActivo"];
  if (perfilRaw === 0 || perfilRaw === 1) perfilActivo = perfilRaw;

  return { cfgMini, cfgMicro, perfilActivo, i2cEnabled, i2cSda, i2cScl, spiEnabled, trimA, trimB, blocklyXml };
}
