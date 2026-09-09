/**
 * FRANKY LAB — Reglas de "prueba cronometrada" (Laberinto y Seguidor de
 * Línea comparten exactamente esta necesidad: botón Iniciar (o el botón
 * físico START — ver sw-entry.ts) + cronómetro oficial que arranca solo
 * con esa orden, nunca al cargar el escenario). Ambas modalidades todavía
 * no tienen firmware propio (llegará con Blockly) — por ahora esto deja
 * el cronómetro listo para medir el tiempo una vez que existan los
 * algoritmos, y detecta la llegada real en Laberinto.
 */
import { endMatch } from "../worldModel.js";
import { isFullyInsideZone } from "../simulationEngine.js";
export function tickTimedTrialRules(world, robotId, dtMs) {
    if (!world.match.started || world.match.ended)
        return;
    world.match.elapsedMs += dtMs;
    // Laberinto: reglamento LNR — "el tiempo oficial se detendrá cuando el
    // robot ingrese COMPLETAMENTE en la celda de llegada (piso blanco), sin
    // ser necesario detener su movimiento". Nunca por tocar una línea, ni
    // por el centro, ni por un sensor — el cuerpo entero adentro.
    if (world.mazeFinish) {
        const robot = world.robots[robotId];
        if (robot && isFullyInsideZone(robot.position, world.mazeFinish)) {
            endMatch(world, "robot");
        }
    }
    // Seguidor de Línea: sin condición de fin automática todavía (no hay
    // meta/objetivo detectable sin firmware propio) — el usuario detiene la
    // prueba a mano cuando corresponda.
}
