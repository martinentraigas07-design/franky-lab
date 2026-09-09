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
import { CABECEO_MS, DireccionOponente, EvadeState, TipoDistSensor } from "./model.js";
import { moveDirLetter, moveDiff, stopMotorsShared } from "./motorControl.js";
import { flog } from "./monitor.js";
import { RETARDO_SUMO_MS, EVADE_BACK_MS, EVADE_TURN_SIMPLE_MS, EVADE_TURN_DOBLE_MS, } from "../../../core/src/simulationEngine.js";
export { RETARDO_SUMO_MS, EVADE_BACK_MS, EVADE_TURN_SIMPLE_MS, EVADE_TURN_DOBLE_MS, CABECEO_MS };
/**
 * RECUPERACION_MS — cuánto dura la búsqueda sesgada hacia la última
 * dirección conocida del oponente antes de volver a la estrategia de
 * búsqueda normal. NO configurable (réplica del real: el doble del
 * CABECEO_MS de fábrica, 2×250ms = 500ms). Ver .ino, constante homónima.
 */
export const RECUPERACION_MS = CABECEO_MS * 2;
/** Réplica de direccionTexto() real — usada por /api (campo s_dirTxt). */
export function direccionTexto(d) {
    switch (d) {
        case DireccionOponente.IZQUIERDA: return "IZQUIERDA";
        case DireccionOponente.DERECHA: return "DERECHA";
        case DireccionOponente.CENTRO: return "CENTRO";
        default: return "DESCONOCIDA";
    }
}
/**
 * FASE "CIERRE SUMO" — abstracción pedagógica de búsqueda: el alumno
 * configura "Velocidad de búsqueda" (velBusqueda) e "Intensidad del
 * giro" (intGiro) — NO las velocidades de rueda externa/interna
 * directamente. Única traducción entre esa abstracción y el par de
 * ruedas real (misma fórmula que el firmware real):
 *   velExterna = velBusqueda + intGiro/2
 *   velInterna = velBusqueda - intGiro/2
 * Recortado a [0,255]. velInterna nunca baja de 0 (la rueda interna
 * nunca gira en reversa durante la búsqueda).
 */
