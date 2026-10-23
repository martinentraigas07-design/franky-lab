/// <reference lib="webworker" />
/**
 * FRANKY LAB — Core / Service Worker Runtime (genérico)
 *
 * No conoce FRANKY, ni v3.2-LNR, ni ninguna ruta concreta. Recibe un
 * ProviderServer ya armado (Provider + Board + MCU + World, todo resuelto)
 * y la lista de rutas de API de ESE Provider, e intercepta fetch() en
 * consecuencia. El Provider concreto es quien arma todo esto en su propio
 * archivo de entrada (ver providers/franky-server-4.0/sw-entry.ts).
 */
import { ProviderServer, Query } from "./providerContract.js";

declare const self: ServiceWorkerGlobalScope;

export function startServiceWorker(
  server: ProviderServer,
  apiRoutes: readonly string[],
  onTick?: (dtMs: number) => void,
): void {
  const apiRouteSet = new Set(apiRoutes);
  let lastTick = Date.now();

  function pumpClock(): void {
    const now = Date.now();
    const dtMs = Math.min(now - lastTick, 250); // tope defensivo si la pestaña estuvo en background
    lastTick = now;
    onTick?.(dtMs);
    server.tick();
  }

  self.addEventListener("install", () => {
    self.skipWaiting();
  });

  self.addEventListener("activate", (event: ExtendableEvent) => {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("fetch", (event: FetchEvent) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    // ── Portabilidad de despliegue (raíz del dominio o cualquier
    // subdirectorio — GitHub Pages Project Pages, Apache, Nginx, etc.) ──
    // El scope real del Service Worker (self.registration.scope) es el
    // ÚNICO lugar donde el proyecto sabe, en runtime, desde qué subpath
    // quedó publicado — nunca se hardcodea. Toda ruta entrante se
    // "canonicaliza" acá (se le quita ese prefijo) ANTES de tocar
    // apiRouteSet o server.handle(): así el resto del sistema (rutas
    // declaradas en cada Provider, Firmware Runtime, Virtual Server)
    // sigue pensando en rutas absolutas-desde-raíz exactamente como
    // siempre — sin tener que saber nada de dónde está publicado.
    const canonicalPath = toCanonicalPath(url.pathname, currentScopePath());
    if (canonicalPath === null) return; // pedido fuera del scope de este SW — no debería pasar, pero es defensivo
    if (!apiRouteSet.has(canonicalPath)) return; // estático -> lo sirve el host tal cual
    event.respondWith(handleApiFetch(server, event.request, canonicalPath, pumpClock));
  });

  /**
   * Canal NO-HTTP para Workspaces (ADR pendiente de escribir; requerido
   * explícitamente: "los Workspaces obtienen su información directamente
   * del Runtime/Firmware Model/World Model, sin pasar por HTTP").
   *
   * Protocolo: la página pide estado con postMessage({type:"FRANKY_LAB_REQUEST_STATE"})
   * sobre navigator.serviceWorker.controller; el SW responde con
   * postMessage({type:"FRANKY_LAB_STATE", payload: server.getLiveState()})
   * dirigido a ese mismo cliente. No es fetch(), no tiene URL, método,
   * código de estado ni Content-Type — es paso de mensajes entre contextos,
   * la única vía real de comunicación entre una página y su Service Worker
   * (no existe memoria compartida entre ambos).
   */
  self.addEventListener("message", (event: ExtendableMessageEvent) => {
    const data = event.data as { type?: string; pin?: number; value?: number } | undefined;
    if (data?.type === "FRANKY_LAB_REQUEST_STATE") {
      pumpClock();
      if (!server.getLiveState) return;
      const client = event.source as Client | null;
      client?.postMessage({ type: "FRANKY_LAB_STATE", payload: server.getLiveState() });
      return;
    }
    if (data?.type === "FRANKY_LAB_SET_INPUT") {
      if (server.setDigitalInput && data.pin !== undefined && data.value !== undefined) {
        server.setDigitalInput(data.pin, data.value === 0 ? 0 : 1);
      }
      return;
    }
  });
}

// Diagnóstico Síntoma D (POST /bloques/xml -> 400 "Cuerpo vacio") — causa
// raíz CONFIRMADA: este parser asumía SIEMPRE
// application/x-www-form-urlencoded, sin mirar el Content-Type real.
// guardarXmlEnRobot() en bloques.html manda el XML como body CRUDO con
// Content-Type: text/plain (correcto — así se comporta de verdad el
// WebServer de ESP32: cualquier POST que no sea form-urlencoded expone el
// body entero bajo el pseudo-argumento "plain", server.arg("plain") en el
// .ino real). Al parsear ese XML crudo como URLSearchParams se obtenía
// basura/vacío -> body.plain quedaba undefined -> el handler de
// /bloques/xml (con razón, desde su propio punto de vista) devolvía 400.
// El cliente YA es correcto (no se toca); el fix va acá: replicar la
// convención real de ESP32 según el Content-Type efectivo, en vez de
// asumir form-urlencoded para todo POST. Extraída a su propia función
// (antes inline en handleApiFetch) para poder probarla directamente sin
// necesitar un ServiceWorkerGlobalScope real — ver swRuntime.selfTest.ts.
export function parsePostBody(contentType: string | null, text: string): Query {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  // Cuerpo crudo (text/plain, application/json, sin Content-Type, etc.)
  // -> igual que el ESP32 real, se expone entero bajo "plain".
  return { plain: text };
}

async function handleApiFetch(
  server: ProviderServer,
  request: Request,
  canonicalPath: string,
  pumpClock: () => void,
): Promise<Response> {
  pumpClock();

  const url = new URL(request.url);
  const method = request.method === "POST" ? "POST" : "GET";
  const query: Query = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  let body: Query = {};
  if (method === "POST") {
    try {
      const text = await request.text();
      body = parsePostBody(request.headers.get("content-type"), text);
    } catch {
      body = {};
    }
  }

  const result = server.handle(method, canonicalPath, query, body);

  const headers: Record<string, string> = {
    "Content-Type": result.contentType === "application/json" ? "application/json" : result.contentType === "text/html" ? "text/html" : "text/plain",
    "Access-Control-Allow-Origin": "*",
  };
  // result.location, si existe, es SIEMPRE una ruta canónica absoluta-
  // desde-raíz (ej. "/", "/panel_config.html") — el mismo Virtual Server
  // no sabe ni le importa desde qué subpath está publicado el sitio. Acá
  // es donde se le vuelve a agregar el prefijo real antes de mandarla al
  // navegador, exactamente en el mismo punto (y con la misma fuente de
  // verdad, self.registration.scope) que canonicaliza las rutas entrantes.
  if (result.location) headers["Location"] = reprefixLocation(result.location, currentScopePath());

  const responseBody =
    result.body === null ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body);

  return new Response(responseBody, { status: result.status, headers });
}

