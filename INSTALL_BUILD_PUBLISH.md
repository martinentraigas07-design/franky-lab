# FRANKY-LAB — Fase 2 P0 corregida — instalación, build y publicación

Este paquete tiene dos carpetas:

```
SOURCE/              ← código fuente completo (TypeScript, Blockly, firmware
                        de Laboratorio, tests, scripts de build, docs)
DIST_GITHUB_PAGES/   ← distribución YA COMPILADA, lista para publicar en
                        GitHub Pages tal cual (no requiere Node/npm)
```

`SOURCE/` se verificó carpeta por carpeta contra la raíz real del repositorio
`franky-lab` (rama `fase2-p0-validacion`, vía `git clone`): `core/`, `boards/`,
`build/`, `docs/`, `mcu/` son idénticos byte a byte; `providers/` y
`package.json` difieren únicamente en los archivos que corrige esta entrega
(ver §"Qué se corrigió..." más abajo). `SOURCE/` incluye también `public-src/`
(los 3 archivos fuente — `loader.html`, `lab.html`, `blockly-compiler.mjs` —
que lee `build/copy-to-public.mjs`; **sin esta carpeta `npm run build:release`
falla** con `ENOENT public-src/loader.html`), `.gitignore` y `.github/`
(el workflow de CI del repo), para que la estructura de `SOURCE/` sea un
espejo completo de la raíz del repo y puedas copiarla ahí sin reorganizar
nada. `node_modules/`, `dist/`, `dist-sw/`, `public/` y `gh-pages/` quedan
fuera a propósito (son 100% generados por `npm run build:release` — no se
versionan, ver `.gitignore`).

`npm install && npm run build:release` corrido desde `SOURCE/` tal cual viene
en este ZIP fue probado de punta a punta en esta entrega (build completo +
554+212 aserciones, 0 fallos) antes de empaquetar.

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
2. `build:sw` — `tsc -p tsconfig.sw.json` (Service Worker, build separado porque corre en un scope distinto)
3. `build:public` — ensambla `dist/` + `dist-sw/` + los assets estáticos (`providers/*/assets/`) en `public/`, genera el shim `sw.js`, copia `loader.html` → `start.html`
4. `build:ghpages` — copia `public/*` a `gh-pages/` (1:1, lista para GitHub Pages)
5. `build:root` — copia `gh-pages/*` a la raíz del repo (para el modo "Deploy from branch → / root")

**No alcanza con que `tsc` compile sin errores** — correr siempre la cadena completa (`build:release`), no solo `build`, antes de dar por buena una distribución: `public/`/`gh-pages/`/la raíz del repo son artefactos generados por `copy-to-*.mjs`, no por `tsc`.

### Tests

```bash
npm test          # 554 aserciones — 14 suites unitarias (incluye la Fase 2 P0 nueva, ver abajo)
npm run test:e2e  # 212 aserciones — 7 scripts: smoke test, portabilidad de subdirectorio, bloques.html real, base.js, monitor, Blockly real, compilador
npm run test:all  # ambas — 766 aserciones en total, 0 fallaron (corrida completa verificada en esta entrega)
```

Agregado en esta corrección: `providers/franky-server-4.0/tests/fase2p0Opcodes.selfTest.ts`
(16 aserciones nuevas, cubren específicamente los opcodes 74-88/115-119/
124-133 recién implementados: variables con nombre, `varGlobal`↔`varTabla[0]`
como el mismo accessor, expresiones aritméticas con protección de /0,
decisiones si/sino por expresión (rama verdadera y falsa), REPEAT exacto
de N vueltas con `repeatStack` propia, texto fijo+dinámico conviviendo en
el mismo framebuffer OLED, sonar por Blockly con y sin correspondencia a
un sensor Sumo configurado, y la cadena de comparación-como-valor +
lógica booleana + IF_TRUE). También se agregó un test manual con
Chromium real (`nav01-subpath.manual.mjs`, no corre en `npm test`/`test:e2e`
por no depender de Playwright como dependencia del proyecto — ver cabecera
del archivo para instrucciones) que reproduce NAV-01 bajo un subdirectorio
real y confirma la corrección.

### Verificar el firmware de Laboratorio en aislamiento

```bash
node dist/providers/franky-server-4.0/tests/fase2p0Opcodes.selfTest.js
```

## Qué se corrigió en esta Fase 2 P0 (resumen — ver el informe final para el detalle completo)

1. **Causa raíz real:** `fase2-p0-validacion` solo había cambiado
   `providers/franky-server-4.0/assets/bloques.html` (el compilador
   Blockly) — el intérprete (`firmware/runtime.ts`) nunca recibió los
   `case` nuevos para los opcodes que ese compilador ya emitía desde
   antes. Por eso "se ven los bloques nuevos pero los programas no
   corren": el compilador generaba bytecode válido, pero el intérprete
   lo ignoraba.
2. **Corrección:** se agregaron los 30 `case` faltantes a
   `tickBloques()` (`firmware/runtime.ts`) y los campos `varTabla`/
   `repeatStack` a `FirmwareModel` (`firmware/model.ts`), replicando
   exactamente la semántica ya verificada contra el firmware físico de
   referencia (`varGlobal` como accessor en vivo de `varTabla[0]`,
   `repeatStack` separada de `pila[]`/`callStack[]`, mismo orden de
   pop, misma saturación a int16, mismo criterio de "pila vacía nunca
   revienta").
3. **SENS-01** (correspondencia sonar↔sensor Sumo): el nuevo
   `OP_PUSH_SONAR` del Laboratorio compara el TRIG/ECHO elegido en
   Blockly contra `cfgActiva().trigI/echoI`/`trigD/echoD` — si coincide,
   devuelve la lectura simulada de ESE sensor; si no, devuelve 999 ("sin
   eco", igual que el firmware real sin lectura válida) en vez de
   inventar un tercer sensor. El menú de `bloques.html` ahora identifica
   en el propio texto de cada opción qué GPIO corresponde a qué sonar de
   fábrica.
4. **NAV-01** (404 en "Volver al inicio" bajo GitHub Pages en
   subdirectorio): `bloques.html` era la única página con un
   `href="/"` absoluto-a-la-raíz-del-dominio — se corrigió al mismo
   mecanismo portable (`data-app-href` + `FRANKY_BASE.rewriteDom()`) que
   usa el resto del proyecto. Verificado con Chromium real sirviendo el
   build bajo `/franky-lab/` (ver `nav01-subpath.manual.mjs`).
5. **SUMO-01** (guardar configuración sin iniciar el combate):
   `sumo.html` solo guardaba la configuración como efecto colateral de
   presionar "INICIAR SUMO". Se extrajo `guardarConfigSumo()` como
   función propia y se agregó el botón "💾 Guardar configuración", que
   llama al mismo endpoint `/sumo/config` sin arrancar ningún combate.
   La persistencia (export/import `.franky`, recarga de página) ya
   funcionaba de antes a nivel de backend — no se tocó ese mecanismo.

## Limitación explícita — firmware físico

Esta corrección es **exclusivamente de FRANKY-LAB** (el simulador
TypeScript) y de los assets web compartidos (`bloques.html`/`sumo.html`).
El firmware físico (`.ino`) se auditó por separado — ver el paquete
`FRANKY_SERVER_FASE2_P0_CORREGIDO.zip` y su propio `README.md` para el
detalle y las limitaciones de esa verificación (sin compilación real por
falta de acceso de red al toolchain de Arduino en este entorno).
