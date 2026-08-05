/**
 * FRANKY LAB — Core / Virtual Server Engine
 *
 * Router genérico: registerRoute(path, handler) / dispatch(...). No sabe qué
 * es "/api" ni "/sumo/config" — eso lo registra cada Provider. Esto es lo
 * único que hace estable "Virtual Server" entre versiones de firmware
 * (ADR-001 §3).
 */
import { HttpResponse, Query } from "./providerContract.js";

export type RouteHandler = (query: Query, body: Query, method: "GET" | "POST") => HttpResponse;

export class VirtualServerEngine {
  private routes = new Map<string, RouteHandler>();

  registerRoute(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
  }

  dispatch(method: "GET" | "POST", path: string, query: Query, body: Query = {}): HttpResponse {
    const handler = this.routes.get(path);
    if (!handler) {
      return { status: 404, body: { ok: false, error: "NOT_FOUND" }, contentType: "application/json" };
    }
    return handler(query, body, method);
  }

  routePaths(): string[] {
    return [...this.routes.keys()];
  }
}
