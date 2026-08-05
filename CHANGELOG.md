# CHANGELOG

## v3.3.0 — Portabilidad de despliegue (BASE_URL automático)

FRANKY LAB ya no depende de servirse desde la raíz del dominio. El
mismo proyecto, sin ninguna modificación, funciona en el ESP32, en la
raíz de cualquier dominio, en un subdirectorio de GitHub Pages (Project
Pages), en Live Server de VSCode, o en cualquier hosting estático —
detectando su propia ruta base en runtime.

### Agregado
- `providers/franky-server-4.0/assets/base.js` — único punto de cálculo
  de la ruta base de la app (`document.currentScript.src`), expone
  `resolveUrl()`, `resolvePath()`, `rewriteDom()` y un monkey-patch de
  `fetch()` que resuelve automáticamente cualquier `fetch("/...")`
  existente sin tener que reescribirlo.
- `core/src/swRuntime.ts`: el fetch handler del Service Worker ahora
  canonicaliza cada request contra `self.registration.scope` antes de
  matchear rutas, y re-prefija el header `Location` de los redirects —
  el resto del sistema (rutas, Firmware Runtime, Virtual Server) sigue
  pensando en rutas absolutas-desde-raíz sin cambios.
- Registro del Service Worker (`start.html`) portado a ruta relativa
  resuelta por `base.js`, sin forzar `scope: "/"` — el navegador calcula
  el scope real automáticamente.
- Tres suites de test nuevas: `core/src/swRuntime.selfTest.ts` (22
  aserciones), `providers/franky-server-4.0/tests/base-js.e2e.mjs` (15
  aserciones, corre el `base.js` real contra 4 escenarios de despliegue),
  y `providers/franky-server-4.0/tests/subpath-deployment.e2e.mjs` (10
  aserciones, integración de punta a punta contra el Service Worker
  compilado real publicado bajo un subdirectorio simulado).

### Cambiado
- Las 8 páginas de `providers/franky-server-4.0/assets/` y `lab.html`/
  `start.html` (`public-src/`): cero rutas absolutas (`href="/`,
  `src="/`, `action="/`) restantes — reemplazadas por `data-app-href`/
  `data-app-src`/`data-app-action` + `rewriteDom()`, o por `resolveUrl()`
  en el código dinámico (iframe, imports, comparaciones de path).
- El parche de arranque de `index.html` (`build/copy-to-public.mjs`)
  pasó de `location.replace("/start.html")` a una ruta relativa —
  funciona igual sin depender del orden de carga de `base.js`.
- README y `docs/internal/architecture.md` (sección 7, nueva)
  actualizados: ya no piden servir desde la raíz del dominio.

### Corregido de paso
- `providers/franky-server-4.0/tests/bloques-html.e2e.mjs`: el harness
  de extracción de código real desde `bloques.html` pasaba el sandbox
  como `this` (`fn.call(sandbox)`) pero nunca como argumentos — un bug
  preexistente que no se notaba porque nada en el script extraído
  dependía de los valores del sandbox a nivel superior hasta ahora
  (`FRANKY_BASE.rewriteDom()` sí, y lo expuso). Corregido a
  `fn.call(sandbox, ...Object.values(sandbox))`.

## v3.2.1 — Cierre de Fase 3 y entrega de distribución

### Corregido
- `providers/franky-server-4.0/assets/bloques.html` sincronizado con la
  versión real de Fase 3 (`fetch()` a `/bloques/add` ahora revisa el
  código de estado de la respuesta y propaga el error — antes lo
  ignoraba).

### Reescrito
- `docs/internal/firmware-migration.md` reescrito por completo contra el
  firmware real (`esp32c3_franky_SPIFFS.ino`, variante Servidor Web/REST
  recibida en el cierre de Fase 3). La versión anterior estaba escrita
  contra `FRANKY_4_0_v4_1.ino` (variante BLE, sin intérprete de bloques)
  por un archivo enviado por error — quedó documentada como advertencia
  en su momento y ahora queda reemplazada por la versión verificada.
  Resultado: la mayoría de lo que se creía pendiente ya está portado
  (pila, saltos, funciones, OLED); lo que queda pendiente es más acotado
  (texto en OLED/Serial, funciones matemáticas, buzzer real).

