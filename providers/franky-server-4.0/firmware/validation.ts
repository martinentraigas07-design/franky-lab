/**
 * Réplica exacta de contarADCUsados()/validateSumoADC() del .ino real.
 * Solo Sharp + borde consumen ADC (sonar/óptico usan pines digitales).
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

export function pinBloqueadoPorBus(pin: number, i2cEnabled: boolean): boolean {
  return i2cEnabled && (pin === 6 || pin === 7);
}
