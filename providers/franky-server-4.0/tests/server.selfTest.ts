import { StubHAL } from "../../../core/src/stubHal.js";
import { createProviderServer } from "../server/virtualServer.js";
import { RobotMode } from "../firmware/model.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. Esquema JSON de /api");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const res = server.handle("GET", "/api", {});
  assert(res.status === 200, "status 200");
  const body = res.body as Record<string, unknown>;
  for (const key of ["a0","a1","mode","running","sharp_adc_i","sharp_det_i","s_perfil"]) {
    assert(key in body, `clave '${key}' presente`);
  }
  assert(body.mode === RobotMode.IDLE, "modo inicial numérico IDLE (0)");
}

console.log("\n2. /mv, /st, /spd — sin validación (igual que firmware real)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/spd", { val: "220" });
  server.handle("GET", "/mv", { d: "f" });
  const api = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert((api.pwmA as number) > 0, "/mv mueve el robot, reflejado en /api");
  server.handle("GET", "/st", {});
  const api2 = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert(api2.pwmA === 0, "/st frena");
}

console.log("\n3. /sumo/config traduce CommandResult a HTTP 400 con {ok:false,error}");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const res = server.handle("GET", "/sumo/config", { modo: "micro", tipo: "sharp", numDist: "2", numBorde: "1" });
  assert(res.status === 400, "400 por exceso de ADC");
  assert((res.body as { ok: boolean }).ok === false, "{ok:false}");
}

console.log("\n4. /stopall -> 303");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const res = server.handle("GET", "/stopall", {});
  assert(res.status === 303 && res.location === "/", "redirige a /");
}

console.log("\n5. tick() del ProviderServer delega al Firmware Runtime (retardo 5s)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/micro", {});
  hal.advance(5001);
  server.tick();
  const api = server.handle("GET", "/api", {}).body as Record<string, unknown>;
  assert(api.mode === RobotMode.MICRO, "sigue en modo MICRO tras el tick");
}

console.log("\n6. Bloques: agregar, ejecutar, LED_ON/OFF vía opcode, y limpiar (hueco de cobertura encontrado en QA)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/bloques/add", { op: "7", val: "0" }); // LED_ON
  server.handle("GET", "/bloques/add", { op: "8", val: "0" }); // LED_OFF
  let list = server.handle("GET", "/bloques/list", {}).body as any[];
  assert(list.length === 2, "/bloques/add agregó las dos instrucciones");

  server.handle("GET", "/bloques/run", {});
  let api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === RobotMode.BLOQUES, "/bloques/run activa modo BLOQUES");

  server.tick(); // ejecuta instrucción 0 (LED_ON) y avanza progPC
  assert(hal.getDigital(8) === 0, "LED_ON (op=7) escribe GPIO8 en LOW de verdad");
  server.tick(); // ejecuta instrucción 1 (LED_OFF)
  assert(hal.getDigital(8) === 1, "LED_OFF (op=8) escribe GPIO8 en HIGH de verdad");

  server.handle("GET", "/bloques/clear", {});
  list = server.handle("GET", "/bloques/list", {}).body as any[];
  assert(list.length === 0, "/bloques/clear vacía el programa");

  server.handle("GET", "/bloques/add", { op: "6", val: "500" }); // OP_ESP, pausa 500ms
  server.handle("GET", "/bloques/run", {});
  server.tick();
  api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === RobotMode.BLOQUES && api.running === 1, "OP_ESP deja el programa corriendo (en pausa) sin trabarse");
}

console.log("\n7. Automatizaciones (Vivero/Meteo) y /panel/save (huecos de cobertura encontrados en QA)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);

  server.handle("GET", "/auto/vivero", {});
  let api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === RobotMode.VIVERO && api.running === 1, "/auto/vivero activa modo VIVERO en ejecución");

  server.handle("GET", "/auto/stop", {});
  api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === RobotMode.IDLE, "/auto/stop vuelve a IDLE");

  server.handle("GET", "/auto/meteo", {});
  api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === RobotMode.METEO, "/auto/meteo activa modo METEO");

  const panelRes = server.handle("GET", "/panel/save", { i2c: "" }); // presencia del parámetro, no su valor (real: hasArg)
  api = server.handle("GET", "/api", {}).body as any;
  assert(panelRes.body === "OK. Reiniciando...", "/panel/save responde el texto exacto del firmware real");
  assert(api.i2c === 1 && api.spi === 0, "/panel/save?i2c= activa i2c y deja spi apagado, reflejado en /api");
}

console.log("\n8. LA CAUSA REAL de 'Minisumo no inicia': sin oponente ni borde, el robot debe BUSCAR (moverse), no quedarse quieto");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numBorde: "0", estrategia: "0" });
  server.handle("GET", "/sumo/mini", {});
  hal.advance(5001);
  server.tick(); // consume el retardo
  server.tick(); // primer tick de combate real
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.pwmA !== 0 || lab.pwmB !== 0, "sin oponente/borde, el robot se mueve solo en patrón de búsqueda (antes: se quedaba quieto)");
}

