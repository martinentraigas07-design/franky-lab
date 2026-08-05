/**
 * FRANKY — resolución de ruta base (BASE_URL / APP_ROOT), único punto.
 *
 * Por qué existe: todo el proyecto (Servidor Web original + FRANKY LAB)
 * es UN SOLO árbol de archivos, servido tal cual tanto por el ESP32
 * (siempre desde la raíz real del dominio, ej. http://192.168.4.1/)
 * como por cualquier hosting estático (GitHub Pages, Apache, Nginx,
 * Live Server) — que puede servirlo desde la raíz o desde un subdirectorio
 * (ej. https://usuario.github.io/franky-lab/). El código nunca sabe de
 * antemano cuál de los dos es. Este archivo lo calcula solo, en runtime,
 * sin configuración y sin detectar la plataforma.
 *
 * Cómo funciona: se carga como el PRIMER <script> de cada página, con
 * una ruta RELATIVA (`<script src="base.js"></script>`, sin "/" inicial).
 * Esa única referencia relativa es, por construcción, siempre correcta
 * — el navegador la resuelve contra la URL de la página que lo carga,
 * sea cual sea su profundidad real. A partir de ahí, `document.currentScript.src`
 * le da a este archivo su propia URL absoluta ya resuelta, y de ahí se
 * deriva la raíz de la app entera — sin hardcodear nada.
 *
 * Todo el resto del proyecto (fetch, registro del Service Worker,
 * navegación entre páginas, iframes, imports dinámicos, y los recursos
 * estáticos marcados con data-app-*, ver rewriteDom más abajo) pasa por
 * `resolveUrl()`. No debe quedar ningún "/..." hardcodeado donde esto
 * pueda usarse en su lugar.
 */
(function (global) {
  "use strict";

  var thisScript = document.currentScript;
  if (!thisScript) {
    // Fallback defensivo (no debería hacer falta con <script> síncronos
    // cargados normalmente, pero evita romper si algún día se carga distinto).
    var scripts = document.getElementsByTagName("script");
    thisScript = scripts[scripts.length - 1];
  }

  // Directorio que contiene a base.js, como URL absoluta terminada en
  // "/". Como base.js vive siempre en la raíz de la app (junto a
  // index.html, sw.js, etc.), esto ES la raíz de la app — sea la raíz
  // real del dominio o cualquier subdirectorio.
  var root = new URL(".", thisScript.src).href;

  /**
   * Resuelve cualquier ruta de la app (relativa a su raíz) contra la
   * ubicación real de despliegue. Tolerante con un "/" inicial legado
   * (lo interpreta como "raíz de la app", no "raíz del dominio") para
   * que envolver código existente sea un cambio de una sola línea.
   */
  function resolveUrl(path) {
    path = String(path == null ? "" : path).replace(/^\/+/, "");
    return new URL(path, root).href;
  }

  /** Solo el pathname resuelto — útil para comparar contra location.pathname. */
  function resolvePath(path) {
    return new URL(resolveUrl(path)).pathname;
  }

  /**
   * Recorre el DOM (o un nodo específico) y convierte los atributos
   * data-app-href / data-app-src / data-app-action en href/src/action
   * reales, resueltos contra la raíz de la app. Único mecanismo para
   * recursos estáticos (imágenes, links de navegación, forms) — mismo
   * resolveUrl() que usa todo lo demás, sin rutas mezcladas.
   */
  function rewriteDom(root_) {
    root_ = root_ || document;
    var map = { href: "data-app-href", src: "data-app-src", action: "data-app-action" };
    Object.keys(map).forEach(function (attr) {
      var sel = "[" + map[attr] + "]";
      var els = root_.querySelectorAll ? root_.querySelectorAll(sel) : [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        el.setAttribute(attr, resolveUrl(el.getAttribute(map[attr])));
      }
    });
  }

  global.FRANKY_BASE = { root: root, resolveUrl: resolveUrl, resolvePath: resolvePath, rewriteDom: rewriteDom };
  // Alias corto — es lo que se usa en el resto del código.
  global.resolveUrl = resolveUrl;

  /**
   * Único punto para fetch(): en vez de salir a buscar y envolver cada
   * fetch("/algo") repartido por ~10 páginas (un lugar fácil de olvidar
   * uno), se intercepta fetch UNA sola vez acá. Cualquier llamada a
   * fetch() con una URL de string que empiece con "/" (ruta absoluta-
   * desde-raíz "de toda la vida", como las usa cada página tal cual las
   * escribió el firmware original) se resuelve contra la raíz real de la
   * app antes de salir a la red. Rutas ya absolutas (http://, https://)
   * o relativas sin "/" inicial pasan sin tocar. Esto es lo que hace que
   * ningún fetch("/xxx") existente haya tenido que reescribirse a mano:
   * todos pasan, sin saberlo, por la misma resolución que este archivo
   * calculó una sola vez.
   */
  var nativeFetch = global.fetch ? global.fetch.bind(global) : null;
  if (nativeFetch) {
    global.fetch = function (input, init) {
      if (typeof input === "string" && input.charAt(0) === "/") {
        input = resolveUrl(input);
      }
      return nativeFetch(input, init);
    };
  }
})(window);
