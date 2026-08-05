/**
 * FRANKY LAB — Reglas de Minisumo
 *
 * Encapsula la ÚNICA regla real de Minisumo que la simulación necesita
 * arbitrar: expulsión del dohyo. El Simulation Engine (simulationEngine.ts)
 * nunca decide esto — solo calcula física/sensores/movimiento. Este módulo
 * los interpreta cada tick y actualiza MatchState en consecuencia.
 *
 * Completamente simétrico: cualquiera de los dos robots (principal u
 * oponente) puede ganar o perder — no hay ninguna diferencia de reglas
 * entre ellos, solo la estrategia que cada uno usa.
 */
import { WorldModel, endMatch, startMatch } from "../worldModel.js";
import { isOutsideDohyo } from "../simulationEngine.js";

export function tickMinisumoRules(world: WorldModel, robotId: string): void {
  if (world.arena.shape !== "circle") return;
  if (!world.match.started) startMatch(world); // Minisumo no usa botón manual: arranca con el modo (ver sw-entry.ts)
  if (world.match.ended) return;

  const robot = world.robots[robotId];
  const robotOut = robot ? isOutsideDohyo(world, robot.position) : false;

  const opponents = Object.values(world.opponents);
  const anyOpponentOut = opponents.some((o) => isOutsideDohyo(world, o.position));

  if (robotOut && anyOpponentOut) {
    endMatch(world, "empate"); // caso borde: ambos salieron en el mismo tick
  } else if (robotOut) {
    endMatch(world, "oponente");
  } else if (anyOpponentOut && opponents.length > 0) {
    endMatch(world, "robot");
  }
}
