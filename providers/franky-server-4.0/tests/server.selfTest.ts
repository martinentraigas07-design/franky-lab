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

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
