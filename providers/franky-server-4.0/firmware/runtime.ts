/**
 * FRANKY LAB — Provider franky-server-4.0 / Firmware Runtime
 *
 * Lógica de negocio del firmware v3.2-LNR. API de DOMINIO (nunca query
 * params, nunca códigos HTTP, ADR-003 §3) — la única autorizada a mutar
 * FirmwareModel. Lee/escribe MCU (RobotHAL) para sensores/motores.
 *
 * Mapeo de pines de motor confirmado contra boards/franky-board-4x/manifest.json
 * (GPIO5=motor izq fwd, GPIO4=motor izq rev, GPIO3=motor der fwd, GPIO2=motor der rev).
 * TODO (deuda reconocida, no bloqueante): leer esto del manifest de Board en
 * vez de hardcodearlo acá — hoy hay un único Board real, se resuelve cuando
 * aparezca el segundo.
 */
import { RobotHAL } from "../../../core/src/robotHal.js";
import { CommandResult } from "../../../core/src/providerContract.js";
import {
  FirmwareModel,
  RobotMode,
  EvadeState,
  SumoConfig,
  TipoDistSensor,
  MAX_INST,
  TABLA_BITMAP_MAX,
  GpioMotivo,
} from "./model.js";
import { validateSumoADC, contarADCUsados } from "./validation.js";
import { ejecutarSumo, leerBordeIzq, leerBordeDer, leerOponente, reiniciarMemoriaSumo, velExterna, velInterna } from "./sumoEngine.js";
import { generarProyectoJson, validarProyectoImport, ProyectoError } from "./proyecto.js";
import {
  pinBloqueadoPorBus,
  gpioSincronizarBuses,
  gpioAplicarReservasSumoActivo,
  gpioLiberarPorMotivo,
  aplicarI2C,
  gpioEstadoSnapshot,
  GpioEstadoPin,
} from "./gpio.js";
import { flog, flogThrottle, modoTexto, generarMonitorLogJson, generarLogTexto, MonitorLogResponse } from "./monitor.js";
import { progUsaOled, progUsaMotores, progUsaSerial, hayConflictoRecurso } from "./recursos.js";
import { LOGO_MDE_128x64_HEX, LOGO_MDE_128x32_HEX } from "./model.js";
import { moveDirLetter, stopMotorsShared, PIN } from "./motorControl.js";

function constrain(val: number, lo: number, hi: number): number {
  if (Number.isNaN(val)) return lo;
  return Math.max(lo, Math.min(hi, val));
}

/** Pop seguro de la pila de trabajo — 0 si está vacía (programa mal formado), nunca revienta. */
function popStack(m: FirmwareModel): number {
  const v = m.pila.pop();
  return v !== undefined ? v : 0;
}

export interface ConfigureSumoInput {
  perfil: "micro" | "mini";
  tipo?: "sonar" | "optico" | "sharp";
  numDist?: number;
  trigI?: number; echoI?: number; trigD?: number; echoD?: number;
  optI?: number; optD?: number;
  sharpI?: number; sharpD?: number; umbralSharp?: number;
  numBorde?: number; bordeI?: number; bordeD?: number;
  umbralDist?: number; umbralDistMini?: number;
  umbralBorde?: number; umbralBordeMini?: number;
  spdAtaque?: number; spdEvasion?: number;
  // FASE "CIERRE SUMO" — velBusqueda/intGiro son los nombres PRIMARIOS.
  // spdBuscExt/spdBuscInt/circuloExt/circuloInt se siguen aceptando por
  // compatibilidad con cualquier página cacheada que todavía los use —
  // si llegan ambos estilos en la misma petición, gana el nuevo (misma
  // regla que handleSumoConfig() real).
  velBusqueda?: number; intGiro?: number;
  spdBuscExt?: number; spdBuscInt?: number;
  circuloExt?: number; circuloInt?: number;
  durBarrido?: number;
  estrategia?: number;
}

export class FirmwareRuntime {
  constructor(
    public readonly model: FirmwareModel,
    private hal: RobotHAL,
  ) {
    // Réplica de la secuencia real de setup(): las reservas de fábrica ya
    // vienen aplicadas por defaultFirmwareModel() (gpioInicializarReservasDeFabrica
    // equivalente, ver model.ts) — acá se sincronizan los buses dinámicos
    // y el perfil activo, igual que gpioSincronizarBuses()+
    // gpioAplicarReservasSumoActivo() al final de setup() real.
    gpioSincronizarBuses(this.model);
    gpioAplicarReservasSumoActivo(this.model, this.cfgActiva());
  }

  /** Debe llamarse en cada frame (equivalente a loop() del firmware real). */
  tick(): void {
    const cfg = this.cfgActiva();
    if (this.model.currentMode === RobotMode.MICRO || this.model.currentMode === RobotMode.MINI) {
      ejecutarSumo(this.model, this.hal, cfg);
    }
    if (this.model.currentMode === RobotMode.BLOQUES && this.model.modeRunning) {
      this.tickBloques();
    }
    if (this.model.currentMode === RobotMode.ACCESO) {
      // Réplica de loopAcceso() real (.ino línea 696): botón LOW abre el acceso.
      if (!this.model.accesoAbierto && this.hal.digitalRead(PIN.boton) === 0) {
        this.model.accesoAbierto = true;
      }
    }
  }

  // ---- Movimiento manual ----
  moveManual(direction: string): CommandResult {
    this.exitAutoModeOnManualCommand();
    moveDirLetter(this.model, this.hal, direction, this.model.motorSpeed);
    return { ok: true, data: undefined };
  }

  stopMotors(): CommandResult {
    stopMotorsShared(this.model, this.hal);
    return { ok: true, data: undefined };
  }

  setSpeed(value: number): CommandResult {
    this.model.motorSpeed = value;
    return { ok: true, data: undefined };
  }

  stopAll(): CommandResult {
    this.model.currentMode = RobotMode.IDLE;
    this.model.modeRunning = false;
    this.model.evadeState = EvadeState.IDLE;
    this.stopMotors();
    return { ok: true, data: undefined };
  }

