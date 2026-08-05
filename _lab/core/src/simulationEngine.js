/**
 * FRANKY LAB — Core / Motor de Simulación
 *
 * Física mínima pero real: tracción diferencial (idea adaptada de la
 * `DifferentialDrive` de RoboLab — reimplementada acá contra nuestro propio
 * WorldModel, no copiada) + raycasting para sensores de distancia (idea
 * adaptada de su `SensorInstance._raycastDistance`) + movimiento simple del
 * Robot Oponente. Cada entidad aporta su propia lógica; este motor no
 * necesita cambiar cuando se agrega una entidad nueva (pelota, etc.).
 *
 * Unidades: centímetros, radianes, milisegundos.
 */
import { getRobot } from "./worldModel.js";
const DEFAULT_DRIVE = { wheelbaseCm: 11, maxSpeedCmS: 55, accel: 0.28 };
const ROBOT_RADIUS_CM = 7; // ~14cm de diámetro, tamaño típico FRANKY-KID
/**
 * Constantes de combate compartidas — ÚNICA fuente de verdad. El Firmware
 * Runtime (Provider) las importa desde acá en vez de definir su propia
 * copia, y el Robot Oponente (Core, sin firmware) las reutiliza
 * directamente. Así se garantiza "exactamente la misma lógica de evasión",
 * no una reimplementación con los mismos números a mano.
 */
export const RETARDO_SUMO_MS = 5000;
export const EVADE_BACK_MS = 150;
export const EVADE_TURN_SIMPLE_MS = 220;
export const EVADE_TURN_DOBLE_MS = 440;
/** Distancia mínima de un punto a un segmento (paredes, sensores de línea, cajas). */
export function pointToSegmentDistance(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0;
    t = clamp(t, 0, 1);
    const closest = { x: a.x + abx * t, y: a.y + aby * t };
    return { distance: Math.hypot(p.x - closest.x, p.y - closest.y), closest };
}
/** Distancia mínima de un punto a una caja axis-aligned (sin rotación todavía). */
function pointToBoxDistance(p, o) {
    const halfW = o.width / 2, halfH = o.height / 2;
    const dx = Math.max(o.position.x - halfW - p.x, 0, p.x - (o.position.x + halfW));
    const dy = Math.max(o.position.y - halfH - p.y, 0, p.y - (o.position.y + halfH));
    return Math.hypot(dx, dy);
}
/**
 * Sensor de línea (Seguidor de Línea, configuración de 3 sensores):
 * true si el punto cae sobre la franja negra de alguna pista del World
 * Model (distancia al segmento más cercano <= mitad del ancho de línea).
 */
