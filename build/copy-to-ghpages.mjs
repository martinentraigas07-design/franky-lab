// FRANKY LAB — Genera gh-pages/ (listo para GitHub Pages) a partir de public/.
//
// NOTA DE NOMBRE (importante): el pedido de cierre habla de una carpeta
// "dist/" para GitHub Pages, pero "dist/" YA está tomado en este proyecto
// — es la salida del compilador TypeScript (ver tsconfig.json outDir,
// y "dist-sw/" para el bundle del Service Worker; build/copy-to-public.mjs
// lee de ahí). Reusar "dist/" para esto pisaría esa salida y rompería
// build:public y test. Por eso esta carpeta se llama "gh-pages/": mismo
// rol que el "dist/ para Pages" pedido, sin la colisión de nombre.
//
// Regla de fuente única (puntos 3 y 4 del cierre v3.2): public/ sigue
// siendo la única fuente real, usada tal cual para SPIFFS en el firmware
// físico. gh-pages/ NO se edita a mano ni tiene lógica propia — es una
// copia 1:1 de public/ una vez que build:public ya corrió. Esto evita el
// escenario que el pedido prohíbe explícitamente: dos servidores, dos
// Blockly, dos fuentes de verdad.
//
// gh-pages/ contiene únicamente lo que public/ ya contiene: Servidor
// FRANKY, Workspace, Blockly (bloques.html), recursos, Service Worker y
// assets. No se expone core/, providers/*/firmware, providers/*/server
// ni ningún código fuente TypeScript — eso vive solo en el repo, nunca
// en Pages.
import { existsSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const publicDir = join(root, "public");
const ghPagesDir = join(root, "gh-pages");

if (!existsSync(publicDir) || !existsSync(join(publicDir, "sw.js"))) {
  console.error("public/ no existe o está incompleto. Corré 'npm run build:public' primero.");
  process.exit(1);
}

rmSync(ghPagesDir, { recursive: true, force: true });
cpSync(publicDir, ghPagesDir, { recursive: true });

console.log("  copiado: public/* -> gh-pages/ (copia 1:1, lista para GitHub Pages)");
console.log("\ngh-pages/ listo. Publicar sirviendo esta carpeta como raíz en GitHub Pages");
console.log("(Settings -> Pages -> Deploy from branch -> /gh-pages, o via Actions).");
