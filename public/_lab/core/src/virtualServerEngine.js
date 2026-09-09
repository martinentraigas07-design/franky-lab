export class VirtualServerEngine {
    routes = new Map();
    registerRoute(path, handler) {
        this.routes.set(path, handler);
    }
    dispatch(method, path, query, body = {}) {
        const handler = this.routes.get(path);
        if (!handler) {
            return { status: 404, body: { ok: false, error: "NOT_FOUND" }, contentType: "application/json" };
        }
        return handler(query, body, method);
    }
    routePaths() {
        return [...this.routes.keys()];
    }
}
