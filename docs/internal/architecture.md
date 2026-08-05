# FRANKY LAB — Arquitectura interna

Documento de mantenimiento. No forma parte del README público.

## 1. Capas (congeladas por ADR-001..003)

```
World  →  Robot  →  Board  →  MCU  →  Firmware Model  →  Firmware Runtime  →  Virtual Server
```

- **World** (`core/src/worldModel.ts`): física del entorno — obstáculos,
  geometría, raycasting, escenarios (Área Libre, Minisumo/tatami 77cm,
  Laberinto, Fútbol).
- **Robot / MCU** (`core/src/robotHal.ts`, `mcu/esp32-c3/manifest.json`):
  contrato de hardware genérico (pines, ADC, PWM, buses) — reutilizable
  independientemente del Board (ADR-001: MCU es un paquete reusable,
  no depende del Board).
- **Board** (`boards/franky-board-4x/manifest.json`): mapeo concreto de
  componentes físicos a pines del MCU para una placa específica.
- **Firmware Model** (`providers/franky-server-4.0/firmware/model.ts`):
  única fuente de verdad del estado del firmware simulado (ADR-003).
- **Firmware Runtime** (`.../firmware/runtime.ts`, `sumoEngine.ts`,
  `motorControl.ts`, `validation.ts`): lógica de dominio pura, sin
  awareness de HTTP.
- **Virtual Server** (`.../server/virtualServer.ts`, `routes.ts`):
  traducción HTTP pura — nunca contiene lógica de negocio.

`RoboLab` (biblioteca externa de referencia) es solo eso: referencia de
soluciones técnicas puntuales, nunca base ni modelo arquitectónico.

## 2. Fuente única de verdad — código vs. build vs. distribución

```
providers/franky-server-4.0/assets/   ← código fuente real (Blockly, HTML, servidor original)
public-src/                            ← código fuente del shell de Laboratorio (lab.html, loader, compilador Blockly)
core/, providers/*/firmware, /server   ← TypeScript fuente (Runtime, Model, World, etc.)
            │
            │  npm run build        (tsc → dist/)
            │  npm run build:sw     (tsc → dist-sw/, bundle del Service Worker)
            ▼
public/                                ← ENSAMBLADO por build/copy-to-public.mjs
                                          (fuente real para SPIFFS del firmware físico)
            │
            │  npm run build:ghpages
            ▼
gh-pages/                              ← copia 1:1 de public/, lista para GitHub Pages
```

`public/` y `gh-pages/` son **artefactos generados**, no se editan a mano
y no se versionan (ver `.gitignore`). Esto es intencional y resuelve el
pedido de separar "código interno" de lo que el usuario final ve: el
código fuente vive en `core/`, `providers/*/firmware`, `providers/*/server`
y `public-src/`; nada de eso llega a `public/` ni a `gh-pages/` salvo ya
compilado a JS y ensamblado.