console.log("\n9. Ataque: oponente detectado a ambos lados -> avanza recto");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numBorde: "0", numDist: "2", sharpI: "0", sharpD: "1", umbral_sharp: "1800" });
  server.handle("GET", "/sumo/mini", {});
  hal.advance(5001);
  server.tick();
  hal.setAnalog(0, 2500); // ambos sensores detectan al oponente
  hal.setAnalog(1, 2500);
  server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.pwmA > 0 && lab.pwmB > 0, "oponente detectado a ambos lados -> ataque recto (ambos motores adelante)");
}

console.log("\n10. Búsqueda circular real (perfil micro, o estrategia=0): motores con velocidades DISTINTAS (círculo, no recto)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numBorde: "0", estrategia: "0", circuloExt: "210", circuloInt: "80" });
  server.handle("GET", "/sumo/mini", {});
  hal.setAnalog(0, 200); // sin esto, el default de alta impedancia (4095) simula un "oponente" falso
  hal.setAnalog(1, 200);
  hal.advance(5001);
  server.tick();
  server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.pwmA !== lab.pwmB, "búsqueda circular: pwmA y pwmB son distintos (círculo, no línea recta)");
}

console.log("\n11. REGRESIÓN: con 2 sensores y AMBOS detectando, debe embestir recto — no quedar girando para siempre");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numBorde: "0", numDist: "2", sharpI: "0", sharpD: "1", umbral_sharp: "1800" });
  server.handle("GET", "/sumo/mini", {});
  hal.advance(5001);
  server.tick();
  hal.setAnalog(0, 2500); // AMBOS sensores detectan (antes: solo uno tenía raycast real)
  hal.setAnalog(1, 2500);
  server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.pwmA === lab.pwmB && lab.pwmA > 0, "ambos sensores detectando -> avanza recto (pwmA===pwmB), no gira");
}

console.log("\n12. REGRESIÓN: con 2 sensores y SOLO el izquierdo detectando, debe girar hacia ese lado (no embestir recto todavía)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numBorde: "0", numDist: "2", sharpI: "0", sharpD: "1", umbral_sharp: "1800" });
  server.handle("GET", "/sumo/mini", {});
  hal.advance(5001);
  server.tick();
  hal.setAnalog(0, 2500); // solo izquierdo detecta
  hal.setAnalog(1, 200);  // derecho NO detecta
  server.tick();
  // pwmA/pwmB del firmware real (y de este puerto fiel) SOLO guardan
  // magnitud, no dirección (moveDiff real: "pwmA=rA" ya viene en abs) —
  // por eso la dirección hay que verificarla en los pines crudos: girar
  // hacia la izquierda usa motor izq en reversa (GPIO4) + motor der
  // adelante (GPIO3), nunca los cuatro pines a la vez avanzando.
  assert(hal.getPwm(4) > 0 && hal.getPwm(3) > 0, "detección asimétrica -> gira hacia el oponente (izq reversa + der adelante)");
  assert(hal.getPwm(5) === 0 && hal.getPwm(2) === 0, "los pines opuestos quedan en 0 (no es un avance recto disfrazado)");
}