export function isOverLine(world, point, lineWidthCm = 2) {
    const half = lineWidthCm / 2;
    for (const line of world.lines) {
        for (let i = 0; i < line.points.length - 1; i++) {
            if (pointToSegmentDistance(point, line.points[i], line.points[i + 1]).distance <= half)
                return true;
        }
    }
    return false;
}
export class DifferentialDrive {
    params;
    vL = 0;
    vR = 0;
    constructor(params = DEFAULT_DRIVE) {
        this.params = params;
    }
    /** leftNorm/rightNorm en [-1, 1] (signo = sentido, magnitud = PWM normalizado). */
    step(world, robotId, leftNorm, rightNorm, dtMs) {
        const robot = getRobot(world, robotId);
        const targetL = clamp(leftNorm, -1, 1) * this.params.maxSpeedCmS;
        const targetR = clamp(rightNorm, -1, 1) * this.params.maxSpeedCmS;
        const n = Math.min(1, this.params.accel * (dtMs / 16.67));
        this.vL += (targetL - this.vL) * n;
        this.vR += (targetR - this.vR) * n;
        const v = (this.vL + this.vR) / 2;
        const omega = (this.vL - this.vR) / this.params.wheelbaseCm;
        const dt = dtMs / 1000;
        robot.headingRad += omega * dt;
        const next = {
            x: robot.position.x + Math.cos(robot.headingRad) * v * dt,
            y: robot.position.y + Math.sin(robot.headingRad) * v * dt,
        };
        // Cajas y cilindros: si son MOVIBLES, se empujan según la relación de
        // masa (un robot mucho más liviano que el objeto no logra moverlo —
        // queda bloqueado, igual que contra una pared). Si no son movibles
        // (o es una pared), bloqueo duro de siempre.
        let pushBlocked = false;
        for (const o of world.obstacles) {
            if (obstacleDistance(next, o) >= ROBOT_RADIUS_CM)
                continue;
            if (!o.physics.movable) {
                pushBlocked = true;
                break;
            }
            const massRatio = robot.physics.massG / (robot.physics.massG + o.physics.massG);
            if (massRatio < 0.2) {
                pushBlocked = true;
                break;
            } // demasiado liviano para moverlo
            const dirX = o.position.x - next.x, dirY = o.position.y - next.y;
            const len = Math.hypot(dirX, dirY) || 1;
            const overlap = ROBOT_RADIUS_CM - len + (o.shape === "cilindro" ? o.radius : Math.max(o.width, o.height) / 2);
            const pushDist = Math.max(0, overlap) * massRatio * (1 - o.physics.friction * 0.5);
            o.position.x += (dirX / len) * pushDist;
            o.position.y += (dirY / len) * pushDist;
        }
        const blockedByWall = world.walls.some((w) => pointToSegmentDistance(next, w.from, w.to).distance < ROBOT_RADIUS_CM);
        // Robots (oponente): también empujables entre sí por masa, igual que
        // los objetos — "los dos robots... empujan" (validación de combate).
        let opponentBlocked = false;
        for (const op of Object.values(world.opponents)) {
            const d = dist(next, op.position);
            if (d >= ROBOT_RADIUS_CM + op.radius)
                continue;
            const massRatio = robot.physics.massG / (robot.physics.massG + op.physics.massG);
            if (massRatio < 0.2) {
                opponentBlocked = true;
                break;
            }
            const dirX = op.position.x - next.x, dirY = op.position.y - next.y;
            const len = Math.hypot(dirX, dirY) || 1;
            const overlap = ROBOT_RADIUS_CM + op.radius - len;
            const pushDist = Math.max(0, overlap) * massRatio;
            op.position.x += (dirX / len) * pushDist;
            op.position.y += (dirY / len) * pushDist;
        }
        // IMPORTANTE: el borde del dohyo (arena circular) NUNCA es una pared
        // física — en un combate real no hay ninguna fuerza que impida cruzar
        // la línea blanca. Solo los sensores de borde (leerBordeIzq/Der, más
        // abajo) le informan al firmware que se está acercando; la decisión de
        // evadir es 100% del firmware, nunca del Simulation Engine. Si el
        // firmware no reacciona a tiempo (o el robot es empujado), el robot
        // sale del dohyo de verdad y pierde — no lo frenamos artificialmente.
        // Las arenas rectangulares (Laberinto/Línea/Fútbol) SÍ representan
        // paredes físicas reales del escenario, así que ahí el límite se
        // mantiene como colisión legítima, no como ayuda artificial.
        if (!pushBlocked && !blockedByWall && !opponentBlocked) {
            if (world.arena.shape === "circle") {
                robot.position.x = next.x;
                robot.position.y = next.y;
            }
            else {
                robot.position.x = clamp(next.x, world.arena.margin, world.arena.width - world.arena.margin);
                robot.position.y = clamp(next.y, world.arena.margin, world.arena.height - world.arena.margin);
            }
        }
        else {
            this.vL = 0;
            this.vR = 0;
        }
    }
    currentSpeedCmS() {
        return (this.vL + this.vR) / 2;
    }
    currentAngularSpeedRadS() {
        return (this.vL - this.vR) / this.params.wheelbaseCm;
    }
}
function obstacleDistance(p, o) {
    return o.shape === "caja" ? pointToBoxDistance(p, o) : dist(p, o.position) - o.radius;
}
/**
 * Movimiento del Robot Oponente. Dos modos:
 * - Simple (combatEnabled=false): los 3 patrones de siempre (quieto,
 *   avance_lento, giro_aleatorio) — para "Prueba de Navegación" u objetos
 *   colocados a mano.
 * - Combate (combatEnabled=true): máquina de estados retardo->buscando->
 *   atacando->recuperando. NO ejecuta firmware — es una heurística simple
 *   (distancia + ángulo al robot principal) suficiente para validar la IA
 *   del robot real, tal como se pidió ("no hace falta IA avanzada").
 *   Respeta el mismo retardo reglamentario de 5s que el robot principal.
 */
