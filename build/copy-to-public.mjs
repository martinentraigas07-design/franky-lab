// FRANKY LAB — Ensambla public/ para despliegue.
//
// Regla física (ADR-001 §2): los archivos ORIGINALES de FRANKY usan rutas
// absolutas de raíz -> tienen que quedar en la raíz de public/.
// El Service Worker en sí también tiene que estar en la raíz (scope "/").
// PERO sus módulos internos (core + provider) NO necesitan estar en la
// raíz -- solo necesitan ser alcanzables por import relativo desde donde
// esté el archivo que los importa. Por eso: public/sw.js es un shim de una
// línea que importa el bundle real desde public/_lab/ (anidado, prolijo).
import { readdirSync, copyFileSync, mkdirSync, existsSync, cpSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distSw = join(root, "dist-sw");
const dist = join(root, "dist");
const publicDir = join(root, "public");
const publicSrc = join(root, "public-src");
const providerId = "franky-server-4.0";
const assetsDir = join(root, "providers", providerId, "assets");

if (!existsSync(distSw)) {
  console.error("dist-sw/ no existe. Corré 'npm run build:sw' primero.");
  process.exit(1);
}

// -1) manifest.json es documentación/metadata de build; routes.ts es la
//     fuente real que consume el navegador (ver comentario en routes.ts
//     sobre por qué se dejó de importar el .json como módulo ES). Si se
//     desincronizan, alguien editó una lista y se olvidó de la otra —
//     mejor abortar el build que servir algo inconsistente.
{
  const manifestPath = join(root, "providers", providerId, "manifest.json");
  const routesJsPath = join(dist, "providers", providerId, "routes.js");
  if (!existsSync(routesJsPath)) {
    console.error(`Falta ${routesJsPath}. Corré 'npm run build' primero.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const routesMod = await import("file://" + routesJsPath);
  const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!sameArray(manifest.apiRoutes, routesMod.API_ROUTES)) {
    console.error("manifest.json.apiRoutes y routes.ts API_ROUTES están desincronizados.");
    process.exit(1);
  }
  if (!sameArray(manifest.labRoutes, routesMod.LAB_ROUTES)) {
    console.error("manifest.json.labRoutes y routes.ts LAB_ROUTES están desincronizados.");
    process.exit(1);
  }
  console.log("  verificado: manifest.json y routes.ts coinciden.");
}


// 0) Guarda de colisión: los assets originales no pueden compartir nombre
//    con lo que el build va a poner en la raíz de public/.
const rootReserved = ["sw.js", "start.html", "lab.html"];
const originalFiles = readdirSync(assetsDir);
const collisions = rootReserved.filter((f) => originalFiles.includes(f));
if (collisions.length > 0) {
  console.error(`Colisión de nombres entre archivos reservados y assets originales: ${collisions.join(", ")}`);
  process.exit(1);
}

rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });

// 1) Módulos compilados del Service Worker, anidados (no necesitan estar en raíz)
cpSync(distSw, join(publicDir, "_lab"), { recursive: true });
console.log("  copiado: dist-sw/* -> public/_lab/ (estructura preservada)");

// 2) sw.js — shim en la raíz (scope "/", obligatorio). Versionado por build:
//    los navegadores solo detectan que un Service Worker "cambió" comparando
//    BYTE A BYTE el script pasado a register() — nunca miran sus imports
//    internos. Un shim de texto fijo nunca dispara una actualización, sin
//    importar cuánto cambie sw-entry.js por dentro (esto causó que un SW
//    viejo con el bug del manifest.json quedara pegado indefinidamente).
//    Por eso el import lleva un query param con el hash del build: cambia
//    los bytes de sw.js en cada build, lo que sí dispara el algoritmo de
//    actualización real del navegador.
const buildId = hashDirectory(distSw).slice(0, 12);
const swEntryRelPath = `_lab/providers/${providerId}/sw-entry.js?v=${buildId}`;
writeFileSync(join(publicDir, "sw.js"), `import "./${swEntryRelPath}";\n`);
console.log(`  generado: public/sw.js (shim -> ${swEntryRelPath}, build ${buildId})`);

/** Hash determinístico de TODO el árbol compilado (no solo sw-entry.js), para
 * que cualquier cambio en cualquier dependencia (core/, firmware/, server/)
 * cambie los bytes de sw.js y el navegador detecte la actualización real. */
function hashDirectory(dir) {
  const hash = createHash("sha256");
  const files = [];
  (function walk(d, prefix) {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, entry.name);
      const rel = prefix + "/" + entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  })(dir, "");
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update(readFileSync(join(dir, rel.slice(1))));
  }
  return hash.digest("hex");
}

// 3) Assets ORIGINALES, sin modificar un byte, en la raíz
cpSync(assetsDir, publicDir, { recursive: true });
console.log("  copiado: assets originales -> public/ (raíz, sin modificar)");

// 3.1) Parche SOLO en la COPIA de public/index.html (nunca en el asset
// fuente de providers/*/assets/ — ese mismo archivo se usa tal cual para
// SPIFFS en el robot físico, y un robot físico nunca tiene start.html
// ni sw.js; parchear la fuente rompería el panel real del robot).
//
// Motivo: GitHub Pages abre siempre index.html, nunca start.html. Sin
// este parche, la primera visita a un sitio publicado vería el HTML
// original de FRANKY sin ningún backend real detrás (fetch() a /api,
// etc. fallarían) porque el Service Worker todavía no está registrado
// ni controlando la pestaña. Con este parche, index.html se comporta
// exactamente como start.html en ese caso: si todavía no hay un Service
// Worker controlando la página, redirige a start.html (ruta RELATIVA —
// portable a cualquier subdirectorio sin depender de base.js, ver
// docs/internal/architecture.md sección 6) — que registra el Service
// Worker y recién ahí lleva a lab.html. start.html no se renombra ni se
// elimina, sigue existiendo tal cual.
//
// Si YA hay un Service Worker controlando (visitas siguientes, y el caso
// del iframe de lab.html que carga index.html: para cuando ese iframe
// carga, el Service Worker de la pestaña ya está activo y controla esa
// misma carga) el chequeo da falso y el archivo se comporta 100% igual
// al original — cero diferencia de comportamiento en ese caso.
{
  const indexPath = join(publicDir, "index.html");
  const original = readFileSync(indexPath, "utf8");
  const guard =
    '<script>if(!("serviceWorker" in navigator)||!navigator.serviceWorker.controller){location.replace("start.html");}</script>\n';
  if (!original.includes(guard)) {
    const patched = original.replace("<head>", "<head>\n" + guard);
    if (patched === original) {
      console.error("No se encontró <head> en index.html — no se pudo aplicar el parche de arranque.");
      process.exit(1);
    }
    writeFileSync(indexPath, patched);
  }
  console.log("  parcheado: public/index.html (arranca como start.html si no hay Service Worker controlando)");
}

// 4) Loader
copyFileSync(join(publicSrc, "loader.html"), join(publicDir, "start.html"));
console.log("  copiado: loader.html -> public/start.html");

// 5) Lab shell (iframe del Servidor original + Workspace del Robot Virtual)
copyFileSync(join(publicSrc, "lab.html"), join(publicDir, "lab.html"));
console.log("  copiado: lab.html -> public/lab.html");

// 6) Device Model compilado (Fase 3) — lo consulta el Hardware Workspace
// del lab.html vía <script type="module"> para saber qué dispositivos
// mostrar según el programa cargado.
copyFileSync(join(dist, "core/src/deviceModel.js"), join(publicDir, "deviceModel.js"));
console.log("  copiado: deviceModel.js -> public/deviceModel.js");

console.log("\npublic/ listo.");
console.log("Primer uso: abrir /start.html una vez. Visitas siguientes: /index.html directo.");