console.log("\n8. Bloques COMPLETO (Fase 3 — base real de Runtime Blockly): movimiento, condicionales, variables, GPIO, servo");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  // OP_ADE (avanzar)
  server.handle("GET", "/bloques/add", { op: "1", val: "180" });
  server.handle("GET", "/bloques/run", {});
  server.tick();
  assert(hal.getPwm(5) === 180 && hal.getPwm(3) === 180, "OP_ADE mueve motores adelante con la velocidad indicada (no solo LED)");

  const hal2 = new StubHAL();
  const server2 = createProviderServer(hal2);
  // Semántica REAL confirmada contra el .ino: condición VERDADERA -> progPC+=2
  // (SALTEA la siguiente instrucción); condición FALSA -> progPC+=1 (la ejecuta).
  hal2.setAnalog(0, 100); // NO supera el umbral -> condición falsa -> ejecuta lo que sigue
  server2.handle("GET", "/bloques/add", { op: "70", val: "1800" }); // if ADC0 > 1800
  server2.handle("GET", "/bloques/add", { op: "7", val: "0" });      // LED_ON (se ejecuta porque la condición dio falsa)
  server2.handle("GET", "/bloques/run", {});
  server2.tick();
  server2.tick();
  assert(hal2.getDigital(8) === 0, "OP_IF_GT: condición falsa -> progPC+=1, ejecuta la instrucción siguiente (LED prende)");

  const hal3 = new StubHAL();
  const server3 = createProviderServer(hal3);
  hal3.setAnalog(0, 3000); // SÍ supera el umbral -> condición verdadera -> saltea lo que sigue
  server3.handle("GET", "/bloques/add", { op: "70", val: "1800" });
  server3.handle("GET", "/bloques/add", { op: "7", val: "0" }); // se debe SALTEAR
  server3.handle("GET", "/bloques/add", { op: "8", val: "0" }); // LED_OFF, se ejecuta en su lugar
  server3.handle("GET", "/bloques/run", {});
  server3.tick(); // condición verdadera -> progPC+=2, saltea el LED_ON
  server3.tick(); // ejecuta LED_OFF
  assert(hal3.getDigital(8) === 1, "OP_IF_GT: condición verdadera -> progPC+=2, saltea de verdad la instrucción siguiente");

  const hal4 = new StubHAL();
  const server4 = createProviderServer(hal4);
  server4.handle("GET", "/bloques/add", { op: "60", val: "10" }); // VAR_SET 10
  server4.handle("GET", "/bloques/add", { op: "61", val: "5" });  // VAR_ADD 5
  server4.handle("GET", "/bloques/add", { op: "62", val: "3" });  // VAR_SUB 3
  server4.handle("GET", "/bloques/run", {});
  server4.tick(); server4.tick(); server4.tick();
  const lab4 = server4.handle("GET", "/lab/state", {}).body as any;
  assert(lab4.varGlobal === 12, `variable global: 10+5-3=12 (dio ${lab4.varGlobal})`);

  const hal5 = new StubHAL();
  const server5 = createProviderServer(hal5);
  server5.handle("GET", "/bloques/add", { op: "20", val: "91" }); // OP_DOUT: gpio=9, nivel=1 (empaquetado real val=gpio*10+nivel)
  server5.handle("GET", "/bloques/run", {});
  server5.tick();
  assert(hal5.getDigital(9) === 1, "OP_DOUT desempaqueta gpio/nivel exactamente como el firmware real (val/10, val%10)");

  const hal6 = new StubHAL();
  const server6 = createProviderServer(hal6);
  server6.handle("GET", "/bloques/add", { op: "40", val: "6090" }); // OP_SERVO: gpio=6, ang=90
  server6.handle("GET", "/bloques/run", {});
  server6.tick();
  const lab6 = server6.handle("GET", "/lab/state", {}).body as any;
  assert(lab6.servoGPIO === 6 && lab6.servoAngle === 90, "OP_SERVO desempaqueta gpio/ángulo exactamente como el firmware real (val/1000, val%1000)");
}

console.log("\n9. FASE 3 — OP_JMP: la pieza fundamental que faltaba para CUALQUIER bucle real");
{
  // Bucle real: mientras varGlobal < 3, avanzar y sumar 1 (no desenrollado,
  // no un REPEAT — un while de verdad usando salto incondicional).
  // NOTA: igual que IF_GT/IF_LT reales, la semántica es "condición
  // verdadera -> SALTEA la siguiente instrucción" — para "seguir mientras
  // varGlobal<3" hay que usar la comparación INVERTIDA (IF_VAR_GT con
  // umbral N-1), el mismo detalle no intuitivo que ya documenté para los
  // condicionales reales.
  //   0: VAR_SET 0
  //   1: OP_ADE (avanzar)          <- cuerpo del bucle
  //   2: VAR_ADD 1
  //   3: IF_VAR_GT val=2   (varGlobal>2 ? progPC+=2 (sale) : progPC+=1 (sigue))
  //   4: JMP 1              (vuelve al inicio del cuerpo)
  //   5: STOP                (progPC=6 al terminar)
  //   6: JMP 6               (halt real: se queda acá — si no, al llegar al
  //                           final el programa se reinicia solo, igual que
  //                           el OP_FIN del firmware real)
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/bloques/add", { op: "60", val: "0" });  // VAR_SET 0
  server.handle("GET", "/bloques/add", { op: "1", val: "150" }); // ADE (progPC=1)
  server.handle("GET", "/bloques/add", { op: "61", val: "1" });  // VAR_ADD 1 (progPC=2)
  server.handle("GET", "/bloques/add", { op: "120", val: "2" }); // IF_VAR_GT 2 (progPC=3)
  server.handle("GET", "/bloques/add", { op: "91", val: "1" });  // JMP 1 (progPC=4)
  server.handle("GET", "/bloques/add", { op: "5", val: "0" });   // STOP (progPC=5)
  server.handle("GET", "/bloques/add", { op: "91", val: "6" });  // JMP 6 = halt (progPC=6)
  server.handle("GET", "/bloques/run", {});
  for (let i = 0; i < 15; i++) server.tick(); // de sobra para 3 vueltas + halt, sin riesgo de reiniciarse
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.varGlobal === 3, `el bucle real corrió exactamente 3 vueltas antes de salir (varGlobal=${lab.varGlobal})`);
  assert(lab.progPC === 6, "terminó detenido en el halt (progPC=6), no se reinició solo");
}

