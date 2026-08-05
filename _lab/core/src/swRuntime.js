export function startServiceWorker(server, apiRoutes, onTick) {
    const apiRouteSet = new Set(apiRoutes);
    let lastTick = Date.now();
    function pumpClock() {
        const now = Date.now();
        const dtMs = Math.min(now - lastTick, 250); // tope defensivo si la pestaña estuvo en background
        lastTick = now;
        onTick?.(dtMs);
        server.tick();
    }
    self.addEventListener("install", () => {
        self.skipWaiting();
    });
    self.addEventListener("activate", (event) => {
        event.waitUntil(self.clients.claim());
    });
    self.addEventListener("fetch", (event) => {
        const url = new URL(event.request.url);
        if (url.origin !== self.location.origin)
            return;
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
        if (canonicalPath === null)
            return; // pedido fuera del scope de este SW — no debería pasar, pero es defensivo
        if (!apiRouteSet.has(canonicalPath))
            return; // estático -> lo sirve el host tal cual
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
    self.addEventListener("message", (event) => {
        const data = event.data;
        if (data?.type === "FRANKY_LAB_REQUEST_STATE") {
            pumpClock();
            if (!server.getLiveState)
                return;
            const client = event.source;
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
async function handleApiFetch(server, request, canonicalPath, pumpClock) {
    pumpClock();
    const url = new URL(request.url);
    const method = request.method === "POST" ? "POST" : "GET";
    const query = {};
    for (const [k, v] of url.searchParams.entries())
        query[k] = v;
    let body = {};
    if (method === "POST") {
        try {
            const text = await request.text();
            body = Object.fromEntries(new URLSearchParams(text));
        }
        catch {
            body = {};
        }
    }
    const result = server.handle(method, canonicalPath, query, body);
    const headers = {
        "Content-Type": result.contentType === "application/json" ? "application/json" : "text/plain",
        "Access-Control-Allow-Origin": "*",
    };
    // result.location, si existe, es SIEMPRE una ruta canónica absoluta-
    // desde-raíz (ej. "/", "/panel_config.html") — el mismo Virtual Server
    // no sabe ni le importa desde qué subpath está publicado el sitio. Acá
    // es donde se le vuelve a agregar el prefijo real antes de mandarla al
    // navegador, exactamente en el mismo punto (y con la misma fuente de
    // verdad, self.registration.scope) que canonicaliza las rutas entrantes.
    if (result.location)
        headers["Location"] = reprefixLocation(result.location, currentScopePath());
    const responseBody = result.body === null ? "" : typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    return new Response(responseBody, { status: result.status, headers });
}
/** pathname del scope del Service Worker, siempre terminado en "/" (ej. "/" o "/franky-lab/"). */
export function scopePathOf(scope) {
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
function currentScopePath() {
    const reg = self.registration;
    if (reg?.scope)
        return scopePathOf(reg.scope);
    return "/";
}
/**
 * Le saca el prefijo de despliegue (scopePath) a una ruta entrante real
 * y devuelve la ruta canónica absoluta-desde-raíz que el resto del
 * sistema espera (ej. "/franky-lab/api" -> "/api"). null si la ruta no
 * pertenece al scope de este Service Worker.
 */
export function toCanonicalPath(pathname, scopePath) {
    if (!pathname.startsWith(scopePath))
        return null;
    return "/" + pathname.slice(scopePath.length);
}
/** Inverso de toCanonicalPath: le vuelve a poner el prefijo de despliegue a una ruta canónica. */
export function reprefixLocation(canonicalLocation, scopePath) {
    return scopePath + canonicalLocation.replace(/^\/+/, "");
}
