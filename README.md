# FRANKY LAB

Laboratorio virtual de robótica educativa. Simula un robot FRANKY 4.0
completo (chasis diferencial, sensores, OLED) corriendo dentro del
navegador, usando el **mismo** Servidor FRANKY y el **mismo** Blockly
oficial que corre en el robot físico — no una reimplementación paralela.

**Usar FRANKY LAB:** abrir la página publicada en GitHub Pages de este
repositorio. No requiere instalación, ni Node, ni build — el sitio ya
viene compilado dentro de este mismo repositorio.

FRANKY LAB detecta automáticamente su propia ruta base — puede
publicarse tanto desde la raíz de un dominio como desde cualquier
subdirectorio (GitHub Project Pages incluido) sin tocar una sola línea
de código. Ver "Publicar en GitHub Pages" más abajo.

## Qué es

FRANKY LAB reproduce, dentro de un Service Worker, el comportamiento real
del firmware Servidor Web/REST (verificado contra
`esp32c3_franky_SPIFFS.ino`, cierre de Fase 3): física de movimiento
diferencial, evasión de borde, detección de oponente, automatizaciones,
y — como extensión propia de Laboratorio — un intérprete de bloques con
control de flujo real (bucles, funciones) y soporte OLED. Todo esto corre
contra la interfaz web **original** del robot (`index.html`, `sumo.html`,
`bloques.html`, `gamepad.html`, etc.) sin modificarla — el alumno usa
exactamente la misma pantalla que usaría frente al robot físico.

## Estado actual

- **Fase 3: cerrada.** El firmware físico real (`esp32c3_franky_SPIFFS.ino`)
  ya incorpora pila de trabajo, saltos, funciones y OLED real (dibujo).
  Detalle completo y lo que queda pendiente en
  `docs/internal/firmware-migration.md`.
- **Arquitectura:** congelada (ADR-001 a ADR-003). Capas World → Robot →
  Board → MCU → Firmware Model → Firmware Runtime → Virtual Server,
  desacopladas entre sí.
- **Escenarios:** Área Libre, Minisumo (tatami 77cm), Laberinto, Fútbol.
- **Blockly:** oficial, único, integrado en `bloques.html` — sin
  bifurcaciones.
- **Cobertura de tests:** suite completa de tests unitarios y E2E
  cubriendo física, Runtime de bloques, Device Model, Hardware Workspace,
  reglas de competencia y persistencia — 0 fallos.

## Publicar en GitHub Pages

Este repositorio ya contiene el sitio compilado en su raíz
(`index.html`, `start.html`, `lab.html`, `sw.js`, assets y `_lab/`). Para
publicarlo:

1. Crear un repositorio nuevo en GitHub y subir todo el contenido de este
   repositorio tal cual.
2. Settings → Pages → Deploy from branch → seleccionar la rama y `/ (root)`.

**Funciona desde cualquier ubicación**, sin tocar código: raíz del
dominio (`usuario.github.io`), subdirectorio de Project Pages
(`usuario.github.io/nombre-repo/`), dominio propio, subdirectorio
anidado en cualquier otro hosting (Apache, Nginx, Live Server de
VSCode), etc. El proyecto calcula su propia ruta base en tiempo real
(`base.js` — ver `docs/internal/architecture.md`, sección 6) en vez de
asumir que está en la raíz. Esto incluye el registro del Service Worker,
todas las llamadas a la API y toda la navegación entre páginas — no solo
los recursos estáticos.

Esta portabilidad es nueva a partir de esta versión; versiones
anteriores de este README pedían publicar exclusivamente desde la raíz
del dominio. Ya no hace falta.

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| `index.html`, `start.html`, `lab.html`, `sw.js`, `base.js`, `deviceModel.js`, `*.html`/`*.js`/`*.css` sueltos, `_lab/` | **Sitio compilado** — esto es lo que GitHub Pages sirve. Generado, no se edita a mano. |
| `core/` | World, Device Model, Simulation Engine, reglas de competencia — TypeScript fuente |
| `providers/franky-server-4.0/` | Firmware Runtime, Virtual Server, assets originales (Servidor FRANKY, Blockly) — fuente real de los archivos compilados en la raíz |
| `boards/`, `mcu/` | Manifiestos de hardware (placa, microcontrolador) |
| `public-src/` | Fuente del shell de Laboratorio (lab.html, loader, compilador Blockly) |
| `build/` | Scripts de ensamblado (no hace falta correrlos para publicar; sirven para cuando el código fuente cambie) |
| `docs/internal/` | Documentación de mantenimiento (no pública) |

Los archivos sueltos de la raíz (`index.html`, `bloques.html`, etc.) son
una copia generada por `npm run build:release` a partir del código
fuente de arriba — no se editan a mano. Si el código fuente cambia en el
futuro, esos archivos de la raíz se regeneran corriendo ese comando y
commiteando el resultado. `public/` y `gh-pages/` (si se llegan a generar
localmente al correr el build) son carpetas intermedias de trabajo, sin
versionar — ver `.gitignore`.

## Licencia

Este repositorio referencia el documento "FRANKY 4.0 Educational
Hardware & Embedded Software License v1.0". El texto completo de esa
licencia no estaba disponible como archivo de texto en esta entrega
(existe como documento Word aparte) — ver `LICENSE.md` para el estado
pendiente.