console.log("\n10. FASE 3 — OP_CALL/OP_RET: función real reutilizable");
{
  //   0: CALL 3       (llama a la "función" en progPC=3)
  //   1: LED_ON       (se ejecuta después de volver de la función)
  //   2: STOP
  //   3: VAR_SET 42   ("cuerpo" de la función)
  //   4: RET          (vuelve a progPC=1)
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/bloques/add", { op: "92", val: "3" }); // CALL 3
  server.handle("GET", "/bloques/add", { op: "7", val: "0" });  // LED_ON
  server.handle("GET", "/bloques/add", { op: "5", val: "0" });  // STOP
  server.handle("GET", "/bloques/add", { op: "60", val: "42" }); // VAR_SET 42
  server.handle("GET", "/bloques/add", { op: "93", val: "0" });  // RET
  server.handle("GET", "/bloques/run", {});
  for (let i = 0; i < 6; i++) server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.varGlobal === 42, "la función se ejecutó (varGlobal=42)");
  assert(hal.getDigital(8) === 0, "volvió correctamente y siguió ejecutando después del CALL (LED prendido)");
}

console.log("\n11. FASE 3 — funciones matemáticas (map/constrain/abs/min/max) sobre la pila de trabajo");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  // map(50, 0, 100, 0, 255) = 127.5
  for (const v of [50, 0, 100, 0, 255]) server.handle("GET", "/bloques/add", { op: "90", val: String(v) });
  server.handle("GET", "/bloques/add", { op: "95", val: "0" }); // MATH_MAP
  server.handle("GET", "/bloques/run", {});
  for (let i = 0; i < 6; i++) server.tick(); // 5 PUSH + 1 MATH_MAP
  let lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(Math.abs(lab.varGlobal - 127.5) < 0.01, `map(50,0,100,0,255)=127.5 (dio ${lab.varGlobal})`);

  const hal2 = new StubHAL();
  const server2 = createProviderServer(hal2);
  for (const v of [500, 0, 255]) server2.handle("GET", "/bloques/add", { op: "90", val: String(v) }); // constrain(500,0,255)
  server2.handle("GET", "/bloques/add", { op: "96", val: "0" });
  server2.handle("GET", "/bloques/run", {});
  for (let i = 0; i < 4; i++) server2.tick(); // 3 PUSH + 1 MATH_CONSTRAIN
  lab = server2.handle("GET", "/lab/state", {}).body as any;
  assert(lab.varGlobal === 255, `constrain(500,0,255)=255 (dio ${lab.varGlobal})`);
}

console.log("\n12. FASE 3 — OLED: doble buffer real (draft vs shown, como Adafruit_GFX real)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/bloques/add", { op: "101", val: "0" }); // OLED_INIT
  server.handle("GET", "/bloques/add", { op: "102", val: "0" }); // OLED_CLEAR
  server.handle("GET", "/bloques/add", { op: "90", val: "10" }); server.handle("GET", "/bloques/add", { op: "90", val: "20" }); // cursor 10,20
  server.handle("GET", "/bloques/add", { op: "103", val: "0" }); // OLED_CURSOR
  server.handle("GET", "/bloques/add", { op: "104", val: "0", txt: "HOLA" }); // OLED_PRINT
  server.handle("GET", "/bloques/run", {});
  for (let i = 0; i < 6; i++) server.tick(); // INIT, CLEAR, PUSH10, PUSH20, CURSOR, PRINT
  let lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.oled.shown.length === 0, "antes de OLED_DISPLAY, 'shown' sigue vacío (doble buffer real)");
  assert(lab.oled.draft.length === 1 && lab.oled.draft[0].text === "HOLA", "el texto ya está en 'draft' (dibujado, no mostrado todavía)");
  server.handle("GET", "/bloques/add", { op: "108", val: "0" }); // OLED_DISPLAY
  server.tick();
  lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.oled.shown.length === 1 && lab.oled.shown[0].text === "HOLA", "tras OLED_DISPLAY, el texto aparece en 'shown' en la posición correcta");
  assert(lab.oled.shown[0].x === 10 && lab.oled.shown[0].y === 20, "la posición del cursor se respetó");
}

console.log("\n9. FASE 3 (cierre) — OP_BUZZER: frecuencia y duración vía la pila de trabajo");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/bloques/add", { op: "90", val: "440" }); // push freq
  server.handle("GET", "/bloques/add", { op: "90", val: "500" }); // push duracion
  server.handle("GET", "/bloques/add", { op: "123", val: "0" }); // BUZZER
  server.handle("GET", "/bloques/run", {});
  server.tick(); server.tick(); server.tick();
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  assert(lab.buzzerFreqHz === 440 && lab.buzzerDurationMs === 500, `buzzer recibe freq=440Hz dur=500ms (dio ${lab.buzzerFreqHz}/${lab.buzzerDurationMs})`);
}

