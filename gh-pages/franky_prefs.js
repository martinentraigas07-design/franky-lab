// ═══════════════════════════════════════════════════════
//  FASE 4.8 — PREFERENCIAS DE INTERFAZ (localStorage)
//
//  Esto es DISTINTO del Proyecto FRANKY (config real del robot: Sumo,
//  Laberinto, I2C, Blockly), que vive en el firmware (NVS) y se exporta
//  como archivo .franky. Acá solo se guardan preferencias VISUALES sin
//  ningún impacto funcional — última pestaña abierta, último ejemplo
//  elegido, etc. Si esto se pierde (modo privado, otro navegador), la
//  página simplemente vuelve a su vista por defecto; no se pierde
//  ninguna configuración real del robot.
//
//  A diferencia de un Artifact de Claude, esto corre en el navegador
//  real del usuario contra un servidor propio (FRANKY Server) — acá
//  localStorage es la herramienta correcta y estándar.
//
//  Namespace "franky." para no chocar con otra cosa si el navegador se
//  reutiliza. Cada acceso va en try/catch: si localStorage no está
//  disponible (modo privado estricto, primera carga, etc.) la página
//  tiene que seguir funcionando igual, solo sin recordar nada.
// ═══════════════════════════════════════════════════════
var FrankyPrefs = (function () {
  var PREFIX = "franky.";

  function getPref(clave, porDefecto) {
    try {
      var v = window.localStorage.getItem(PREFIX + clave);
      return (v === null) ? porDefecto : v;
    } catch (e) {
      return porDefecto;
    }
  }

  function setPref(clave, valor) {
    try {
      window.localStorage.setItem(PREFIX + clave, valor);
      return true;
    } catch (e) {
      return false; // modo privado, cuota llena, etc. — no rompe la pagina
    }
  }

  function getPrefInt(clave, porDefecto) {
    var v = getPref(clave, null);
    if (v === null) return porDefecto;
    var n = parseInt(v, 10);
    return isNaN(n) ? porDefecto : n;
  }

  return { get: getPref, set: setPref, getInt: getPrefInt };
})();
// NOTA FRANKY-LAB: puerto literal del franky_prefs.js real (Fase 4.8) —
// es localStorage puro, sin dependencia de red ni de firmware; no hay
// nada que adaptar. Ver auditoría Server-vs-LAB (Sesión 1, ítem 1).
