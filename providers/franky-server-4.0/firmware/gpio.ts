/**
 * FRANKY LAB — Provider franky-server-4.0 / GPIO & I2C
 *
 * Puerto FIEL del sistema central de reservas real (Fase 4.1 + 4.2 del
 * .ino): gpioReservar()/gpioLiberar()/gpioLiberarPorMotivo()/
 * gpioDisponible()/gpioMotivoActual()/gpioMotivoTexto(), pinBloqueadoPorBus(),
 * gpioSincronizarBuses(), esPinI2CValido(), aplicarI2C() y
 * gpioAplicarReservasSumoActivo().
 *
 * Las reservas de fábrica (motor/led/botón/adc_fijo) y el estado
 * (`gpioReserva[]`, `i2cSda`, `i2cScl`) viven en `model.ts` — este
 * archivo es SOLO comportamiento (mismo principio que sumoEngine.ts vs
 * SumoConfig): `FirmwareModel.gpioReserva` es la fuente de verdad del
 * modelo virtual, y todas las funciones de acá leen/mutan ese array
 * directamente, nunca un estado paralelo.
 *
 * DIFERENCIA DOCUMENTADA respecto del `.ino` real: `aplicarI2C()` real
 * persiste en NVS y hace `ESP.restart()` para que `Wire.begin()` se
 * reconstruya limpio. El LAB no tiene equivalente de reinicio — el
 * cambio de SDA/SCL se aplica en caliente, inmediatamente (confirmado
 * explícitamente con el usuario antes de implementar esta fase).
 */
import { FirmwareModel, GpioMotivo, GPIO_EXPUESTOS, SumoConfig, TipoDistSensor } from "./model.js";
import { PIN } from "./motorControl.js";

// ── Pool I2C/SPI — réplica de los #define reales ──────────────────────
export const PIN_I2C_SDA_DEFAULT = 6;
export const PIN_I2C_SCL_DEFAULT = 7;
export const PIN_SPI_CS = 10;
export const PIN_SPI_SCLK = 20;
export const PIN_SPI_MOSI = 21;

// ── Núcleo del mapa de reservas ────────────────────────────────────────
export function gpioIndex(pin: number): number {
  return GPIO_EXPUESTOS.indexOf(pin);
}
export function gpioValido(pin: number): boolean {
  return gpioIndex(pin) >= 0;
}

/** Reserva un pin para un motivo. false (sin reservar nada) si ya está ocupado por un motivo DISTINTO — nunca pisa una reserva ajena en silencio. Idempotente si ya era del mismo motivo. */
export function gpioReservar(model: FirmwareModel, pin: number, motivo: GpioMotivo): boolean {
  const idx = gpioIndex(pin);
  if (idx < 0) return false; // GPIO inexistente en este hardware
  const actual = model.gpioReserva[idx];
  if (actual !== GpioMotivo.LIBRE && actual !== motivo) return false;
  model.gpioReserva[idx] = motivo;
  return true;
}

/** Libera un pin — SOLO tiene efecto sobre reservas dinámicas (I2C, bus alternativo, sensor de Sumo). Las reservas de fábrica son permanentes. */
export function gpioLiberar(model: FirmwareModel, pin: number): void {
  const idx = gpioIndex(pin);
  if (idx < 0) return;
  const m = model.gpioReserva[idx];
  if (m === GpioMotivo.MOTOR || m === GpioMotivo.LED || m === GpioMotivo.BOTON || m === GpioMotivo.ADC_FIJO) return;
  model.gpioReserva[idx] = GpioMotivo.LIBRE;
}

/** Libera TODOS los pines reservados por un motivo dado — usado al cambiar de par I2C o de perfil de Sumo activo. */
export function gpioLiberarPorMotivo(model: FirmwareModel, motivo: GpioMotivo): void {
  for (let i = 0; i < model.gpioReserva.length; i++) {
    if (model.gpioReserva[i] === motivo) model.gpioReserva[i] = GpioMotivo.LIBRE;
  }
}

