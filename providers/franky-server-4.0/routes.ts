/**
 * Lista de rutas de API/Lab en TypeScript plano — NO JSON importado como
 * módulo ES. El import assertion `with {type:"json"}` resultó frágil entre
 * navegadores/servidores (depende del Content-Type exacto y de qué sintaxis
 * soporte cada versión de Chrome), y rompía el install completo del Service
 * Worker. manifest.json sigue siendo la fuente legible para humanos/tooling
 * de build; este archivo es la fuente que consume el runtime del navegador,
 * y el build verifica que ambas coincidan (ver build/copy-to-public.mjs).
 */
export const API_ROUTES: readonly string[] = [
  "/api", "/debug", "/bloques/list",
  "/mv", "/st", "/spd", "/stopall",
  "/sumo/config", "/sumo/trim", "/sumo/micro", "/sumo/mini", "/sumo/stop", "/sumo/umbral",
  "/bloques/add", "/bloques/del", "/bloques/run", "/bloques/stop", "/bloques/clear",
  "/auto/vivero", "/auto/meteo", "/auto/alarma", "/auto/alarma/reset", "/auto/acceso", "/auto/stop",
  "/panel/config", "/panel/save",
  "/led/on", "/led/off", "/led/brillo",
  "/gpio/out", "/gpio/read",
  "/sonar/read", "/sonar/stop", "/dht/pin",
];

/**
 * TRANSITORIO (ver ADR pendiente / instrucción explícita del usuario):
 * /lab/state es una API HTTP paralela al firmware, creada para acelerar el
 * desarrollo del primer Workspace. La arquitectura definitiva usa el canal
 * postMessage (ver swRuntime.ts `getLiveState`) — /lab/state se mantiene
 * como fallback mientras ese canal termina de probarse, y debería poder
 * eliminarse sin que ningún Workspace se rompa.
 */
export const LAB_ROUTES: readonly string[] = ["/lab/state"];
