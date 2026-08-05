// FRANKY LAB — Verificación ejecutable de base.js (portabilidad de
// despliegue) contra el archivo REAL, no una reimplementación a mano.
//
// Corre el código real de providers/franky-server-4.0/assets/base.js
// en un DOM mínimo simulado, fijando document.currentScript.src a lo
// que un navegador real reportaría en cada escenario de publicación, y
// verifica que resolveUrl()/resolvePath()/rewriteDom() den el resultado
// correcto en cada uno — raíz del dominio, subdirectorio de GitHub
// Project Pages, Live Server, y anidado a dos niveles.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../assets/base.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log(`  ✓ ${desc}`); }
  else { fail++; console.log(`  ✗ ${desc}`); }
}

/** Corre base.js real en un DOM mínimo simulado, con base.js "servido" desde `scriptSrc`. */
function runBaseJs(scriptSrc, domElements = []) {
  const registered = {}; // atributo -> [ {selector-ish tag, attrs} ]
  const fakeElements = domElements.map((el) => ({
    ...el,
    setAttribute(attr, value) { this[attr] = value; },
    getAttribute(attr) { return this[attr]; },
  }));

  const fakeDocument = {
    currentScript: { src: scriptSrc },
    querySelectorAll(sel) {
      const attr = sel.replace(/^\[|\]$/g, "");
      return fakeElements.filter((el) => attr in el && el[attr] !== undefined && el.hasOwnProperty(attr));
    },
  };
  const fakeWindow = {};
  // base.js es un IIFE que recibe `window` como argumento y define
  // `document`/`URL` como globals de navegador — se los proveemos acá.
  const fn = new Function("window", "document", "URL", src + "\nreturn window;");
  const result = fn(fakeWindow, fakeDocument, URL);
  return { FRANKY_BASE: result.FRANKY_BASE, elements: fakeElements };
}

console.log("1. Raíz del dominio (ESP32, GitHub User Pages, hosting simple)");
{
  const { FRANKY_BASE } = runBaseJs("https://usuario.github.io/base.js");
  check("root -> 'https://usuario.github.io/'", FRANKY_BASE.root === "https://usuario.github.io/");
  check("resolveUrl('style.css') -> 'https://usuario.github.io/style.css'", FRANKY_BASE.resolveUrl("style.css") === "https://usuario.github.io/style.css");
  check("resolveUrl('/api') (legado con barra) -> 'https://usuario.github.io/api'", FRANKY_BASE.resolveUrl("/api") === "https://usuario.github.io/api");
  check("resolvePath('bloques.html') -> '/bloques.html'", FRANKY_BASE.resolvePath("bloques.html") === "/bloques.html");
}

console.log("\n2. ESP32 real (IP local, siempre raíz)");
{
  const { FRANKY_BASE } = runBaseJs("http://192.168.4.1/base.js");
  check("root -> 'http://192.168.4.1/'", FRANKY_BASE.root === "http://192.168.4.1/");
  check("resolveUrl('sw.js') -> 'http://192.168.4.1/sw.js'", FRANKY_BASE.resolveUrl("sw.js") === "http://192.168.4.1/sw.js");
}

console.log("\n3. GitHub Project Pages (subdirectorio) — el caso que antes rompía");
{
  const { FRANKY_BASE } = runBaseJs("https://usuario.github.io/franky-lab/base.js");
  check("root -> '.../franky-lab/'", FRANKY_BASE.root === "https://usuario.github.io/franky-lab/");
  check("resolveUrl('style.css') -> '.../franky-lab/style.css' (NO a la raíz del dominio)", FRANKY_BASE.resolveUrl("style.css") === "https://usuario.github.io/franky-lab/style.css");
  check("resolveUrl('/api') (legado con barra) -> '.../franky-lab/api', no '.../api'", FRANKY_BASE.resolveUrl("/api") === "https://usuario.github.io/franky-lab/api");
  check("resolvePath('bloques.html') -> '/franky-lab/bloques.html'", FRANKY_BASE.resolvePath("bloques.html") === "/franky-lab/bloques.html");
}

console.log("\n4. Subdirectorio anidado (Live Server, Apache, Nginx sirviendo un alias)");
{
  const { FRANKY_BASE } = runBaseJs("http://localhost:5500/proyectos/robotica/franky-lab/base.js");
  check("root preserva los tres niveles", FRANKY_BASE.root === "http://localhost:5500/proyectos/robotica/franky-lab/");
  check("resolveUrl('lab.html') preserva los tres niveles", FRANKY_BASE.resolveUrl("lab.html") === "http://localhost:5500/proyectos/robotica/franky-lab/lab.html");
}

console.log("\n5. rewriteDom() — recursos estáticos (data-app-href/src/action) resueltos igual que fetch()");
{
  const { FRANKY_BASE, elements } = runBaseJs("https://usuario.github.io/franky-lab/base.js", [
    { "data-app-src": "logo.jpg" },
    { "data-app-href": "sumo.html" },
    { "data-app-action": "panel/save" },
  ]);
  FRANKY_BASE.rewriteDom();
  check("data-app-src -> src resuelto bajo el subdirectorio", elements[0].src === "https://usuario.github.io/franky-lab/logo.jpg");
  check("data-app-href -> href resuelto bajo el subdirectorio", elements[1].href === "https://usuario.github.io/franky-lab/sumo.html");
  check("data-app-action -> action resuelto bajo el subdirectorio", elements[2].action === "https://usuario.github.io/franky-lab/panel/save");
}

console.log(`\n${pass} pasaron, ${fail} fallaron.`);
if (fail > 0) process.exit(1);