export function velExterna(cfg) {
    const v = cfg.velBusqueda + Math.floor(cfg.intGiro / 2);
    return Math.max(0, Math.min(255, v));
}
export function velInterna(cfg) {
    const v = cfg.velBusqueda - Math.floor(cfg.intGiro / 2);
    return Math.max(0, Math.min(255, v));
}
// ---- Lectura de sensores (borde y oponente, dual izq/der) ----
export function leerBordeIzq(hal, cfg) {
    if (cfg.numBorde < 1)
        return false;
    return hal.analogRead(cfg.bordePinI) >= cfg.umbralBorde;
}
export function leerBordeDer(hal, cfg) {
    if (cfg.numBorde < 2)
        return false;
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
export function leerOponente(hal, cfg) {
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
export function iniciarEvasion(model, hal, now, borderLeft, borderRight) {
    model.evadeState = EvadeState.BACK;
    model.evadeTimer = now;
    model.evadeBoth = borderLeft && borderRight;
    model.evadeDirRight = borderLeft; // si borde izq -> girar derecha (alejarse)
}
/** Retorna true mientras la maniobra de evasión está en curso (igual que el real). */
export function tickEvasion(model, hal, cfg) {
    if (model.evadeState === EvadeState.IDLE)
        return false;
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
export function checkRetardoNormativo(model, hal) {
    if (!model.retardoOK && hal.millis() - model.tInicioModo >= RETARDO_SUMO_MS) {
        model.retardoOK = true;
        model.evadeState = EvadeState.IDLE;
        hal.digitalWrite(8, 0); // LED fijo (encendido, lógica invertida) al arrancar el combate
    }
}
// ---- Estrategias de búsqueda ----
function searchCircle(model, hal, cfg) {
    moveDiff(model, hal, velInterna(cfg), velExterna(cfg));
}
/**
 * searchSweep() — "Barrido"/"Cabeceo". Réplica de la versión ACTUAL del
 * firmware real (post fase "Cierre Sumo"): una CURVA alternada (ambas
 * ruedas siempre hacia adelante, alternando cuál es la "externa"
 * rápida) — NO un pivote sobre el propio eje. Usa cfg.durBarrido
 * (configurable, solo Mini) en vez de la constante fija CABECEO_MS;
 * CABECEO_MS queda como resguardo defensivo si durBarrido llegara en 0.
 */
function searchSweep(model, hal, cfg, now) {
    const duracion = cfg.durBarrido > 0 ? cfg.durBarrido : CABECEO_MS;
    if (now - model.tCabeceo >= duracion) {
        model.tCabeceo = now;
        model.cabeceoDirDer = !model.cabeceoDirDer;
    }
    if (model.cabeceoDirDer)
        moveDiff(model, hal, velExterna(cfg), velInterna(cfg)); // curva hacia un lado
    else
        moveDiff(model, hal, velInterna(cfg), velExterna(cfg)); // curva hacia el otro lado
}
/**
 * Núcleo de combate unificado — réplica fiel de ejecutarSumo() real.
 * Se llama en cada tick mientras el modo activo sea MICRO o MINI.
 * Blinkea el LED durante el retardo (igual que el real), evade bordes,
 * ataca al oponente detectado, o busca (círculo/cabeceo) si no hay nadie.
 */
export function ejecutarSumo(model, hal, cfg) {
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
    // Evasión en curso — prioridad absoluta, sin cambios.
    if (tickEvasion(model, hal, cfg))
        return;
    // Bordes — SIEMPRE antes que oponente/búsqueda. El borde corta
    // cualquier recuperación en curso, sin excepción.
    const bI = leerBordeIzq(hal, cfg);
    const bD = leerBordeDer(hal, cfg);
    if (bI || bD) {
        model.enRecuperacion = false;
        iniciarEvasion(model, hal, now, bI, bD);
        return;
    }
    const { oI, oD } = leerOponente(hal, cfg);
    const oponentePresente = oI || oD;
    // ── Memoria de última dirección — SOLO con 2 sensores independientes
    // (nunca se infiere IZQUIERDA/DERECHA a partir de un solo sensor).
    if (cfg.numDistSensores >= 2 && oponentePresente) {
        const nueva = oI && oD ? DireccionOponente.CENTRO : oI ? DireccionOponente.IZQUIERDA : DireccionOponente.DERECHA;
        if (nueva !== model.ultimaDirOponente) {
            model.ultimaDirOponente = nueva;
            flog(model, hal, "I", `OPONENTE -> ${direccionTexto(nueva)}`); // FASE MONITOR/DEBUG (punto 2 de la lista cerrada)
        }
    }
    // ── Transición "oponente perdido" — arranca una recuperación acotada
    // hacia la última dirección conocida SOLO si esa dirección es
    // IZQUIERDA/DERECHA válida (nunca con DESCONOCIDA ni CENTRO).
    if (model.oponentePresenteAnt && !oponentePresente) {
        flog(model, hal, "I", "Oponente perdido"); // FASE MONITOR/DEBUG
        if (model.ultimaDirOponente === DireccionOponente.IZQUIERDA || model.ultimaDirOponente === DireccionOponente.DERECHA) {
            model.enRecuperacion = true;
            model.tRecuperacion = now;
            model.recuperacionHaciaIzquierda = model.ultimaDirOponente === DireccionOponente.IZQUIERDA;
            flog(model, hal, "I", `RECUPERACION -> ULTIMA DIRECCION: ${direccionTexto(model.ultimaDirOponente)}`); // FASE MONITOR/DEBUG
        }
    }
    model.oponentePresenteAnt = oponentePresente;
    // Ataque — corta cualquier recuperación en curso (el oponente volvió a aparecer).
    if (oponentePresente) {
        model.enRecuperacion = false;
        // FASE MONITOR/DEBUG — log por FLANCO (ultimoAtaqueDirLog), no por
        // tick: réplica exacta del real, evita inundar el buffer mientras el
        // robot sigue atacando en la misma dirección.
        const dirAtaque = oI && oD ? 0 : oI ? 1 : 2; // 0=ambos,1=izq,2=der
        if (dirAtaque !== model.ultimoAtaqueDirLog) {
            model.ultimoAtaqueDirLog = dirAtaque;
            flog(model, hal, "I", `ATAQUE -> ${dirAtaque === 0 ? "AMBOS" : dirAtaque === 1 ? "IZQUIERDA" : "DERECHA"}`);
        }
        if (oI && oD) {
            moveDiff(model, hal, cfg.spdAtaque, cfg.spdAtaque);
            return;
        }
        if (oI && !oD) {
            moveDiff(model, hal, -cfg.spdAtaque, cfg.spdAtaque);
            return;
        } // girar izq
        moveDiff(model, hal, cfg.spdAtaque, -cfg.spdAtaque);
        return; // girar der (!oI && oD)
    }
    model.ultimoAtaqueDirLog = -1; // no hay ataque este tick — el próximo ataque siempre se anuncia de nuevo (mismo criterio real)
    // Búsqueda — recuperación acotada primero (si está activa), después
    // la estrategia normal (CÍRCULO o BARRIDO).
    if (model.enRecuperacion) {
        if (now - model.tRecuperacion >= RECUPERACION_MS) {
            model.enRecuperacion = false;
        }
        else {
            if (model.recuperacionHaciaIzquierda)
                moveDiff(model, hal, velInterna(cfg), velExterna(cfg));
            else
                moveDiff(model, hal, velExterna(cfg), velInterna(cfg));
            return;
        }
    }
    if (cfg.perfil === 1 || cfg.estrategia === 0)
        searchCircle(model, hal, cfg);
    else
        searchSweep(model, hal, cfg, now);
}
/**
 * Reinicia la memoria de combate (última dirección del oponente +
 * recuperación) — réplica de reiniciarMemoriaSumo() real. Debe llamarse
 * al INICIAR un nuevo combate (un combate nuevo no hereda la "última
 * dirección" del anterior). No se llama al detener.
 */
export function reiniciarMemoriaSumo(model) {
    model.ultimaDirOponente = DireccionOponente.DESCONOCIDA;
    model.oponentePresenteAnt = false;
    model.enRecuperacion = false;
    model.ultimoAtaqueDirLog = -1; // FASE MONITOR/DEBUG — no dejar el flanco de log "colgado" entre combates
}
