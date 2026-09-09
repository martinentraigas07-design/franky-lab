/**
 * Regresión — sistema central de reservas de GPIO/I2C (gpio.ts), fuente
 * de verdad del modelo virtual (condición explícita del usuario). Foco
 * especial en conflictos REALES de recursos: asignar como SDA/SCL un
 * GPIO ya ocupado por otra función debe rechazarse Y dejar la
 * configuración anterior intacta (nunca un estado a medio aplicar).
 */
import { defaultFirmwareModel, defaultSumoConfigMini, GpioMotivo, GPIO_EXPUESTOS, TipoDistSensor } from "../firmware/model.js";
import {
  gpioReservar,
  gpioLiberar,
  gpioLiberarPorMotivo,
  gpioDisponible,
  gpioMotivoActual,
  gpioMotivoTexto,
  pinBloqueadoPorBus,
  gpioSincronizarBuses,
  esPinI2CValido,
  aplicarI2C,
  gpioAplicarReservasSumoActivo,
  gpioEstadoSnapshot,
  PIN_SPI_SCLK,
  PIN_SPI_MOSI,
  PIN_SPI_CS,
} from "../firmware/gpio.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. Reservas de fábrica — motor(4)/led/boton/adc_fijo(2), permanentes; 5 pines restantes LIBRES");
{
  const m = defaultFirmwareModel();
  assert(m.gpioReserva.length === 13, `13 pines expuestos (dio ${m.gpioReserva.length})`);
  assert(gpioMotivoActual(m, 5) === GpioMotivo.MOTOR && gpioMotivoActual(m, 4) === GpioMotivo.MOTOR, "GPIO4/5 (motor A) reservados de fábrica");
  assert(gpioMotivoActual(m, 3) === GpioMotivo.MOTOR && gpioMotivoActual(m, 2) === GpioMotivo.MOTOR, "GPIO2/3 (motor B) reservados de fábrica");
  assert(gpioMotivoActual(m, 8) === GpioMotivo.LED, "GPIO8 (LED) reservado de fábrica");
  assert(gpioMotivoActual(m, 9) === GpioMotivo.BOTON, "GPIO9 (botón) reservado de fábrica");
  assert(gpioMotivoActual(m, 0) === GpioMotivo.ADC_FIJO && gpioMotivoActual(m, 1) === GpioMotivo.ADC_FIJO, "GPIO0/1 (ADC fijo) reservados de fábrica");
  for (const pin of [6, 7, 10, 20, 21]) {
    assert(gpioDisponible(m, pin) === true, `GPIO${pin} arranca LIBRE (I2C/SPI todavía deshabilitados)`);
  }
}

console.log("\n2. gpioReservar/gpioLiberar: no pisa reservas ajenas, es idempotente con el mismo motivo");
{
  const m = defaultFirmwareModel();
  assert(gpioReservar(m, 6, GpioMotivo.I2C) === true, "GPIO6 libre se reserva para I2C");
  assert(gpioReservar(m, 6, GpioMotivo.I2C) === true, "reservar de nuevo con el MISMO motivo es idempotente");
  assert(gpioReservar(m, 6, GpioMotivo.BUS_ALT) === false, "reservar con OTRO motivo mientras está ocupado se rechaza");
  assert(gpioMotivoActual(m, 6) === GpioMotivo.I2C, "el motivo original no cambió tras el rechazo");
  assert(gpioReservar(m, 5, GpioMotivo.I2C) === false, "no se puede reservar un pin de fábrica (motor) para otra función");
  assert(gpioMotivoActual(m, 5) === GpioMotivo.MOTOR, "el motor sigue reservado como motor");
}
{
  const m = defaultFirmwareModel();
  gpioLiberar(m, 5); // intentar liberar un pin de fábrica
  assert(gpioMotivoActual(m, 5) === GpioMotivo.MOTOR, "gpioLiberar() NUNCA libera una reserva de fábrica (motor/led/boton/adc_fijo)");
  gpioReservar(m, 6, GpioMotivo.I2C);
  gpioLiberar(m, 6);
  assert(gpioDisponible(m, 6) === true, "gpioLiberar() SÍ libera una reserva dinámica (I2C)");
}

console.log("\n3. gpioLiberarPorMotivo: libera únicamente el motivo indicado");
{
  const m = defaultFirmwareModel();
  gpioReservar(m, 6, GpioMotivo.I2C);
  gpioReservar(m, 7, GpioMotivo.I2C);
  gpioReservar(m, 20, GpioMotivo.BUS_ALT);
  gpioLiberarPorMotivo(m, GpioMotivo.I2C);
  assert(gpioDisponible(m, 6) === true && gpioDisponible(m, 7) === true, "GPIO6/7 (I2C) quedaron libres");
  assert(gpioMotivoActual(m, 20) === GpioMotivo.BUS_ALT, "GPIO20 (bus_alt) NO se tocó");
}

