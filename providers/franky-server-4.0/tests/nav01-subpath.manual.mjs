// NAV-01 — reproducción/verificación con un navegador REAL (Chromium vía
// Playwright), no un stub de DOM. Sirve public/ bajo un subdirectorio
// "/franky-lab/" (igual que GitHub Project Pages: usuario.github.io/
// franky-lab/), abre bloques.html, hace click en el enlace "Volver" y
// confirma que la navegación queda DENTRO de /franky-lab/ con 200 — no en
// la raíz del dominio con 404 (el bug real que tenía bloques.html: un
// <a href="/"> hardcodeado, única página del proyecto sin el mecanismo
// portable data-app-href + FRANKY_BASE.rewriteDom() que usan todas las
// demás — ver bloques.html, buscar "CORRECCIÓN NAV-01").
//
// NO forma parte de `npm test`/`npm run test:e2e`: requiere el paquete
// "playwright" (no es una devDependency del proyecto, para no obligar a
// descargar un binario de Chromium solo para esta verificación puntual) y
// un Chromium ya instalado. Para correrlo:
//   npm install --no-save playwright
//   npm run build:all
//   node providers/franky-server-4.0/tests/nav01-subpath.manual.mjs ./public [ruta-a-chromium]
// Si se omite [ruta-a-chromium], Playwright intenta resolver su propio
// binario (requiere haber corrido antes `npx playwright install chromium`,
// lo que a su vez requiere red); en este sandbox de verificación se usó el
// Chromium ya preinstalado en /opt/pw-browsers/chromium-*/chrome-linux/chrome.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.argv[2] || "./public");
const EXECUTABLE_PATH = process.argv[3]; // opcional
const PREFIX = "/franky-lab";

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".gz": "application/octet-stream" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); res.end("fuera del subdirectorio simulado: " + p); return; }
  p = p.slice(PREFIX.length) || "/";
  if (p === "/") p = "/index.html";
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end("404 real: " + p); return;
  }
  const ext = path.extname(full);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch(EXECUTABLE_PATH ? { executablePath: EXECUTABLE_PATH } : {});
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`${base}${PREFIX}/bloques.html`, { waitUntil: "load" });

  const href = await page.locator('a.btn.bg:has-text("Volver")').first().getAttribute("href");
  console.log("href resuelto del enlace 'Volver':", href);

  const [resp] = await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }).catch((e) => ({ error: String(e) })),
    page.locator('a.btn.bg:has-text("Volver")').first().click(),
  ]);

  const finalUrl = page.url();
  console.log("URL final tras el click:", finalUrl);
  const status = resp && resp.status ? resp.status() : "(sin respuesta de navegación, ver error)";
  console.log("status HTTP de la navegación:", status);

  // index.html redirige a start.html cuando todavía no hay un Service
  // Worker controlando la página (comportamiento esperado, ver
  // copy-to-public.mjs) — lo que importa para NAV-01 es que la navegación
  // quede DENTRO de /franky-lab/ con 200, no en la raíz del dominio con 404.
  const ok = finalUrl.startsWith(`${base}${PREFIX}/`) && status === 200;
  console.log(ok ? "RESULTADO: OK — navega dentro de /franky-lab/, no a la raíz del dominio" : "RESULTADO: FALLÓ — NO quedó dentro de /franky-lab/");
  console.log("errores de página (deben ser 0):", consoleErrors.length, consoleErrors.join(" | "));
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
