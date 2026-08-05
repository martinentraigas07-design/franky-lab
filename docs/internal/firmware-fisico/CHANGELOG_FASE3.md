# FRANKY 4.0 — Actualización de Fase 3 (FRANKY LAB → Servidor Web oficial)

Este proyecto es el Servidor Web + Firmware oficial de FRANKY, actualizado
con las correcciones y extensiones validadas en FRANKY LAB (Laboratorio
Virtual). Todo lo que sigue fue verificado antes de incorporarse acá.

## Cambios en `esp32c3_franky_SPIFFS.ino`

### Corrección crítica
- **`OP_JMP` (opcode 91, salto incondicional)**: sin esto, `f_if_gt`/`f_if_lt`
  del Bloques oficial solo condicionaban la PRIMERA instrucción de un
  bloque "si...entonces" de varias instrucciones — el resto se ejecutaba
  siempre, sin importar el sensor. `f_while_gt` no funcionaba en absoluto
  (caía al `default`, reiniciaba el programa). Ambos corregidos en
  `bloques.html` usando este opcode.

### Extensión (Fase 3 — capacidades educativas nuevas)
- **`OP_PUSH` (90)**: pila de trabajo de 8 elementos — necesaria porque
  una instrucción `{op, val}` solo tiene UN parámetro numérico, y varias
  operaciones nuevas necesitan varios (ej. dibujar una línea necesita 4
  coordenadas).
- **`OP_CALL`/`OP_RET` (92/93)**: llamada/retorno de función real, con
  pila de retorno propia (8 niveles).
- **`OP_MILLIS_READ` (94)**: lee el reloj real a la variable global.
- **OLED real (opcodes 101-108)**: `Adafruit_SSD1306` estaba incluida en
  el firmware desde siempre pero **nunca se inicializaba ni se usaba**.
  Ahora sí — `display.begin()`, `clearDisplay()`, `setCursor()`,
  `drawLine()`, `drawRect()`, `drawCircle()`, `display()` — todo
  conectado a los bloques `f_oled_clear`/`f_oled_text`/`f_oled_show` del
  Bloques oficial.
  - **Limitación conocida**: `f_oled_text` (opcode 104) todavía NO puede
    mostrar el texto real en el robot físico — el struct `Instruccion`
    solo tiene `{op, val}`, sin lugar para una cadena de texto. El
    opcode está implementado como **no-op seguro** (avanza el programa
    sin interrumpirlo) en vez de caer al `default` y reiniciar todo. En
    FRANKY LAB (el simulador) sí funciona completo, porque ahí el struct
    de instrucción sí tiene un campo de texto opcional.
- **Monitor Serie (`OP_SERIAL_PRINT`, 122)**: mismo motivo y misma
  limitación que OLED_PRINT — no-op seguro, imprime un aviso genérico por
  el puerto serie real en vez del mensaje del programa.
- **Buzzer (`OP_BUZZER`, 123)**: **no existe el componente en la placa**
  (confirmado contra el BOM real, `MAINBOARDFRANKY4_0.csv` — sin pin
  libre documentado). No-op seguro. Requiere una decisión de hardware
  (agregar el componente), no solo de firmware.

### Otro
- `handleBloquesAdd()`: ahora responde con error HTTP 400 claro cuando el
  programa llega al límite de 64 instrucciones, en vez de descartar la
  instrucción en silencio y responder "OK" igual.

## Cambios en `data/bloques.html`

- Corregido `f_if_gt`/`f_if_lt`: ahora arman `[COND][JMP-si-falso][CUERPO]`,
  condicionando el bloque "entonces" completo, no solo la primera línea.
- Agregado `case` para `f_while_gt` (antes no existía — el bloque se
  ignoraba en silencio al "Ejecutar", aunque el código C++ generado sí se
  veía bien — desajuste ya corregido).
- `f_oled_clear`/`f_oled_text`/`f_oled_show` y `f_serial_print`: antes
  generaban SOLO código C++ — ahora también generan los opcodes reales de
  arriba.
- Corregido el envío HTTP: `fetch("/bloques/add?...")` no mandaba el
  parámetro `txt` (usado por OLED/Serial) ni revisaba el código de estado
  de la respuesta — ambos corregidos.
- Bloque nuevo: `f_buzzer` (opcode 123).
- Bloques nuevos, solo C++ (documentados, sin simular todavía):
  `f_mcp3208_read`, `f_qtr8a_read` — mismo criterio que los bloques PID
  existentes (`f_pid_*`, que tampoco tienen opcode real: confirmado que
  el firmware ni siquiera usa `PID_v1_bc.h` más allá del `#include`).

## Verificación realizada

- Compilación real con `arduino-cli` + toolchain RISC-V de ESP32-C3
  (cross-compilador auténtico, no una revisión manual): las funciones
  modificadas (`ejecutarBloque()`, `handleBloquesAdd()`) compilan sin
  errores ni advertencias (`-Wall`) contra los tipos y objetos reales del
  firmware.
- El pipeline de compilación automático completo (`arduino-cli compile`
  de punta a punta) no se pudo validar en este entorno por una
  incompatibilidad de la herramienta `ctags` genérica con el generador de
  prototipos de `arduino-builder` — confirmado que es un problema de
  tooling, no del código fuente (la salida de `ctags` sí tiene la
  información correcta). **Recomendación: compilar una vez más con el
  Arduino IDE normal antes de flashear a un robot físico**, para
  descartar cualquier problema en secciones del archivo no cubiertas por
  la verificación aislada.
- `data/bloques.html`: 10 pruebas automatizadas extraídas del archivo
  real (no una copia), ejecutadas contra el intérprete completo — todas
  en verde.

## Pendiente para una futura actualización

- Extender `struct Instruccion` con un campo de texto para que
  `OP_OLED_PRINT`/`OP_SERIAL_PRINT` funcionen de verdad en el robot
  físico (hoy son no-ops seguros). Esto también requiere actualizar el
  formato de guardado en NVS (`guardarProg()`/`cargarProg()`).
- MCP3208/QTR8A: requieren librería SPI + hardware nuevo, sin empezar.
- Buzzer: requiere agregar el componente a la placa.