console.log("\n4. gpioMotivoTexto/pinBloqueadoPorBus/gpioValido — consistencia básica");
{
  const m = defaultFirmwareModel();
  assert(gpioMotivoTexto(GpioMotivo.LIBRE) === "libre", "texto de LIBRE");
  assert(gpioMotivoTexto(GpioMotivo.SENSOR_SUMO) === "sensor_sumo", "texto de SENSOR_SUMO");
  assert(pinBloqueadoPorBus(m, 6) === false, "GPIO6 libre -> no bloqueado");
  gpioReservar(m, 6, GpioMotivo.I2C);
  assert(pinBloqueadoPorBus(m, 6) === true, "GPIO6 reservado -> bloqueado (pinBloqueadoPorBus ya no recibe i2cEnabled suelto)");
}

console.log("\n5. gpioSincronizarBuses: refleja i2cEnabled/spiEnabled/i2cSda/i2cScl en el mapa");
{
  const m = defaultFirmwareModel();
  m.i2cEnabled = true; m.i2cSda = 6; m.i2cScl = 7;
  gpioSincronizarBuses(m);
  assert(gpioMotivoActual(m, 6) === GpioMotivo.I2C && gpioMotivoActual(m, 7) === GpioMotivo.I2C, "SDA/SCL activos quedan reservados como I2C");
  m.spiEnabled = true;
  gpioSincronizarBuses(m);
  assert(gpioMotivoActual(m, PIN_SPI_SCLK) === GpioMotivo.BUS_ALT && gpioMotivoActual(m, PIN_SPI_MOSI) === GpioMotivo.BUS_ALT, "SCLK/MOSI quedan reservados como bus_alt");
  assert(gpioMotivoActual(m, PIN_SPI_CS) === GpioMotivo.LIBRE, "GPIO10 (CS) NO se reserva — misma omisión que el firmware real, preservada a propósito");
  m.i2cEnabled = false; m.spiEnabled = false;
  gpioSincronizarBuses(m);
  assert(gpioDisponible(m, 6) === true && gpioDisponible(m, PIN_SPI_SCLK) === true, "al deshabilitar ambos buses, sus pines vuelven a LIBRE");
}

console.log("\n6. esPinI2CValido: pool real {6,7,10,20,21}, GPIO0/1 NUNCA ofrecidos");
{
  for (const pin of [6, 7, 10, 20, 21]) assert(esPinI2CValido(pin) === true, `GPIO${pin} es válido para I2C`);
  for (const pin of [0, 1, 8, 9, 2, 3, 4, 5]) assert(esPinI2CValido(pin) === false, `GPIO${pin} NO es válido para I2C`);
}

console.log("\n7. aplicarI2C: validaciones básicas (pool, sda≠scl)");
{
  const m = defaultFirmwareModel();
  const r1 = aplicarI2C(m, 99, 7);
  assert(r1.ok === false, "GPIO fuera del pool se rechaza");
  const r2 = aplicarI2C(m, 6, 6);
  assert(r2.ok === false, "SDA=SCL se rechaza");
  assert(m.i2cSda === 6 && m.i2cScl === 7, "tras ambos rechazos, el par por defecto (6/7) sigue intacto");
}

console.log("\n8. CONFLICTO REAL: asignar como SDA/SCL un GPIO ya ocupado se rechaza y la config anterior queda intacta");
{
  const m = defaultFirmwareModel();
  // Mini con UN solo sensor sonar (numDistSensores=1) — reserva solo
  // trigI=20/echoI=21 como SENSOR_SUMO, dejando 6/7/10 libres para I2C.
  // (El default de Mini usa 2 sensores y ocupa 20,21,6,7 — los 4 pines
  // se solapan con el pool I2C completo salvo GPIO10, ver hallazgo abajo.)
  const miniUnSensor = { ...defaultSumoConfigMini(), numDistSensores: 1 as 1 | 2 };
  gpioAplicarReservasSumoActivo(m, miniUnSensor);
  assert(gpioMotivoActual(m, 20) === GpioMotivo.SENSOR_SUMO, "GPIO20 (trigI de Mini) queda reservado como sensor de Sumo");
  assert(gpioDisponible(m, 6) === true && gpioDisponible(m, 7) === true, "con 1 solo sensor, GPIO6/7 (trigD/echoD no usados) quedan libres");

  // Aplicar un i2c inicial válido (6/7 — libres, no chocan con 20/21).
  const inicial = aplicarI2C(m, 6, 7);
  assert(inicial.ok === true, `par inicial 6/7 se aplica sin conflicto (error: ${inicial.ok ? "" : inicial.error})`);

  // Ahora intentar MOVER el I2C a 20/21 — GPIO20/21 están ocupados por
  // SENSOR_SUMO (Mini). Debe rechazarse.
  const conflicto = aplicarI2C(m, 20, 21);
  assert(conflicto.ok === false, "mover I2C a GPIO20/21 (ocupados por sensor de Sumo) se rechaza");
  assert(!conflicto.ok && /ocupado/.test(conflicto.error), `el mensaje de error identifica el conflicto (dio: "${!conflicto.ok ? conflicto.error : ""}")`);
  assert(m.i2cSda === 6 && m.i2cScl === 7, "tras el rechazo, el par ANTERIOR (6/7) permanece intacto — no queda a medio aplicar");
  assert(gpioMotivoActual(m, 6) === GpioMotivo.I2C && gpioMotivoActual(m, 7) === GpioMotivo.I2C, "la reserva I2C anterior (6/7) se restauró completa, no se perdió");
  assert(gpioMotivoActual(m, 20) === GpioMotivo.SENSOR_SUMO && gpioMotivoActual(m, 21) === GpioMotivo.SENSOR_SUMO, "GPIO20/21 siguen siendo del sensor de Sumo, no quedaron a medio liberar");
}