export function stepOpponent(world, opponentId, dtMs) {
    const opp = world.opponents[opponentId];
    if (!opp)
        return;
    if (opp.behavior.combatEnabled) {
        stepOpponentCombat(world, opp, dtMs);
        return;
    }
    if (opp.behavior.pattern === "quieto")
        return;
    const now = world.clock.simTime;
    if (opp.behavior.pattern === "giro_aleatorio" && now >= opp.behavior.nextChangeAt) {
        opp.headingRad = Math.random() * Math.PI * 2;
        opp.behavior.nextChangeAt = now + opp.behavior.headingChangeIntervalMs;
    }
    moveOpponentBody(world, opp, opp.headingRad, opp.behavior.speedCmS, dtMs, true);
}
const OPPONENT_DETECT_RANGE_CM = 25;
const OPPONENT_DETECT_CONE_RAD = Math.PI / 3; // ±60°
const OPPONENT_ATTACK_TIMEOUT_MS = 3000;
const OPPONENT_RECOVER_MS = 400;
function stepOpponentCombat(world, opp, dtMs) {
    const now = world.clock.simTime;
    if (opp.behavior.bornAt < 0)
        opp.behavior.bornAt = now;
    if (opp.behavior.combatState === "retardo") {
        if (now - opp.behavior.bornAt >= opp.behavior.startDelayMs) {
            opp.behavior.combatState = "buscando";
            opp.behavior.combatStateTimer = now;
        }
        return; // quieto durante el retardo, igual que el robot principal
    }
    // Evasión de borde: MISMA prioridad y MISMA máquina de estados/tiempos
    // que el robot principal (BACK 150ms -> TURN 220/440ms) — reutiliza las
    // constantes de core/simulationEngine.ts, no una copia con los mismos
    // números a mano. El borde tiene prioridad sobre el ataque, igual que en
    // ejecutarSumo() real (se chequea ANTES que el oponente).
    if (opp.behavior.combatState === "evade_back" || opp.behavior.combatState === "evade_turn") {
        stepOpponentEvasion(world, opp, now);
        return;
    }
    const { left: borderLeft, right: borderRight } = checkDohyoBorder(world, opp);
    if (borderLeft || borderRight) {
        opp.behavior.combatState = "evade_back";
        opp.behavior.combatStateTimer = now;
        opp.behavior.evadeDirRight = borderLeft;
        opp.behavior.evadeBoth = borderLeft && borderRight;
        return;
    }
    const mainRobot = Object.values(world.robots)[0];
    const toRobot = mainRobot ? { x: mainRobot.position.x - opp.position.x, y: mainRobot.position.y - opp.position.y } : null;
    const distToRobot = toRobot ? Math.hypot(toRobot.x, toRobot.y) : Infinity;
    const angleToRobot = toRobot ? Math.atan2(toRobot.y, toRobot.x) : 0;
    const angleDiff = toRobot ? Math.atan2(Math.sin(angleToRobot - opp.headingRad), Math.cos(angleToRobot - opp.headingRad)) : Math.PI;
    const robotVisible = distToRobot < OPPONENT_DETECT_RANGE_CM && Math.abs(angleDiff) < OPPONENT_DETECT_CONE_RAD;
    switch (opp.behavior.combatState) {
        case "buscando": {
            if (robotVisible) {
                opp.behavior.combatState = "atacando";
                opp.behavior.combatStateTimer = now;
                break;
            }
            if (now >= opp.behavior.nextChangeAt) {
                opp.headingRad += (Math.random() - 0.5) * 1.2; // deambula, no 100% aleatorio de golpe
                opp.behavior.nextChangeAt = now + opp.behavior.headingChangeIntervalMs;
            }
            moveOpponentBody(world, opp, opp.headingRad, opp.behavior.speedCmS, dtMs, true);
            break;
        }
        case "atacando": {
            if (!robotVisible && distToRobot > OPPONENT_DETECT_RANGE_CM * 1.5) {
                opp.behavior.combatState = "buscando";
                opp.behavior.combatStateTimer = now;
                break;
            }
            if (now - opp.behavior.combatStateTimer > OPPONENT_ATTACK_TIMEOUT_MS) {
                opp.behavior.combatState = "recuperando";
                opp.behavior.combatStateTimer = now;
                break;
            }
            if (toRobot)
                opp.headingRad = angleToRobot; // embiste de frente, sin esquivar
            moveOpponentBody(world, opp, opp.headingRad, opp.behavior.speedCmS * 1.8, dtMs, false);
            break;
        }
        case "recuperando": {
            moveOpponentBody(world, opp, opp.headingRad + Math.PI, opp.behavior.speedCmS, dtMs, false);
            if (now - opp.behavior.combatStateTimer > OPPONENT_RECOVER_MS) {
                opp.behavior.combatState = "buscando";
                opp.behavior.combatStateTimer = now;
            }
            break;
        }
    }
}
/** Réplica de leerBordeIzq/Der + dohyoBorderADC, aplicada directamente al oponente (sin pines/MCU, no tiene firmware). */
function checkDohyoBorder(world, opp) {
    if (world.arena.shape !== "circle")
        return { left: false, right: false };
    const fwd = { x: Math.cos(opp.headingRad), y: Math.sin(opp.headingRad) };
    const lat = { x: -Math.sin(opp.headingRad), y: Math.cos(opp.headingRad) };
    const mountL = { x: opp.position.x + fwd.x * 5 - lat.x * 4, y: opp.position.y + fwd.y * 5 - lat.y * 4 };
    const mountR = { x: opp.position.x + fwd.x * 5 + lat.x * 4, y: opp.position.y + fwd.y * 5 + lat.y * 4 };
    const umbral = 1500; // mismo umbral por defecto que cfgMini real
    return { left: dohyoBorderADC(world, mountL) >= umbral, right: dohyoBorderADC(world, mountR) >= umbral };
}
/** Evasión del oponente — MISMA máquina de estados y tiempos que tickEvasion() real. */
function stepOpponentEvasion(world, opp, now) {
    if (opp.behavior.combatState === "evade_back") {
        moveOpponentBody(world, opp, opp.headingRad + Math.PI, opp.behavior.speedCmS, 16.67, false); // retrocede
        if (now - opp.behavior.combatStateTimer >= EVADE_BACK_MS) {
            opp.behavior.combatStateTimer = now;
            opp.behavior.combatState = "evade_turn";
        }
        return;
    }
    // evade_turn
    opp.headingRad += (opp.behavior.evadeDirRight ? 1 : -1) * 0.08; // gira hacia el lado correspondiente
    const duracion = opp.behavior.evadeBoth ? EVADE_TURN_DOBLE_MS : EVADE_TURN_SIMPLE_MS;
    if (now - opp.behavior.combatStateTimer >= duracion) {
        opp.behavior.combatState = "buscando";
        opp.behavior.combatStateTimer = now;
    }
}
/** Desplaza el cuerpo del oponente respetando límites/obstáculos/paredes (sin atravesarlos). Reutilizable por cualquier módulo de reglas. */
export function moveOpponentBody(world, opp, headingRad, speedCmS, dtMs, bounceOnBlock) {
    const dt = dtMs / 1000;
    const next = { x: opp.position.x + Math.cos(headingRad) * speedCmS * dt, y: opp.position.y + Math.sin(headingRad) * speedCmS * dt };
    // El borde del dohyo NUNCA bloquea (ver nota en DifferentialDrive.step)
    // — el oponente puede salir del tatami igual que el robot principal, ya
    // sea por su propia torpeza o porque lo empujaron. Las arenas
    // rectangulares sí tienen paredes físicas reales.
    const blockedByStatic = world.obstacles.some((o) => obstacleDistance(next, o) < opp.radius) ||
        world.walls.some((w) => pointToSegmentDistance(next, w.from, w.to).distance < opp.radius);
    // FIX (simetría de combate): el robot principal SÍ podía empujar al
    // oponente (DifferentialDrive.step), pero el oponente nunca chequeaba
    // colisión contra el robot principal — podía superponerse sin empujarlo
    // nunca. Ahora usa exactamente la misma física de empuje por masa, en el
    // sentido contrario.
    let blockedByRobot = false;
    for (const robot of Object.values(world.robots)) {
        const d = dist(next, robot.position);
        const minDist = opp.radius + ROBOT_RADIUS_CM;
        if (d >= minDist)
            continue;
        const massRatio = opp.physics.massG / (opp.physics.massG + robot.physics.massG);
        if (massRatio < 0.2) {
            blockedByRobot = true;
            break;
        }
        const dirX = robot.position.x - next.x, dirY = robot.position.y - next.y;
        const len = Math.hypot(dirX, dirY) || 1;
        const overlap = minDist - len;
        const pushDist = Math.max(0, overlap) * massRatio;
        robot.position.x += (dirX / len) * pushDist;
        robot.position.y += (dirY / len) * pushDist;
    }
    const blocked = blockedByStatic || blockedByRobot;
    const boundOk = world.arena.shape === "circle"
        ? true
        : next.x > world.arena.margin &&
            next.x < world.arena.width - world.arena.margin &&
            next.y > world.arena.margin &&
            next.y < world.arena.height - world.arena.margin;
    if (!blocked && boundOk) {
        opp.position = next;
    }
    else if (bounceOnBlock) {
        opp.headingRad += Math.PI;
    }
}
/**
 * Física de la Pelota (Fútbol) — cuerpo independiente, no un obstáculo.
 * Integra velocidad, aplica rozamiento (frena progresivamente hasta
 * detenerse), rebota contra paredes/límites del arena, y recibe impulso al
 * chocar con el robot principal o el Oponente (empuje simple en la
 * dirección del choque, sin conservación de momento completa — "no hace
 * falta simulación compleja todavía").
 */
