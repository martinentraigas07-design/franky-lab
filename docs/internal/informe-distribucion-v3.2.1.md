# Informe de entrega - Distribucion lista para publicar (v3.2.1)

## Que cambio respecto a la entrega anterior

La entrega anterior era el proyecto fuente con el pipeline de
compilacion (build, copy-to-public, copy-to-ghpages). Esta entrega es el
producto terminado: el sitio compilado ya esta presente en la raiz del
repositorio, al lado del codigo fuente. No hace falta correr ningun
comando para publicarlo.

## Correccion de la migracion de firmware

El archivo FRANKY_4_0_v4_1.ino de la entrega anterior era la variante
BLE (identidad multi-robot) - no tenia el interprete de bloques. Con el
archivo correcto (esp32c3_franky_SPIFFS.ino, variante Servidor
Web/REST) ahora incluido, docs/internal/firmware-migration.md fue
reescrito por completo contra el firmware real. Resumen del cambio de
diagnostico: la mayoria de lo que se creia pendiente (pila, saltos,
funciones, OLED) ya esta portado - lo que queda pendiente es mas acotado
(texto en OLED/Serial, funciones matematicas 95-100, condicional sobre
variable, buzzer real). Detalle completo en ese documento.

De paso, se sincronizo providers/franky-server-4.0/assets/bloques.html
(fuente unica de Laboratorio) con la correccion real de Fase 3 que
todavia no tenia (verificacion del codigo de estado HTTP en
/bloques/add).

## Verificacion de la checklist pedida

- OK - Existe index.html en la raiz.
- OK - Existe start.html en la raiz - no fue renombrado ni eliminado.
- OK - Ambos funcionan: start.html sigue haciendo el registro real del
  Service Worker y redirigiendo a /lab.html, sin cambios. index.html
  ahora empieza con un chequeo: si no hay Service Worker controlando la
  pestana, redirige a /start.html - mismo comportamiento efectivo que
  abrir start.html directamente.
- OK - GitHub Pages puede abrir directamente index.html: al ser la
  pagina de entrada por defecto de Pages, y comportarse ahora como
  start.html, la primera visita queda cubierta.
- OK - El Service Worker sigue funcionando: sw.js no se toco (sigue
  siendo el shim versionado que importa
  _lab/providers/.../sw-entry.js); toda la suite de tests que ejercita
  el Service Worker (sw-entry.ts real, via dist-sw/) sigue en verde.
- OK - Blockly sigue siendo unico: bloques.html, sin bifurcaciones ni
  archivos alternativos.
- OK - El Servidor Web sigue siendo unico: providers/franky-server-4.0/assets/
  sigue siendo la unica fuente; los archivos de la raiz son su copia
  compilada, no una reimplementacion paralela.
- OK - No existen rutas rotas: la unica referencia residual a "carpetas
  que se generan despues" era un texto de ayuda para desarrollo local
  dentro de start.html (mencionaba public/ y npm run serve) - reescrito
  para no asumir ninguna carpeta intermedia y dar la indicacion correcta
  tanto en desarrollo local como en GitHub Pages.
- OK - No existen referencias a carpetas que deban generarse
  posteriormente: _lab/, index.html, start.html, lab.html, sw.js y todos
  los assets ya estan presentes y son exactamente lo que se sirve - nada
  se genera en runtime ni requiere un paso posterior.

## Advertencia que no estaba en el pedido original, pero es necesaria

Publicar este repositorio tal cual, como "Project Pages" con un nombre
de repo arbitrario, NO VA A FUNCIONAR: todo el proyecto usa rutas
absolutas de raiz (/sw.js, /style.css, /api, etc.), preexistentes al
proyecto (necesarias para que los mismos archivos sirvan tanto al robot
fisico como a Laboratorio). GitHub Pages sirve los repos "Project Pages"
bajo un subpath (usuario.github.io/nombre-repo/), lo que rompe cada una
de esas rutas absolutas.

Esto no es algo que se pueda resolver dejando el ZIP "mas terminado" -
es una decision de donde publicar, no de que contiene el repositorio.
Documentado con las dos soluciones sin tocar codigo (repo
usuario.github.io, o dominio propio con CNAME) en el README, seccion
"Publicar en GitHub Pages", y en docs/internal/architecture.md, seccion 6.

## Pendiente que no se resolvio en esta entrega

- LICENSE.md: se dejo como placeholder honesto. El texto legal real
  ("FRANKY 4.0 Educational Hardware & Embedded Software License v1.0")
  existe como documento Word de una entrega anterior del proyecto, no
  como parte de los archivos recibidos en esta ronda - no correspondia
  inventar el contenido. Falta pegar el texto real antes de la
  publicacion publica si se quiere que LICENSE.md sea vinculante.
- Flakiness observada en un tramo de tests E2E: en una de las corridas
  completas de verificacion, 2 aserciones de varios grupos E2E fallaron
  una sola vez, y pasaron limpio en las tres corridas siguientes (y en
  las anteriores a esa). No se identifico una causa de codigo - es
  consistente con una prueba sensible a temporizacion (timers reales)
  mas que con una regresion real, pero queda anotado por transparencia.
  Si vuelve a aparecer de forma reproducible, conviene revisar los tests
  que dependen de Date.now()/setTimeout real en vez de tiempo simulado.

## Conclusion

El repositorio, tal cual esta empaquetado en este ZIP, cumple los 6
pasos pedidos: descomprimir, crear repo, subir, Settings -> Pages,
seleccionar rama y raiz, tener FRANKY LAB funcionando - siempre que el
repositorio se publique de una de las dos formas que sirven desde la
raiz del dominio (ver advertencia arriba). No hace falta instalar Node,
correr npm, generar public/gh-pages a mano, ni renombrar ningun archivo.
