/**
 * FRANKY LAB — Reglas de Fútbol
 *
 * Encapsula TODO lo específico de la modalidad: arranque manual, cronómetro,
 * detección de gol, marcador, condición de victoria, y la IA sencilla del
 * oponente ("buscar la pelota, empujarla hacia el arco rival"). El
 * Simulation Engine (simulationEngine.ts) sigue siendo genérico — solo
 * ofrece primitivas reutilizables (moveOpponentBody, applyPushFromCircle),
 * nunca decide nada de fútbol por su cuenta.
 */
import { WorldModel, Ball, Goal, Vector2, endMatch } from "../worldModel.js";
import { moveOpponentBody, applyPushFromCircle } from "../simulationEngine.js";

const OPPONENT_FUTBOL_SPEED_CMS = 18;
/** Paleta frontal en forma de "C" (dos brazos laterales que envuelven
 * parcialmente la pelota, como en los robots de fútbol reales — no una
 * "<" con un solo punto de contacto). Se modela con DOS puntos de
 * contacto (brazo izquierdo/derecho), cada uno adelante y hacia afuera
 * del chasis, más ancho que el cuerpo del robot para "abrazar" la pelota. */
const PADDLE_ARM_REACH_CM = 6;
const PADDLE_FORWARD_CM = 7; // qué tan adelante del centro están los brazos
const PADDLE_LATERAL_CM = 7; // separación lateral de cada brazo (ancho de la "C")

export function tickFutbolRules(world: WorldModel, robotId: string, dtMs: number, robotSpeedCmS: number, robotHeadingRad: number): void {
  if (!world.match.started || world.match.ended) return; // esperando "Iniciar Partido" — nadie se mueve hasta entonces (ver sw-entry.ts)

  world.match.elapsedMs += dtMs;
  if (world.match.durationMs !== null && world.match.elapsedMs >= world.match.durationMs) {
    const winner =
      world.match.scoreRobot > world.match.scoreOponente ? "robot"
      : world.match.scoreOponente > world.match.scoreRobot ? "oponente"
      : "empate";
    endMatch(world, winner);
    return;
  }

  // IA del oponente: "sencilla, no compleja" tal como se pidió, pero con
  // dos correcciones encontradas en pruebas reales:
  //   1) se posiciona del lado de la pelota OPUESTO a su propio arco, para
  //      que empujarla derecho la mande hacia el arco rival — antes
  //      atacaba desde cualquier lado, lo que producía autogoles fáciles;
  //   2) si queda bloqueado (ej. contra un poste del arco) gira en vez de
  //      congelarse — antes podía quedar trabado dentro del arco.
  const ball = world.balls[0];
  const ownGoal = world.goals.find((g) => g.team === "derecho"); // FRANKY ataca "derecho" (ver scoring abajo) -> ese es el arco PROPIO del oponente, el que debe evitar autogolear
  for (const opp of Object.values(world.opponents)) {
    if (!ball) continue;
    let targetX = ball.position.x, targetY = ball.position.y;
    if (ownGoal) {
      const goalCenter = { x: (ownGoal.from.x + ownGoal.to.x) / 2, y: (ownGoal.from.y + ownGoal.to.y) / 2 };
      const awayX = ball.position.x - goalCenter.x, awayY = ball.position.y - goalCenter.y;
      const len = Math.hypot(awayX, awayY) || 1;
      const OFFSET_CM = 9; // se ubica ~9cm del lado contrario a su arco antes de empujar
      targetX = ball.position.x + (awayX / len) * OFFSET_CM;
      targetY = ball.position.y + (awayY / len) * OFFSET_CM;
    }
    const angle = Math.atan2(targetY - opp.position.y, targetX - opp.position.x);
    opp.headingRad = angle;
    moveOpponentBody(world, opp, angle, OPPONENT_FUTBOL_SPEED_CMS, dtMs, true);
  }

  // Paleta frontal en "C": dos puntos de contacto (brazo izq/der), no uno
  // solo — así la pelota puede quedar "abrazada" entre ambos brazos en
  // vez de solo rozar un punto central, más parecido al robot real.
  if (ball) {
    const robotPos = robotPositionOf(world, robotId);
    const fwd = { x: Math.cos(robotHeadingRad), y: Math.sin(robotHeadingRad) };
    const lat = { x: -Math.sin(robotHeadingRad), y: Math.cos(robotHeadingRad) };
    const armL: Vector2 = {
      x: robotPos.x + fwd.x * PADDLE_FORWARD_CM - lat.x * PADDLE_LATERAL_CM,
      y: robotPos.y + fwd.y * PADDLE_FORWARD_CM - lat.y * PADDLE_LATERAL_CM,
    };
    const armR: Vector2 = {
      x: robotPos.x + fwd.x * PADDLE_FORWARD_CM + lat.x * PADDLE_LATERAL_CM,
      y: robotPos.y + fwd.y * PADDLE_FORWARD_CM + lat.y * PADDLE_LATERAL_CM,
    };
    applyPushFromCircle(ball, armL, PADDLE_ARM_REACH_CM, robotSpeedCmS);
    applyPushFromCircle(ball, armR, PADDLE_ARM_REACH_CM, robotSpeedCmS);
  }

  // Detección de gol: la pelota debe cruzar COMPLETAMENTE la línea del
  // arco (no solo tocarla) dentro del ancho real de la boca del arco.
  if (ball) {
    for (const goal of world.goals) {
      if (ballFullyInGoal(ball, goal)) {
        if (goal.team === "derecho") world.match.scoreRobot++; // FRANKY ataca el arco derecho
        else world.match.scoreOponente++; // el oponente ataca el arco izquierdo (el "propio" de FRANKY)
        ball.position = { x: world.arena.width / 2, y: world.arena.height / 2 };
        ball.velocity = { x: 0, y: 0 };
      }
    }
  }
}

function robotPositionOf(world: WorldModel, robotId: string): Vector2 {
  const r = world.robots[robotId];
  return r ? r.position : { x: 0, y: 0 };
}

function ballFullyInGoal(ball: Ball, goal: Goal): boolean {
  const minY = Math.min(goal.from.y, goal.to.y);
  const maxY = Math.max(goal.from.y, goal.to.y);
  if (ball.position.y < minY || ball.position.y > maxY) return false;
  return goal.team === "izquierdo" ? ball.position.x <= goal.from.x + ball.radius : ball.position.x >= goal.from.x - ball.radius;
}