export function gpioDisponible(model: FirmwareModel, pin: number): boolean {
  const idx = gpioIndex(pin);
  if (idx < 0) return false; // un GPIO que no existe nunca está "disponible"
  return model.gpioReserva[idx] === GpioMotivo.LIBRE;
}

export function gpioMotivoActual(model: FirmwareModel, pin: number): GpioMotivo {
  const idx = gpioIndex(pin);
  if (idx < 0) return GpioMotivo.MOTOR; // valor defensivo — igual criterio que el real (nunca debería consultarse un pin inválido)
  return model.gpioReserva[idx];
}

export function gpioMotivoTexto(m: GpioMotivo): string {
  switch (m) {
    case GpioMotivo.LIBRE: return "libre";
    case GpioMotivo.MOTOR: return "motor";
    case GpioMotivo.LED: return "led";
    case GpioMotivo.BOTON: return "boton";
    case GpioMotivo.ADC_FIJO: return "adc_fijo";
    case GpioMotivo.I2C: return "i2c";
    case GpioMotivo.BUS_ALT: return "bus_alt";
    case GpioMotivo.SENSOR_SUMO: return "sensor_sumo";
    default: return "?";
  }
}

/**
 * Réplica de pinBloqueadoPorBus(pin) real (Fase 4.1) — YA NO recibe
 * `i2cEnabled` suelto como antes de esta fase: la fuente de verdad es
 * el mapa central `gpioReserva[]`, sincronizado por gpioSincronizarBuses().
 */
export function pinBloqueadoPorBus(model: FirmwareModel, pin: number): boolean {
  return !gpioDisponible(model, pin);
}

/**
 * Réplica de gpioSincronizarBuses() real: se llama después de construir/
 * cargar el modelo y cada vez que cambian i2cEnabled/spiEnabled o
 * i2cSda/i2cScl, para que el mapa de reservas nunca quede desincronizado.
 * Nota fiel al real: si el pin ya está ocupado por otro motivo, la
 * reserva simplemente no se aplica (gpioReservar devuelve false y acá no
 * se revisa) — el real tampoco lo revisa en este punto; la protección
 * real contra conflictos vive en aplicarI2C()/handleSumoConfig(), no acá.
 */
export function gpioSincronizarBuses(model: FirmwareModel): void {
  gpioLiberarPorMotivo(model, GpioMotivo.I2C);
  gpioLiberarPorMotivo(model, GpioMotivo.BUS_ALT);
  if (model.i2cEnabled) {
    gpioReservar(model, model.i2cSda, GpioMotivo.I2C);
    gpioReservar(model, model.i2cScl, GpioMotivo.I2C);
  }
  if (model.spiEnabled) {
    gpioReservar(model, PIN_SPI_SCLK, GpioMotivo.BUS_ALT);
    gpioReservar(model, PIN_SPI_MOSI, GpioMotivo.BUS_ALT);
  }
  // Nota real: PIN_SPI_CS (GPIO10) NO se reservaba en el comportamiento
  // original — se preserva esa misma omisión acá a propósito.
}

/** Réplica de esPinI2CValido() real — mismo pool {6,7,10,20,21}, GPIO0/1 NUNCA se ofrecen (únicos 2 canales ADC). */
export function esPinI2CValido(pin: number): boolean {
  return pin === PIN_I2C_SDA_DEFAULT || pin === PIN_I2C_SCL_DEFAULT || pin === PIN_SPI_CS || pin === PIN_SPI_SCLK || pin === PIN_SPI_MOSI;
}

export type AplicarI2CResult = { ok: true } | { ok: false; error: string };

/**
 * Réplica de aplicarI2C() real: valida el pool, valida sda≠scl, libera la
 * reserva I2C actual ANTES de chequear disponibilidad (para poder "mover"
 * el bus reutilizando alguno de los pines actuales sin bloquearse a sí
 * mismo), y si el par pedido choca con otra función, REVIERTE al par
 * anterior — nunca deja el sistema sin el I2C reservado ni aplica un
 * estado a medio camino.
 */