export function stepBall(world, ball, dtMs, robotSpeedCmS = 0) {
    const dt = dtMs / 1000;
    const damping = Math.pow(1 - ball.friction, dtMs / 1000);
    ball.velocity.x *= damping;
    ball.velocity.y *= damping;
    if (Math.hypot(ball.velocity.x, ball.velocity.y) < 0.5) {
        ball.velocity.x = 0;
        ball.velocity.y = 0;
    }
    let nextX = ball.position.x + ball.velocity.x * dt;
    let nextY = ball.position.y + ball.velocity.y * dt;
    for (const w of world.walls) {
        const { distance, closest } = pointToSegmentDistance({ x: nextX, y: nextY }, w.from, w.to);
        if (distance < ball.radius) {
            const nx = nextX - closest.x, ny = nextY - closest.y;
            const len = Math.hypot(nx, ny) || 1;
            const normal = { x: nx / len, y: ny / len };
            const dot = ball.velocity.x * normal.x + ball.velocity.y * normal.y;
            // Rebote escalado por restitution (0=absorbe todo, 1=rebote elástico).
            ball.velocity.x -= (1 + ball.restitution) * dot * normal.x;
            ball.velocity.y -= (1 + ball.restitution) * dot * normal.y;
            nextX = ball.position.x;
            nextY = ball.position.y;
            break;
        }
    }
    if (world.arena.shape === "rect") {
        if (nextX < world.arena.margin + ball.radius || nextX > world.arena.width - world.arena.margin - ball.radius) {
            ball.velocity.x *= -1;
            nextX = clamp(nextX, world.arena.margin + ball.radius, world.arena.width - world.arena.margin - ball.radius);
        }
        if (nextY < world.arena.margin + ball.radius || nextY > world.arena.height - world.arena.margin - ball.radius) {
            ball.velocity.y *= -1;
            nextY = clamp(nextY, world.arena.margin + ball.radius, world.arena.height - world.arena.margin - ball.radius);
        }
    }
    ball.position.x = nextX;
    ball.position.y = nextY;
    for (const robot of Object.values(world.robots)) {
        applyPushFromCircle(ball, robot.position, ROBOT_RADIUS_CM, robotSpeedCmS);
    }
    for (const opp of Object.values(world.opponents)) {
        applyPushFromCircle(ball, opp.position, opp.radius, opp.behavior.speedCmS);
    }
}
/** Impulso proporcional a la velocidad del que golpea — "cuanto mayor la velocidad, mayor el impulso". Reutilizable (ej. paleta frontal de Fútbol). */
export function applyPushFromCircle(ball, center, radius, strikerSpeedCmS) {
    const d = dist(ball.position, center);
    const minDist = ball.radius + radius;
    if (d < minDist && d > 0.001) {
        const nx = (ball.position.x - center.x) / d, ny = (ball.position.y - center.y) / d;
        const overlap = minDist - d;
        ball.position.x += nx * overlap;
        ball.position.y += ny * overlap;
        const pushSpeed = Math.max(10, Math.abs(strikerSpeedCmS) * 1.4); // energía del impacto, no un valor fijo
        ball.velocity.x = nx * pushSpeed;
        ball.velocity.y = ny * pushSpeed;
    }
}
/**
 * Sensor de borde del dohyo — SOLO informa, nunca frena al robot (ver nota
 * en DifferentialDrive.step). Convierte la distancia real desde el centro
 * de la arena circular hasta un punto (mount del sensor) en un valor
 * ADC-like que cruza el umbral por defecto (1500) unos ~2cm ANTES del
 * borde real — igual que un sensor físico, que detecta la transición al
 * blanco antes de que las ruedas lleguen. Solo tiene sentido en arenas
 * circulares (dohyo); en arenas rectangulares no se usa.
 */
