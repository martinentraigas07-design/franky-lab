# Migración a firmware físico — Estado real tras el cierre de Fase 3

**Este documento reemplaza la versión anterior**, escrita antes de tener
acceso al firmware real. Aquella versión (`FRANKY_4_0_v4_1.ino`, variante
BLE de identidad multi-robot) no era el archivo correcto: no contiene el
intérprete de bloques. El archivo correcto es
**`esp32c3_franky_SPIFFS.ino`** (variante Servidor Web/REST), recibido
en el cierre de Fase 3 — este documento está verificado línea por línea
contra ese archivo real, no contra una inferencia del Runtime de
Laboratorio.

**Buena noticia:** la mayor parte de lo que el documento anterior
describía como "pendiente de portar" **ya está portado y funcionando**
en el firmware físico. Lo que queda pendiente es más acotado de lo que
se pensaba.

---

## 1. Qué ya está en el firmware físico (verificado en `esp32c3_franky_SPIFFS.ino`)

| Opcode(s) | Qué es | Estado |
|---|---|---|
| 0–74 | Movimiento, LED, ADC, servo, variables simples, condicionales fijos a ADC0, `OP_REPEAT` (74) | ✅ Ya existía |
| 90 `OP_PUSH` | Pila de trabajo (8 elementos) | ✅ Portado |
| 91 `OP_JMP` | Salto incondicional — **corrige un bug real**: sin esto, `f_if_gt`/`f_if_lt` solo condicionaban la primera instrucción del bloque "entonces", y `f_while_gt` no funcionaba en absoluto | ✅ Portado y corregido en `bloques.html` |
| 92/93 `OP_CALL`/`OP_RET` | Funciones reales con pila de retorno propia (8 niveles) | ✅ Portado |
| 94 `OP_MILLIS_READ` | Lee `millis()` a la variable global | ✅ Portado |
| 101–108 OLED | `Adafruit_SSD1306` — init, clear, cursor, línea, rectángulo, círculo, display (doble buffer real) | ✅ Portado — **con una limitación**, ver sección 2 |
| 122 `OP_SERIAL_PRINT` | Monitor Serie | ⚠️ Portado como no-op seguro, ver sección 2 |
| 123 `OP_BUZZER` | Buzzer | ⚠️ Portado como no-op seguro (sin hardware), ver sección 3 |
| — | `handleBloquesAdd()` responde `400` con mensaje claro al llegar a 64 instrucciones, en vez de descartar en silencio | ✅ Corregido |
| — | `bloques.html`: `fetch()` a `/bloques/add` ahora revisa el código de estado de la respuesta y propaga el error | ✅ Corregido (sincronizado en el asset fuente de Laboratorio en este mismo cierre) |

Todos estos cambios fueron verificados por Martín con `arduino-cli` +
toolchain RISC-V real (compilación auténtica de las funciones
modificadas, sin errores ni warnings con `-Wall`) y contra 10 pruebas
automatizadas extraídas del `bloques.html` real. El pipeline de
compilación automático punta a punta no se pudo validar por una
incompatibilidad de tooling (`ctags` vs `arduino-builder`) ajena al
código — **recomendación vigente: compilar una vez más con el Arduino
IDE normal antes de flashear a un robot físico**, para descartar
cualquier problema no cubierto por la verificación aislada.

---

## 2. Limitación real y compartida: `Instruccion` sin campo de texto

`struct Instruccion { uint8_t op; int16_t val; };` — un único parámetro
numérico. `OP_OLED_PRINT` (104) y `OP_SERIAL_PRINT` (122) necesitan
texto, no solo un número. Mientras no se resuelva esto:

- **`OP_OLED_PRINT`**: no-op explícito (avanza el programa, no dibuja
  texto). Antes de este cierre, un opcode no reconocido caía en el
  `default` y **reiniciaba todo el programa** — eso ya está corregido
  (ahora es un no-op seguro), pero el texto en sí todavía no se muestra.
- **`OP_SERIAL_PRINT`**: imprime un aviso genérico fijo por el puerto
  serie real, no el mensaje del programa del alumno.
- El resto de OLED (clear, cursor, línea, rectángulo, círculo,
  mostrar) **funciona completo** — dibujar figuras ya es 100% real en
  el robot físico hoy. Solo el texto queda pendiente.

`bloques.html` ya envía el parámetro `txt` por HTTP
(`/bloques/add?...&txt=...`) — el firmware simplemente todavía no lo
lee ni lo guarda (`handleBloquesAdd()` solo toma `op` y `val`).

### Camino de solución (sin implementar todavía — decisión de Martín)

```cpp
struct Instruccion {
  uint8_t op;
  int16_t val;
  char txt[24];   // "" en toda instrucción que no sea OLED_PRINT/SERIAL_PRINT
};
```

Con 64 instrucciones (`MAX_INST`), el arreglo pasa de 3 a 27 bytes por
instrucción — de 192 a 1728 bytes. Debería tolerarlo sin problema un
ESP32-C3 (320KB RAM), pero no se verificó contra el uso de RAM real del
firmware actualizado; confirmar antes de aplicar.