console.log("\n10. FASE .franky — /proyecto/export y /proyecto/import (HTTP real, convenio 'plain')");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const exp = server.handle("GET", "/proyecto/export", {});
  assert(exp.status === 200, "/proyecto/export responde 200");
  const proyecto = exp.body as any;
  assert(proyecto.format === "FRANKY" && proyecto.version === 2, "el JSON exportado tiene forma FRANKY v2");

  // Import válido: mismo convenio que server.arg("plain") real — el
  // cuerpo completo del .franky viaja en la clave "plain".
  const okImport = server.handle("POST", "/proyecto/import", {}, { plain: JSON.stringify(proyecto) });
  assert(okImport.status === 200, `import válido responde 200 (dio ${okImport.status}, body=${JSON.stringify(okImport.body)})`);

  // Import inválido: cuerpo vacío
  const vacio = server.handle("POST", "/proyecto/import", {}, {});
  assert(vacio.status === 400, "cuerpo vacío responde 400");

  // Import inválido: JSON corrupto
  const corrupto = server.handle("POST", "/proyecto/import", {}, { plain: "{esto no es json" });
  assert(corrupto.status === 400, "JSON corrupto responde 400");

  // Import inválido: sección fuera de rango -> 400, y el estado real no cambia
  const antesTrimA = server.handle("GET", "/api", {}).body as any;
  const malo = { ...proyecto, trim: { motorA: 9999, motorB: 255 } };
  const rechazo = server.handle("POST", "/proyecto/import", {}, { plain: JSON.stringify(malo) });
  assert(rechazo.status === 400, "sección inválida responde 400");
  const despuesTrimA = server.handle("GET", "/api", {}).body as any;
  assert(antesTrimA.trimA === despuesTrimA.trimA, "el import rechazado no modificó el estado real (atomicidad end-to-end)");
}

console.log("\n11. FASE GPIO/I2C — /gpio/estado, /i2c/set (con conflicto real), /i2c/scan (stub sin hardware)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);

  const estado1 = server.handle("GET", "/gpio/estado", {});
  assert(estado1.status === 200, "/gpio/estado responde 200");
  const snap1 = estado1.body as any;
  assert(Array.isArray(snap1.pines) && snap1.pines.length === 13, "/gpio/estado trae los 13 pines");
  assert(snap1.i2c_sda === 6 && snap1.i2c_scl === 7, "par I2C por defecto 6/7");

  // Mini es el perfil activo por defecto (sonar dual: 20,21,6,7) — ya
  // reservado como sensor_sumo por el constructor de FirmwareRuntime.
  const pinLed = snap1.pines.find((p: any) => p.gpio === 8);
  assert(pinLed && pinLed.libre === false && pinLed.motivo === "led", "GPIO8 (LED) reportado ocupado, motivo=led");
  const pin20 = snap1.pines.find((p: any) => p.gpio === 20);
  assert(pin20 && pin20.libre === false && pin20.motivo === "sensor_sumo", "GPIO20 (trigI de Mini) reportado ocupado, motivo=sensor_sumo");

  // CONFLICTO REAL vía HTTP: intentar mover I2C a GPIO20 (ocupado por el
  // sensor de Sumo de Mini) debe rechazarse con 409 y no tocar el estado.
  const conflicto = server.handle("GET", "/i2c/set", { sda: "20", scl: "21" });
  assert(conflicto.status === 409, `GPIO ocupado responde 409 (dio ${conflicto.status})`);
  const estadoTrasConflicto = server.handle("GET", "/gpio/estado", {}).body as any;
  assert(estadoTrasConflicto.i2c_sda === 6 && estadoTrasConflicto.i2c_scl === 7, "tras el 409, el par I2C anterior (6/7) sigue intacto");

  // Faltan parámetros -> 400.
  const sinParams = server.handle("GET", "/i2c/set", {});
  assert(sinParams.status === 400, "sin sda/scl responde 400");

  // /i2c/scan con I2C deshabilitado -> 400 (error común, no un conflicto real — CORRECCIÓN: antes usaba 409, confundible con conflicto de recursos).
  const scanOff = server.handle("GET", "/i2c/scan", {});
  assert(scanOff.status === 400, "/i2c/scan con I2C deshabilitado responde 400");

  // Habilitar I2C (vía /panel/save, sin tocar sda/scl) y reintentar el scan.
  server.handle("GET", "/panel/save", { i2c: "1" });
  const scanOn = server.handle("GET", "/i2c/scan", {});
  assert(scanOn.status === 200, "/i2c/scan con I2C habilitado responde 200");
  assert(Array.isArray(scanOn.body) && (scanOn.body as unknown[]).length === 0, "/i2c/scan devuelve [] — sin hardware I2C simulado, nunca inventa dispositivos");

  // Ahora un par SIN conflicto (GPIO10 y GPIO7 — GPIO7 quedó libre porque
  // Mini reserva 6 (trigD) y 7 (echoD); en este caso probamos con GPIO0? no,
  // 0/1 son ADC_FIJO. Usamos 10, que nunca está ocupado por Sumo/motor/led/boton/adc.
  const sinConflicto = server.handle("GET", "/i2c/set", { sda: "10", scl: "6" });
  // GPIO6 SÍ está ocupado por Mini (trigD) -> debe rechazarse también.
  assert(sinConflicto.status === 409, "GPIO6 (trigD de Mini) también está ocupado -> 409");

  // Cambiar Mini a 1 solo sensor libera trigD/echoD (6/7) antes de tocar I2C.
  server.handle("GET", "/sumo/config", { modo: "mini", numDist: "1" });
  const ahoraSi = server.handle("GET", "/i2c/set", { sda: "6", scl: "7" });
  assert(ahoraSi.status === 200, `con Mini reconfigurado a 1 sensor, GPIO6/7 quedan libres y el I2C se aplica (dio ${ahoraSi.status})`);
  const estadoFinal = server.handle("GET", "/gpio/estado", {}).body as any;
  assert(estadoFinal.i2c_sda === 6 && estadoFinal.i2c_scl === 7, "el nuevo par (6/7) quedó aplicado");
}