  // ---- Sumo ----
  configureSumo(input: ConfigureSumoInput): CommandResult {
    const key = input.perfil;
    const cfg: SumoConfig = { ...(key === "micro" ? this.model.cfgMicro : this.model.cfgMini) };

    if (input.tipo === "sonar") cfg.tipoDistSensor = TipoDistSensor.SONAR;
    else if (input.tipo === "optico") cfg.tipoDistSensor = TipoDistSensor.OPTICO;
    else if (input.tipo === "sharp") cfg.tipoDistSensor = TipoDistSensor.SHARP;

    if (input.numDist !== undefined) cfg.numDistSensores = constrain(input.numDist, 1, 2) as 1 | 2;
    if (input.trigI !== undefined) cfg.trigI = input.trigI;
    if (input.echoI !== undefined) cfg.echoI = input.echoI;
    if (input.trigD !== undefined) cfg.trigD = input.trigD;
    if (input.echoD !== undefined) cfg.echoD = input.echoD;
    if (input.optI !== undefined) cfg.optPinI = input.optI;
    if (input.optD !== undefined) cfg.optPinD = input.optD;
    if (input.sharpI !== undefined) cfg.sharpPinI = constrain(input.sharpI, 0, 1) as 0 | 1;
    if (input.sharpD !== undefined) cfg.sharpPinD = constrain(input.sharpD, 0, 1) as 0 | 1;
    if (input.umbralSharp !== undefined) cfg.umbralSharp = constrain(input.umbralSharp, 100, 4095);
    if (input.numBorde !== undefined) cfg.numBorde = constrain(input.numBorde, 0, 2) as 0 | 1 | 2;
    if (input.bordeI !== undefined) cfg.bordePinI = constrain(input.bordeI, 0, 1) as 0 | 1;
    if (input.bordeD !== undefined) cfg.bordePinD = constrain(input.bordeD, 0, 1) as 0 | 1;
    if (input.umbralDist !== undefined) cfg.umbralDistCm = constrain(input.umbralDist, 2, 200);
    if (input.umbralDistMini !== undefined) cfg.umbralDistCm = constrain(input.umbralDistMini, 2, 200);
    if (input.umbralBorde !== undefined) cfg.umbralBorde = constrain(input.umbralBorde, 100, 4095);
    if (input.umbralBordeMini !== undefined) cfg.umbralBorde = constrain(input.umbralBordeMini, 100, 4095);
    if (input.spdAtaque !== undefined) cfg.spdAtaque = constrain(input.spdAtaque, 0, 255);

    // FASE "CIERRE SUMO" — misma lógica de compatibilidad que
    // handleSumoConfig() real: velBusqueda/intGiro son primarios; si en
    // la misma petición llegan también nombres viejos (spdBuscExt/
    // spdBuscInt/circuloExt/circuloInt), se usan solo para los campos
    // que NO vinieron ya en formato nuevo.
    const tieneVelNueva = input.velBusqueda !== undefined;
    const tieneIntNueva = input.intGiro !== undefined;
    if (tieneVelNueva) cfg.velBusqueda = constrain(input.velBusqueda!, 0, 255);
    if (tieneIntNueva) cfg.intGiro = constrain(input.intGiro!, 0, 255);
    const extViejoRaw = input.spdBuscExt !== undefined ? input.spdBuscExt : input.circuloExt;
    const intViejoRaw = input.spdBuscInt !== undefined ? input.spdBuscInt : input.circuloInt;
    if (extViejoRaw !== undefined || intViejoRaw !== undefined) {
      const extViejo = extViejoRaw !== undefined ? constrain(extViejoRaw, 0, 255) : velExterna(cfg);
      const intViejo = intViejoRaw !== undefined ? constrain(intViejoRaw, 0, 255) : velInterna(cfg);
      if (!tieneVelNueva) cfg.velBusqueda = Math.floor((extViejo + intViejo) / 2);
      if (!tieneIntNueva) cfg.intGiro = extViejo >= intViejo ? extViejo - intViejo : 0;
    }

    if (input.spdEvasion !== undefined) cfg.spdEvasion = constrain(input.spdEvasion, 0, 255);
    if (input.estrategia !== undefined) cfg.estrategia = constrain(input.estrategia, 0, 1) as 0 | 1;
    // "Duración del barrido" — se acepta para cualquier perfil (si se
    // manda para Micro, queda guardado sin uso — mismo criterio que
    // "estrategia" en Micro).
    if (input.durBarrido !== undefined) cfg.durBarrido = constrain(input.durBarrido, 50, 3000);

    if (!validateSumoADC(cfg)) {
      return { ok: false, error: `ADC limit exceeded: need ${contarADCUsados(cfg)} ADC pins, only 2 available` };
    }
    // FASE GPIO/I2C — liberar la reserva SENSOR_SUMO que la propia config
    // ya tenía puesta desde la última vez que se activó este perfil ANTES
    // de validar, para que un perfil no se bloquee a sí mismo (mismo
    // fix real: "sus propios pines ocupados por su propia reserva
    // anterior" tiraba conflicto aunque nada más los estuviera usando).
    gpioLiberarPorMotivo(this.model, GpioMotivo.SENSOR_SUMO);
    if (cfg.tipoDistSensor === TipoDistSensor.SONAR) {
      const conflict =
        pinBloqueadoPorBus(this.model, cfg.trigI) ||
        pinBloqueadoPorBus(this.model, cfg.echoI) ||
        (cfg.numDistSensores >= 2 &&
          (pinBloqueadoPorBus(this.model, cfg.trigD) || pinBloqueadoPorBus(this.model, cfg.echoD)));
      if (conflict) {
        gpioAplicarReservasSumoActivo(this.model, this.cfgActiva()); // restaurar la reserva del perfil realmente activo antes de salir con error
        return { ok: false, error: "GPIO conflict: sonar pin used by active I2C/SPI bus" };
      }
    }
    if (cfg.tipoDistSensor === TipoDistSensor.OPTICO) {
      const conflict =
        pinBloqueadoPorBus(this.model, cfg.optPinI) ||
        (cfg.numDistSensores >= 2 && pinBloqueadoPorBus(this.model, cfg.optPinD));
      if (conflict) {
        gpioAplicarReservasSumoActivo(this.model, this.cfgActiva()); // ídem
        return { ok: false, error: "GPIO conflict: optical pin used by active I2C/SPI bus" };
      }
    }

    if (key === "micro") this.model.cfgMicro = cfg;
    else this.model.cfgMini = cfg;
    // Fase 4.2 real: resincroniza reservas al guardar — reserva los
    // pines del perfil REALMENTE activo (sea el que se acaba de editar o
    // no; this.cfgActiva() ya lee el valor recién commiteado si coincide).
    gpioAplicarReservasSumoActivo(this.model, this.cfgActiva());
    return { ok: true, data: undefined };
  }