También requiere:
- `handleBloquesAdd()`: leer `server.arg("txt")` y copiarlo a
  `programa[progLen].txt` (con límite de 23 caracteres + `\0`).
- `guardarProg()`/`cargarProg()` (NVS): el formato de guardado guarda
  hoy `{op, val}` por instrucción — hay que extenderlo para persistir
  también `txt`, o el texto se perdería al reiniciar el robot.
- Los casos `OP_OLED_PRINT`/`OP_SERIAL_PRINT` en `ejecutarBloque()`: dejan
  de ser no-op y pasan a usar `ins.txt` (igual que ya hace el Runtime de
  Laboratorio, que sirvió de referencia validada para este mismo cambio).

---

## 3. Buzzer — no es un problema de firmware, es de placa

Confirmado contra el BOM real (`MAINBOARDFRANKY4_0.csv`): **no hay
componente de buzzer ni pin reservado** en la placa actual. El opcode
123 ya existe en el firmware, ya descarta correctamente los dos valores
de la pila (frecuencia/duración) que `bloques.html` empuja, y no rompe
nada — pero no puede sonar hasta que exista el hardware.

Esto es una decisión de **hardware**, no de software: agregar el
componente (y un GPIO libre) a una futura revisión de la placa. Una vez
resuelto eso, el firmware solo necesita reemplazar el no-op por
`tone(PIN_BUZZER, freq, duracion);` — el opcode y el parseo de la pila
ya están listos.

---

## 4. Lo que sigue sin portar (no estaba en el firmware recibido)

Estos opcodes existen en el Runtime de Laboratorio (simulados,
100% probados) pero **no aparecen en `esp32c3_franky_SPIFFS.ino`** — no
fueron parte de este cierre de Fase 3:

| Opcode(s) | Qué es | Nota |
|---|---|---|
| 95–100 | Funciones matemáticas (`map`, `constrain`, `abs`, `min`, `max`, `random`) sobre la pila de trabajo | Sin dependencias de hardware nuevo — solo usan la pila (90), ya portada |
| 110–114 | Lectura de sensores (borde izq/der, línea izq/centro/der) como valor de variable | Requiere confirmar si hay sensores de línea física conectados en la placa actual antes de que tenga sentido portarlos |
| 120/121 | Condicionales sobre variable (`OP_IF_VAR_GT`/`LT`) — hoy los condicionales físicos (70/71) están fijos a ADC0 | Necesario para "repetir mientras variable > umbral"; no rompe 70/71, es aditivo |

Ninguno de estos es urgente — son extensiones educativas, no
correcciones de bugs. Se pueden portar en una futura ronda con el mismo
patrón aditivo ya usado en Fase 3 (agregar `case` al switch, nunca tocar
uno existente).

## 5. Sin empezar — requiere hardware/librería nueva

- **MCP3208** (ADC externo SPI de 8 canales) y **QTR-8A** (array de
  línea vía MCP3208): los bloques ya existen en `bloques.html`
  (`f_mcp3208_read`, `f_qtr8a_read`) pero **solo generan código C++
  documentado**, sin opcode real — mismo criterio ya usado para los
  bloques PID existentes (`f_pid_*`, que tampoco tienen opcode: el
  firmware ni siquiera usa `PID_v1_bc.h` más allá del `#include`).
  Requiere librería SPI y hardware nuevo conectado.

---

## 6. Device Model de Laboratorio — actualizar

`core/src/deviceModel.ts` todavía marca `real: false` para `oled`,
`serial` y `mcp3208`/`qtr8a`. Tras este cierre, corresponde:

- `oled`: pasar a `real: true` (el dibujo funciona; el texto no —
  considerar un tercer estado si se quiere ser más preciso, o dejarlo en
  `true` con una nota, ya que la mayoría de las capacidades sí son
  reales).
- `serial`: dejar en `false` hasta que el mensaje real se imprima (hoy
  el firmware imprime un aviso genérico, no el mensaje del programa —
  no es equivalente funcional todavía).
- `buzzer`: dejar en `false` — sigue sin hardware.
- `mcp3208`/`qtr8a`: sin cambios, siguen sin opcode.

No se aplicó este cambio en este cierre para no mezclar auditoría de
FRANKY LAB con la migración de firmware — queda como tarea separada,
de decisión de Martín, para cuando se confirme el criterio de
"real" a usar en el caso intermedio de OLED.

---

## 7. Orden recomendado para lo que queda

1. Extender `struct Instruccion` con `txt[24]` + persistencia NVS — es
   lo único que bloquea que OLED_PRINT y Serial funcionen de verdad.
2. Funciones matemáticas (95–100) — sin dependencias, solo usan la pila
   ya portada.
3. Condicionales y lectura sobre variable (110–114, 120/121) — solo si
   hay sensores de línea física conectados.
4. Buzzer real — cuando exista la decisión de hardware.
5. MCP3208/QTR8A — cuando exista el hardware SPI conectado.

Cada paso sigue siendo aditivo e independiente, como ya lo demostró esta
misma ronda de Fase 3.