console.log("\n12. FASE MONITOR/DEBUG — /monitor/log, /monitor/debug, /log (HTTP real)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);

  const logInicial = server.handle("GET", "/monitor/log", {});
  assert(logInicial.status === 200, "/monitor/log responde 200");
  const bodyInicial = logInicial.body as any;
  assert(bodyInicial.debug === false, "DEBUG apagado por defecto");
  assert(Array.isArray(bodyInicial.entradas), "trae un array de entradas (vacío al arrancar: el constructor no genera logs por sí solo)");

  const toggleOn = server.handle("GET", "/monitor/debug", { on: "1" });
  assert(toggleOn.status === 200 && (toggleOn.body as any).debug === true, "/monitor/debug?on=1 activa DEBUG");
  const toggleOff = server.handle("GET", "/monitor/debug", { on: "0" });
  assert(toggleOff.status === 200 && (toggleOff.body as any).debug === false, "/monitor/debug?on=0 lo desactiva");
  const soloLectura = server.handle("GET", "/monitor/debug", {});
  assert(soloLectura.status === 200 && (soloLectura.body as any).debug === false, "sin 'on', /monitor/debug es de solo lectura (no cambia el estado)");

  // Generar un evento real (MODE_CHANGE) y confirmar que aparece.
  server.handle("GET", "/sumo/mini", {});
  const logConEvento = server.handle("GET", "/monitor/log", {});
  const entradas = (logConEvento.body as any).entradas as any[];
  assert(entradas.some((e) => e.msg.includes("MODE_CHANGE")), "un evento real (arrancar Mini) aparece en /monitor/log");

  const logTexto = server.handle("GET", "/log", {});
  assert(logTexto.status === 200, "/log responde 200");
  assert(typeof logTexto.body === "string" && logTexto.body.includes("FRANKY LAB"), "/log es texto plano y se identifica como LAB virtual");
  assert((logTexto.body as string).includes("SOLO EXISTEN EN UN ESP32 FISICO"), "/log declara explícitamente los datos que no simula");
}

{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const vacio = server.handle("GET", "/bloques/xml", {}).body as any;
  assert(vacio.existe === false, "sin guardar todavía, existe=false");
  const xml = "<xml><block type=\"f_stop\" id=\"a\"></block></xml>";
  const save = server.handle("POST", "/bloques/xml", {}, { plain: xml, hash: "123" });
  assert(save.status === 200, "guardar XML responde 200");
  const leido = server.handle("GET", "/bloques/xml", {}).body as any;
  assert(leido.existe === true && leido.xml === xml, "el XML guardado se puede releer intacto");
  assert(leido.sincronizado === false, "sin marcarFuente todavía, sincronizado=false");
  server.handle("GET", "/bloques/marcarFuente", { hash: "123" });
  const leido2 = server.handle("GET", "/bloques/xml", {}).body as any;
  assert(leido2.sincronizado === true, "tras marcarFuente con el mismo hash, sincronizado=true");
  const save2 = server.handle("POST", "/bloques/xml", {}, { plain: xml.replace("a", "b"), hash: "999" });
  assert(save2.status === 200, "guardar un XML nuevo responde 200");
  const leido3 = server.handle("GET", "/bloques/xml", {}).body as any;
  assert(leido3.sincronizado === false, "tras cambiar el XML sin volver a marcarFuente, sincronizado vuelve a false");
  const sinBody = server.handle("POST", "/bloques/xml", {}, {});
  assert(sinBody.status === 400, "POST sin body responde 400");
}