  /**
   * Réplica de handleSumoMicro()/handleSumoMini() reales: siempre usa el
   * perfil YA activo tal cual está — nunca reconstruye configuración.
   * Compartida por ambos puntos de entrada reales (servidor y botón),
   * cada uno con SU propio gate — ver startSumo()/pulsarBotonSumo().
   */
  private iniciarSumoInterno(which: "micro" | "mini"): CommandResult {
    const modoAnterior = this.model.currentMode;
    this.model.cfgActivaKey = which;
    this.model.currentMode = which === "micro" ? RobotMode.MICRO : RobotMode.MINI;
    this.model.modeRunning = true;
    this.model.retardoOK = false;
    this.model.tInicioModo = this.hal.millis();
    this.model.evadeState = EvadeState.IDLE;
    reiniciarMemoriaSumo(this.model); // un combate nuevo no hereda la "última dirección" del anterior
    gpioAplicarReservasSumoActivo(this.model, this.cfgActiva()); // Fase 4.2 real: resincroniza reservas al cambiar de perfil activo
    if (modoAnterior !== this.model.currentMode) {
      // FASE MONITOR/DEBUG (punto 1 de la lista cerrada) — MODE_CHANGE
      flog(this.model, this.hal, "I", `MODE_CHANGE ${modoTexto(modoAnterior)} -> ${modoTexto(this.model.currentMode)}`);
    }
    return { ok: true, data: undefined };
  }

  /** Réplica de handleSumoMicro()/handleSumoMini() reales — inicio desde el servidor, con su propio gate (sumoInicioServidor). */
  startSumo(which: "micro" | "mini"): CommandResult {
    if (!this.model.sumoInicioServidor) {
      return { ok: false, error: 'Inicio desde el servidor deshabilitado (ver "Modo de inicio" en Sumo)' };
    }
    return this.iniciarSumoInterno(which);
  }

  /**
   * Réplica de iniciarSumoDesdeBoton() real: mismo efecto que iniciar
   * desde el servidor, pero usando SIEMPRE el perfil YA activo (nunca
   * elige ni reconstruye) — doble gate de seguridad idéntico al real:
   * (1) sumoInicioBoton habilitado, (2) currentMode===IDLE.
   * DIFERENCIA DOCUMENTADA: el real detecta un flanco eléctrico
   * debounced de un GPIO físico (GPIO9) sondeado continuamente; el LAB
   * no tiene ruido eléctrico que filtrar — este método representa
   * directamente "se detectó una pulsación limpia", disparado por un
   * único click del botón virtual en la UI.
   */
  /** Réplica del manejo de inicioServidor/inicioBoton en handleSumoConfig() real — gates globales, no per-perfil. */
  setModoInicioSumo(servidor?: boolean, boton?: boolean): CommandResult {
    if (servidor !== undefined) this.model.sumoInicioServidor = servidor;
    if (boton !== undefined) this.model.sumoInicioBoton = boton;
    flog(this.model, this.hal, "I", `Modo de inicio Sumo: servidor=${this.model.sumoInicioServidor} boton=${this.model.sumoInicioBoton}`);
    return { ok: true, data: undefined };
  }

  pulsarBotonSumo(): CommandResult {
    if (!this.model.sumoInicioBoton || this.model.currentMode !== RobotMode.IDLE) {
      return { ok: false, error: "El boton de inicio esta deshabilitado o el robot no esta libre (IDLE)" };
    }
    const r = this.iniciarSumoInterno(this.model.cfgActivaKey);
    flog(this.model, this.hal, "I", `Sumo iniciado desde el boton virtual (GPIO${PIN.boton}) — perfil activo: ${this.model.cfgActivaKey === "micro" ? "MICRO" : "MINI"}`);
    return r;
  }

  stopSumo(): CommandResult {
    const modoAnterior = this.model.currentMode;
    this.model.currentMode = RobotMode.IDLE;
    this.model.modeRunning = false;
    this.model.evadeState = EvadeState.IDLE;
    this.model.enRecuperacion = false;
    this.model.ultimoAtaqueDirLog = -1; // fase "Cierre Sumo" real — no dejar latches de log "colgados" tras detener
    this.stopMotors();
    if (modoAnterior !== this.model.currentMode) {
      flog(this.model, this.hal, "I", `MODE_CHANGE ${modoTexto(modoAnterior)} -> ${modoTexto(this.model.currentMode)}`);
    }
    return { ok: true, data: undefined };
  }

  setTrim(ma?: number, mb?: number): CommandResult {
    if (ma !== undefined) this.model.trimA = constrain(ma, 0, 255);
    if (mb !== undefined) this.model.trimB = constrain(mb, 0, 255);
    return { ok: true, data: undefined };
  }

  // ---- Proyecto FRANKY (.franky) ----
  exportProyecto(): CommandResult<ReturnType<typeof generarProyectoJson>> {
    const json = generarProyectoJson(
      this.model.cfgMini,
      this.model.cfgMicro,
      this.model.cfgActivaKey === "micro" ? 1 : 0,
      this.model.sumoInicioServidor,
      this.model.sumoInicioBoton,
      this.model.i2cEnabled,
      this.model.i2cSda,
      this.model.i2cScl,
      this.model.spiEnabled,
      this.model.trimA,
      this.model.trimB,
      velExterna,
      velInterna,
    );
    return { ok: true, data: json };
  }

