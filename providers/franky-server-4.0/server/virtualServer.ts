/**
 * FRANKY LAB — Provider franky-server-4.0 / Virtual Server
 *
 * SOLO forma HTTP (ADR-003 §3): parsea query/body, arma comandos de
 * dominio, se los pasa a FirmwareRuntime, y traduce el resultado a
 * HttpResponse. Para endpoints de lectura, consulta FirmwareModel
 * directamente. Nunca decide de negocio acá.
 */
import { VirtualServerEngine } from "../../../core/src/virtualServerEngine.js";
import { ProviderServer, HttpResponse, Query } from "../../../core/src/providerContract.js";
import { RobotHAL } from "../../../core/src/robotHal.js";
import { FirmwareRuntime, ConfigureSumoInput } from "../firmware/runtime.js";
import { defaultFirmwareModel, RobotMode } from "../firmware/model.js";
import { contarADCUsados } from "../firmware/validation.js";

function toInt(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}
function ok(): HttpResponse { return { status: 200, body: "OK", contentType: "text/plain" }; }
function json(status: number, body: unknown): HttpResponse { return { status, body, contentType: "application/json" }; }

export function createProviderServer(hal: RobotHAL): ProviderServer {
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
      pwmA: m.pwmA, pwmB: m.pwmB, trimA: m.trimA, trimB: m.trimB, motorSpeed: m.motorSpeed,
      adc_used: adcUsed, adc_avail: 2 - adcUsed,
      sharp_adc_i: m.sharpAdcValI, sharp_adc_d: m.sharpAdcValD,
      sharp_det_i: m.sharpDetI ? 1 : 0, sharp_det_d: m.sharpDetD ? 1 : 0,
      s_perfil: cfg.perfil, s_tipo: cfg.tipoDistSensor, s_nds: cfg.numDistSensores, s_nb: cfg.numBorde,
      s_udist: cfg.umbralDistCm, s_usharp: cfg.umbralSharp, s_uborde: cfg.umbralBorde,
      s_atk: cfg.spdAtaque, s_bex: cfg.spdBuscExt, s_bin: cfg.spdBuscInt, s_ev: cfg.spdEvasion, s_est: cfg.estrategia,
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
    const perfil: "micro" | "mini" =
      p.modo !== undefined ? (p.modo === "micro" ? "micro" : "mini")
      : p.perfil !== undefined ? (toInt(p.perfil) === 1 ? "micro" : "mini") : "mini";
    const input: ConfigureSumoInput = {
      perfil,
      tipo: p.tipo as ConfigureSumoInput["tipo"],
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
      spdBuscExt: p.spdBuscExt !== undefined ? toInt(p.spdBuscExt) : undefined,
      spdBuscInt: p.spdBuscInt !== undefined ? toInt(p.spdBuscInt) : undefined,
      spdEvasion: p.spdEvasion !== undefined ? toInt(p.spdEvasion) : undefined,
      circuloExt: p.circuloExt !== undefined ? toInt(p.circuloExt) : undefined,
      circuloInt: p.circuloInt !== undefined ? toInt(p.circuloInt) : undefined,
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

  engine.registerRoute("/bloques/add", (q) => {
    const r = runtime.bloquesAdd(toInt(q.op), toInt(q.val), typeof q.txt === "string" ? q.txt : undefined);
    return r.ok ? ok() : { status: 400, body: r.error!, contentType: "text/plain" };
  });
  engine.registerRoute("/bloques/del", (q) => { runtime.bloquesDel(toInt(q.idx)); return ok(); });
  engine.registerRoute("/bloques/run", () => { runtime.bloquesRun(); return ok(); });
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
    const p: Query = method === "POST" ? { ...q, ...b } : q;
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
