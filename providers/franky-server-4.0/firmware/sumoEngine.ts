/**
 * FRANKY LAB — Núcleo de combate Sumo (ejecutarSumo real, completo)
 *
 * Puerto FIEL de ejecutarSumo()/tickEvasion()/searchCircle()/searchSweep()
 * del .ino real (líneas 556-666). La Etapa anterior solo había portado la
 * mitad defensiva (evasión de borde) — esta versión agrega la mitad
 * ofensiva completa: lectura de oponente dual, ataque, y las dos
 * estrategias de búsqueda (círculo / cabeceo). Esto es lo que hacía que
 * "Minisumo no iniciara": tras el retardo de 5s el robot no tenía ninguna
 * conducta programada y se quedaba quieto.
 */
import { EvadeState, FirmwareModel, SumoConfig, TipoDistSensor } from "./model.js";
import { RobotHAL } from "../../../core/src/robotHal.js";
import { moveDirLetter, moveDiff, stopMotorsShared } from "./motorControl.js";

import {
  RETARDO_SUMO_MS, EVADE_BACK_MS, EVADE_TURN_SIMPLE_MS, EVADE_TURN_DOBLE_MS,
} from "../../../core/src/simulationEngine.js";
export { RETARDO_SUMO_MS, EVADE_BACK_MS, EVADE_TURN_SIMPLE_MS, EVADE_TURN_DOBLE_MS };
export const CABECEO_MS = 300;

// ---- Lectura de sensores (borde y oponente, dual izq/der) ----

export function leerBordeIzq(hal: RobotHAL, cfg: SumoConfig): boolean {
  if (cfg.numBorde < 1) return false;
  return hal.analogRead(cfg.bordePinI) >= cfg.umbralBorde;
}
export function leerBordeDer(hal: RobotHAL, cfg: SumoConfig): boolean {
  if (cfg.numBorde < 2) return false;
  return hal.analogRead(cfg.bordePinD) >= cfg.umbralBorde;
}

/**
 * Réplica de leerOponente(): switch por tipo de sensor, dual izq/der.
 *
 * Sonar: el Motor de Simulación (sw-entry.ts) precomputa la distancia real
 * por raycast y la escribe en el pin de "echo" como un valor crudo en cm
 * (no ADC) — reutiliza el mismo canal genérico de RobotHAL en vez de
 * inventar un método específico de sonar en la interfaz del MCU.
 */
export function leerOponente(hal: RobotHAL, cfg: SumoConfig): { oI: boolean; oD: boolean } {
  switch (cfg.tipoDistSensor) {
    case TipoDistSensor.SONAR: {
      const detI = hal.analogRead(cfg.echoI) < cfg.umbralDistCm;
      if (cfg.numDistSensores >= 2) {
        const detD = hal.analogRead(cfg.echoD) < cfg.umbralDistCm;
        return { oI: detI, oD: detD };
      }
      return { oI: detI, oD: detI };
    }
    case TipoDistSensor.OPTICO: {
      const detI = hal.digitalRead(cfg.optPinI) === 0;
      if (cfg.numDistSensores >= 2) {
        const detD = hal.digitalRead(cfg.optPinD) === 0;
        return { oI: detI, oD: detD };
      }
      return { oI: detI, oD: detI };
    }
    case TipoDistSensor.SHARP: {
      const detI = hal.analogRead(cfg.sharpPinI) > cfg.umbralSharp;
      if (cfg.numDistSensores >= 2) {
        const detD = hal.analogRead(cfg.sharpPinD) > cfg.umbralSharp;
        return { oI: detI, oD: detD };
      }
      return { oI: detI, oD: detI };
    }
  }
}

// ---- Evasión (ahora SÍ mueve los motores, réplica fiel) ----

export function iniciarEvasion(model: FirmwareModel, hal: RobotHAL, now: number, borderLeft: boolean, borderRight: boolean): void {
  model.evadeState = EvadeState.BACK;
  model.evadeTimer = now;
  model.evadeBoth = borderLeft && borderRight;
  model.evadeDirRight = borderLeft; // si borde izq -> girar derecha (alejarse)
}