export function aplicarI2C(model: FirmwareModel, sda: number, scl: number): AplicarI2CResult {
  if (!esPinI2CValido(sda) || !esPinI2CValido(scl)) {
    return { ok: false, error: "GPIO invalido para I2C (solo 6,7,10,20,21)" };
  }
  if (sda === scl) return { ok: false, error: "SDA y SCL no pueden ser el mismo GPIO" };

  const sdaAnterior = model.i2cSda;
  const sclAnterior = model.i2cScl;
  gpioLiberarPorMotivo(model, GpioMotivo.I2C);

  if (!gpioDisponible(model, sda) || !gpioDisponible(model, scl)) {
    // Revertir: el par pedido choca con otra función (bus_alt o un sensor
    // de Sumo activo) — se restaura la reserva anterior tal cual estaba,
    // nunca se deja el sistema sin el I2C reservado.
    gpioReservar(model, sdaAnterior, GpioMotivo.I2C);
    gpioReservar(model, sclAnterior, GpioMotivo.I2C);
    const error =
      "GPIO ocupado por otra funcion (sda=" + gpioMotivoTexto(gpioMotivoActual(model, sda)) +
      " scl=" + gpioMotivoTexto(gpioMotivoActual(model, scl)) + ")";
    return { ok: false, error };
  }

  gpioReservar(model, sda, GpioMotivo.I2C);
  gpioReservar(model, scl, GpioMotivo.I2C);
  model.i2cSda = sda;
  model.i2cScl = scl;
  return { ok: true };
}

/**
 * Réplica de gpioAplicarReservasSumoActivo() real: reserva SOLO los
 * pines de sensor (sonar/óptico) del perfil `cfgActiva` — Sharp y borde
 * ya viven en GPIO0/GPIO1, permanentemente reservados como ADC_FIJO
 * desde `defaultGpioReserva()`, no hace falta (ni corresponde) volver a
 * reservarlos acá.
 */
export function gpioAplicarReservasSumoActivo(model: FirmwareModel, cfgActiva: SumoConfig): void {
  gpioLiberarPorMotivo(model, GpioMotivo.SENSOR_SUMO);
  if (cfgActiva.tipoDistSensor === TipoDistSensor.SONAR) {
    gpioReservar(model, cfgActiva.trigI, GpioMotivo.SENSOR_SUMO);
    gpioReservar(model, cfgActiva.echoI, GpioMotivo.SENSOR_SUMO);
    if (cfgActiva.numDistSensores >= 2) {
      gpioReservar(model, cfgActiva.trigD, GpioMotivo.SENSOR_SUMO);
      gpioReservar(model, cfgActiva.echoD, GpioMotivo.SENSOR_SUMO);
    }
  } else if (cfgActiva.tipoDistSensor === TipoDistSensor.OPTICO) {
    gpioReservar(model, cfgActiva.optPinI, GpioMotivo.SENSOR_SUMO);
    if (cfgActiva.numDistSensores >= 2) gpioReservar(model, cfgActiva.optPinD, GpioMotivo.SENSOR_SUMO);
  }
}

/** Snapshot de los 13 pines expuestos — réplica de handleGpioEstado() real. */
export interface GpioEstadoPin {
  gpio: number;
  libre: boolean;
  motivo: string;
}
export function gpioEstadoSnapshot(model: FirmwareModel): { pines: GpioEstadoPin[]; i2c_sda: number; i2c_scl: number } {
  const pines = GPIO_EXPUESTOS.map((gpio, i) => ({
    gpio,
    libre: model.gpioReserva[i] === GpioMotivo.LIBRE,
    motivo: gpioMotivoTexto(model.gpioReserva[i]),
  }));
  return { pines, i2c_sda: model.i2cSda, i2c_scl: model.i2cScl };
}
