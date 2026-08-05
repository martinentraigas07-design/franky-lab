// FRANKY LAB — Core / swRuntime.selfTest
//
// Prueba la infraestructura de portabilidad de despliegue: el Service
// Worker tiene que poder publicarse desde la raíz del dominio (ESP32,
// GitHub User Pages, cualquier hosting apuntado a su raíz) o desde
// cualquier subdirectorio (GitHub Project Pages, ej.
// usuario.github.io/franky-lab/) SIN cambiar una sola línea de las
// rutas internas (routes.ts, virtualServer.ts, firmware/*) — todas
// siguen pensando en rutas canónicas absolutas-desde-raíz ("/api",
// "/bloques/add", etc.), y este archivo es el único punto que traduce
// entre esa realidad interna y la realidad externa de dónde quedó
// publicado el sitio.
import { scopePathOf, toCanonicalPath, reprefixLocation } from "./swRuntime.js";

let pass = 0, fail = 0;
function check(desc: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}`); }
}

console.log("1. scopePathOf — siempre termina en '/', sea raíz o subcarpeta");
check("raíz del dominio -> '/'", scopePathOf("https://usuario.github.io/") === "/");
check("subcarpeta (GitHub Project Pages) -> '/franky-lab/'", scopePathOf("https://usuario.github.io/franky-lab/") === "/franky-lab/");
check("ESP32 (IP local) -> '/'", scopePathOf("http://192.168.4.1/") === "/");
check("subcarpeta anidada -> preserva los dos niveles", scopePathOf("https://ejemplo.com/robotica/franky/") === "/robotica/franky/");

console.log("\n2. toCanonicalPath — le saca el prefijo de despliegue, devuelve la ruta canónica interna");
check("raíz: '/api' con scope '/' -> '/api' (sin cambios)", toCanonicalPath("/api", "/") === "/api");
check("raíz: '/bloques/add' con scope '/' -> '/bloques/add'", toCanonicalPath("/bloques/add", "/") === "/bloques/add");
check("subcarpeta: '/franky-lab/api' con scope '/franky-lab/' -> '/api'", toCanonicalPath("/franky-lab/api", "/franky-lab/") === "/api");
check("subcarpeta: '/franky-lab/bloques/add' con scope '/franky-lab/' -> '/bloques/add'", toCanonicalPath("/franky-lab/bloques/add", "/franky-lab/") === "/bloques/add");
check("fuera de scope -> null (defensivo, no debería pasar en la práctica)", toCanonicalPath("/otra-app/api", "/franky-lab/") === null);

console.log("\n3. reprefixLocation — inverso exacto de toCanonicalPath, para el header Location de redirects");
check("raíz: '/' con scope '/' -> '/'", reprefixLocation("/", "/") === "/");
check("raíz: '/panel_config.html' con scope '/' -> '/panel_config.html'", reprefixLocation("/panel_config.html", "/") === "/panel_config.html");
check("subcarpeta: '/' con scope '/franky-lab/' -> '/franky-lab/' (vuelve adentro de la app, no al dominio)", reprefixLocation("/", "/franky-lab/") === "/franky-lab/");
check("subcarpeta: '/panel_config.html' con scope '/franky-lab/' -> '/franky-lab/panel_config.html'", reprefixLocation("/panel_config.html", "/franky-lab/") === "/franky-lab/panel_config.html");

console.log("\n4. Round-trip — canonicalizar y volver a prefijar da la ruta original, en cualquier profundidad de despliegue");
for (const scope of ["/", "/franky-lab/", "/robotica/franky/"]) {
  for (const real of [scope + "api", scope + "bloques/add", scope]) {
    const canonical = toCanonicalPath(real, scope);
    const back = canonical !== null ? reprefixLocation(canonical, scope) : null;
    check(`round-trip '${real}' bajo scope '${scope}'`, back === real || (real === scope && back === scope));
  }
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
if (fail > 0) process.exit(1);