{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", numDist: "1" }); // libera GPIO6/7 (trigD/echoD) para poder usar I2C
  const ok1 = server.handle("GET", "/i2c/set", { sda: "10", scl: "6" });
  assert(ok1.status === 200, "guardar un par válido responde 200");
  const estado1 = server.handle("GET", "/gpio/estado", {}).body as any;
  assert(estado1.i2c_sda === 10 && estado1.i2c_scl === 6, "el estado refleja el nuevo par tras guardar");
  const invalido = server.handle("GET", "/i2c/set", { sda: "0", scl: "1" });
  assert(invalido.status === 409, "GPIO0/1 (ADC fijo) nunca son válidos para I2C");
  const estado2 = server.handle("GET", "/gpio/estado", {}).body as any;
  assert(estado2.i2c_sda === 10 && estado2.i2c_scl === 6, "tras un intento invalido, el par anterior se conserva intacto");
  const mismoGpio = server.handle("GET", "/i2c/set", { sda: "20", scl: "20" });
  assert(mismoGpio.status === 409, "SDA=SCL se rechaza");
}

console.log("\n15. /panel/save habilita I2C (toggle real del Panel Industrial — efecto real sobre el modelo)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", numDist: "1" }); // libera GPIO6/7 (por defecto ocupados por el sonar dual de Mini)
  const antes = server.handle("GET", "/api", {}).body as any;
  assert(antes.i2c === 0, "I2C deshabilitado por defecto");
  server.handle("GET", "/panel/save", { i2c: "1" });
  const despues = server.handle("GET", "/api", {}).body as any;
  assert(despues.i2c === 1, "tras habilitar I2C desde el Panel, queda reflejado en el modelo — efecto real, no solo visual");
  const gpio = server.handle("GET", "/gpio/estado", {}).body as any;
  const pinSda = gpio.pines.find((p: any) => p.gpio === gpio.i2c_sda);
  assert(pinSda.motivo === "i2c", "el GPIO SDA queda reservado como i2c en el mapa central de recursos (mismo sistema, no paralelo)");
}

{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/panel/save", { i2c: "1" });
  server.handle("GET", "/oled/test", { size: "96" });
  server.handle("GET", "/oled/logo", {});
  const lab = server.handle("GET", "/lab/state", {}).body as any;
  const logoEl = lab.oled.shown.find((e: any) => e.kind === "bitmap");
  assert(!!logoEl, "el logo se dibuja como kind='bitmap' (no como texto placeholder)");
  assert(logoEl.anchoBits === 128 && logoEl.altoBits === 64, "dimensiones correctas para 0.96\" (128x64)");
  assert(logoEl.bitmap.length === 2048, `bitmap de 128x64 = 2048 chars hex (dio ${logoEl.bitmap.length})`);
  assert(/^[0-9a-f]+$/.test(logoEl.bitmap), "el bitmap es hex válido");

  const server2 = createProviderServer(new StubHAL());
  server2.handle("GET", "/panel/save", { i2c: "1" });
  server2.handle("GET", "/oled/test", { size: "91" });
  server2.handle("GET", "/oled/logo", {});
  const lab2 = server2.handle("GET", "/lab/state", {}).body as any;
  const logoEl2 = lab2.oled.shown.find((e: any) => e.kind === "bitmap");
  assert(logoEl2.altoBits === 32 && logoEl2.bitmap.length === 1024, `bitmap de 128x32 = 1024 chars hex (dio ${logoEl2.bitmap.length})`);
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);

console.log("\n17. PERSISTENCIA SUMO — FLUJO A: configurar → salir/volver (simulado) → recuperar configuración");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", tipo: "sharp", numDist: "1", numBorde: "0", sharpI: "1", umbral_sharp: "1234", spdAtaque: "111" });
  // "Salir y volver" = una página nueva que solo tiene /proyecto/export para reconstruir su UI (nunca localStorage).
  const proyecto = server.handle("GET", "/proyecto/export", {}).body as any;
  assert(proyecto.sumo.mini.tipoDistSensor === 2, "tipoDistSensor (sharp=2) se recupera vía /proyecto/export");
  assert(proyecto.sumo.mini.sharpPinI === 1, "sharpPinI se recupera");
  assert(proyecto.sumo.mini.umbralSharp === 1234, "umbralSharp se recupera");
  assert(proyecto.sumo.mini.spdAtaque === 111, "spdAtaque se recupera");
}

console.log("\n18. PERSISTENCIA SUMO — FLUJO B: configurar → exportar → cambiar → importar anterior → recuperar original");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "mini", spdAtaque: "200", numDist: "1" });
  const original = server.handle("GET", "/proyecto/export", {}).body;
  server.handle("GET", "/sumo/config", { modo: "mini", spdAtaque: "77", numDist: "1" }); // cambio
  const cambiado = server.handle("GET", "/api", {}).body as any;
  assert(cambiado.s_atk === 77, "la config cambió realmente antes de re-importar");
  const restaurar = server.handle("POST", "/proyecto/import", {}, { plain: JSON.stringify(original) });
  assert(restaurar.status === 200, "importar el proyecto anterior se acepta");
  const final = server.handle("GET", "/api", {}).body as any;
  assert(final.s_atk === 200, "spdAtaque vuelve al valor original tras importar (200, no 77)");
}