console.log("\n8b. HALLAZGO documentado: el default de fábrica de Mini (sonar dual) ocupa 4 de los 5 pines del pool I2C");
{
  const m = defaultFirmwareModel();
  gpioAplicarReservasSumoActivo(m, defaultSumoConfigMini()); // numDistSensores=2 -> trigI,echoI,trigD,echoD = 20,21,6,7
  for (const pin of [6, 7, 20, 21]) {
    assert(gpioMotivoActual(m, pin) === GpioMotivo.SENSOR_SUMO, `GPIO${pin} ocupado por el sonar dual de fábrica de Mini`);
  }
  assert(gpioDisponible(m, 10) === true, "solo GPIO10 queda libre del pool I2C — no alcanza un par (SDA≠SCL) sin reconfigurar el sensor de Sumo primero");
  const intento = aplicarI2C(m, 6, 10);
  assert(intento.ok === false, "con Mini (sonar dual) activo, NINGÚN par I2C es aplicable sin liberar antes el sensor — comportamiento esperado, no un bug del LAB");
}

console.log("\n9. aplicarI2C: mover reutilizando uno de los pines actuales no se bloquea a sí mismo");
{
  const m = defaultFirmwareModel();
  aplicarI2C(m, 6, 7);
  const r = aplicarI2C(m, 6, 10); // SDA se mantiene, SCL pasa de 7 a 10
  assert(r.ok === true, `mover de 6/7 a 6/10 (reutilizando SDA) funciona (error: ${r.ok ? "" : r.error})`);
  assert(m.i2cSda === 6 && m.i2cScl === 10, "el nuevo par (6/10) quedó aplicado");
  assert(gpioDisponible(m, 7) === true, "GPIO7 (SCL anterior) quedó libre");
}

console.log("\n10. aplicarI2C: par válido sin conflicto se aplica normalmente");
{
  const m = defaultFirmwareModel();
  const r = aplicarI2C(m, 10, 20);
  assert(r.ok === true, `10/20 (libres, sin Sumo/SPI activo) se aplica (error: ${r.ok ? "" : r.error})`);
  assert(m.i2cSda === 10 && m.i2cScl === 20, "par aplicado correctamente");
}

console.log("\n11. gpioAplicarReservasSumoActivo: libera la reserva anterior antes de aplicar la nueva");
{
  const m = defaultFirmwareModel();
  gpioAplicarReservasSumoActivo(m, defaultSumoConfigMini()); // sonar: 20,21,6,7
  assert(gpioMotivoActual(m, 20) === GpioMotivo.SENSOR_SUMO, "reserva inicial (Mini, sonar) aplicada");

  const perfilOptico = { ...defaultSumoConfigMini(), tipoDistSensor: TipoDistSensor.OPTICO, optPinI: 6, optPinD: 7, numDistSensores: 2 as 1 | 2 };
  gpioAplicarReservasSumoActivo(m, perfilOptico);
  assert(gpioDisponible(m, 20) === true && gpioDisponible(m, 21) === true, "los pines sonar anteriores (20/21) se liberaron");
  assert(gpioMotivoActual(m, 6) === GpioMotivo.SENSOR_SUMO && gpioMotivoActual(m, 7) === GpioMotivo.SENSOR_SUMO, "los nuevos pines ópticos (6/7) quedaron reservados");
}

console.log("\n12. gpioEstadoSnapshot: forma exacta del handleGpioEstado() real");
{
  const m = defaultFirmwareModel();
  const snap = gpioEstadoSnapshot(m);
  assert(snap.pines.length === 13, "13 pines en el snapshot");
  assert(snap.i2c_sda === m.i2cSda && snap.i2c_scl === m.i2cScl, "i2c_sda/i2c_scl reflejan el modelo");
  const pinLed = snap.pines.find((p) => p.gpio === 8);
  assert(!!pinLed && pinLed.libre === false && pinLed.motivo === "led", "GPIO8 reportado como ocupado, motivo=led");
  assert(JSON.stringify(snap.pines.map((p) => p.gpio)) === JSON.stringify([...GPIO_EXPUESTOS]), "el orden de los pines coincide con GPIO_EXPUESTOS real");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
