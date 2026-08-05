/**
 * FRANKY LAB — Core / Contrato de Provider
 *
 * Esto es TODO lo que Core sabe sobre un Provider. Nunca conoce rutas
 * concretas, ni el esquema de RobotState/FirmwareModel de una firmware en
 * particular — únicamente esta superficie mínima (ADR-003 §5: "impacto
 * fuera del Provider = ninguno").
 */
export type CommandResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export interface HttpResponse {
  status: number;
  body: unknown;
  contentType: "application/json" | "text/plain";
  location?: string;
}

export type Query = Record<string, string>;

/** Lo que cualquier Provider debe exponer para que Core/SW lo puedan correr. */
export interface ProviderServer {
  handle(method: "GET" | "POST", path: string, query: Query, body?: Query): HttpResponse;
  /** Avanza la lógica dependiente del tiempo (máquinas de estado, etc.). */
  tick(): void;
  /**
   * Snapshot opaco de estado en vivo para los Workspaces del laboratorio.
   * Opcional: Core no interpreta su contenido, solo lo retransmite por
   * postMessage a quien lo pida — así los Workspaces son "otra vista del
   * mismo estado interno" en vez de un cliente HTTP adicional.
   */
  getLiveState?(): unknown;
  /**
   * Permite a un Workspace simular una entrada física (ej. el botón START)
   * escribiendo directamente en el MCU, tal como lo haría el Motor de
   * Simulación cuando exista. No pasa por el Firmware Runtime porque es un
   * evento de entrada del mundo, no un comando de software.
   */
  setDigitalInput?(pin: number, value: 0 | 1): void;
  /**
   * Config de sensor de oponente ACTIVA (tipo + pines), para que el
   * Simulation Engine sepa dónde escribir el raycast — sin esto, el motor
   * de física no tiene forma de saber si el usuario configuró Sharp,
   * sonar u óptico, ni en qué pines, desde el Servidor Web.
   */
  getActiveSensorConfig?(): unknown;
  /**
   * Timing real del combate (tInicioModo/retardoOK del Firmware Model) —
   * para que el Robot Oponente sincronice su propio retardo reglamentario
   * con el mismo instante exacto que usa el robot principal, en vez de un
   * temporizador independiente.
   */
  getCombatTiming?(): unknown;
}