console.log("\n19. MODO DE INICIO — nomenclatura real y defaults (sumoInicioServidor=true, sumoInicioBoton=false)");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const api = server.handle("GET", "/api", {}).body as any;
  assert(api.s_inicio_srv === 1, "por defecto, inicio desde servidor HABILITADO (igual que el .ino real)");
  assert(api.s_inicio_btn === 0, "por defecto, inicio desde botón DESHABILITADO (igual que el .ino real)");
}

console.log("\n20. FLUJO C — Inicio desde Servidor: gate sumoInicioServidor");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { inicioServidor: "0" });
  const r = server.handle("GET", "/sumo/mini", {});
  assert(r.status !== 200 || (r.body as any).ok === false, "con inicio-desde-servidor deshabilitado, /sumo/mini NO arranca Sumo");
  const api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === 0, "el modo sigue IDLE — no arrancó nada");
  server.handle("GET", "/sumo/config", { inicioServidor: "1" });
  const r2 = server.handle("GET", "/sumo/mini", {});
  const api2 = server.handle("GET", "/api", {}).body as any;
  assert(api2.mode === 2, "con inicio-desde-servidor habilitado de nuevo, /sumo/mini SÍ arranca (mode=2=MINI)");
}

console.log("\n21. FLUJO D — Inicio desde el botón virtual: doble gate + usa SIEMPRE el perfil ya activo");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  // Gate 1: boton deshabilitado por defecto -> no debe hacer nada.
  const sinHabilitar = server.handle("GET", "/sumo/boton", {});
  assert(sinHabilitar.status !== 200 || (sinHabilitar.body as any).ok === false, "botón deshabilitado por defecto -> sin efecto");
  assert((server.handle("GET", "/api", {}).body as any).mode === 0, "sigue IDLE");

  // Habilitar el botón; perfil activo por defecto es Mini.
  server.handle("GET", "/sumo/config", { inicioBoton: "1" });
  const r = server.handle("GET", "/sumo/boton", {});
  assert(r.status === 200, "con el botón habilitado y el robot IDLE, el botón SÍ arranca Sumo");
  const api = server.handle("GET", "/api", {}).body as any;
  assert(api.mode === 2, "arrancó con el perfil YA activo (Mini=2) — el botón no elige perfil, igual que el real");

  // Gate 2: mientras está corriendo (no IDLE), una segunda pulsación no debe hacer nada.
  const r2 = server.handle("GET", "/sumo/boton", {});
  assert(r2.status !== 200 || (r2.body as any).ok === false, "con el robot ya corriendo (no IDLE), el botón no tiene efecto (mismo gate que el real)");
}

console.log("\n22. FLUJO E — Sumo + modo de inicio: exportar/importar recupera AMBOS estados juntos");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  server.handle("GET", "/sumo/config", { modo: "micro", spdAtaque: "222", inicioServidor: "0", inicioBoton: "1" });
  const proyecto = server.handle("GET", "/proyecto/export", {}).body as any;
  assert(proyecto.sumo.inicio.servidor === false && proyecto.sumo.inicio.boton === true, "el .franky exportado incluye el modo de inicio real (no un valor fijo)");
  assert(proyecto.sumo.micro.spdAtaque === 222, "y también la config de Sumo modificada");

  const server2 = createProviderServer(new StubHAL());
  const importar = server2.handle("POST", "/proyecto/import", {}, { plain: JSON.stringify(proyecto) });
  assert(importar.status === 200, "importar en un Laboratorio limpio se acepta");
  const api2 = server2.handle("GET", "/api", {}).body as any;
  assert(api2.s_inicio_srv === 0 && api2.s_inicio_btn === 1, "el modo de inicio se recuperó tras importar");
  assert((server2.handle("GET", "/proyecto/export", {}).body as any).sumo.micro.spdAtaque === 222, "y la config de Sumo también se recuperó");
}

console.log("\n23. FLUJO F — Compatibilidad .franky: un archivo SIN sección 'inicio' (formato anterior) sigue importando bien");
{
  const hal = new StubHAL();
  const server = createProviderServer(hal);
  const proyecto = server.handle("GET", "/proyecto/export", {}).body as any;
  delete proyecto.sumo.inicio; // simula un .franky exportado ANTES de esta fase
  const r = server.handle("POST", "/proyecto/import", {}, { plain: JSON.stringify(proyecto) });
  assert(r.status === 200, "un .franky sin sección 'inicio' (formato viejo) se importa igual, sin romperse");
  const api = server.handle("GET", "/api", {}).body as any;
  assert(api.s_inicio_srv === 1 && api.s_inicio_btn === 0, "sin esa sección, se conservan los valores por defecto (no se corrompe el estado)");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