**Por qué el directorio de Pages se llama `gh-pages/` y no `dist/`:**
`dist/` ya está tomado por la salida del compilador TypeScript
(`tsconfig.json`, `outDir: "dist"`) — así se lo usa en `npm run test`
(`node dist/core/src/....selfTest.js`). Reusar ese nombre para el sitio
de GitHub Pages pisaría la salida del compilador y rompería el build.
`gh-pages/` cumple el mismo rol que pedía el cierre ("carpeta lista para
GitHub Pages") sin la colisión de nombre.

`npm run build:release` corre la cadena completa: `build → build:sw →
build:public → build:ghpages`.

## 3. Blockly — una sola fuente

Blockly oficial vive integrado en `providers/franky-server-4.0/assets/bloques.html`
(y sus bundles `bly_*.js`, vendored). No existe ni debe crearse ningún
Blockly alternativo. El compilador de bloques a bytecode para Laboratorio
vive aparte en `public-src/blockly-compiler.mjs` — comparte semántica de
opcodes con `bloques.html`, pero es un módulo propio de Laboratorio
(necesario porque Laboratorio compila también en contexto de Service
Worker, sin DOM).

## 4. Device Model — contrato entre firmware y Hardware Workspace

`core/src/deviceModel.ts` es la única fuente de qué dispositivo se activa
según qué opcodes aparecen en un programa cargado, y detecta conflictos
de pin reales (`detectPinConflicts()`). Cada entrada declara `real:
true|false` — `true` si ya existe en el firmware físico hoy, `false` si
es una extensión de Laboratorio pendiente de portar (ver
`docs/internal/firmware-migration.md`).

## 5. Preparación para futuras plataformas

No hay soporte implementado para otras placas o MCUs — a propósito
(pedido explícito: dejar la arquitectura preparada, no implementar). La
separación Board/MCU (ADR-001) es lo que lo habilita:

- **Nueva placa con el mismo MCU** (ej. una revisión de PCB de
  `franky-board-4x`): agregar un nuevo directorio en `boards/` con su
  propio `manifest.json` (`pinBindings` distintos), reutilizando
  `mcu/esp32-c3/` sin cambios.
- **Nuevo MCU** (ej. "FRANKY 5", "ROBOARD 6"): agregar un nuevo directorio
  en `mcu/` con su propio `manifest.json` (conteo de GPIO, pines ADC,
  canales PWM, buses). El `RobotHAL` (`core/src/robotHal.ts`) es la
  interfaz que un MCU nuevo debe satisfacer — el World y el Firmware
  Runtime no conocen el MCU directamente, solo el HAL.
- **Nuevo provider** (firmware de otra familia, ej. si "FRANKY 5" corriera
  un firmware distinto en vez de una versión evolucionada del actual):
  agregar un nuevo directorio en `providers/` con su propio
  `manifest.json`, `firmware/`, `server/`. `providerContract.ts` define
  el contrato mínimo que Core espera de cualquier provider.

Ninguno de estos puntos de extensión requiere tocar `core/` — es
precisamente la garantía que buscaba ADR-001.

## 6. Distribución — sitio compilado en la raíz del repo

Desde el cierre de distribución de Fase 3, `npm run build:release`
encadena un paso más al final: `build:root` (`build/copy-to-root.mjs`)
copia el contenido de `gh-pages/` directamente a la raíz del repositorio,
al lado de `core/`, `providers/`, etc. Esto es lo que permite que el
repositorio, tal cual se entrega, ya esté listo para GitHub Pages sin que
nadie tenga que correr `npm install` ni ningún build — el índice, el
Service Worker, `_lab/` y todos los assets ya están presentes y
versionados en la raíz.

Cuando el código fuente cambie en el futuro, republicar es: correr
`npm run build:release` de nuevo (regenera `public/`, `gh-pages/` y pisa
los archivos de la raíz) y commitear los cambios resultantes en la raíz
junto con el código fuente que los originó. `public/` y `gh-pages/` en sí
siguen sin versionarse (`.gitignore`) — son carpetas intermedias de
trabajo, no el producto final.

### `index.html` como puerta de entrada de GitHub Pages

GitHub Pages sirve siempre `index.html` como página de entrada — nunca
`start.html`. Como `index.html` es, además, el archivo original de
FRANKY (usado tal cual para SPIFFS en el robot físico), no se lo puede
reemplazar por el bootstrap de Laboratorio sin romper la placa real.

Solución aplicada en `build/copy-to-public.mjs` (paso 3.1): la **copia**
de `index.html` que termina en `public/` (y de ahí en `gh-pages/` y en la
raíz del repo) recibe una línea inyectada al inicio de `<head>` que
comprueba si ya hay un Service Worker controlando la pestaña. Si no lo
hay, redirige a `start.html` (ruta relativa — portable a cualquier
subdirectorio sin depender de `base.js`, ver sección 7) que hace el
registro real y termina en `lab.html`. Si ya lo hay (visitas siguientes,
y el caso del iframe de `lab.html`, que carga `index.html` bajo un
Service Worker que ya está activo), el archivo se comporta exactamente
igual que el original, sin ninguna diferencia. El asset fuente en
`providers/franky-server-4.0/assets/` nunca se toca — el parche es
exclusivo del build.

## 7. Portabilidad de despliegue — `base.js` y el scope del Service Worker

**Historia:** hasta la versión anterior de este documento, todo el
proyecto (Service Worker con `scope: "/"`, y cada asset/ruta con path
absoluto: `/style.css`, `/sw.js`, `/api`, `/bloques/add`, etc.) asumía
que se servía desde la raíz del dominio — necesario, en su momento, para
que los mismos assets funcionaran sin cambios tanto en el robot físico
como en Laboratorio. Eso rompía cualquier publicación como GitHub
Project Pages (`usuario.github.io/nombre-repo/`), Live Server sirviendo
un subdirectorio, o cualquier hosting que no controle la raíz del
dominio. Esta sección documenta la resolución de esa limitación: **el
proyecto ahora detecta su propia ruta base en runtime**, sin
configuración y sin necesitar saber de antemano dónde va a vivir.

### El principio: un único punto de verdad, dos mitades simétricas

No existe una sola "ruta base" global compartida por browser y Service
Worker — son dos contextos de ejecución distintos, cada uno con su
propia forma nativa de saber dónde vive. La arquitectura usa la fuente
de verdad correcta en cada mitad, pero con el mismo principio en las dos:
**nunca hardcodear, siempre preguntarle a la plataforma**.

**Lado navegador — `providers/franky-server-4.0/assets/base.js`:**
se carga como el PRIMER `<script>` de cada página HTML, con una ruta
relativa (`<script src="base.js"></script>`, sin "/" inicial). Esa única
referencia relativa es, por construcción, siempre correcta — el
navegador la resuelve contra la URL real de la página. A partir de ahí,
`document.currentScript.src` le da a `base.js` su propia URL absoluta ya
resuelta, y de eso deriva la raíz de la app entera (`new URL(".",
thisScript.src)`). Expone:
- `resolveUrl(path)` / `FRANKY_BASE.resolveUrl(path)` — resuelve
  cualquier ruta de la app contra la raíz real de despliegue. Tolera un
  "/" inicial legado (lo trata como "raíz de la app", no "raíz del
  dominio"), para que envolver un fetch existente sea un cambio de una
  sola línea o ninguno (ver el monkey-patch de `fetch` más abajo).
- `FRANKY_BASE.resolvePath(path)` — solo el pathname resuelto, para
  comparar contra `location.pathname` (ver `currentIframePath()` en
  `lab.html`).
- `FRANKY_BASE.rewriteDom(root?)` — recorre el DOM y convierte atributos
  `data-app-href` / `data-app-src` / `data-app-action` en
  `href`/`src`/`action` reales, resueltos contra la raíz de la app. Es
  el mecanismo para recursos ESTÁTICOS (imágenes, links de navegación,
  forms) — mismo `resolveUrl()` que usa todo lo demás.
- Un monkey-patch de `window.fetch`: cualquier `fetch("/algo")` con un
  string que empiece con "/" se resuelve automáticamente contra la raíz
  real antes de salir a la red. Esto es lo que permitió que ninguno de
  los ~60 `fetch("/...")` ya existentes en las páginas originales de
  FRANKY tuviera que reescribirse a mano — todos pasan, sin saberlo, por
  la misma resolución.

Por qué los `<link>`/`<img>`/`<a>` NO quedaron como paths relativos
simples (`href="style.css"` sin más): aunque técnicamente también
funcionarían dado que todo el sitio es un único directorio plano, se
optó por pasarlos por el mismo mecanismo (`data-app-*` + `rewriteDom()`)
para que **no haya dos estrategias mezcladas** — código estático y
dinámico usan literalmente la misma función. La hoja de estilos es la
única excepción deliberada: se inyecta con `document.write()` en el
`<head>`, ANTES de que el resto de la página empiece a renderizar, para
no introducir un parpadeo de contenido sin estilo (FOUC) — pero sigue
pasando por `resolveUrl()`, no por un path relativo a mano.

**Lado Service Worker — `core/src/swRuntime.ts`:** un Service Worker no
es un documento HTML, no tiene "su propia URL de script resuelta contra
la página" de la misma forma — pero tiene algo mejor:
`self.registration.scope`, la URL absoluta que el navegador le asignó en
el momento del registro (calculada, a su vez, a partir de dónde se
registró — ver `start.html` más abajo). Es el equivalente exacto de
`base.js` pero para este contexto: **el único lugar donde el Service
Worker sabe, en runtime, desde qué subpath quedó publicado**.

El fetch handler (`self.addEventListener("fetch", ...)`) usa ese scope
para traducir en las dos direcciones, en un solo punto:
- **Entrada:** `toCanonicalPath(url.pathname, scopePath)` le saca el
  prefijo de despliegue a cada request real (ej.
  `/franky-lab/bloques/add` → `/bloques/add`) ANTES de tocar
  `apiRouteSet` o `server.handle()`. El resto del sistema entero — rutas
  declaradas en cada Provider, Firmware Runtime, Virtual Server — sigue
  pensando en rutas canónicas absolutas-desde-raíz exactamente como
  siempre, sin saber nada de dónde está publicado. Cero cambios en
  `routes.ts`, `virtualServer.ts`, `runtime.ts`, ni ningún handler.
- **Salida:** `reprefixLocation(result.location, scopePath)` hace el
  camino inverso para el header `Location` de los redirects (ej. el
  Virtual Server devuelve `location: "/"` sin saber de subpaths;
  `reprefixLocation` lo convierte en `/franky-lab/` antes de mandarlo al
  navegador, para que un redirect nunca saque al usuario de la app).

Si `self.registration` no está disponible (única situación real: un
entorno de pruebas que simula `self` a mano, ver
`providers/franky-server-4.0/tests/e2e.smoketest.mjs`), se asume raíz
del dominio como red de seguridad — un Service Worker real activado
siempre tiene `registration` poblado.

**Registro portable (`start.html`):** el registro pasó de
`register("/sw.js", { scope: "/" })` a
`register(resolveUrl("sw.js"), { type: "module" })` — ruta resuelta por
`base.js`, y **sin forzar `scope`**. Omitir `scope` deja que el
navegador calcule el default (el directorio que contiene a `sw.js`, que
es siempre la raíz real de la app) en vez de forzarlo a la raíz del
dominio a mano.

### Por qué esto no rompe el ESP32

En el ESP32, `document.currentScript.src` para `base.js` siempre resuelve
a algo como `http://192.168.4.1/base.js` (el robot solo sabe servir
desde su propia raíz) — `base.js` calcula root = `http://192.168.4.1/`,
exactamente lo que ya pasaba antes con los paths absolutos a mano, pero
ahora calculado en vez de hardcodeado. Mismo razonamiento para
`self.registration.scope` en el Service Worker (que en el ESP32 ni
siquiera se usa — el ESP32 no tiene Service Worker, sirve todo
directamente). Cero comportamiento distinto para el robot físico; la
prueba en la sección de verificación lo confirma explícitamente.

### Verificación

Cubierto por tres archivos de test nuevos, corridos automáticamente en
`npm run test` / `npm run test:e2e`:
- `core/src/swRuntime.selfTest.ts` — `toCanonicalPath`/`reprefixLocation`/
  `scopePathOf` en aislamiento, con casos de raíz, subpath y subpath
  anidado, más pruebas de round-trip.
- `providers/franky-server-4.0/tests/base-js.e2e.mjs` — ejecuta el
  archivo REAL `base.js` (no una reimplementación) con
  `document.currentScript.src` fijado a cuatro escenarios reales
  (raíz, ESP32, GitHub Project Pages, subdirectorio anidado), incluyendo
  `rewriteDom()`.
- `providers/franky-server-4.0/tests/subpath-deployment.e2e.mjs` —
  integración de punta a punta contra el bundle COMPILADO real (el mismo
  `sw.js` que se publica), con `self.registration.scope` apuntando a
  `/franky-lab/`: confirma que `GET /franky-lab/api`, `POST
  /franky-lab/bloques/add`, y el redirect de `/franky-lab/stopall`
  responden correctamente, y que un request SIN el prefijo del subpath
  correctamente NO es interceptado (fuera de scope).

## 8. Verificación de integridad build-time

`build/copy-to-public.mjs` aborta el build si `manifest.json` (rutas
declaradas) y `routes.ts` (rutas reales que sirve el código) se
desincronizan — evita servir algo inconsistente. Cualquier nueva ruta
HTTP que se agregue (ej. `/api/serial` si se porta Monitor Serie al
firmware físico, ver migración) debe declararse en ambos lugares.
