# FRANKY-LAB — Programación no bloqueante con millis() (TP5 Actividad 13) — instalación, build y publicación

Este paquete tiene dos carpetas:

```
SOURCE/              ← código fuente completo (TypeScript, Blockly, firmware
                        de Laboratorio, tests, scripts de build, docs)
DIST_GITHUB_PAGES/   ← distribución YA COMPILADA, lista para publicar en
                        GitHub Pages tal cual (no requiere Node/npm)
```

`SOURCE/` conserva exactamente la misma estructura de raíz que la entrega
corregida anterior (`FRANKY_LAB_FASE2_P0_CORREGIDO.zip`, ya confirmada
funcional): `core/`, `boards/`, `build/`, `docs/`, `mcu/`, `public-src/`,
`.gitignore`, `.github/` — todos sin cambios — más `providers/` y
`package.json`, que son los únicos tocados por esta actualización (ver
el informe técnico adjunto, `Informe_Tecnico_Millis_No_Bloqueante.md`,
para el detalle archivo por archivo). `node_modules/`, `dist/`,
`dist-sw/`, `public/` y `gh-pages/` quedan fuera a propósito (son 100%
generados por `npm run build:release`, no se versionan — ver `.gitignore`).

`npm install && npm run build:release` corrido desde `SOURCE/` tal cual
viene en este ZIP fue probado de punta a punta en esta entrega (build
completo + `npm test` + `npm run test:e2e`, 687 aserciones, 0 fallos)
antes de empaquetar — incluye las 22 aserciones nuevas de esta
actualización (`millis-compiler.e2e.mjs` + `millisNoBloqueante.e2e.mjs`,
ver §Tests).

## Si solo querés publicar el sitio (sin tocar código)

Subí el contenido de `DIST_GITHUB_PAGES/` como la raíz de tu GitHub Pages
(Settings → Pages → Deploy from branch → selecciona la rama/carpeta que
contenga esto en la raíz). Primera visita: abrir `/start.html` una vez
(registra el Service Worker); visitas siguientes: `/index.html` directo.

## Si vas a modificar el código fuente

```bash
cd SOURCE
npm install
npm run build:release   # tsc + tsc:sw + copy-to-public + copy-to-ghpages + copy-to-root
```

`npm run build:release` encadena:
1. `build` — `tsc -p tsconfig.json` (lógica de dominio: `core/`, `providers/*/firmware`, `providers/*/server`)
2. `build:sw` — `tsc -p tsconfig.sw.json` (Service Worker)
3. `build:public` — ensambla `dist/` + `dist-sw/` + los assets estáticos (`providers/*/assets/`) en `public/`, genera el shim `sw.js`, copia `loader.html` → `start.html`
4. `build:ghpages` — copia `public/*` a `gh-pages/` (1:1, lista para GitHub Pages)
5. `build:root` — copia `gh-pages/*` a la raíz del repo (para el modo "Deploy from branch → / root")

**No alcanza con que `tsc` compile sin errores** — correr siempre la cadena completa (`build:release`), no solo `build`, antes de dar por buena una distribución.

### Tests

```bash
npm test          # suites unitarias existentes (sin cambios en esta actualización)
npm run test:e2e  # 9 scripts e2e — los 7 ya existentes + los 2 nuevos de esta actualización:
                   #   millis-compiler.e2e.mjs      (7 aserciones)  — compila XML de Blockly REAL
                   #                                                  con el compilador real de
                   #                                                  bloques.html y verifica que
                   #                                                  "f_millis" emite el opcode
                   #                                                  real (94), no una constante 0
                   #   millisNoBloqueante.e2e.mjs    (15 aserciones) — Pruebas A, B, C y D del
                   #                                                  enunciado, sobre el intérprete
                   #                                                  real (FirmwareRuntime) con un
                   #                                                  reloj simulado controlable
npm run test:all  # ambas — 687 aserciones en total, 0 fallaron (corrida completa verificada en esta entrega)
```

### Verificar sólo la parte nueva, en aislamiento

```bash
node providers/franky-server-4.0/tests/millis-compiler.e2e.mjs
node providers/franky-server-4.0/tests/millisNoBloqueante.e2e.mjs
```
(Requieren `npm run build` primero — ambos importan desde `dist/`.)

## Qué se agregó en esta actualización (resumen — ver el informe técnico para el detalle completo)

1. El bloque "millis()" se trasladó de la categoría **Sensores** a
   **Tiempo** en el toolbox de `bloques.html` (compartido por ambos
   proyectos).
2. Se descubrió y corrigió la causa raíz real del bug reportado: el
   compilador de Blockly (`compileExpr()` en `bloques.html`) **nunca
   tuvo un `case` para `f_millis`** — el bloque se veía bien, generaba
   el texto de referencia "millis()" en la pestaña de código C++, pero
   al compilarse a bytecode cada vez caía en el `default` genérico, que
   empuja una constante `0`. El programa compilado jamás leía el reloj
   real, sin importar qué tan bien se viera o se explicara el bloque.
3. Se agregó el opcode real `PUSH_MILLIS` (reutilizando el nº 94, ya
   reservado pero muerto en ambos intérpretes) en los tres lugares que
   tienen que coincidir: el compilador (`bloques.html`), el intérprete
   del Laboratorio (`providers/franky-server-4.0/firmware/runtime.ts`)
   y el firmware físico (`esp32c3_franky_SPIFFS.ino`, ver el ZIP del
   Server).
4. Se implementó una estrategia de desborde segura a 16 bits (nunca
   saturación/clamp) para que la comparación clásica de Arduino
   `actual - anterior >= intervalo` siga siendo válida incluso cuando
   el contador de milisegundos "da la vuelta".
5. Se documentó y resolvió (con bloques ya existentes, sin opcodes ni
   bloques nuevos) una limitación estructural real de la arquitectura
   de ambos proyectos: no existe un "setup() una sola vez" separado del
   "loop() que se repite" — todo el programa compilado se reinicia
   desde el principio en cada vuelta. Ver el informe técnico, sección
   "Limitaciones estructurales encontradas", para el detalle y el
   patrón de inicialización-con-guardia recomendado para los docentes.

## Limitación explícita — firmware físico

Esta actualización modifica **ambos** proyectos (ver el ZIP separado
`FRANKY_SERVER_MILLIS.zip` para el firmware físico). El `.ino` no pudo
compilarse de verdad en este entorno por falta de acceso al toolchain
real de Arduino/ESP32-C3 — se verificó en su lugar con una comprobación
estructural (balance de llaves/paréntesis, sin `case` duplicados, mismo
recuento de opcodes que la línea de base ya verificada) y con revisión
manual línea por línea del cambio. Ver el informe técnico para el
detalle completo de qué se ejecutó de verdad, qué se verificó solo por
revisión de código, y qué queda pendiente de prueba sobre hardware real.
