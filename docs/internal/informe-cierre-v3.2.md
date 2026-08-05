# Informe final — FRANKY LAB v3.2, cierre de fase

## Estado del proyecto

FRANKY LAB llega a este cierre en buen estado técnico: arquitectura
congelada y respetada en todo el código, cobertura de tests amplia y
100% verde, sin código muerto ni deuda no documentada, y un pipeline de
build reproducible de punta a punta (fuente → compilado → `public/` →
`gh-pages/`).

## Arquitectura

Las capas World → Robot → Board → MCU → Firmware Model → Firmware
Runtime → Virtual Server (ADR-001 a ADR-003) están implementadas tal
como fueron definidas, sin fugas entre capas: el Firmware Runtime no
conoce HTTP, el Virtual Server no contiene lógica de dominio, y el
Device Model es la única fuente de verdad para qué hardware muestra el
Hardware Workspace. No se encontró ninguna violación de estos límites en
el código revisado.

## Código eliminado

Ninguno. La auditoría no encontró código muerto, archivos huérfanos,
referencias rotas ni bloques deshabilitados que ameritaran eliminación.
El único ítem de deuda técnica reconocida encontrado
(`runtime.ts:10`, mapeo de pines de motor hardcodeado en vez de leído
del manifest de Board) está explícitamente documentado en el propio
código como "no bloqueante" y queda igual — no hay un segundo Board hoy
que justifique generalizarlo todavía.

## Código consolidado

- Pipeline de build extendido con `build:ghpages` y `build:release`
  (ver CHANGELOG).
- `.gitignore` agregado — separa por primera vez, explícitamente,
  código fuente de artefactos generados.

## Cambios realizados

Ver `CHANGELOG.md` en la raíz del repositorio para el detalle completo.
En resumen: build de distribución para GitHub Pages, `.gitignore`,
documentación interna de arquitectura y de migración de firmware,
README público. Cero cambios de comportamiento en Runtime, World,
Device Model, Blockly o servidor.

## Cambios pendientes

- Ninguno del lado de FRANKY LAB para esta versión candidata.
- Del lado del firmware físico: todo lo detallado en
  `docs/internal/firmware-migration.md` (opcodes 90+, OLED, Buzzer,
  Monitor Serie) sigue sin portarse — es trabajo fuera del alcance de
  este repositorio, a criterio de cuándo Martín decida encararlo.

## Cambios recomendados para el firmware

Ver `docs/internal/firmware-migration.md`, sección 10, para el orden
sugerido de trabajo (pila/control de flujo primero, matemáticas después,
OLED al final por el conflicto de pin conocido con línea-centro).

**Alerta que requiere confirmación de Martín antes de tocar firmware
físico:** el archivo `FRANKY_4_0_v4_1.ino` recibido en este cierre es la
variante **BLE** (identidad multi-robot), no la variante Servidor
Web/REST que realmente contiene el intérprete de bloques. El documento
de migración fue escrito contra la lógica del Runtime de Laboratorio
(que sí replica fielmente el firmware Servidor Web/REST) pero **no pudo
verificarse línea por línea contra el `.ino` físico real**, porque ese
archivo no fue parte de esta entrega. Antes de aplicar cualquier cambio
de `firmware-migration.md`, ubicar el `.ino` correcto.

## Cambios recomendados para el Servidor FRANKY

Ninguno — la fuente en `providers/franky-server-4.0/assets/` se dejó
intacta, tal como pedía el punto 4 del cierre ("no romper el firmware,
no quiero dos servidores").

## Riesgos detectados

1. **Discrepancia de archivo firmware** (ver arriba) — riesgo de que la
   documentación de migración se aplique sobre el archivo equivocado si
   no se confirma antes cuál `.ino` es el que realmente ejecuta bloques.
2. **Conflicto de pin GPIO6** (OLED I²C SDA vs. sensor de línea centro
   digital) — ya documentado y modelado, pero sin resolver; un programa
   físico que use ambos a la vez chocaría. No bloquea esta publicación
   (Laboratorio ya lo reporta correctamente como conflicto), pero sí
   bloquea portar OLED al firmware físico sin antes decidir qué hacer.
3. **Tamaño de `Instruccion` en firmware físico**: extenderla con
   `char txt[24]` multiplica por 9 el tamaño del arreglo de programa
   (192 → 1728 bytes con `MAX_INST=64`). Debería tolerarlo sin problema
   en un ESP32-C3, pero no se pudo confirmar contra el uso de RAM real
   del firmware físico (no disponible en esta entrega).

Ningún riesgo detectado bloquea la publicación de FRANKY LAB en sí — los
tres son exclusivos del trabajo futuro sobre firmware físico.

## Compatibilidad con versiones anteriores

Sin cambios de comportamiento: los 158 tests unitarios y las 4 suites
E2E existentes (Minisumo, sincronización/evasión, Fútbol/Laberinto,
persistencia, botón START, fidelidad de dohyo, sensores dinámicos,
bloques.html) pasan igual antes y después de este cierre. `public/`
generado es byte-idéntico en estructura a como se generaba antes de
agregar `build:ghpages` (el nuevo script solo agrega un paso posterior,
no modifica `copy-to-public.mjs`).

## Preparación para GitHub

Repositorio queda con separación clara código fuente → build →
distribución (punto 2 del cierre). `.gitignore` asegura que solo se
suba código fuente: `core/`, `providers/*/firmware`, `providers/*/server`,
`providers/*/assets`, `boards/`, `mcu/`, `public-src/`, `build/`,
`docs/`, y los archivos de configuración (`package.json`,
`tsconfig*.json`). Nunca se sube `public/`, `gh-pages/`, `dist/`,
`dist-sw/` ni `node_modules/`.

## Preparación para GitHub Pages

`npm run build:release` deja `gh-pages/` listo para publicarse tal cual
como raíz del sitio (o vía GitHub Actions que corra ese mismo comando y
publique el resultado — recomendado sobre versionar `gh-pages/` a mano,
para que nunca se desincronice de `public/`).

## Preparación para futuras plataformas

Arquitectura preparada, sin implementación adicional (tal como se pidió).
Ver `docs/internal/architecture.md`, sección 5, para el procedimiento
concreto de cómo agregar una placa nueva, un MCU nuevo, o un provider
nuevo sin tocar `core/`.

## Conclusión

**Desde el criterio técnico de esta auditoría, FRANKY LAB puede
considerarse una versión estable, lista para publicarse como candidata
oficial**, con una única salvedad que no bloquea la publicación del
laboratorio en sí: la documentación de migración de firmware
(`firmware-migration.md`) necesita ser confirmada contra el `.ino` real
del modo Servidor Web/REST antes de usarse como guía de implementación,
ya que el archivo recibido en este cierre corresponde a la variante BLE.
