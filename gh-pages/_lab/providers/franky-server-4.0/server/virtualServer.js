/**
 * FRANKY LAB — Provider franky-server-4.0 / Virtual Server
 *
 * SOLO forma HTTP (ADR-003 §3): parsea query/body, arma comandos de
 * dominio, se los pasa a FirmwareRuntime, y traduce el resultado a
 * HttpResponse. Para endpoints de lectura, consulta FirmwareModel
 * directamente. Nunca decide de negocio acá.
 */
import { VirtualServerEngine } from "../../../core/src/virtualServerEngine.js";
import { FirmwareRuntime } from "../firmware/runtime.js";
import { defaultFirmwareModel, RobotMode } from "../firmware/model.js";
import { contarADCUsados } from "../firmware/validation.js";
import { velExterna, velInterna, direccionTexto } from "../firmware/sumoEngine.js";
function toInt(v) {
    if (v === undefined)
        return 0;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
}
function ok() { return { status: 200, body: "OK", contentType: "text/plain" }; }
function json(status, body) { return { status, body, contentType: "application/json" }; }
export function createProviderServer(hal) {
    const model = defaultFirmwareModel();
    const runtime = new FirmwareRuntime(model, hal);
    const engine = new VirtualServerEngine();
    engine.registerRoute("/api", () => {
        runtime.refreshTelemetry();
        const m = model;
        const cfg = runtime.cfgActiva();
        const adcUsed = contarADCUsados(cfg);
        return json(200, {
            a0: hal.analogRead(0), a1: m.spiEnabled ? 0 : hal.analogRead(1), btn: hal.digitalRead(9) ? 1 : 0,
            temp: Number(m.sensorTemp.toFixed(2)), hum: Number(m.sensorHum.toFixed(2)),
            mode: m.currentMode, running: m.modeRunning ? 1 : 0, proglen: m.programa.length,
            i2c: m.i2cEnabled ? 1 : 0, spi: m.spiEnabled ? 1 : 0, dht: m.dhtOK ? 1 : 0,
            i2c_sda: m.i2cSda, i2c_scl: m.i2cScl,
            oled_det: m.oled.panelDetectado ? 1 : 0, oled_w: m.oled.panelAncho, oled_h: m.oled.panelAlto,
            ...runtime.resumenRecursos(),
            pwmA: m.pwmA, pwmB: m.pwmB, trimA: m.trimA, trimB: m.trimB, motorSpeed: m.motorSpeed,
            adc_used: adcUsed, adc_avail: 2 - adcUsed,
            sharp_adc_i: m.sharpAdcValI, sharp_adc_d: m.sharpAdcValD,
            sharp_det_i: m.sharpDetI ? 1 : 0, sharp_det_d: m.sharpDetD ? 1 : 0,
            s_perfil: cfg.perfil, s_tipo: cfg.tipoDistSensor, s_nds: cfg.numDistSensores, s_nb: cfg.numBorde,
            s_udist: cfg.umbralDistCm, s_usharp: cfg.umbralSharp, s_uborde: cfg.umbralBorde,
            s_atk: cfg.spdAtaque,
            // FASE "CIERRE SUMO" — s_vel/s_int/s_dur son los campos primarios
            // (abstracción pedagógica); s_bex/s_bin se mantienen RECONSTRUIDOS
            // (nunca leídos de un campo que ya no existe en el struct) por si
            // alguna página vieja en caché todavía los espera.
            s_vel: cfg.velBusqueda, s_int: cfg.intGiro, s_dur: cfg.durBarrido,
            s_bex: velExterna(cfg), s_bin: velInterna(cfg),
            s_ev: cfg.spdEvasion, s_est: cfg.estrategia,
            // Memoria de última dirección del oponente (observable explícitamente).
            s_dir: m.ultimaDirOponente, s_dirTxt: direccionTexto(m.ultimaDirOponente),
        });
    });
    engine.registerRoute("/debug", () => ({
        status: 200, contentType: "text/plain",
        body: [
            "=== FRANKY LAB Servidor Virtual ===", "FW: v3.2-LNR (virtual)",
            `TrimA: ${model.trimA}`, `TrimB: ${model.trimB}`,
            `Mini: tipo=${model.cfgMini.tipoDistSensor} nds=${model.cfgMini.numDistSensores} nb=${model.cfgMini.numBorde}`,
        ].join("\n"),
    }));
    engine.registerRoute("/bloques/list", () => json(200, model.programa));
    engine.registerRoute("/mv", (q) => { runtime.moveManual(q.d ?? ""); return ok(); });
    engine.registerRoute("/st", () => { runtime.stopMotors(); return ok(); });
    engine.registerRoute("/spd", (q) => { runtime.setSpeed(toInt(q.val)); return ok(); });
    engine.registerRoute("/stopall", () => {
        runtime.stopAll();
        return { status: 303, body: null, contentType: "text/plain", location: "/" };
    });
    engine.registerRoute("/sumo/config", (q, b, method) => {
        const p = method === "POST" ? { ...q, ...b } : q;
        const perfil = p.modo !== undefined ? (p.modo === "micro" ? "micro" : "mini")
            : p.perfil !== undefined ? (toInt(p.perfil) === 1 ? "micro" : "mini") : "mini";
        const input = {
            perfil,
            tipo: p.tipo,
            numDist: p.numDist !== undefined ? toInt(p.numDist) : undefined,
            trigI: p.trigI !== undefined ? toInt(p.trigI) : undefined,
            echoI: p.echoI !== undefined ? toInt(p.echoI) : undefined,
            trigD: p.trigD !== undefined ? toInt(p.trigD) : undefined,
            echoD: p.echoD !== undefined ? toInt(p.echoD) : undefined,
            optI: p.optI !== undefined ? toInt(p.optI) : undefined,
            optD: p.optD !== undefined ? toInt(p.optD) : undefined,
            sharpI: p.sharpI !== undefined ? toInt(p.sharpI) : undefined,
            sharpD: p.sharpD !== undefined ? toInt(p.sharpD) : undefined,
            umbralSharp: p.umbral_sharp !== undefined ? toInt(p.umbral_sharp) : undefined,
            numBorde: p.numBorde !== undefined ? toInt(p.numBorde) : undefined,
            bordeI: p.bordeI !== undefined ? toInt(p.bordeI) : undefined,
            bordeD: p.bordeD !== undefined ? toInt(p.bordeD) : undefined,
            umbralDist: p.umbral_dist !== undefined ? toInt(p.umbral_dist) : undefined,
            umbralDistMini: p.umbral_dist_mini !== undefined ? toInt(p.umbral_dist_mini) : undefined,
            umbralBorde: p.umbral_borde !== undefined ? toInt(p.umbral_borde) : undefined,
            umbralBordeMini: p.umbral_borde_mini !== undefined ? toInt(p.umbral_borde_mini) : undefined,
            spdAtaque: p.spdAtaque !== undefined ? toInt(p.spdAtaque) : undefined,
            velBusqueda: p.velBusqueda !== undefined ? toInt(p.velBusqueda) : undefined,
            intGiro: p.intGiro !== undefined ? toInt(p.intGiro) : undefined,
            spdBuscExt: p.spdBuscExt !== undefined ? toInt(p.spdBuscExt) : undefined,
            spdBuscInt: p.spdBuscInt !== undefined ? toInt(p.spdBuscInt) : undefined,
            spdEvasion: p.spdEvasion !== undefined ? toInt(p.spdEvasion) : undefined,
            circuloExt: p.circuloExt !== undefined ? toInt(p.circuloExt) : undefined,
            circuloInt: p.circuloInt !== undefined ? toInt(p.circuloInt) : undefined,
            durBarrido: p.durBarrido !== undefined ? toInt(p.durBarrido) : undefined,
            estrategia: p.estrategia !== undefined ? toInt(p.estrategia) : undefined,
        };
        const result = runtime.configureSumo(input);
        return result.ok ? json(200, { ok: true }) : json(400, { ok: false, error: result.error });
    });
    engine.registerRoute("/sumo/trim", (q) => {
        runtime.setTrim(q.ma !== undefined ? toInt(q.ma) : undefined, q.mb !== undefined ? toInt(q.mb) : undefined);
        return ok();
    });
    engine.registerRoute("/sumo/micro", () => { runtime.startSumo("micro"); return ok(); });
    engine.registerRoute("/sumo/mini", () => { runtime.startSumo("mini"); return ok(); });
    engine.registerRoute("/sumo/stop", () => { runtime.stopSumo(); return ok(); });
    engine.registerRoute("/sumo/umbral", () => ok());
    // ---- Proyecto FRANKY (.franky) ----
    engine.registerRoute("/proyecto/export", () => {
        const r = runtime.exportProyecto();
        return r.ok ? json(200, r.data) : json(500, { ok: false, error: r.error });
    });
    engine.registerRoute("/proyecto/import", (q, b, method) => {
        // Mismo convenio que el firmware real (server.arg("plain")): el
        // cuerpo completo del archivo .franky viaja como texto plano en la
        // clave "plain" — Core solo conoce Query (Record<string,string>),
        // así que no hace falta tocar el contrato de ProviderServer/Core
        // para aceptar un body JSON completo.
        if (method !== "POST" || !b.plain || b.plain.length === 0) {
            return json(400, { ok: false, error: "Cuerpo de la peticion vacio (se espera el JSON del archivo .franky)" });
        }
        if (b.plain.length > 49152) {
            return json(413, { ok: false, error: "Archivo demasiado grande (maximo 48KB)" });
        }
        let parsed;
        try {
            parsed = JSON.parse(b.plain);
        }
        catch {
            return json(400, { ok: false, error: "El cuerpo no es JSON valido" });
        }
        const r = runtime.importProyecto(parsed);
        return r.ok ? json(200, { ok: true, blockly: r.data }) : json(400, { ok: false, error: r.error });
    });
    engine.registerRoute("/bloques/add", (q) => {
        const r = runtime.bloquesAdd(toInt(q.op), toInt(q.val), typeof q.txt === "string" ? q.txt : undefined, typeof q.bitmap === "string" ? q.bitmap : undefined);
        return r.ok ? ok() : { status: 400, body: r.error, contentType: "text/plain" };
    });
    engine.registerRoute("/bloques/del", (q) => { runtime.bloquesDel(toInt(q.idx)); return ok(); });
    engine.registerRoute("/bloques/run", () => {
        const r = runtime.bloquesRun();
        return r.ok ? ok() : json(400, { ok: false, error: r.error });
    });
    engine.registerRoute("/bloques/stop", () => { runtime.bloquesStop(); return ok(); });
    engine.registerRoute("/bloques/clear", () => { runtime.bloquesClear(); return ok(); });
    engine.registerRoute("/auto/vivero", () => { runtime.autoSet(RobotMode.VIVERO); return ok(); });
    engine.registerRoute("/auto/meteo", () => { runtime.autoSet(RobotMode.METEO); return ok(); });
    engine.registerRoute("/auto/alarma", () => { runtime.autoAlarmaReset(); runtime.autoSet(RobotMode.ALARMA); return ok(); });
    engine.registerRoute("/auto/alarma/reset", () => { runtime.autoAlarmaReset(); return ok(); });
    engine.registerRoute("/auto/acceso", () => { runtime.autoSet(RobotMode.ACCESO); return ok(); });
    engine.registerRoute("/auto/stop", () => { runtime.autoStop(); return ok(); });
    engine.registerRoute("/panel/config", () => ({ status: 302, body: null, contentType: "text/plain", location: "/panel_config.html" }));
    engine.registerRoute("/panel/save", (q, b, method) => {
        const p = method === "POST" ? { ...q, ...b } : q;
        runtime.panelSave(p.i2c !== undefined, p.spi !== undefined);
        return { status: 200, body: "OK. Reiniciando...", contentType: "text/plain" };
    });
    engine.registerRoute("/led/on", () => { runtime.ledOn(); return ok(); });
    engine.registerRoute("/led/off", () => { runtime.ledOff(); return ok(); });
    engine.registerRoute("/led/brillo", (q) => { runtime.ledBrillo(toInt(q.val)); return ok(); });
    engine.registerRoute("/gpio/out", (q) => {
        const r = runtime.gpioOut(toInt(q.pin), toInt(q.val));
        return r.ok ? ok() : { status: 400, body: r.error, contentType: "text/plain" };
    });
    engine.registerRoute("/gpio/read", (q) => {
        const r = runtime.gpioRead(toInt(q.pin));
        return r.ok ? json(200, r.data) : { status: 400, body: r.error, contentType: "text/plain" };
    });
    engine.registerRoute("/sonar/read", () => { const r = runtime.sonarRead(); return json(200, r.ok ? r.data : { cm: 999 }); });
    engine.registerRoute("/sonar/stop", () => ok());
    engine.registerRoute("/dht/pin", () => ok());
    // ---- GPIO / I2C (Fase GPIO/I2C) ----
    engine.registerRoute("/gpio/estado", () => json(200, runtime.gpioEstado()));
    engine.registerRoute("/i2c/set", (q, b, method) => {
        const p = method === "POST" ? { ...q, ...b } : q;
        if (p.sda === undefined || p.scl === undefined) {
            return json(400, { ok: false, error: "Faltan parametros sda/scl" });
        }
        const r = runtime.setI2CPins(toInt(p.sda), toInt(p.scl));
        // DIFERENCIA DOCUMENTADA: el firmware real responde texto plano "OK.
        // Reiniciando..." y hace ESP.restart() — el LAB aplica en caliente
        // (sin reinicio, confirmado explícitamente) y responde de inmediato.
        return r.ok
            ? { status: 200, body: "OK. Aplicado (sin reinicio — LAB virtual).", contentType: "text/plain" }
            : json(409, { ok: false, error: r.error });
    });
    engine.registerRoute("/i2c/scan", () => {
        const r = runtime.i2cScan();
        // Sin hardware I2C simulado (decisión confirmada): nunca inventa
        // direcciones ni dispositivos — solo puede confirmar si el bus está
        // habilitado o no.
        return r.ok ? json(200, r.data) : json(400, { ok: false, error: r.error }); // 400: error comun (no confundir con 409=conflicto real con Blockly
    });
    // ---- Monitor Serie Virtual (Fase MONITOR/DEBUG) ----
    engine.registerRoute("/monitor/log", (q) => {
        // NOTA (hallazgo real, ver monitor.selfTest.ts sección 1b): el .ino
        // real usa "since=0" como default y compara "seq <= since", lo que
        // deja la entrada seq=0 permanentemente invisible a cualquier
        // polling que nunca pase "since" explícito. Acá se replica la MISMA
        // fórmula de comparación (fidelidad), pero el default cuando el
        // cliente no manda "since" es -1 en vez de 0, para que la primera
        // llamada sin parámetros sí traiga todo el buffer — decisión de
        // implementación del LAB, no un cambio de la fórmula real.
        const since = q.since !== undefined ? toInt(q.since) : -1;
        return json(200, runtime.monitorLog(since));
    });
    engine.registerRoute("/monitor/debug", (q, b, method) => {
        const p = method === "POST" ? { ...q, ...b } : q;
        const on = p.on !== undefined ? p.on === "1" : undefined;
        return json(200, runtime.monitorDebug(on));
    });
    // Réplica REDUCIDA Y HONESTA de /log real (ver monitor.ts) — texto plano.
    // CORRECCIÓN (navegación): /log real es texto plano puro, sin forma de
    // volver — en el LAB (aplicación web) eso deja al usuario "atrapado".
    // Mismo criterio ya aplicado a I2C: se envuelve en un HTML mínimo con
    // un botón Volver, sin tocar el contenido de logTexto() (idéntico).
    engine.registerRoute("/log", () => {
        const texto = runtime.logTexto();
        const escapado = texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const htmlPagina = '<!doctype html><html lang="es"><head><meta charset="UTF-8">' +
            "<title>FRANKY LAB - Log</title>" +
            "<style>body{background:#0d0d14;color:#c8d0e0;font-family:monospace;padding:16px;}" +
            "pre{white-space:pre-wrap;word-break:break-word;font-size:12px;}" +
            "a.volver{display:inline-block;margin-bottom:12px;padding:8px 16px;background:#e05a00;" +
            "color:#fff;text-decoration:none;border-radius:6px;font-family:sans-serif;font-size:13px;font-weight:700;}</style>" +
            '</head><body><a class="volver" href="index.html">&#8962; Volver</a><pre>' + escapado + "</pre></body></html>";
        return { status: 200, body: htmlPagina, contentType: "text/html" };
    });
    // ---- Diagnóstico de cliente (Sesión 1, auditoría Server-vs-LAB) ----
    engine.registerRoute("/runtime/pagina", (q) => {
        runtime.runtimePagina(typeof q.p === "string" ? q.p : "?");
        return { status: 200, body: "OK", contentType: "text/plain" };
    });
    engine.registerRoute("/runtime/navegador", (q) => {
        runtime.runtimeNavegador(typeof q.tipo === "string" ? q.tipo : "?", typeof q.pagina === "string" ? q.pagina : "?", typeof q.msg === "string" ? q.msg : "");
        return { status: 200, body: "OK", contentType: "text/plain" };
    });
    // ---- "Programa Fuente" virtual (Sesión 1, auditoría Server-vs-LAB) ----
    engine.registerRoute("/bloques/xml", (q, b, method) => {
        if (method === "POST") {
            const p = { ...q, ...b };
            if (typeof p.plain !== "string" || p.plain.length === 0) {
                return json(400, { ok: false, error: "Cuerpo vacio (se espera el XML de Blockly en 'plain')" });
            }
            const hash = p.hash !== undefined ? toInt(p.hash) : 0;
            const r = runtime.bloquesXmlSet(p.plain, hash);
            return r.ok ? ok() : json(400, { ok: false, error: r.error });
        }
        return json(200, runtime.bloquesXmlGet());
    });
    engine.registerRoute("/bloques/marcarFuente", (q) => {
        if (q.hash === undefined)
            return json(400, { ok: false, error: "Falta el parametro hash" });
        runtime.bloquesMarcarFuente(toInt(q.hash));
        return ok();
    });
    // ---- Panel Industrial: OLED (Sesión 1, auditoría Server-vs-LAB) ----
    engine.registerRoute("/oled/test", (q) => {
        const size = q.size === "91" ? "91" : "96";
        const forzar = q.forzar === "1";
        const r = runtime.oledTest(size, forzar);
        if (!r.ok && "conflicto" in r)
            return json(409, { conflicto: true, recurso: "oled", mensaje: r.mensaje });
        return r.ok ? json(200, r.data) : json(400, { ok: false, error: r.error }); // 400: error comun (no confundir con 409=conflicto real con Blockly
    });
    engine.registerRoute("/oled/clear", (q) => {
        const r = runtime.oledClear(q.forzar === "1");
        if (!r.ok && "conflicto" in r)
            return json(409, { conflicto: true, recurso: "oled", mensaje: r.mensaje });
        return r.ok ? ok() : json(400, { ok: false, error: r.error }); // 400: error comun (no confundir con 409=conflicto real con Blockly
    });
    engine.registerRoute("/oled/logo", (q) => {
        const r = runtime.oledLogo(q.forzar === "1");
        if (!r.ok && "conflicto" in r)
            return json(409, { conflicto: true, recurso: "oled", mensaje: r.mensaje });
        return r.ok ? ok() : json(400, { ok: false, error: r.error }); // 400: error comun (no confundir con 409=conflicto real con Blockly
    });
    // Exclusivo de FRANKY LAB — no existe en el firmware real. Alimenta el
    // Workspace de visualización del Robot Virtual.
    engine.registerRoute("/lab/state", () => json(200, runtime.getLabTelemetry()));
    return {
        handle: (method, path, query, body) => engine.dispatch(method, path, query, body ?? {}),
        tick: () => runtime.tick(),
        getLiveState: () => runtime.getLabTelemetry(),
        setDigitalInput: (pin, value) => hal.digitalWrite(pin, value),
        getActiveSensorConfig: () => {
            const cfg = runtime.cfgActiva();
            return {
                tipo: cfg.tipoDistSensor,
                numDist: cfg.numDistSensores,
                sharpPinI: cfg.sharpPinI,
                sharpPinD: cfg.sharpPinD,
                echoI: cfg.echoI,
                echoD: cfg.echoD,
                numBorde: cfg.numBorde,
                bordePinI: cfg.bordePinI,
                bordePinD: cfg.bordePinD,
            };
        },
        getCombatTiming: () => ({ tInicioModo: model.tInicioModo, retardoOK: model.retardoOK }),
    };
}