export function dohyoBorderADC(world, point) {
    if (world.arena.shape !== "circle")
        return 0;
    const center = { x: world.arena.width / 2, y: world.arena.height / 2 };
    const safeRadius = world.arena.width / 2 - world.arena.margin; // borde negro/blanco
    const distFromCenter = dist(point, center);
    const transitionCm = 3;
    const t = (distFromCenter - (safeRadius - transitionCm)) / transitionCm;
    return Math.round(clamp(t * 4095, 0, 4095));
}
/** true si el CENTRO del cuerpo ya cruzó el borde físico real del dohyo (perdió). */
export function isOutsideDohyo(world, point) {
    if (world.arena.shape !== "circle")
        return false;
    const center = { x: world.arena.width / 2, y: world.arena.height / 2 };
    return dist(point, center) > world.arena.width / 2;
}
/**
 * true si el CUERPO ENTERO del robot (no el centro, no un sensor) está
 * dentro de una zona rectangular — reglamento LNR de Laberinto: "sin ser
 * necesario detener su movimiento... debe verificarse que el robot haya
 * ingresado completamente". Genérico — reutilizable por cualquier
 * modalidad basada en "el robot debe entrar completo a una zona"
 * (Laberinto hoy, Seguidor de Línea u otras más adelante).
 */
