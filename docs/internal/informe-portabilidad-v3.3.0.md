# Informe de verificacion - Portabilidad de despliegue (v3.3.0)

## Resumen

FRANKY LAB dejo de depender de servirse desde la raiz del dominio. Un
unico mecanismo (base.js del lado navegador, self.registration.scope
del lado Service Worker) calcula la ruta base en tiempo real, sin
configuracion y sin necesitar saber de antemano donde va a publicarse.
Documentado en detalle en docs/internal/architecture.md, seccion 7.

## Que se cambio

- base.js (nuevo): unico punto de resolucion de rutas para todo el
  proyecto. Se carga como primer script de cada pagina.
- core/src/swRuntime.ts: el fetch handler del Service Worker canonicaliza
  las rutas entrantes contra self.registration.scope antes de matchear
  contra la tabla de rutas interna, y re-prefija el header Location de
  los redirects. El resto del sistema (routes.ts, virtualServer.ts,
  firmware/runtime.ts) sigue pensando en rutas absolutas-desde-raiz sin
  ningun cambio.
- Las 8 paginas de assets originales + lab.html/start.html: cero rutas
  absolutas (href="/, src="/, action="/) restantes.
- Registro del Service Worker: ruta relativa resuelta por base.js, sin
  forzar scope.

## Verificacion explicita de la checklist pedida

- OK - Funcionamiento desde "/": cubierto por la suite completa de
  tests unitarios y E2E existente (158+ aserciones), que sigue en verde
  despues del cambio, mas base-js.e2e.mjs escenario 1 y 2 (raiz de
  dominio, ESP32 por IP).
- OK - Funcionamiento desde "/franky-lab/": verificado de dos formas
  independientes. (1) base-js.e2e.mjs escenario 3 confirma
  algebraicamente que base.js real calcula la raiz correcta y resuelve
  cada tipo de referencia (fetch, atributos estaticos via rewriteDom)
  bajo ese subdirectorio. (2) subpath-deployment.e2e.mjs instancia el
  Service Worker COMPILADO real (el mismo sw.js que se publica) con
  self.registration.scope apuntando a /franky-lab/, y ejercita un ciclo
  real: GET /franky-lab/api, POST /franky-lab/bloques/add (agregar una
  instruccion real), GET /franky-lab/sumo/mini (arrancar Minisumo de
  verdad, confirmando que el estado cambia), y el redirect de
  /franky-lab/stopall (confirma que el Location header vuelve a apuntar
  DENTRO de /franky-lab/, no a la raiz del dominio). Tambien confirma
  que un request SIN el prefijo del subpath correctamente no es
  interceptado por este Service Worker (fuera de su scope real).
- OK - Funcionamiento con GitHub Pages: el escenario de
  base-js.e2e.mjs usa exactamente la forma real de URL que GitHub
  Project Pages genera (usuario.github.io/nombre-repo/). Ademas, se
  sirvio el build real (carpeta public/) con un servidor HTTP plano
  desde dos raices distintas (una simulando dominio raiz, otra con
  public/ copiado dentro de una subcarpeta franky-lab/) y se confirmo
  con curl que index.html, base.js, style.css, sw.js y el modulo
  compilado del Service Worker responden 200 en ambos casos, con
  estructura de archivos identica.
- OK - Funcionamiento en Live Server: mismo mecanismo que GitHub Pages
  Project Pages desde el punto de vista de base.js (un subdirectorio
  arbitrario del sistema de archivos servido por HTTP) - cubierto por el
  escenario 4 de base-js.e2e.mjs (subdirectorio anidado de dos niveles,
  el caso tipico de Live Server sirviendo una carpeta de proyectos).
- OK - Funcionamiento del Service Worker: swRuntime.selfTest.ts (22
  aserciones sobre las funciones puras de canonicalizacion) +
  subpath-deployment.e2e.mjs (integracion real, ver arriba) + la suite
  E2E existente completa (40 aserciones) que ejercita el Service Worker
  real en la raiz sigue en 0 fallos.
- OK - Funcionamiento de Blockly: bloques-html.e2e.mjs (10 aserciones)
  sigue en verde, extrayendo y ejecutando el codigo REAL de bloques.html
  (parseBlock, compileIf, compileWhile, wsToInstructions) tal como quedo
  despues de agregarle base.js/resolveUrl. De paso se encontro y corrigio
  un bug preexistente en el harness de este test (ver CHANGELOG).
- OK - Funcionamiento del Workspace: la suite E2E completa
  (e2e.smoketest.mjs, 40 aserciones) cubre Minisumo, sincronizacion de
  combate, evasion de oponente, Futbol, Laberinto, persistencia del
  Workspace, boton START unificado, fidelidad del dohyo y sensores
  dinamicos - todo en verde despues del cambio.
- OK - Funcionamiento del Servidor Web: server.selfTest.ts (18
  aserciones) y firmware.selfTest.ts (45 aserciones) siguen en verde;
  ademas subpath-deployment.e2e.mjs prueba rutas reales del Servidor Web
  (api, sumo/mini, stopall, bloques/add) bajo un subpath, no solo en la
  raiz.

## Verificacion de compatibilidad (lista completa pedida)

Blockly, Workspace, Gamepad, Service Worker, Simulacion, Servidor Web,
Debug, Minisumo, Futbol, Laberinto, Linea, Device Model, Hardware
Workspace: todos cubiertos, directa o indirectamente, por la suite
completa de tests que sigue en 0 fallos despues del cambio (158+
aserciones unitarias, 22 nuevas de portabilidad, 40+10+15+10 E2E). No se
modifico ninguna logica de dominio (World, Firmware Runtime, Device
Model, reglas de competencia) - el cambio completo quedo confinado a la
capa de resolucion de URLs (base.js del lado navegador,
canonicalizacion de scope del lado Service Worker) y a las paginas HTML
que referencian archivos estaticos.

## Limitacion honesta de esta verificacion

No hay un navegador real disponible en este entorno de trabajo. La
verificacion consiste en: (1) ejecutar el codigo REAL (base.js, el
Service Worker compilado) en Node con URLs/scopes fabricados que
replican exactamente lo que un navegador real reportaria en cada
escenario, y (2) servir los archivos reales por HTTP y confirmar
alcanzabilidad con curl. Esto verifica la logica de resolucion de rutas
con rigor (son funciones puras y deterministicas, el mismo codigo que
correria en el navegador), pero no sustituye abrir la pagina en un
Chrome/Firefox real, hacer click en cada boton, y mirar la consola. Si
algo visual o de interaccion real llegara a fallar que no dependa de
resolucion de URLs (ej. un evento de mouse, un estilo CSS), esta
verificacion no lo hubiera detectado.

## Conclusion

La arquitectura de portabilidad quedo implementada como un unico punto
de resolucion por contexto (base.js para paginas, self.registration.scope
para el Service Worker), sin logica de deteccion de plataforma, sin
build distinto para GitHub y sin tocar ninguna ruta interna del sistema
de dominio. Verificado contra el codigo real (no reimplementaciones) en
los cuatro escenarios pedidos (raiz, subdirectorio, GitHub Pages, Live
Server/subdirectorio anidado) y contra la suite completa de
funcionalidad existente, que sigue en 0 fallos.
