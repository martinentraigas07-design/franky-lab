// FRANKY LAB — Publica el sitio compilado en la RAÍZ del repositorio,
// al lado del código fuente (core/, providers/, boards/, mcu/,
// public-src/, build/). Un único proyecto, código fuente y producto
// terminado conviviendo en el mismo repo — ver CHANGELOG "Fase 3,
// cierre de distribución" para el porqué.
//
// Corre DESPUÉS de `npm run build:ghpages` (o `build:release`, que ya
// lo encadena). No genera nada nuevo por sí solo: copia gh-pages/ tal
// cual a la raíz del proyecto.
//
// Sin colisión posible: gh-pages/ solo contiene archivos sueltos
// (index.html, start.html, lab.html, sw.js, deviceModel.js, los .html/
// .js/.css originales de FRANKY, y la carpeta _lab/) — ningún nombre
// coincide con las carpetas fuente del repo (core/, providers/, boards/,
// mcu/, build/, public-src/, docs/) ni con package.json/tsconfig*.json.
import { existsSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const ghPagesDir = join(root, "gh-pages");

if (!existsSync(ghPagesDir)) {
  console.error("gh-pages/ no existe. Corré 'npm run build:ghpages' primero.");
  process.exit(1);
}

for (const entry of readdirSync(ghPagesDir)) {
  cpSync(join(ghPagesDir, entry), join(root, entry), { recursive: true });
}

console.log("  copiado: gh-pages/* -> raíz del repo (listo para publicar sin build)");
console.log("\nRaíz del repo lista. GitHub Pages -> Deploy from branch -> / (root) sirve esto directo.");