  /**
   * POST /proyecto/import — atomicidad real: validarProyectoImport() lanza
   * ProyectoError ante CUALQUIER problema, y en ese caso este método no
   * toca ningún estado real (mismo criterio "todo o nada" que el .ino).
   */
  importProyecto(body: unknown): CommandResult<{ blocklyXml: string | null }> {
    let r: ReturnType<typeof validarProyectoImport>;
    try {
      r = validarProyectoImport(body, this.model.cfgMini, this.model.cfgMicro);
    } catch (e) {
      const msg = e instanceof ProyectoError || e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
    // Todo válido — recién ahora se aplica.
    this.model.cfgMini = r.cfgMini;
    this.model.cfgMicro = r.cfgMicro;
    this.model.i2cEnabled = r.i2cEnabled;
    this.model.i2cSda = r.i2cSda;
    this.model.i2cScl = r.i2cScl;
    this.model.spiEnabled = r.spiEnabled;
    this.model.trimA = r.trimA;
    this.model.trimB = r.trimB;
    // Mismo criterio de seguridad que configureSumo(): no reasignar el
    // perfil activo si Sumo está efectivamente corriendo.
    if (r.perfilActivo !== undefined && this.model.currentMode === RobotMode.IDLE) {
      this.model.cfgActivaKey = r.perfilActivo === 1 ? "micro" : "mini";
    }
    // FASE "PERSISTENCIA SUMO" — opcionales a propósito (un .franky viejo
    // no los trae): si vienen, se aplican; si no, se conserva lo actual.
    if (r.inicioServidor !== undefined) this.model.sumoInicioServidor = r.inicioServidor;
    if (r.inicioBoton !== undefined) this.model.sumoInicioBoton = r.inicioBoton;
    // El .ino real reinicia (ESP.restart()) tras un import, lo que
    // re-ejecuta gpioSincronizarBuses()/gpioAplicarReservasSumoActivo()
    // en setup(). El LAB no reinicia (diferencia documentada/confirmada)
    // — se resincroniza el mapa de reservas explícitamente acá.
    gpioSincronizarBuses(this.model);
    gpioAplicarReservasSumoActivo(this.model, this.cfgActiva());
    // FASE MONITOR/DEBUG (punto 4 de la lista cerrada)
    flog(this.model, this.hal, "I", "PROYECTO importado y aplicado (sin reinicio — LAB virtual)");
    // blocklyXml se devuelve validado pero NO se aplica a ningún estado
    // del Firmware Model — ver nota de ALCANCE en proyecto.ts. El
    // navegador (bloques.html) es responsable de cargarlo al Workspace.
    return { ok: true, data: { blocklyXml: r.blocklyXml } };
  }

  // ---- Bloques ----
  bloquesAdd(op: number, val: number, txt?: string, bitmap?: string): CommandResult {
    if (this.model.programa.length >= MAX_INST) {
      return { ok: false, error: `Programa lleno (máximo ${MAX_INST} instrucciones, igual que el firmware real)` };
    }
    // OP_OLED_SPRITE (109) con bitmap propio — réplica del límite real de
    // tablaBitmap[] (TABLA_BITMAP_MAX=8): handleBloquesAdd() real responde
    // 400 si la tabla ya tiene sus 8 entradas ocupadas.
    if (op === 109 && bitmap !== undefined) {
      if (this.model.tablaBitmapLen >= TABLA_BITMAP_MAX) {
        return { ok: false, error: `Tabla de bitmaps llena (máximo ${TABLA_BITMAP_MAX} sprites, igual que el firmware real)` };
      }
      this.model.tablaBitmapLen++;
    }
    const ins: { op: number; val: number; txt?: string; bitmap?: string } = { op, val };
    if (txt !== undefined) ins.txt = txt;
    if (bitmap !== undefined) ins.bitmap = bitmap;
    this.model.programa.push(ins);
    return { ok: true, data: undefined };
  }
  bloquesDel(idx: number): CommandResult {
    if (idx >= 0 && idx < this.model.programa.length) this.model.programa.splice(idx, 1);
    return { ok: true, data: undefined };
  }
  bloquesRun(): CommandResult {
    const modoAnterior = this.model.currentMode;
    // CORRECCIÓN (falso conflicto OLED): un programa vacío nunca debe
    // poder quedar "ejecutando" — evita que progUsaOled/hayConflictoRecurso
    // reflejen un estado que no representa nada real.
    if (this.model.programa.length === 0) {
      return { ok: false, error: "No hay ningun programa compilado para ejecutar" };
    }
    this.model.progPC = 0;
    this.model.bEsperando = false;
    this.model.currentMode = RobotMode.BLOQUES;
    this.model.modeRunning = true;
    if (modoAnterior !== this.model.currentMode) {
      flog(this.model, this.hal, "I", `MODE_CHANGE ${modoTexto(modoAnterior)} -> ${modoTexto(this.model.currentMode)}`);
    }
    return { ok: true, data: undefined };
  }
  bloquesStop(): CommandResult {
    const modoAnterior = this.model.currentMode;
    this.model.currentMode = RobotMode.IDLE;
    this.model.modeRunning = false;
    this.stopMotors();
    if (modoAnterior !== this.model.currentMode) {
      flog(this.model, this.hal, "I", `MODE_CHANGE ${modoTexto(modoAnterior)} -> ${modoTexto(this.model.currentMode)}`);
    }
    return { ok: true, data: undefined };
  }
  bloquesClear(): CommandResult {
    this.model.programa = [];
    this.model.progPC = 0;
    this.model.tablaBitmapLen = 0; // réplica: cada recompilación completa arranca las tablas de cero
    return { ok: true, data: undefined };
  }
  /**
   * Réplica FIEL de ejecutarBloque() real (.ino líneas 456-496) — el
   * intérprete de Bloques del firmware, que será la base real de Runtime
   * Blockly (Fase 3): todo programa Blockly se compila a esta MISMA
   * secuencia de opcodes, no a un intérprete paralelo.
   *
   * OP_REPEAT (74) está definido en el firmware real pero NUNCA
   * implementado — cae al "default" (para y resetea). Lo replico
   * exactamente así, sin "arreglarlo": si el firmware real no lo soporta,
   * el Laboratorio tampoco debe fingir que sí. Ver informe de
   * compatibilidad de Blockly sobre cómo se resuelve esto en el lado del
   * compilador (desenrollado, no una capacidad nueva del intérprete).
   */
  private tickBloques(): void {
    const m = this.model;
    if (m.programa.length === 0 || m.progPC >= m.programa.length) { m.progPC = 0; return; }
    if (m.bEsperando) {
      if (this.hal.millis() - m.tBloque >= m.bEsperaMs) { m.bEsperando = false; m.progPC++; }
      return;
    }
    const ins = m.programa[m.progPC];
    switch (ins.op) {
      case 1: moveDirLetter(m, this.hal, "f", ins.val > 0 ? ins.val : m.motorSpeed); if (flogThrottle(m, this.hal, "blockly_bloque", 300)) flog(m, this.hal, "D", `Adelante vel=${ins.val > 0 ? ins.val : m.motorSpeed}`); m.progPC++; break; // OP_ADE
      case 2: moveDirLetter(m, this.hal, "b", ins.val > 0 ? ins.val : m.motorSpeed); if (flogThrottle(m, this.hal, "blockly_bloque", 300)) flog(m, this.hal, "D", `Atras vel=${ins.val > 0 ? ins.val : m.motorSpeed}`); m.progPC++; break; // OP_ATR
      case 3: moveDirLetter(m, this.hal, "l", ins.val > 0 ? ins.val : m.motorSpeed); if (flogThrottle(m, this.hal, "blockly_bloque", 300)) flog(m, this.hal, "D", `Izquierda vel=${ins.val > 0 ? ins.val : m.motorSpeed}`); m.progPC++; break; // OP_IZQ
      case 4: moveDirLetter(m, this.hal, "r", ins.val > 0 ? ins.val : m.motorSpeed); if (flogThrottle(m, this.hal, "blockly_bloque", 300)) flog(m, this.hal, "D", `Derecha vel=${ins.val > 0 ? ins.val : m.motorSpeed}`); m.progPC++; break; // OP_DER
      case 5: stopMotorsShared(m, this.hal); m.progPC++; break; // OP_STOP
      case 6: m.tBloque = this.hal.millis(); m.bEsperaMs = ins.val; m.bEsperando = true; break; // OP_ESP (NO avanza progPC todavía)
      case 7: this.hal.digitalWrite(PIN.led, 0); m.progPC++; break; // OP_LED_ON
      case 8: this.hal.digitalWrite(PIN.led, 1); m.progPC++; break; // OP_LED_OFF
      case 9: m.progPC += this.hal.analogRead(0) > ins.val ? 2 : 1; break; // OP_IF_DIST (ADC0 fijo, salta la siguiente si NO se cumple)
      case 11: // OP_FRENO — frenado activo (los 4 canales a full duty), no es lo mismo que STOP
        this.hal.pwmWrite(PIN.motorIzqFwd, 255); this.hal.pwmWrite(PIN.motorIzqRev, 255);
        this.hal.pwmWrite(PIN.motorDerFwd, 255); this.hal.pwmWrite(PIN.motorDerRev, 255);
        m.progPC++; break;
      case 20: { // OP_DOUT — gpio=val/10, nivel=val%10 (empaquetado real)
        const gpio = Math.trunc(ins.val / 10), nivel = ins.val % 10;
        this.hal.digitalWrite(gpio, nivel);
        m.progPC++; break;
      }
      case 22: this.hal.pwmWrite(PIN.motorDerFwd, ins.val); m.progPC++; break; // OP_PWM_OUT (real: reengancha PWM a GPIO3)
      case 30: m.adcLast = this.hal.analogRead(ins.val >= 0 ? ins.val : 0); m.varGlobal = m.adcLast; m.progPC++; break; // OP_ADC_READ
      case 40: { // OP_SERVO — gpio=val/1000, ang=val%1000 (empaquetado real)
        const gpio = Math.trunc(ins.val / 1000), ang = ins.val % 1000;
        m.servoGPIO = gpio; m.servoAngle = ang;
        m.progPC++; break;
      }
      case 60: m.varGlobal = ins.val; m.progPC++; break; // OP_VAR_SET
      case 61: m.varGlobal += ins.val; m.progPC++; break; // OP_VAR_ADD
      case 62: m.varGlobal -= ins.val; m.progPC++; break; // OP_VAR_SUB
      case 70: m.adcLast = this.hal.analogRead(0); m.progPC += m.adcLast > ins.val ? 2 : 1; break; // OP_IF_GT
      case 71: m.adcLast = this.hal.analogRead(0); m.progPC += m.adcLast < ins.val ? 2 : 1; break; // OP_IF_LT
      // ── Extensión de Laboratorio (opcodes 90+, NO existen en el
      // firmware real todavía — ver informe de evolución) ──────────────
      case 90: { // OP_PUSH — apila un valor en la pila de trabajo (máx 8)
        m.pila.push(ins.val);
        if (m.pila.length > 8) m.pila.shift();
        m.progPC++;
        break;
      }
      case 91: m.progPC = ins.val; break; // OP_JMP — salto incondicional (no existe en el real: sin esto, ningún while/for real es posible)
      case 92: { // OP_CALL — apila dirección de retorno, salta (para funciones)
        m.callStack.push(m.progPC + 1);
        if (m.callStack.length > 8) m.callStack.shift();
        m.progPC = ins.val;
        break;
      }
      case 93: { // OP_RET — vuelve a la dirección de retorno
        const ret = m.callStack.pop();
        m.progPC = ret !== undefined ? ret : m.progPC + 1;
        break;
      }
      case 94: m.varGlobal = this.hal.millis(); m.progPC++; break; // OP_MILLIS_READ
      case 95: { // OP_MATH_MAP — pop orden [value,fromLow,fromHigh,toLow,toHigh]
        const toHigh = popStack(m), toLow = popStack(m), fromHigh = popStack(m), fromLow = popStack(m), value = popStack(m);
        m.varGlobal = fromHigh === fromLow ? toLow : ((value - fromLow) * (toHigh - toLow)) / (fromHigh - fromLow) + toLow;
        m.progPC++;
        break;
      }
      case 96: { // OP_MATH_CONSTRAIN — pop [value,min,max]
        const max = popStack(m), min = popStack(m), value = popStack(m);
        m.varGlobal = Math.min(Math.max(value, min), max);
        m.progPC++;
        break;
      }
      case 97: m.varGlobal = Math.abs(popStack(m)); m.progPC++; break; // OP_MATH_ABS
      case 98: { const b = popStack(m), a = popStack(m); m.varGlobal = Math.min(a, b); m.progPC++; break; } // OP_MATH_MIN
      case 99: { const b = popStack(m), a = popStack(m); m.varGlobal = Math.max(a, b); m.progPC++; break; } // OP_MATH_MAX
      case 100: { const max = popStack(m), min = popStack(m); m.varGlobal = Math.floor(Math.random() * (max - min + 1)) + min; m.progPC++; break; } // OP_MATH_RANDOM
      case 101: m.oled.on = true; m.progPC++; break; // OP_OLED_INIT
      case 102: m.oled.draft = []; m.oled.cursorX = 0; m.oled.cursorY = 0; m.progPC++; break; // OP_OLED_CLEAR
      case 103: { const y = popStack(m), x = popStack(m); m.oled.cursorX = x; m.oled.cursorY = y; m.progPC++; break; } // OP_OLED_CURSOR
      case 104: // OP_OLED_PRINT — usa ins.txt, no la pila
        m.oled.draft.push({ kind: "text", x: m.oled.cursorX, y: m.oled.cursorY, text: ins.txt ?? "" });
        m.progPC++;
        break;
      case 105: { const y2 = popStack(m), x2 = popStack(m), y = popStack(m), x = popStack(m); m.oled.draft.push({ kind: "line", x, y, x2, y2 }); m.progPC++; break; } // OP_OLED_LINE
      case 106: { const h = popStack(m), w = popStack(m), y = popStack(m), x = popStack(m); m.oled.draft.push({ kind: "rect", x, y, w, h }); m.progPC++; break; } // OP_OLED_RECT
      case 107: { const r = popStack(m), y = popStack(m), x = popStack(m); m.oled.draft.push({ kind: "circle", x, y, r }); m.progPC++; break; } // OP_OLED_CIRCLE
      case 108: m.oled.shown = m.oled.draft.slice(); m.progPC++; break; // OP_OLED_DISPLAY (doble buffer, igual que display.display() real)
      case 109: { // OP_OLED_SPRITE — x,y llegan por la pila (mismo mecanismo que LINE/RECT/CIRCLE), bitmap va en ins.bitmap (16x16, 1bpp, 64 chars hex)
        const y = popStack(m), x = popStack(m);
        m.oled.draft.push({ kind: "sprite", x, y, bitmap: ins.bitmap ?? "0".repeat(64) });
        m.progPC++;
        break;
      }
      case 110: m.varGlobal = leerBordeIzq(this.hal, this.cfgActiva()) ? 1 : 0; m.progPC++; break; // OP_READ_BORDE_IZQ
      case 111: m.varGlobal = leerBordeDer(this.hal, this.cfgActiva()) ? 1 : 0; m.progPC++; break; // OP_READ_BORDE_DER
      case 112: m.varGlobal = this.hal.analogRead(0) < 1800 ? 1 : 0; m.progPC++; break; // OP_READ_LINEA_IZQ (mismo pin que sw-entry.ts LINE_PIN_IZQ)
      case 113: m.varGlobal = this.hal.digitalRead(6) === 0 ? 1 : 0; m.progPC++; break; // OP_READ_LINEA_CENTRO (LINE_PIN_CENTRO)
      case 114: m.varGlobal = this.hal.analogRead(1) < 1800 ? 1 : 0; m.progPC++; break; // OP_READ_LINEA_DER (LINE_PIN_DER)
      // OP_IF_GT/OP_IF_LT reales (70/71) están hardcodeados a analogRead(ADC0)
      // — no sirven para "repetir N veces" ni ningún bucle basado en
      // contador/variable. Propuesta de Laboratorio: la misma semántica de
      // salto (verdadero=saltea, falso=ejecuta), pero comparando varGlobal.
      case 120: m.progPC += m.varGlobal > ins.val ? 2 : 1; break; // OP_IF_VAR_GT
      case 121: m.progPC += m.varGlobal < ins.val ? 2 : 1; break; // OP_IF_VAR_LT
      case 122: // OP_SERIAL_PRINT — "Monitor Serie" no existe en el firmware real
        // (HTTP no tiene concepto de puerto serie) — propuesta de Lab: guarda
        // en un log acotado (últimas 50 líneas), consumido por el Workspace.
        m.serialLog.push(ins.txt ?? "");
        if (m.serialLog.length > 50) m.serialLog.shift();
        // FASE MONITOR/DEBUG (punto 3 de la lista cerrada) — además de
        // serialLog (sin tocarlo), también llega al Monitor Serie Virtual
        // real, throttled igual que el .ino (categoría "gen2", 500ms).
        if (flogThrottle(m, this.hal, "gen2", 500)) flog(m, this.hal, "I", `SERIAL_PRINT: ${ins.txt ?? ""}`);
        m.progPC++;
        break;
      case 123: // OP_BUZZER — no existe en el firmware real (ni el pin está
        // definido). Toma frecuencia (Hz) y duración (ms) de la pila de
        // trabajo — empaquetarlo en un solo `val` no alcanza para valores
        // reales de frecuencia. Orden de push: [freq, duracion].
        m.buzzerDurationMs = popStack(m); // se pusheó último -> sale primero
        m.buzzerFreqHz = popStack(m);
        m.buzzerLastPlayedAt = this.hal.millis();
        m.progPC++;
        break;
      case 0: default: stopMotorsShared(m, this.hal); m.progPC = 0; break; // OP_FIN / cualquier opcode desconocido
    }
  }

  // ---- Automatizaciones / panel / led / gpio / sonar ----
  autoSet(mode: RobotMode): CommandResult {
    this.model.currentMode = mode;
    this.model.modeRunning = true;
    return { ok: true, data: undefined };
  }
  autoAlarmaReset(): CommandResult {
    this.model.alarmaActiva = false;
    return { ok: true, data: undefined };
  }
  autoStop(): CommandResult {
    this.model.currentMode = RobotMode.IDLE;
    this.model.modeRunning = false;
    this.stopMotors();
    return { ok: true, data: undefined };
  }
  panelSave(i2c: boolean, spi: boolean): CommandResult {
    this.model.i2cEnabled = i2c;
    this.model.spiEnabled = spi;
    gpioSincronizarBuses(this.model); // Fase 4.1/4.2 real: handlePanelSave() resincroniza el mapa de reservas
    return { ok: true, data: undefined };
  }

  // ---- GPIO / I2C (Fase GPIO/I2C) ----
  /**
   * Réplica de handleI2CSet() real, sin el ESP.restart() (diferencia
   * documentada y confirmada: el LAB aplica en caliente).
   */
  setI2CPins(sda: number, scl: number): CommandResult {
    const r = aplicarI2C(this.model, sda, scl);
    if (r.ok) {
      // FASE MONITOR/DEBUG (punto 5 de la lista cerrada)
      flog(this.model, this.hal, "I", `[CONFIG] I2C SDA/SCL -> GPIO${sda}/GPIO${scl}`);
    }
    return r.ok ? { ok: true, data: undefined } : { ok: false, error: r.error };
  }

  /** Réplica de handleGpioEstado() real — solo lectura, sin efectos secundarios. */
  gpioEstado(): { pines: GpioEstadoPin[]; i2c_sda: number; i2c_scl: number } {
    return gpioEstadoSnapshot(this.model);
  }

  // ---- Monitor Serie Virtual (Fase MONITOR/DEBUG) ----
  /** Réplica de handleMonitorLog() real. */
  monitorLog(since: number): MonitorLogResponse {
    return generarMonitorLogJson(this.model, since);
  }
  /** Réplica de handleMonitorDebug() real. */
  monitorDebug(on?: boolean): { debug: boolean } {
    if (on !== undefined) this.model.debugEnabled = on;
    return { debug: this.model.debugEnabled };
  }
  /** Réplica REDUCIDA de handleLogTexto() real — ver monitor.ts. */
  logTexto(): string {
    return generarLogTexto(this.model, this.hal);
  }

  /** Réplica de handleRuntimePagina() real — PAGE_ENTER, diagnóstico. */
  runtimePagina(pagina: string): void {
    flog(this.model, this.hal, "I", `PAGE_ENTER ${pagina}`);
  }
  /** Réplica de handleRuntimeNavegador() real — errores capturados del lado del navegador. */
  runtimeNavegador(tipo: string, pagina: string, msg: string): void {
    const acotado = msg.slice(0, 120);
    flog(this.model, this.hal, "W", `[BROWSER] tipo=${tipo} pagina=${pagina} msg=${acotado}`);
  }
  /** Réplica de los campos progUsaOled/Motores/Serial + modoTexto expuestos por /runtime/estado real — acá se agregan a /api en vez de duplicar un endpoint (ver Fase 5: "no dupliques /api"). */
  resumenRecursos(): { modoTexto: string; progUsaOled: boolean; progUsaMotores: boolean; progUsaSerial: boolean } {
    return {
      modoTexto: modoTexto(this.model.currentMode),
      progUsaOled: progUsaOled(this.model),
      progUsaMotores: progUsaMotores(this.model),
      progUsaSerial: progUsaSerial(this.model),
    };
  }

  /** Réplica de handleOledTest() real — SIN detección física (no hay
   * chip I2C que escanear en un mundo virtual). "Probar" confirma la
   * única precondición real (I2C habilitado) y aplica el tamaño que el
   * usuario eligió; nunca "encuentra" una dirección — panelAddr queda
   * fijo en 0x3C. Diferencia documentada explícitamente.
   */
  // ---- "Programa Fuente" virtual (Sesión 1, auditoría Server-vs-LAB) ----
  /** Réplica de handleBloquesXmlGet() real, adaptada a persistencia en memoria (ver nota en model.ts). Límite de tamaño igual al de .franky (48KB) por consistencia interna. */
  bloquesXmlGet(): { existe: boolean; xml: string | null; bytes: number; sincronizado: boolean } {
    const xml = this.model.programaFuenteXml;
    const sincronizado =
      xml !== null &&
      this.model.programaFuenteXmlHash !== null &&
      this.model.programaCompiladoHash !== null &&
      this.model.programaFuenteXmlHash === this.model.programaCompiladoHash;
    return { existe: xml !== null, xml, bytes: xml ? xml.length : 0, sincronizado };
  }
  bloquesXmlSet(xml: string, hash: number): CommandResult {
    if (xml.length > 49152) return { ok: false, error: "Programa demasiado grande (maximo 48KB)" };
    this.model.programaFuenteXml = xml;
    this.model.programaFuenteXmlHash = hash;
    flog(this.model, this.hal, "I", `PROGRAMA fuente (Blockly XML) guardado (${xml.length} bytes)`);
    return { ok: true, data: undefined };
  }
  /** Réplica de handleBloquesMarcarFuente() real — marca qué XML corresponde al programa[] ya compilado. */
  bloquesMarcarFuente(hash: number): CommandResult {
    this.model.programaCompiladoHash = hash;
    return { ok: true, data: undefined };
  }

  // ---- Panel Industrial: OLED (Sesión 1, auditoría Server-vs-LAB) ----
  oledTest(size: "91" | "96", forzar: boolean): CommandResult<{ ancho: number; alto: number; addr: number }> | { ok: false; conflicto: true; mensaje: string } {
    if (hayConflictoRecurso(this.model, progUsaOled(this.model)) && !forzar) {
      flog(this.model, this.hal, "W", "OLED ocupado por BLOCKLY (Panel intento Probar)");
      return { ok: false, conflicto: true, mensaje: "Blockly esta utilizando la pantalla OLED." };
    }
    if (hayConflictoRecurso(this.model, progUsaOled(this.model))) this.bloquesStop(); // "Panel tomo control"
    if (!this.model.i2cEnabled) return { ok: false, error: "I2C deshabilitado (ver Configurar I2C/SPI)" };
    const alto = size === "91" ? 32 : 64;
    this.model.oled.panelDetectado = true;
    this.model.oled.panelAncho = 128;
    this.model.oled.panelAlto = alto;
    this.model.oled.panelAddr = 0x3c;
    return { ok: true, data: { ancho: 128, alto, addr: 0x3c } };
  }
  /** Réplica de handleOledClear() real — limpia y "muestra" de inmediato (no pasa por el intérprete de Bloques). */
  oledClear(forzar: boolean): CommandResult | { ok: false; conflicto: true; mensaje: string } {
    if (hayConflictoRecurso(this.model, progUsaOled(this.model)) && !forzar) {
      flog(this.model, this.hal, "W", "OLED ocupado por BLOCKLY (Panel intento Limpiar)");
      return { ok: false, conflicto: true, mensaje: "Blockly esta utilizando la pantalla OLED." };
    }
    if (hayConflictoRecurso(this.model, progUsaOled(this.model))) this.bloquesStop();
    if (!this.model.oled.panelDetectado) return { ok: false, error: "Ejecutar Probar antes de Limpiar" };
    this.model.oled.draft = [];
    this.model.oled.shown = [];
    return { ok: true, data: undefined };
  }
  /**
   * Réplica de handleOledLogo() real — logo MDE REAL (convertido de la
   * imagen oficial del usuario a bitmap 1bpp), no un placeholder de texto.
   */
  oledLogo(forzar: boolean): CommandResult | { ok: false; conflicto: true; mensaje: string } {
    if (hayConflictoRecurso(this.model, progUsaOled(this.model)) && !forzar) {
      flog(this.model, this.hal, "W", "OLED ocupado por BLOCKLY (Panel intento Logo MDE)");
      return { ok: false, conflicto: true, mensaje: "Blockly esta utilizando la pantalla OLED." };
    }
    if (hayConflictoRecurso(this.model, progUsaOled(this.model))) this.bloquesStop();
    if (!this.model.oled.panelDetectado) return { ok: false, error: "Ejecutar Probar antes de mostrar el Logo" };
    const alto = this.model.oled.panelAlto;
    const hex = alto === 32 ? LOGO_MDE_128x32_HEX : LOGO_MDE_128x64_HEX;
    this.model.oled.draft = [{ kind: "bitmap", x: 0, y: 0, bitmap: hex, anchoBits: 128, altoBits: alto }];
    this.model.oled.shown = this.model.oled.draft.slice();
    return { ok: true, data: undefined };
  }

  /**
   * Réplica de handleI2cScan() real, SIN hardware I2C simulado (decisión
   * confirmada explícitamente): 409 si I2C está deshabilitado (igual que
   * el real), `[]` si está habilitado — nunca inventa direcciones ni
   * dispositivos.
   */
  i2cScan(): CommandResult<string[]> {
    if (!this.model.i2cEnabled) {
      return { ok: false, error: "I2C deshabilitado (ver Configurar I2C/SPI)" };
    }
    return { ok: true, data: [] };
  }
  ledOn(): CommandResult { this.hal.digitalWrite(PIN.led, 0); return { ok: true, data: undefined }; }
  ledOff(): CommandResult { this.hal.digitalWrite(PIN.led, 1); return { ok: true, data: undefined }; }
  ledBrillo(val: number): CommandResult { this.hal.digitalWrite(PIN.led, val); return { ok: true, data: undefined }; }
  gpioOut(pin: number, val: number): CommandResult {
    if ([2, 3, 4, 5].includes(pin)) return { ok: false, error: "Pin ocupado por motor" };
    this.hal.digitalWrite(pin, val ? 1 : 0);
    return { ok: true, data: undefined };
  }
  gpioRead(pin: number): CommandResult<{ pin: number; val: number }> {
    if ([2, 3, 4, 5].includes(pin)) return { ok: false, error: "Pin motor" };
    return { ok: true, data: { pin, val: this.hal.digitalRead(pin) } };
  }
  sonarRead(): CommandResult<{ cm: number }> {
    // Sin Motor de Simulación con física todavía: el firmware real devuelve
    // 999 cuando no hay eco. Ver ADR-002 §3 (Motor de Simulación pendiente).
    return { ok: true, data: { cm: 999 } };
  }

  /**
   * Snapshot para el Workspace del laboratorio (NO forma parte del contrato
   * real del firmware — es exclusivo de FRANKY LAB). Todo lo que devuelve
   * sale de lecturas reales del Firmware Model / MCU en este mismo instante,
   * nunca de valores inventados.
   */
  getLabTelemetry() {
    const cfg = this.cfgActiva();
    const sharpRawI = this.hal.analogRead(cfg.sharpPinI === 0 ? 0 : 1);
    const sharpRawD = this.hal.analogRead(cfg.sharpPinD === 0 ? 0 : 1);
    return {
      mode: this.model.currentMode,
      modeRunning: this.model.modeRunning,
      motorSpeed: this.model.motorSpeed,
      trimA: this.model.trimA,
      trimB: this.model.trimB,
      pwmA: this.model.pwmA,
      pwmB: this.model.pwmB,
      ledOn: this.hal.digitalRead(PIN.led) === 0, // lógica invertida real: LOW = encendido
      btn: this.hal.digitalRead(PIN.boton) === 0, // pull-up: LOW = presionado
      accesoAbierto: this.model.accesoAbierto,
      evadeState: this.model.evadeState,
      progPC: this.model.progPC,
      progLen: this.model.programa.length,
      varGlobal: this.model.varGlobal,
      adcLast: this.model.adcLast,
      servoGPIO: this.model.servoGPIO,
      servoAngle: this.model.servoAngle,
      pila: this.model.pila,
      callStackDepth: this.model.callStack.length,
      oled: this.model.oled,
      serialLog: this.model.serialLog,
      buzzerFreqHz: this.model.buzzerFreqHz,
      buzzerDurationMs: this.model.buzzerDurationMs,
      buzzerLastPlayedAt: this.model.buzzerLastPlayedAt,
      programaOpcodes: this.model.programa.map((i) => i.op),
      sharp: {
        // Lectura EN VIVO del MCU (no el caché de FirmwareModel, que solo
        // se refresca dentro del handler de /api) — el canal postMessage
        // del Workspace no pasa por ahí, así que tenía que leerse acá.
        adcI: sharpRawI,
        detI: sharpRawI > cfg.umbralSharp,
        adcD: sharpRawD,
        detD: sharpRawD > cfg.umbralSharp,
        umbral: cfg.umbralSharp,
      },
      borde: {
        izq: leerBordeIzq(this.hal, cfg),
        der: leerBordeDer(this.hal, cfg),
        umbral: cfg.umbralBorde,
        numBorde: cfg.numBorde,
      },
      // Bloque GENÉRICO (criterio permanente del proyecto: el Workspace
      // nunca decide qué sensores existen, solo refleja la configuración
      // real). tipoLabel/numDist/sensores describen EXACTAMENTE lo que el
      // usuario configuró desde sumo.html — 1 o 2 unidades de Sharp,
      // HC-SR04 (sonar) o JS40 (óptico digital), nunca fijo. Reusa
      // leerOponente() en vez de duplicar la lógica de detección.
      oponenteSensor: (() => {
        const { oI, oD } = leerOponente(this.hal, cfg);
        const tipoLabel = cfg.tipoDistSensor === TipoDistSensor.SHARP ? "sharp"
          : cfg.tipoDistSensor === TipoDistSensor.SONAR ? "sonar" : "optico";
        const valorDe = (izq: boolean): number | null => {
          if (cfg.tipoDistSensor === TipoDistSensor.SHARP) return this.hal.analogRead(izq ? cfg.sharpPinI : cfg.sharpPinD);
          if (cfg.tipoDistSensor === TipoDistSensor.OPTICO) return this.hal.digitalRead(izq ? cfg.optPinI : cfg.optPinD);
          return this.hal.analogRead(izq ? cfg.echoI : cfg.echoD); // sonar: distancia real en cm (ver sw-entry.ts)
        };
        const sensores: { lado: "izq" | "der"; detectado: boolean; valor: number | null }[] = [
          { lado: "izq", detectado: oI, valor: valorDe(true) },
        ];
        if (cfg.numDistSensores >= 2) sensores.push({ lado: "der", detectado: oD, valor: valorDe(false) });
        return { tipo: cfg.tipoDistSensor, tipoLabel, numDist: cfg.numDistSensores, sensores };
      })(),
    };
  }

  // ---- Helpers ----
  cfgActiva(): SumoConfig {
    return this.model.cfgActivaKey === "micro" ? this.model.cfgMicro : this.model.cfgMini;
  }

  /** Refresca la telemetría Sharp cacheada — llamado por Virtual Server antes de leer /api. */
  refreshTelemetry(): void {
    const cfg = this.cfgActiva();
    const a0 = this.hal.analogRead(0);
    const a1 = this.model.spiEnabled ? 0 : this.hal.analogRead(1);
    if (cfg.tipoDistSensor === TipoDistSensor.SHARP) {
      this.model.sharpAdcValI = cfg.sharpPinI === 0 ? a0 : a1;
      this.model.sharpDetI = this.model.sharpAdcValI > cfg.umbralSharp;
      if (cfg.numDistSensores >= 2) {
        this.model.sharpAdcValD = cfg.sharpPinD === 0 ? a0 : a1;
        this.model.sharpDetD = this.model.sharpAdcValD > cfg.umbralSharp;
      }
    }
  }

  private exitAutoModeOnManualCommand(): void {
    if (this.model.currentMode !== RobotMode.IDLE) {
      this.model.currentMode = RobotMode.IDLE;
      this.model.modeRunning = false;
    }
  }
}