/** Retorna true mientras la maniobra de evasión está en curso (igual que el real). */
export function tickEvasion(model: FirmwareModel, hal: RobotHAL, cfg: SumoConfig): boolean {
  if (model.evadeState === EvadeState.IDLE) return false;
  const now = hal.millis();
  switch (model.evadeState) {
    case EvadeState.BACK:
      moveDirLetter(model, hal, "b", cfg.spdEvasion);
      if (now - model.evadeTimer >= EVADE_BACK_MS) {
        model.evadeTimer = now;
        model.evadeState = EvadeState.TURN;
      }
      return true;
    case EvadeState.TURN: {
      moveDirLetter(model, hal, model.evadeDirRight ? "r" : "l", 180);
      const duracion = model.evadeBoth ? EVADE_TURN_DOBLE_MS : EVADE_TURN_SIMPLE_MS;
      if (now - model.evadeTimer >= duracion) {
        stopMotorsShared(model, hal);
        model.evadeState = EvadeState.IDLE;
      }
      return true;
    }
    default:
      model.evadeState = EvadeState.IDLE;
      return false;
  }
}

export function checkRetardoNormativo(model: FirmwareModel, hal: RobotHAL): void {
  if (!model.retardoOK && hal.millis() - model.tInicioModo >= RETARDO_SUMO_MS) {
    model.retardoOK = true;
    model.evadeState = EvadeState.IDLE;
    hal.digitalWrite(8, 0); // LED fijo (encendido, lógica invertida) al arrancar el combate
  }
}

// ---- Estrategias de búsqueda ----
function searchCircle(model: FirmwareModel, hal: RobotHAL, cfg: SumoConfig): void {
  moveDiff(model, hal, cfg.spdBuscInt, cfg.spdBuscExt);
}
function searchSweep(model: FirmwareModel, hal: RobotHAL, cfg: SumoConfig, now: number): void {
  if (now - model.tCabeceo >= CABECEO_MS) {
    model.tCabeceo = now;
    model.cabeceoDirDer = !model.cabeceoDirDer;
  }
  if (model.cabeceoDirDer) moveDiff(model, hal, cfg.spdBuscExt, -cfg.spdBuscExt);
  else moveDiff(model, hal, -cfg.spdBuscExt, cfg.spdBuscExt);
}

/**
 * Núcleo de combate unificado — réplica fiel de ejecutarSumo() real.
 * Se llama en cada tick mientras el modo activo sea MICRO o MINI.
 * Blinkea el LED durante el retardo (igual que el real), evade bordes,
 * ataca al oponente detectado, o busca (círculo/cabeceo) si no hay nadie.
 */
export function ejecutarSumo(model: FirmwareModel, hal: RobotHAL, cfg: SumoConfig): void {
  const now = hal.millis();

  if (!model.retardoOK) {
    if (now - model.tInicioModo < RETARDO_SUMO_MS) {
      hal.digitalWrite(8, Math.floor(now / 250) % 2 === 0 ? 0 : 1); // parpadeo real durante la cuenta regresiva
      return;
    }
    model.retardoOK = true;
    model.evadeState = EvadeState.IDLE;
    hal.digitalWrite(8, 1);
  }

  if (tickEvasion(model, hal, cfg)) return;

  const bI = leerBordeIzq(hal, cfg);
  const bD = leerBordeDer(hal, cfg);
  if (bI || bD) {
    iniciarEvasion(model, hal, now, bI, bD);
    return;
  }

  const { oI, oD } = leerOponente(hal, cfg);
  if (oI && oD) { moveDiff(model, hal, cfg.spdAtaque, cfg.spdAtaque); return; }
  if (oI && !oD) { moveDiff(model, hal, -cfg.spdAtaque, cfg.spdAtaque); return; } // girar izq
  if (!oI && oD) { moveDiff(model, hal, cfg.spdAtaque, -cfg.spdAtaque); return; } // girar der

  if (cfg.perfil === 1 || cfg.estrategia === 0) searchCircle(model, hal, cfg);
  else searchSweep(model, hal, cfg, now);
}
