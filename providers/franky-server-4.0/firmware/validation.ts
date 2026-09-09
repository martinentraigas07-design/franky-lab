/**
 * Réplica exacta de contarADCUsados()/validateSumoADC() del .ino real.
 * Solo Sharp + borde consumen ADC (sonar/óptico usan pines digitales).
 *
 * FASE GPIO/I2C: pinBloqueadoPorBus() se movió a gpio.ts (Fase 4.1 real:
 * pasó de un booleano `i2cEnabled` suelto al mapa central de reservas)
 * — este archivo queda solo con la validación de ADC, que en el .ino
 * real vive separada del sistema de reservas.
 */
import { SumoConfig, TipoDistSensor } from "./model.js";

export function contarADCUsados(cfg: SumoConfig): number {
  let adc = 0;
  if (cfg.tipoDistSensor === TipoDistSensor.SHARP) adc += cfg.numDistSensores;
  adc += cfg.numBorde;
  return adc;
}

export function validateSumoADC(cfg: SumoConfig): boolean {
  return contarADCUsados(cfg) <= 2;
}