/** pathname del scope del Service Worker, siempre terminado en "/" (ej. "/" o "/franky-lab/"). */
export function scopePathOf(scope: string): string {
  return new URL(scope).pathname;
}

/**
 * Scope actual de ESTE Service Worker, resuelto de forma defensiva.
 * self.registration existe siempre en un Service Worker real ya
 * activado — la única razón para que falte es un entorno de pruebas
 * que simula `self` sin registration (ver el harness de pruebas E2E
 * bajo providers, carpeta tests, e2e.smoketest.mjs).
 * En ese caso, y como red de seguridad, se asume raíz del dominio.
 */
function currentScopePath(): string {
  const reg = (self as Partial<ServiceWorkerGlobalScope>).registration;
  if (reg?.scope) return scopePathOf(reg.scope);
  return "/";
}

/**
 * Le saca el prefijo de despliegue (scopePath) a una ruta entrante real
 * y devuelve la ruta canónica absoluta-desde-raíz que el resto del
 * sistema espera (ej. "/franky-lab/api" -> "/api"). null si la ruta no
 * pertenece al scope de este Service Worker.
 */
export function toCanonicalPath(pathname: string, scopePath: string): string | null {
  if (!pathname.startsWith(scopePath)) return null;
  return "/" + pathname.slice(scopePath.length);
}

/** Inverso de toCanonicalPath: le vuelve a poner el prefijo de despliegue a una ruta canónica. */
export function reprefixLocation(canonicalLocation: string, scopePath: string): string {
  return scopePath + canonicalLocation.replace(/^\/+/, "");
}
