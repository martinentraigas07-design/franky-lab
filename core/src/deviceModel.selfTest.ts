import { DEVICE_MODEL, devicesUsedByProgram, detectPinConflicts } from "./deviceModel.js";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("1. Solo aparecen los dispositivos que el programa realmente usa");
{
  const used = devicesUsedByProgram([1, 5, 7]); // avanzar, stop, led_on
  const ids = used.map((d) => d.id);
  assert(ids.includes("motores") && ids.includes("led"), "motores y LED detectados");
  assert(!ids.includes("oled") && !ids.includes("servo") && !ids.includes("serial"), "OLED/Servo/Serial NO aparecen si el programa no los usa");
}

console.log("\n2. Un programa que usa OLED muestra el módulo OLED, y ningún otro de más");
{
  const used = devicesUsedByProgram([101, 102, 104, 108]);
  const ids = used.map((d) => d.id);
  assert(ids.length === 1 && ids[0] === "oled", `solo OLED (dio: ${ids.join(",")})`);
}

console.log("\n3. Programa vacío -> ningún dispositivo (Hardware Workspace vacío, no paneles fijos)");
{
  const used = devicesUsedByProgram([]);
  assert(used.length === 0, "sin instrucciones, sin dispositivos mostrados");
}

console.log("\n4. Conflicto real encontrado en este proyecto: OLED y el sensor de línea (centro) comparten GPIO6");
{
  const oled = DEVICE_MODEL.find((d) => d.id === "oled")!;
  const linea = DEVICE_MODEL.find((d) => d.id === "linea_centro")!;
  const conflicts = detectPinConflicts([oled, linea]);
  assert(conflicts.length === 1 && conflicts[0].pin === 6, `detecta el choque real en GPIO6 (dio ${JSON.stringify(conflicts)})`);
}

console.log("\n5. Dos dispositivos I2C en el mismo bus NO son un conflicto (comparten sharedResource a propósito)");
{
  // Simulamos un segundo dispositivo I2C hipotético en el mismo bus, sin
  // pines fijos en común con OLED, para probar que compartir bus no alcanza
  // para marcarlo como choque.
  const oled = DEVICE_MODEL.find((d) => d.id === "oled")!;
  const otroI2C = { ...oled, id: "otro_i2c", pins: [], sharedResource: "i2c-bus-0" };
  const conflicts = detectPinConflicts([oled, otroI2C]);
  assert(conflicts.length === 0, "sin pines en común, compartir el mismo bus I2C no genera falso positivo");
}

console.log("\n6. Todo dispositivo declara si es real (firmware físico) o extensión de Laboratorio");
{
  const oled = DEVICE_MODEL.find((d) => d.id === "oled")!;
  const motores = DEVICE_MODEL.find((d) => d.id === "motores")!;
  assert(oled.real === false, "OLED marcado como NO real (extensión de Fase 3)");
  assert(motores.real === true, "Motores marcado como real (firmware físico)");
}

console.log(`\n${passed} pasaron, ${failed} fallaron.`);
if (failed > 0) process.exit(1);
