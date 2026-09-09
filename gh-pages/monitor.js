// ═══════════════════════════════════════════════════════
//  FRANKY LAB — Monitor Serie Virtual, componente COMPARTIDO
//
//  Puerto de monitor.js real: mismo widget flotante (botón + panel),
//  mismo polling de /monitor/log, mismos botones (Pausar/Debug/
//  Guardar/Limpiar), mismo fetchConConflicto() para acciones del Panel
//  que pueden chocar con Blockly (ej. OLED).
//
//  DIFERENCIA DE IMPLEMENTACIÓN (documentada, no oculta):
//  - El real tiene una "CAPA 1" (barra de estado global) que hace
//    polling de /runtime/estado cada 2s. El LAB NO agrega ese endpoint
//    (decisión de la Fase 5: ya existe /api con la misma información) —
//    acá la barra de estado usa /api en su lugar. Mismo comportamiento
//    observable, sin duplicar un endpoint que ya existe.
//  - La captura de errores del navegador (window.onerror) SÍ se porta
//    tal cual — /runtime/pagina y /runtime/navegador ya existen en el
//    LAB (agregados en esta misma sesión).
//
//  Se incluye con <script src="monitor.js"> y cada página solo necesita
//  llamar Monitor.setContext("Sumo") (opcional, informativo) — todo lo
//  demás (botón, panel, polling) lo arma este archivo solo. UN SOLO
//  Monitor por página — si ya existe #monitor-btn, no se duplica.
// ═══════════════════════════════════════════════════════
var Monitor = (function () {
  var contexto = "";
  var abierto = false;
  var pausado = false;
  var lastSeq = -1; // -1: la primera consulta trae todo el buffer (ver nota de diseño de /monitor/log en el LAB)
  var pollTimer = null;
  var mensajes = []; // solo lo que ya se mostró en esta página — no es el buffer del firmware

  function crearUI() {
    if (document.getElementById("monitor-btn")) return; // ya existe (por si se llama dos veces)

    var css = document.createElement("style");
    css.textContent =
      "#monitor-btn{position:fixed;bottom:14px;right:14px;z-index:9000;" +
        "width:38px;height:38px;border-radius:50%;background:#1e2a45;border:1px solid #3a3a52;" +
        "color:#9aa4b8;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;" +
        "box-shadow:0 2px 8px rgba(0,0,0,.4);}" +
      "#monitor-btn:hover{color:#fff;border-color:#ffb347;}" +
      "#monitor-panel{position:fixed;bottom:60px;right:14px;z-index:9001;width:min(420px,92vw);" +
        "height:min(360px,60vh);background:#12121c;border:1px solid #3a3a52;border-radius:10px;" +
        "display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.6);overflow:hidden;}" +
      "#monitor-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1a1a2e;" +
        "border-bottom:1px solid #2a2a3e;}" +
      "#monitor-dot{width:8px;height:8px;border-radius:50%;background:#e05252;flex-shrink:0;}" +
      "#monitor-dot.ok{background:#4caf50;}" +
      "#monitor-title{color:#fff;font-size:12px;font-weight:600;flex:1;}" +
      "#monitor-body{flex:1;overflow-y:auto;padding:6px 8px;font-family:monospace;font-size:11px;" +
        "color:#c8d0e0;white-space:pre-wrap;word-break:break-word;}" +
      "#monitor-body div{padding:1px 0;border-bottom:1px solid #1c1c2c;}" +
      "#monitor-foot{display:flex;gap:6px;padding:6px 8px;background:#1a1a2e;border-top:1px solid #2a2a3e;}" +
      "#monitor-foot button{flex:1;font-size:10px;padding:4px 2px;background:#232338;color:#c8d0e0;" +
        "border:1px solid #3a3a52;border-radius:4px;cursor:pointer;}" +
      "#monitor-foot button.on{background:#ffb347;color:#1a1a2e;font-weight:700;}";
    document.head.appendChild(css);

    var btn = document.createElement("button");
    btn.id = "monitor-btn";
    btn.title = "Monitor Serie Virtual";
    btn.innerHTML = "&#128225;";
    btn.onclick = toggle;

    var panel = document.createElement("div");
    panel.id = "monitor-panel";
    panel.innerHTML =
      '<div id="monitor-head">' +
        '<span id="monitor-dot"></span>' +
        '<span id="monitor-title">Monitor Serie Virtual</span>' +
      "</div>" +
      '<div id="monitor-body"></div>' +
      '<div id="monitor-foot">' +
        '<button id="monitor-pause">Pausar</button>' +
        '<button id="monitor-debug">Debug</button>' +
        '<button id="monitor-save">Guardar</button>' +
        '<button id="monitor-clear">Limpiar</button>' +
      "</div>";

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    document.getElementById("monitor-pause").onclick = function () {
      pausado = !pausado;
      this.className = pausado ? "on" : "";
      this.textContent = pausado ? "Reanudar" : "Pausar";
    };
    document.getElementById("monitor-debug").onclick = function () {
      var btnD = this;
      fetch("/monitor/debug?on=" + (btnD.className === "on" ? "0" : "1"))
        .then(function (r) { return r.json(); })
        .then(function (d) { btnD.className = d.debug ? "on" : ""; })
        .catch(function () {});
    };
    document.getElementById("monitor-save").onclick = guardarLog;
    document.getElementById("monitor-clear").onclick = function () {
      mensajes = [];
      document.getElementById("monitor-body").innerHTML = "";
    };
  }

  function toggle() {
    abierto = !abierto;
    document.getElementById("monitor-panel").style.display = abierto ? "flex" : "none";
    if (abierto) { poll(); iniciarPolling(); } else { detenerPolling(); }
  }

  function iniciarPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 1500);
  }
  function detenerPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function poll() {
    fetch("/monitor/log?since=" + lastSeq)
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (d) {
        marcarConexion(true);
        var btnD = document.getElementById("monitor-debug");
        if (btnD) btnD.className = d.debug ? "on" : "";
        if (d.entradas && d.entradas.length) {
          d.entradas.forEach(function (e) {
            lastSeq = Math.max(lastSeq, e.seq);
            agregarLinea(e.msg);
          });
        }
      })
      .catch(function () { marcarConexion(false); });
  }

  function marcarConexion(ok) {
    var dot = document.getElementById("monitor-dot");
    if (dot) dot.className = ok ? "ok" : "";
  }

  function agregarLinea(msg) {
    mensajes.push(msg);
    if (mensajes.length > 500) mensajes.shift();
    var body = document.getElementById("monitor-body");
    if (!body) return;
    var linea = document.createElement("div");
    linea.textContent = msg;
    body.appendChild(linea);
    if (!pausado) body.scrollTop = body.scrollHeight;
  }

  function guardarLog() {
    var txt = mensajes.join("\n");
    var blob = new Blob([txt], { type: "text/plain" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "franky_lab_monitor_" + (contexto || "log") + "_" + Date.now() + ".txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function setContext(nombre) {
    contexto = nombre || "";
    if (document.body) {
      crearUI();
      aplicarTitulo();
      crearBarraEstado();
    } else {
      document.addEventListener("DOMContentLoaded", function () {
        crearUI();
        aplicarTitulo();
        crearBarraEstado();
      });
    }
    // Diagnóstico — PAGE_ENTER (reaprovecha el mismo llamado que ya hace
    // cada página al llamar Monitor.setContext(), sin un fetch aparte).
    fetch("/runtime/pagina?p=" + encodeURIComponent(contexto)).catch(function () {});
  }
  function aplicarTitulo() {
    var t = document.getElementById("monitor-title");
    if (t) t.textContent = "Monitor Serie Virtual" + (contexto ? " — " + contexto : "");
  }

  // ═══════════════════════════════════════════════════════
  //  Errores del navegador — reporte best-effort a /runtime/navegador.
  //  A diferencia del real, NO se encola en localStorage para reintentar
  //  más tarde (el real lo hace porque un ESP32 físico puede estar
  //  momentáneamente inalcanzable en la red WiFi; en el LAB, si
  //  /runtime/navegador no responde, el propio Service Worker está
  //  caído y no hay "más tarde" razonable al que reintentar).
  // ═══════════════════════════════════════════════════════
  window.onerror = function (message, source, lineno) {
    fetch("/runtime/navegador?tipo=BROWSER_ERROR&pagina=" + encodeURIComponent(contexto) +
          "&msg=" + encodeURIComponent(String(message)) +
          (source ? "&fuente=" + encodeURIComponent(source + ":" + lineno) : ""))
      .catch(function () {});
  };

  // ═══════════════════════════════════════════════════════
  //  Barra de estado global — ADAPTADA: usa /api (ya existente en el
  //  LAB) en vez de /runtime/estado (que el real sí tiene, pero el LAB
  //  decidió no duplicar — ver nota de diseño arriba).
  // ═══════════════════════════════════════════════════════
  var estadoTimer = null;

  function crearBarraEstado() {
    if (document.getElementById("franky-estado-badge")) return;
    var css = document.createElement("style");
    css.textContent =
      "#franky-estado-badge{position:fixed;top:8px;right:8px;z-index:8999;" +
        "background:#1a1a2ecc;border:1px solid #3a3a52;border-radius:8px;" +
        "padding:5px 9px;font-family:monospace;font-size:11px;color:#c8d0e0;" +
        "display:flex;align-items:center;gap:6px;box-shadow:0 2px 6px rgba(0,0,0,.35);}" +
      "#franky-estado-dot{width:7px;height:7px;border-radius:50%;background:#666;flex-shrink:0;}" +
      "#franky-estado-dot.activo{background:#ffb347;}" +
      "#franky-estado-dot.espera{background:#4caf50;}" +
      "#franky-estado-txt{line-height:1.3;white-space:pre;}" +
      "#franky-estado-stop{background:#8e1b1b;color:#fff;border:none;border-radius:4px;" +
        "font-size:10px;padding:3px 6px;cursor:pointer;margin-left:2px;}";
    document.head.appendChild(css);

    var badge = document.createElement("div");
    badge.id = "franky-estado-badge";
    badge.innerHTML =
      '<span id="franky-estado-dot"></span>' +
      '<span id="franky-estado-txt">…</span>' +
      '<button id="franky-estado-stop" style="display:none">Detener</button>';
    document.body.appendChild(badge);

    document.getElementById("franky-estado-stop").onclick = function () {
      fetch("/bloques/stop").then(pollEstado).catch(function () {});
    };

    pollEstado();
    estadoTimer = setInterval(pollEstado, 2000);
  }

  function pollEstado() {
    fetch("/api")
      .then(function (r) { return r.json(); })
      .then(function (d) { renderEstado(d); })
      .catch(function () {
        var dot = document.getElementById("franky-estado-dot");
        if (dot) dot.className = "";
        var txt = document.getElementById("franky-estado-txt");
        if (txt) txt.textContent = "● SIN CONEXION";
      });
  }

  function renderEstado(d) {
    var dot = document.getElementById("franky-estado-dot");
    var txt = document.getElementById("franky-estado-txt");
    var stopBtn = document.getElementById("franky-estado-stop");
    if (!dot || !txt) return;
    if (d.running && d.modoTexto === "BLOQUES") {
      var recursos = [];
      if (d.progUsaMotores) recursos.push("MOTORES");
      if (d.progUsaOled) recursos.push("OLED");
      if (d.progUsaSerial) recursos.push("SERIAL");
      dot.className = "activo";
      txt.textContent = "● BLOCKLY EJECUTANDO\n" + (recursos.length ? recursos.join(" + ") : "(sin recursos fisicos)");
      if (stopBtn) stopBtn.style.display = "inline-block";
    } else if (d.running) {
      dot.className = "activo";
      txt.textContent = "● " + (d.modoTexto || "ACTIVO");
      if (stopBtn) stopBtn.style.display = "none";
    } else {
      dot.className = "espera";
      txt.textContent = "● SISTEMA EN ESPERA";
      if (stopBtn) stopBtn.style.display = "none";
    }
  }

  // ═══════════════════════════════════════════════════════
  //  fetch consciente de conflictos de recursos — idéntico al real.
  // ═══════════════════════════════════════════════════════
  var conflictoPendiente = false;

  function fetchConConflicto(url) {
    return fetch(url).then(function (r) {
      if (r.status !== 409) return r;
      return r.json().then(function (d) {
        // CORRECCIÓN: un 409 puede ser un conflicto REAL con Blockly
        // (d.conflicto===true) o un error genérico distinto que también
        // usa 409 por otro motivo — solo el primero dispara el diálogo.
        // El segundo se re-empaqueta tal cual para que el caller lo
        // maneje con su propio manejo de errores (r.ok/r.json()).
        if (!d.conflicto) return new Response(JSON.stringify(d), { status: r.status, headers: { "Content-Type": "application/json" } });
        if (conflictoPendiente) return Promise.reject(new Error("conflicto ya en pantalla"));
        conflictoPendiente = true;
        var msg = (d.mensaje || "Recurso ocupado por Blockly.") +
          "\n\n[Aceptar] = Detener Blockly y continuar\n[Cancelar] = No hacer nada";
        var acepto = window.confirm(msg);
        conflictoPendiente = false;
        if (acepto) {
          var sep = url.indexOf("?") >= 0 ? "&" : "?";
          return fetch(url + sep + "forzar=1").then(function (r2) {
            pollEstado();
            return r2;
          });
        }
        return Promise.reject(new Error("cancelado por el usuario"));
      });
    });
  }

  // ── Versión de página completa, usada por monitor.html ──
  function mostrarPaginaCompleta() {
    crearUI();
    var panel = document.getElementById("monitor-panel");
    var btn = document.getElementById("monitor-btn");
    if (btn) btn.style.display = "none";
    if (panel) {
      panel.style.display = "flex";
      panel.style.position = "static";
      panel.style.width = "100%";
      panel.style.height = "70vh";
      panel.style.margin = "0";
      panel.style.borderRadius = "8px";
    }
    abierto = true;
    poll();
    iniciarPolling();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!document.getElementById("monitor-btn")) crearUI();
    crearBarraEstado();
  });

  return {
    setContext: setContext,
    fetchConConflicto: fetchConConflicto,
    mostrarPaginaCompleta: mostrarPaginaCompleta
  };
})();