### Agregado
- `build/copy-to-root.mjs` y script `npm run build:root` — publica el
  sitio compilado directamente en la raíz del repositorio, al lado del
  código fuente, para que el repo entero sea la entrega final (sin
  carpetas `public/`/`gh-pages/` de por medio en lo que se publica).
  `npm run build:release` ahora encadena este paso también.
- Parche de build (`build/copy-to-public.mjs`, paso 3.1): la copia de
  `index.html` que termina en la raíz del repo se comporta exactamente
  igual que `start.html` cuando no hay un Service Worker controlando la
  pestaña (caso de GitHub Pages, que siempre abre `index.html`). El
  asset fuente no se modifica — el parche es exclusivo del build.
- `docs/internal/firmware-fisico/` — copia de referencia del firmware
  físico real y su changelog, para trazabilidad de contra qué versión
  está verificada la documentación de migración.
- `LICENSE.md` — placeholder honesto: el texto legal real no estaba
  disponible en esta entrega, no se inventó contenido.
- **Esta misma entrega**: el repositorio se publica con el sitio ya
  compilado en la raíz (`index.html`, `start.html`, `lab.html`, `sw.js`,
  assets, `_lab/`) — no requiere `npm install` ni ningún build para
  publicarse en GitHub Pages.

## v3.2 — Cierre de fase, candidata a publicación

Consolidación previa a la primera publicación oficial en GitHub Pages.
No se agregaron funcionalidades nuevas — este cierre es exclusivamente
auditoría, empaquetado y documentación.

### Agregado
- `build/copy-to-ghpages.mjs` y script `npm run build:ghpages` —
  genera `gh-pages/` como copia 1:1 de `public/`, lista para publicar en
  GitHub Pages sin exponer código fuente TypeScript.
- `npm run build:release` — corre la cadena completa de build
  (`build → build:sw → build:public → build:ghpages`) en un solo paso.
- `.gitignore` — excluye artefactos generados (`node_modules/`, `dist/`,
  `dist-sw/`, `public/`, `gh-pages/`) para que el repositorio solo
  contenga código fuente.
- `docs/internal/architecture.md` — referencia interna de arquitectura,
  capas, pipeline de build y guía de portabilidad a futuras plataformas
  (FRANKY 5, ROBOARD 6, etc.).
- `docs/internal/firmware-migration.md` — documento técnico completo de
  qué cambios requiere el firmware físico (opcodes, estructuras,
  Blockly, OLED, Buzzer, Monitor Serie) para sincronizarse con la
  extensión de Laboratorio. Incluye advertencia sobre discrepancia entre
  el `.ino` recibido en este cierre (variante BLE) y el `.ino` real que
  necesita estos cambios (variante Servidor Web/REST).
- `README.md` — descripción del estado actual del proyecto.

### Auditado (sin cambios de código)
- Revisión completa de `core/`, `providers/franky-server-4.0/`,
  `boards/`, `mcu/`, `build/`, `public-src/`: sin código muerto, sin
  TODO/FIXME bloqueantes, sin referencias rotas, sin duplicación de
  Blockly o de servidor.
- Suite completa de tests (unitarios + E2E) ejecutada como línea base y
  re-ejecutada después de cada cambio de build: 158 aserciones
  unitarias + 4 suites E2E, 0 fallos en ambos casos.
- Device Model (`core/src/deviceModel.ts`): confirmado sin conflictos de
  GPIO/ADC/PWM/I²C/SPI/UART no detectados — el único conflicto real
  conocido (OLED vs. sensor de línea centro, ambos en GPIO6) ya está
  correctamente modelado y documentado como decisión pendiente para
  cuando se porte OLED al firmware físico.

### Sin cambios
- `public/` sigue siendo la única fuente usada para SPIFFS — no se
  modificó su contenido ni el pipeline que lo genera
  (`build/copy-to-public.mjs`).
- Blockly sigue siendo exclusivamente `bloques.html` — no se creó
  ninguna alternativa.