export function isFullyInsideZone(position, zone, robotRadiusCm = ROBOT_RADIUS_CM) {
    return (position.x - robotRadiusCm >= zone.x &&
        position.x + robotRadiusCm <= zone.x + zone.w &&
        position.y - robotRadiusCm >= zone.y &&
        position.y + robotRadiusCm <= zone.y + zone.h);
}
/**
 * Raycast: distancia en cm desde `origin`, en dirección `angleRad`, hasta
 * el objeto sólido más cercano (obstáculo cilíndrico o caja, pared, o
 * Robot Oponente) — o `maxRangeCm` si no hay nada en el camino.
 */
export function raycastDistance(world, origin, angleRad, maxRangeCm = 80) {
    const dirX = Math.cos(angleRad);
    const dirY = Math.sin(angleRad);
    let closest = maxRangeCm;
    const circularHit = (center, radius) => {
        const toX = center.x - origin.x, toY = center.y - origin.y;
        const proj = toX * dirX + toY * dirY;
        if (proj < 0 || proj > maxRangeCm)
            return null;
        const closestX = origin.x + dirX * proj, closestY = origin.y + dirY * proj;
        const perpDist = Math.hypot(center.x - closestX, center.y - closestY);
        if (perpDist > radius)
            return null;
        const chord = Math.sqrt(Math.max(0, radius * radius - perpDist * perpDist));
        const hitDist = proj - chord;
        return hitDist >= 0 ? hitDist : null;
    };
    for (const o of world.obstacles) {
        if (o.shape === "cilindro") {
            const hit = circularHit(o.position, o.radius);
            if (hit !== null && hit < closest)
                closest = hit;
        }
        else {
            // Caja: raycast contra sus 4 lados como segmentos.
            const halfW = o.width / 2, halfH = o.height / 2;
            const corners = [
                [{ x: o.position.x - halfW, y: o.position.y - halfH }, { x: o.position.x + halfW, y: o.position.y - halfH }],
                [{ x: o.position.x + halfW, y: o.position.y - halfH }, { x: o.position.x + halfW, y: o.position.y + halfH }],
                [{ x: o.position.x + halfW, y: o.position.y + halfH }, { x: o.position.x - halfW, y: o.position.y + halfH }],
                [{ x: o.position.x - halfW, y: o.position.y + halfH }, { x: o.position.x - halfW, y: o.position.y - halfH }],
            ];
            for (const [a, b] of corners) {
                const hit = raySegmentIntersection(origin, dirX, dirY, a, b, maxRangeCm);
                if (hit !== null && hit < closest)
                    closest = hit;
            }
        }
    }
    for (const w of world.walls) {
        const hit = raySegmentIntersection(origin, dirX, dirY, w.from, w.to, maxRangeCm);
        if (hit !== null && hit < closest)
            closest = hit;
    }
    for (const op of Object.values(world.opponents)) {
        const hit = circularHit(op.position, op.radius);
        if (hit !== null && hit < closest)
            closest = hit;
    }
    return closest;
}
/** Intersección rayo-segmento clásica (parametrización dual), devuelve distancia o null. */
function raySegmentIntersection(origin, dirX, dirY, a, b, maxRangeCm) {
    const sx = b.x - a.x, sy = b.y - a.y;
    const denom = dirX * sy - dirY * sx;
    if (Math.abs(denom) < 1e-9)
        return null;
    const t = ((a.x - origin.x) * sy - (a.y - origin.y) * sx) / denom;
    const u = ((a.x - origin.x) * dirY - (a.y - origin.y) * dirX) / denom;
    if (t >= 0 && t <= maxRangeCm && u >= 0 && u <= 1)
        return t;
    return null;
}
/**
 * Distancia (cm) -> ADC crudo, curva inversa aproximada de un Sharp
 * 2Y0A21 real (más cerca = ADC más alto). Calibrada para que el umbral por
 * defecto (1800) corresponda a ~11cm de distancia real.
 */
export function distanceToSharpADC(distanceCm, maxRangeCm = 80) {
    if (distanceCm >= maxRangeCm)
        return 200;
    const d = Math.max(4, distanceCm);
    const raw = 22000 / d - 230;
    return Math.round(clamp(raw, 200, 4095));
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
