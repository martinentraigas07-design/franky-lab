// FRANKY LAB — Sesión 1 (auditoría Server-vs-LAB): verifica que el
// Monitor Serie Virtual sea un componente COMPARTIDO (monitor.js), no
// una página aislada, y que esté correctamente embebido en
// monitor.html/bloques.html/sumo.html/panel.html — más el contrato de
// datos contra el backend real (compilado) para /monitor/log,
// /monitor/debug, /runtime/pagina, /runtime/navegador y /oled/*.
//
// IMPORTANTE: esto NO es una prueba visual en navegador — no ejecuta
// monitor.js en un DOM real, no verifica el widget flotante renderizado
// ni la interacción de un usuario. Verifica el contrato estructural y
// de datos entre el JS compartido, las páginas que lo incluyen, y el
// backend.
import { readFileSync } from "node:fs";
import { createProviderServer } from "../../../dist/providers/franky-server-4.0/server/virtualServer.js";
import { StubHAL } from "../../../dist/core/src/stubHal.js";

const monitorJs = readFileSync(new URL("../assets/monitor.js", import.meta.url), "utf8");
const monitorHtml = readFileSync(new URL("../assets/monitor.html", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../assets/index.html", import.meta.url), "utf8");
const paginas = {
  "bloques.html": readFileSync(new URL("../assets/bloques.html", import.meta.url), "utf8"),
  "sumo.html": readFileSync(new URL("../assets/sumo.html", import.meta.url), "utf8"),
  "panel.html": readFileSync(new URL("../assets/panel.html", import.meta.url), "utf8"),
};

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}`); }
}

console.log("1. monitor.js: expone el contrato público esperado (mismo que el Server real)");
check('define "var Monitor ="', monitorJs.includes("var Monitor ="));
check("expone setContext", /setContext:\s*setContext/.test(monitorJs));
check("expone fetchConConflicto", /fetchConConflicto:\s*fetchConConflicto/.test(monitorJs));
check("expone mostrarPaginaCompleta", /mostrarPaginaCompleta:\s*mostrarPaginaCompleta/.test(monitorJs));
check("hace polling de /monitor/log", monitorJs.includes("/monitor/log"));
check("usa /monitor/debug para el toggle", monitorJs.includes("/monitor/debug"));
check("reporta errores del navegador a /runtime/navegador", monitorJs.includes("/runtime/navegador"));
check("reporta entrada de página a /runtime/pagina", monitorJs.includes("/runtime/pagina"));
check("la barra de estado usa /api (NO /runtime/estado — decisión documentada de no duplicar)",
  monitorJs.includes('fetch("/api")') && !monitorJs.includes('fetch("/runtime/estado')); 
check("un solo Monitor por página (guard contra doble creación)", monitorJs.includes('getElementById("monitor-btn")) return'));
check("fetchConConflicto solo dispara el diálogo si d.conflicto===true (no cualquier 409)", monitorJs.includes("if (!d.conflicto) return new Response"));

console.log("\n2. monitor.html: wrapper delgado que reutiliza monitor.js (NO duplica el panel)");
check('incluye franky_prefs.js', monitorHtml.includes("franky_prefs.js"));
check('incluye monitor.js', monitorHtml.includes('resolveUrl("monitor.js")'));
check('llama Monitor.setContext("Monitor")', /Monitor\.setContext\("Monitor"\)/.test(monitorHtml));
check("llama Monitor.mostrarPaginaCompleta()", monitorHtml.includes("Monitor.mostrarPaginaCompleta()"));
check("NO redefine su propio buffer/polling (sin 'var lastSeq' propio)", !monitorHtml.includes("var lastSeq"));

console.log("\n3. Monitor embebido en las páginas correspondientes (bloques/sumo/panel)");
for (const [nombre, html] of Object.entries(paginas)) {
  check(`${nombre} incluye franky_prefs.js`, html.includes("franky_prefs.js"));
  check(`${nombre} incluye monitor.js`, html.includes('resolveUrl("monitor.js")'));
  check(`${nombre} llama Monitor.setContext(...)`, /Monitor\.setContext\(/.test(html));
}

console.log("\n4. Alcanzable desde el menú principal (index.html)");
check('index.html tiene un enlace a "monitor.html"', /data-app-href="monitor\.html"/.test(indexHtml));

console.log("\n5. Contrato de datos: /monitor/log y /monitor/debug (backend real compilado)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const r1 = server.handle("GET", "/monitor/log", {});
  check("/monitor/log responde 200", r1.status === 200);
  check('trae "debug" (boolean)', typeof r1.body.debug === "boolean");
  check('trae "entradas" (array)', Array.isArray(r1.body.entradas));

  server.handle("GET", "/sumo/mini", {});
  const r2 = server.handle("GET", "/monitor/log", { since: "-1" });
  check("hay al menos una entrada tras un evento real", r2.body.entradas.length > 0);
  const e = r2.body.entradas[0];
  check('cada entrada tiene seq/ms/msg', typeof e.seq === "number" && typeof e.ms === "number" && typeof e.msg === "string");

  const r3 = server.handle("GET", "/monitor/debug", { on: "1" });
  check("/monitor/debug?on=1 -> {debug:true}", r3.status === 200 && r3.body.debug === true);
}

console.log("\n6. SESIÓN 1 — /runtime/pagina y /runtime/navegador (diagnóstico de cliente)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const r1 = server.handle("GET", "/runtime/pagina", { p: "Sumo" });
  check("/runtime/pagina responde 200 texto plano", r1.status === 200 && r1.body === "OK");
  const log1 = server.handle("GET", "/monitor/log", { since: "-1" });
  check("PAGE_ENTER queda registrado en el Monitor", log1.body.entradas.some((e) => e.msg.includes("PAGE_ENTER Sumo")));

  const r2 = server.handle("GET", "/runtime/navegador", { tipo: "BROWSER_ERROR", pagina: "Bloques", msg: "algo fallo" });
  check("/runtime/navegador responde 200 texto plano", r2.status === 200 && r2.body === "OK");
  const log2 = server.handle("GET", "/monitor/log", { since: "-1" });
  check("BROWSER_ERROR queda registrado en el Monitor", log2.body.entradas.some((e) => e.msg.includes("[BROWSER] tipo=BROWSER_ERROR")));
}

console.log("\n7. SESIÓN 1 — /oled/test, /oled/clear, /oled/logo (Panel Industrial, sin fingir detección física)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);

  const sinI2c = server.handle("GET", "/oled/test", { size: "96" });
  check("/oled/test sin I2C habilitado -> 400 (error comun, no conflicto)", sinI2c.status === 400);

  server.handle("GET", "/panel/save", { i2c: "1" });
  const conI2c = server.handle("GET", "/oled/test", { size: "96" });
  check("/oled/test con I2C habilitado -> 200 (confirma precondición, no escanea hardware)", conI2c.status === 200);
  check("no inventa una dirección I2C real (siempre 0x3C fijo)", conI2c.body.addr === 0x3c);
  check("respeta el tamaño 96 pedido (128x64)", conI2c.body.ancho === 128 && conI2c.body.alto === 64);

  const sinProbar = createProviderServer(new StubHAL());
  sinProbar.handle("GET", "/panel/save", { i2c: "1" });
  const clearSinProbar = sinProbar.handle("GET", "/oled/clear", {});
  check("/oled/clear sin haber probado antes -> 400 (error comun, no conflicto)", clearSinProbar.status === 400);

  const clearOk = server.handle("GET", "/oled/clear", {});
  check("/oled/clear tras Probar -> 200", clearOk.status === 200);

  const logoOk = server.handle("GET", "/oled/logo", {});
  check("/oled/logo tras Probar -> 200", logoOk.status === 200);
  const estado = server.handle("GET", "/api", {}).body;
  check("/api refleja oled_det=1 tras Probar", estado.oled_det === 1);
}

console.log("\n8. SESIÓN 1 — conflicto de recursos real: Blockly usando OLED bloquea al Panel (409), y `forzar=1` lo resuelve");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/panel/save", { i2c: "1" });
  server.handle("GET", "/oled/test", { size: "96" });
  // Programa Blockly que usa OLED (OP_OLED_CLEAR=102) y lo deja corriendo.
  server.handle("GET", "/bloques/add", { op: "102", val: "0" });
  server.handle("GET", "/bloques/run", {});
  const conConflicto = server.handle("GET", "/oled/clear", {});
  check("con Blockly corriendo y usando OLED, /oled/clear responde 409 con forma de conflicto", conConflicto.status === 409 && conConflicto.body.conflicto === true);
  const forzado = server.handle("GET", "/oled/clear", { forzar: "1" });
  check("con forzar=1, la acción del Panel se aplica igual (200)", forzado.status === 200);
  const apiTrasForzar = server.handle("GET", "/api", {}).body;
  check("forzar=1 detuvo Blockly (mismo efecto que detenerBlockly() real)", apiTrasForzar.running === 0);
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
if (fail > 0) process.exit(1);
