# Referencia — firmware físico real (Fase 3)

Copia de referencia del firmware físico contra el que se verificó
`docs/internal/firmware-migration.md`. Vive en su propio repositorio de
firmware — esta copia es solo para que la documentación de migración de
FRANKY LAB sea trazable contra una versión concreta, no la fuente activa
de ese firmware.

- `esp32c3_franky_SPIFFS.ino` — firmware Servidor Web/REST, variante que
  contiene el intérprete de bloques (`ejecutarBloque()`).
- `CHANGELOG_FASE3.md` — changelog original de esta actualización,
  escrito por quien la implementó y verificó contra el hardware/toolchain
  real.

`data/` (los assets HTML/JS que acompañan este firmware para SPIFFS) no
se duplica acá — es idéntico a `providers/franky-server-4.0/assets/` en
este mismo repo (ya sincronizado en este cierre), que es la fuente única
real.
