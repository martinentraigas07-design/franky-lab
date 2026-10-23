#include <PID_v1_bc.h>

/*
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   FRANKY 4.0 — Servidor Web + SPIFFS  v3.2-LNR               ║
 * ║   MDE — Martín Entraigas                                        ║
 * ║   ESP32-C3 SuperMini · Arduino IDE 1.8+                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 * CHANGELOG v3.2-LNR:
 *   [NEW]  Struct SumoConfig unificada — config micro y mini en un solo lugar.
 *   [NEW]  Persistencia SUMO via Preferences (namespace "sumo") — guarda al
 *          aplicar config, restaura al boot. NO escribe en cada ciclo.
 *   [NEW]  Validación ADC en firmware (validateSumoADC). Rechaza configs que
 *          superen los 2 ADC disponibles (GPIO0/GPIO1). Responde JSON de error.
 *   [NEW]  Sharp 2Y0A21 como detector DIGITAL por umbral (no distancia continua).
 *          sharpDetectado() función centralizada. Contempla zona ciega <6cm.
 *   [NEW]  Velocidades independientes: spdAtaque, spdBusquedaExt, spdBusquedaInt,
 *          spdEvasion — todas configurables desde UI.
 *   [NEW]  /api extendida: incluye sharp_adc, sharp_detect, sumo_cfg snapshot,
 *          adc_used, adc_avail, velocidades. Un solo polling necesario.
 *   [NEW]  leerSonar() con instancia estática por pines — evita new/delete cada
 *          ciclo. Timeout reducido para minimizar bloqueo.
 *   [FIX]  delay() de evasión de borde reemplazados por máquina de estados no
 *          bloqueante (evadeState/evadeTimer). server.handleClient() no se bloquea.
 *   [FIX]  sumoSharpMicro se configura independientemente de sumoSharpI (mini).
 *   [FIX]  GPIO6/7/20/21 con validación de bus activo en handleSumoConfig.
 *   [KEEP] Todos los endpoints existentes. Compatibilidad total con v3.1-LNR.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <SPIFFS.h>
#include <ESP32_Servo.h>
#include <NewPing.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128,64,&Wire,-1);
#include <DHT.h>
#include <esp_system.h> // BLOQUE A — esp_reset_reason()/esp_reset_reason_t, header estandar de ESP-IDF, sin librerias nuevas

// HALLAZGO_CTAGS (Fase 4.1, corregido tras el primer intento de
// compilacion real): el generador automatico de prototipos de
// Arduino (ctags) inserta declaraciones adelantadas de TODAS las
// funciones justo despues del ultimo #include, sin importar donde
// esten definidas mas abajo en el archivo. Como varias funciones
// del sistema de reservas de GPIO reciben GpioMotivo como parametro,
// esas declaraciones adelantadas quedaban ANTES de que el enum
// existiera -> "GpioMotivo has not been declared". Unica correccion:
// mover el enum a este punto del archivo, antes de cualquier funcion
// que lo use como tipo. El resto del sistema de reservas (el array,
// las funciones) se queda donde estaba.
enum GpioMotivo {
  GPIO_LIBRE = 0,
  GPIO_MOTOR,          // reservado de fábrica — soldado a RZ7899, nunca liberable
  GPIO_LED,            // reservado de fábrica — LED onboard
  GPIO_BOTON,          // reservado de fábrica — botón BOOT onboard
  GPIO_ADC_FIJO,       // reservado de fábrica — únicos 2 canales ADC (Sharp/borde), nunca asignable a otra función
  GPIO_I2C,            // reservado en runtime — bus I2C activo (par SDA/SCL)
  GPIO_BUS_ALT,        // reservado en runtime — grupo "spiEnabled" (CS/MOSI/SCLK), heredado de v3.2
  GPIO_SENSOR_SUMO,    // reservado en runtime — pin elegido por el usuario para sensor de Sumo
};

// HALLAZGO_CTAGS #3 (mismo mecanismo que GpioMotivo y SumoConfig, ver
// notas anteriores en este archivo): RobotMode nunca se había usado
// como parámetro de función hasta esta etapa (modoTexto(RobotMode)) —
// se mueve acá, junto a los otros dos, apenas empieza a hacer falta.
enum RobotMode {
  MODE_IDLE=0, MODE_MICRO, MODE_MINI,
  MODE_VIVERO, MODE_METEO, MODE_ALARMA, MODE_ACCESO, MODE_BLOQUES
};

// Mismo motivo exacto que GpioMotivo/RobotMode arriba (HALLAZGO_CTAGS,
// ver notas de esas dos): estos dos enums nuevos de la fase "Cierre
// Sumo" se usan como parámetro/retorno de funciones (direccionTexto(),
// logEstadoSumo(), etc. — ver más abajo, junto a cabeceoDirDer) — deben
// quedar declarados ACÁ, antes de que el generador automático de
// prototipos de Arduino inserte las declaraciones adelantadas de esas
// funciones, o el compilador dirá "has not been declared" exactamente
// como ya pasó con los otros tres tipos de este archivo.
enum DireccionOponente { DIR_DESCONOCIDA=0, DIR_IZQUIERDA=1, DIR_DERECHA=2, DIR_CENTRO=3 };
enum EstadoSumoLog { ESL_ESPERA=0, ESL_BUSCANDO, ESL_ATACANDO, ESL_EVADIENDO, ESL_RECUPERANDO };

// HALLAZGO_CTAGS #2 (mismo mecanismo que el enum GpioMotivo de la
// Fase 4.1): struct SumoConfig se usa por referencia
// (const SumoConfig&) en varias funciones (ejecutarSumo(), etc.) --
// el generador automatico de prototipos de Arduino insertaba la
// declaracion adelantada de esas funciones justo despues del ultimo
// #include, antes de que este struct existiera todavia. Se mueve acá
// por el mismo motivo exacto que el enum. El resto del código que usa
// SumoConfig (cfgMini, cfgMicro, cfgActiva, etc.) se queda donde
// estaba.
//  STRUCT SUMOCONFIG — Configuración unificada
//  Tipo sensor oponente: 0=sonar, 1=optico_dig, 2=sharp_adc
//  tipoMini legacy: 0=sonar2,1=sonar1,2=sonar1+opt,3=opt2,4=opt1,5=sharp2,6=sharp1
// ═══════════════════════════════════════════════════════
struct SumoConfig {
  // ── Identificación de perfil ──
  uint8_t  perfil;          // 0=mini, 1=micro

  // ── Sensor de oponente ──
  uint8_t  tipoDistSensor;  // 0=sonar, 1=optico, 2=sharp
  uint8_t  numDistSensores; // 1 o 2
  // Sonar
  uint8_t  trigI, echoI;
  uint8_t  trigD, echoD;
  // Sharp (detección digital por umbral)
  uint8_t  sharpPinI;       // 0=ADC0, 1=ADC1
  uint8_t  sharpPinD;
  uint16_t umbralSharp;     // umbral ADC para detección (por defecto 1800)
  // Óptico digital
  uint8_t  optPinI;
  uint8_t  optPinD;

  // ── Sensores de borde ──
  uint8_t  numBorde;        // 0, 1 o 2
  uint8_t  bordePinI;       // 0=ADC0, 1=ADC1
  uint8_t  bordePinD;
  uint16_t umbralBorde;

  // ── Umbral sonar ──
  uint8_t  umbralDistCm;    // umbral distancia sonar en cm

  // ── Velocidades independientes ──
  uint8_t  spdAtaque;       // velocidad de ataque (0-255)
  // ── Abstracción pedagógica de búsqueda (fase "Cierre Sumo") ──
  // Reemplaza la exposición directa de "rueda externa/rueda interna"
  // (antes spdBuscExt/spdBuscInt) por dos conceptos físicos que el
  // alumno puede entender sin saber cómo está cableado el robot. La
  // traducción a velocidades de rueda real la hacen velExterna()/
  // velInterna() (ver junto a searchCircle()/searchSweep()) — el
  // mecanismo de motores no cambió, solo con qué nombres se configura.
  uint8_t  velBusqueda;     // "Velocidad de búsqueda" — velocidad base con la que el robot se desplaza mientras busca (0-255)
  uint8_t  intGiro;         // "Intensidad del giro" — diferencial RELATIVO entre ruedas (0-255). NO es un ángulo ni un radio exactos.
  uint8_t  spdEvasion;      // velocidad al escapar del borde
  uint16_t durBarrido;      // "Duración del barrido" (ms) — solo aplica a Mini con estrategia=1 (BARRIDO). Micro no la usa (siempre CÍRCULO).

  // ── Estrategia búsqueda (solo mini) ──
  uint8_t  estrategia;      // 0=círculo, 1=barrido (ex "cabeceo")
};


//Ultimo "Franky_4.0-R19"
const char* WIFI_SSID = "Franky_4.0";
const char* WIFI_PASS = "12345678";
const char* FW_VER    = "3.2-LNR";

#define PIN_MB_IN2   2
#define PIN_MB_IN1   3
#define PIN_MA_IN2   4
#define PIN_MA_IN1   5
#define PIN_I2C_SDA  6   // valor por defecto — desde Fase 4.2 es seleccionable, ver i2cSda/i2cScl
#define PIN_I2C_SCL  7   // valor por defecto — desde Fase 4.2 es seleccionable, ver i2cSda/i2cScl
#define PIN_LED      8
#define PIN_BTN      9
#define PIN_SPI_CS   10
// PIN_SPI_MISO eliminado en Fase 4.1 (auditoría): estaba definido como GPIO1,
// el mismo pin que PIN_ADC1 (Sharp/borde) — nunca se usó en ningún lado del
// archivo (no hay SPI.h, no hay transacción SPI real; "spiEnabled" solo
// reserva CS/MOSI/SCLK para un futuro uso, nunca leyó MISO). Mantenerlo
// definido como GPIO1 era un bug latente: cualquier código futuro que usara
// PIN_SPI_MISO literalmente habría pisado el canal ADC1 del Sharp. Los 3
// pines de este grupo (CS/MOSI/SCLK = 10/21/20) siguen reservados como
// "bus alternativo" — es el mismo pool que en Fase 4.2 se ofrece como
// ubicación alternativa de I2C.
#define PIN_SPI_MOSI 21
#define PIN_SPI_SCLK 20
#define PIN_ADC0     0
#define PIN_ADC1     1
#define PIN_DHT22    3   // ver aviso HALLAZGO_DHT22 más abajo — comparte pin con PIN_MB_IN1

#define CH_A1    1
#define CH_A2    2
#define CH_B1    3
#define CH_B2    4
// PWM_FREQ bajado de 20000 a 1000 Hz (corrección, ver reporte de
// Martín: motores solo giraban a PWM=255, ni siquiera 254 alcanzaba).
// Razón técnica: a 20kHz, el tiempo que el H-bridge (RZ7899) pasa
// realmente conmutando es una fracción mayor de cada ciclo — a duty
// altos casi no importa, pero por debajo de ~100% el tiempo efectivo
// de conducción por ciclo se reduce tanto que el motor nunca junta
// suficiente energía para vencer la fricción estática (stiction) del
// eje/reductora. 1kHz es la frecuencia típica recomendada para motores
// de corriente continua con puentes H económicos — mismo criterio que
// usan la mayoría de los firmwares de robots educativos con este tipo
// de driver. Esto es una hipótesis técnica razonable, NO una certeza:
// necesita confirmarse en el robot real (ver plan de prueba del
// changelog). Si con 1kHz el corte sigue siendo tan abrupto, el
// problema probablemente esté en el driver o el cableado, no en la
// frecuencia de PWM.
#define PWM_FREQ 1000
#define PWM_RES  8

#define RETARDO_SUMO  5000
// CABECEO_MS — duración de cada "pierna" del barrido de búsqueda
// (searchSweep(), ver más abajo). Revisado en la fase "Sumo: sincronización
// del botón físico + mejora de estrategia de cabeceo" — antes era 300ms
// con un giro EN EL LUGAR (pivote puro, ambas ruedas a velocidad opuesta),
// que el barrido nuevo reemplaza por una curva (ambas ruedas hacia
// adelante, alternando cuál es la rápida — ver searchSweep()). Valor
// elegido en base a los factores pedidos, no arbitrario:
//   - ejecutarSumo() corre cada 50ms (ver loop(), case MODE_MINI/MODE_MICRO)
//     — leerBordes()/leerOponente() se reevalúan a ESE ritmo, SIEMPRE,
//     sin importar CABECEO_MS: la seguridad de borde no depende de este
//     valor, ya se revisa en cada tick de 50ms antes de continuar
//     cualquier búsqueda (ver ejecutarSumo()).
//   - leerOponente() con sonar puede tardar hasta ~11-12ms POR sensor
//     (NewPing con max_cm=200 ≈ 200*2/34300cm/us ≈ 11.4ms de timeout si
//     no hay eco) — con 2 sensores (Mini) hasta ~23ms dentro de un mismo
//     tick de 50ms. CABECEO_MS no cambia esto, pero se tuvo en cuenta
//     para no elegir un valor tan chico que compita con ese margen.
//   - 250ms / 50ms = 5 ticks de ejecutarSumo() por pierna del barrido:
//     suficientes reevaluaciones de sensor por pierna como para que cada
//     giro sea una curva coherente (no un temblor), pero corto para que
//     el robot no se comprometa muchos grados de rumbo antes de volver a
//     revisar. Punto de partida para la primera prueba física — "corto,
//     predecible y seguro" antes que "máxima eficacia" (ver informe).
#define CABECEO_MS    250

// Timeouts sonar: cortos para minimizar bloqueo en loop (NewPing ya gestiona timeout)
#define SONAR_MAX_CM  200

#define MAX_INST 64
#define OP_FIN      0
#define OP_ADE      1
#define OP_ATR      2
#define OP_IZQ      3
#define OP_DER      4
#define OP_STOP     5
#define OP_ESP      6
#define OP_LED_ON   7
#define OP_LED_OFF  8
#define OP_IF_DIST  9
#define OP_FRENO    11
#define OP_DOUT     20
#define OP_PWM_OUT  22
#define OP_ADC_READ 30
#define OP_SERVO    40
#define OP_VAR_SET  60
#define OP_VAR_ADD  61
#define OP_VAR_SUB  62
#define OP_IF_GT    70
#define OP_IF_LT    71
#define OP_REPEAT   74
// Salto incondicional a un índice absoluto del programa. Sin esto,
// OP_IF_GT/OP_IF_LT (que solo pueden "saltear la instrucción siguiente")
// no alcanzan para condicionar un bloque "si...entonces" de más de una
// instrucción, ni para armar un "mientras" real — ver FRANKY LAB, informe
// de migración de Fase 3, para el detalle completo del bug que esto
// corrige y las pruebas que lo validan.
#define OP_JMP      91
// Extensión de FRANKY LAB (Fase 3, completada en esta actualización):
// pila de trabajo para pasar múltiples parámetros a una instrucción
// (necesaria porque {op,val} solo tiene UN parámetro numérico), y OLED
// real usando la librería que ya estaba incluida pero nunca inicializada.
#define OP_PUSH        90
#define OP_CALL        92
#define OP_RET         93
#define OP_MILLIS_READ 94
#define OP_OLED_INIT    101
#define OP_OLED_CLEAR   102
#define OP_OLED_CURSOR  103
#define OP_OLED_PRINT   104 // requiere texto — struct Instruccion no tiene ese campo todavía, ver informe
#define OP_OLED_LINE    105
#define OP_OLED_RECT    106
#define OP_OLED_CIRCLE  107
#define OP_OLED_DISPLAY 108
#define OP_OLED_SPRITE  109 // Fase 4.4 — nuevo, dibuja un sprite 16x16 desde tablaBitmap[]
#define OP_SERIAL_PRINT 122 // requiere texto — mismo motivo que OP_OLED_PRINT
#define OP_BUZZER       123 // sin pin físico en esta placa — no-op documentado

// Unidad 2 (Etapa 2/Fase 2 P0) — variables con fuente dinámica (ADC/sonar/
// operaciones/otra variable), no sólo literales. Mapa y contratos completos
// en MAPA_OPCODES_CONTRATOS_FASE2_P0.md + su addendum — rango 75-84, ya
// confirmado libre, sin colisión con ningún opcode existente. Todos
// reutilizan pila[]/pilaPop() igual que ya hacen hoy los bloques OLED.
#define OP_PUSH_VAR      75 // empuja varTabla[val] (val=0-3)
#define OP_PUSH_ADC      76 // val=pin*100+N; empuja el promedio de N lecturas analogRead(pin)
#define OP_PUSH_SONAR    77 // val=trig*100+echo; empuja leerSonar(trig,echo) en cm — funciona con o sin Sumo activo
#define OP_POP_ADD       78 // b=pop(); a=pop(); push(a+b), saturado a int16
#define OP_POP_SUB       79 // idem resta
#define OP_POP_MUL       80 // idem multiplicación
#define OP_POP_DIV       81 // idem división entera; b==0 -> push(0), documentado
// Diagnóstico y corrección de temporizadores millis() (Síntomas A/B,
// "CLAUDE — DIAGNÓSTICO Y CORRECCIÓN DE TEMPORIZADORES millis()") —
// causa raíz CONFIRMADA: OP_MILLIS_READ (94) ya truncaba millis() "con
// desborde" (ver su comentario, más abajo), pero OP_POP_SUB satura
// (constrain()) el resultado de la resta en vez de envolverlo en 16
// bits — rompe el truco clásico de Arduino "ahora - antes" en cuanto
// millis() y el valor guardado quedan en lados opuestos del límite de
// ±32768: la resta se satura a un extremo fijo que nunca vuelve a
// cumplir ningún umbral positivo, y el temporizador queda congelado
// para siempre (confirmado y reproducido en FRANKY-LAB, mismo bug
// exacto, mismo intérprete replicado). OP_POP_SUB_T es idéntico a
// OP_POP_SUB (misma pila, mismo pop-pop-push) salvo que ENVUELVE el
// resultado en 16 bits en vez de saturarlo — único emisor: el
// compilador (bloques.html) para el patrón "millis() - variable" (ver
// compileExpr()). OP_POP_SUB sigue intacto, con su saturación original,
// para cualquier otra resta genérica — no cambia el comportamiento de
// ninguna otra operación matemática existente.
#define OP_POP_SUB_T     89
#define OP_VAR_SET_EXPR  82 // varTabla[val]=pop() (val=0-3)
#define OP_VAR_ADD_EXPR  83 // varTabla[val]+=pop()
#define OP_VAR_SUB_EXPR  84 // varTabla[val]-=pop()

// Unidad 4 (Fase 2 P0) — condicionales y lógica genéricos (bloques estándar
// Blockly controls_if/logic_compare/logic_operation/logic_negate, antes
// presentes en el toolbox pero SIN case -> se ignoraban en silencio al
// "Ejecutar"). Mapa consolidado y contratos completos en
// MAPA_OPCODES_CONTRATOS_FASE2_P0.md §0/§2.2 — todos confirmados libres en
// los tres intérpretes antes de asignarse (incluye el rango 95-121,
// ocupado por opcodes "muertos" del LAB, ver §8 del mapa).
//
// Dos familias con propósitos distintos (ambas necesarias, no redundantes):
//  (a) Comparación directa + salto (85-87, 126-128): atajo para el caso
//      común "si A > B" (logic_compare como condición DIRECTA de un
//      controls_if) — compara los dos operandos de pila[] y saltea o no la
//      siguiente instrucción, sin necesitar push+pop intermedio. Mismo
//      patrón que ya usan OP_IF_GT/OP_IF_LT (70/71) pero con operandos
//      dinámicos en vez de ADC0 hardcodeado.
//  (b) Comparación que empuja 0/1 (115, 129-133) + lógica booleana sobre
//      pila (116-118) + consumo final (119): para condiciones compuestas
//      (AND/OR/NOT, comparaciones anidadas) o cuando logic_compare se usa
//      como VALOR (p.ej. "variable = (A>B)"), no como condición directa de
//      un si. OP_IF_TRUE consume el resultado final de esa cadena.
#define OP_IF_GT_EXPR    85  // b=pop(); a=pop(); progPC+=(a>b)?2:1
#define OP_IF_LT_EXPR    86  // idem <
#define OP_IF_EQ_EXPR    87  // idem ==
#define OP_PUSH_CMP_NE   115 // b=pop(); a=pop(); push((a!=b)?1:0)
#define OP_POP_AND       116 // b=pop(); a=pop(); push((a!=0 && b!=0)?1:0)
#define OP_POP_OR        117 // idem ||
#define OP_POP_NOT       118 // a=pop(); push((a==0)?1:0)
#define OP_IF_TRUE       119 // a=pop(); progPC+=(a!=0)?2:1 — consume el resultado final de la cadena AND/OR/NOT/comparación
#define OP_IF_GE_EXPR    126 // idem >=
#define OP_IF_LE_EXPR    127 // idem <=
#define OP_IF_NE_EXPR    128 // idem !=
#define OP_PUSH_CMP_GT   129 // push((a>b)?1:0)
#define OP_PUSH_CMP_LT   130 // push((a<b)?1:0)
#define OP_PUSH_CMP_EQ   131 // push((a==b)?1:0)
#define OP_PUSH_CMP_GE   132 // push((a>=b)?1:0)
#define OP_PUSH_CMP_LE   133 // push((a<=b)?1:0)

// Unidad 5 (Fase 2 P0) — salida dinámica por Serial/OLED. A diferencia
// del plan original (addendum/mapa: "val=índice de variable 0-3"), estos
// dos opcodes popean pila[] directamente — cualquier expresión compilada
// por compileExpr() (variable, ADC, sonar, resultado de operación) puede
// imprimirse, no solo una de las 4 variables con nombre. Mapa consolidado
// actualizado en MAPA_OPCODES_CONTRATOS_FASE2_P0.md §0/§2.3.
#define OP_SERIAL_PRINT_VAR 124 // pop(); Serial.println(valor) — numérico, no texto
#define OP_OLED_PRINT_VAR   125 // pop(); display.print(valor) en el cursor actual (posicionado por OLED_CURSOR, igual que OP_OLED_PRINT)

// Unidad 6 (Fase 2 P0): sin opcode nuevo — OP_PUSH_SONAR (77) ya existía
// desde la Unidad 2; esta unidad conecta su lectura con el Motor de
// Simulación en el LAB (ver provider franky-server-4.0). El Server no
// necesitó ningún cambio: leerSonar() ya usaba NewPing real desde antes.

// Unidad 7 (Fase 2 P0) — ciclo real, reemplaza el desenrollado en tiempo
// de compilación. OP_REPEAT (74, ya declarado desde la auditoría inicial
// pero sin `case` propio — caía al `default:`, tratado como OP_FIN) pasa
// a tener semántica real: empuja val (nº de iteraciones) a repeatStack[]
// y avanza una sola vez, al ENTRAR al ciclo. OP_REPEAT_END (88, nuevo) va
// al final del cuerpo: decrementa el tope de repeatStack[]; si queda >0,
// salta de vuelta al inicio del cuerpo (val = índice absoluto de ese
// inicio, fijado por el compilador); si llega a 0, lo saca de la pila de
// ciclos y sigue. "0 iteraciones" nunca llega a generar estas dos
// instrucciones: el compilador (bloques.html), al ver un literal <=0 en
// el campo N/TIMES, no emite nada para todo el bloque — el ciclo real
// jamás tiene que decidir en tiempo de ejecución si entrar o no con 0,
// porque simplemente no existe en el bytecode. Ver
// MAPA_OPCODES_CONTRATOS_FASE2_P0.md §2.4/§15 para el contrato completo
// y Informe_Unidad7_Ciclos.md para el detalle de implementación y pruebas.
#define OP_REPEAT_END 88 // val = índice absoluto de retorno (= inicio del cuerpo del ciclo)

WebServer   server(80);
Preferences prefs;

bool  i2cEnabled = false;
bool  spiEnabled = false;
// Fase 4.2: SDA/SCL seleccionables — PIN_I2C_SDA/PIN_I2C_SCL (6/7) siguen
// siendo el valor por defecto de fábrica; i2cSda/i2cScl son el par
// REALMENTE activo, persistido aparte, y son los que hay que leer en
// cualquier código nuevo (Wire.begin, reservas de GPIO, JSON de estado).
uint8_t i2cSda = PIN_I2C_SDA;
uint8_t i2cScl = PIN_I2C_SCL;
int   motorSpeed = 200;
int   trimA = 255;
int   trimB = 255;
int   pwmA = 0;
int   pwmB = 0;

RobotMode currentMode = MODE_IDLE;
bool      modeRunning = false;

// ═══════════════════════════════════════════════════════
//  MONITOR SERIE VIRTUAL — infraestructura transversal
//
//  Segunda salida de diagnóstico además de Serial USB, accesible por
//  WiFi/HTTP — para uso normal del robot sin depender del cable. NO
//  reemplaza Serial.println() (sigue existiendo tal cual en todo el
//  archivo); frankyLog() hace las dos cosas a la vez.
//
//  Buffer circular de tamaño FIJO en RAM estática — nunca crece sin
//  límite. Al llenarse, se pisa la entrada más vieja (mismo criterio
//  que cualquier buffer circular). Cada entrada lleva un "seq"
//  (contador incremental) para que el frontend pueda pedir "todo lo
//  nuevo desde seq=N" en vez de releer el buffer entero cada vez.
// ═══════════════════════════════════════════════════════
#define MONITOR_BUF_N   40
#define MONITOR_MSG_LEN 96
struct LogEntry { uint32_t seq; uint32_t ms; char msg[MONITOR_MSG_LEN]; };
LogEntry monitorBuf[MONITOR_BUF_N];
uint8_t  monitorHead = 0;      // próxima posición a escribir
uint32_t monitorSeq  = 0;      // próximo número de secuencia a asignar
bool     debugEnabled = false; // DEBUG apagado por defecto — solo INFO/WARN/ERROR

// Prefijo automático según el modo activo — así ningún punto de
// llamada tiene que repetir "[SUMO]"/"[BLOCKLY]"/etc. a mano.
const char* monitorContextoActual() {
  switch (currentMode) {
    case MODE_MINI:
    case MODE_MICRO:   return "SUMO";
    case MODE_BLOQUES:  return "BLOCKLY";
    case MODE_VIVERO:   return "VIVERO";
    case MODE_METEO:    return "METEO";
    case MODE_ALARMA:   return "ALARMA";
    case MODE_ACCESO:   return "ACCESO";
    default:            return "SERVER";
  }
}

// Etapa de diagnóstico avanzado — texto completo de cada RobotMode
// (distinto de monitorContextoActual(), que agrupa Mini/Micro en
// "SUMO" — acá se necesita el nombre específico para MODE_CHANGE).
const char* modoTexto(RobotMode m) {
  switch (m) {
    case MODE_IDLE:    return "IDLE";
    case MODE_MICRO:   return "MICROSUMO";
    case MODE_MINI:    return "MINISUMO";
    case MODE_VIVERO:  return "VIVERO";
    case MODE_METEO:   return "METEO";
    case MODE_ALARMA:  return "ALARMA";
    case MODE_ACCESO:  return "ACCESO";
    case MODE_BLOQUES: return "BLOQUES";
    default:           return "?";
  }
}

// ═══════════════════════════════════════════════════════
//  ETAPA DE DIAGNÓSTICO AVANZADO — estadísticas + clasificación
//
//  Todo primitivo (uint32_t/unsigned long/bool) — a propósito, sin
//  ningún struct/enum nuevo usado como parámetro de función, para no
//  repetir el bug de ctags ya visto dos veces (GpioMotivo, SumoConfig).
//
//  UMBRALES: son internos de diagnóstico de FRANKY, decididos acá con
//  el valor normal medido (~25ms) como referencia — NO son valores
//  oficiales de Espressif ni de Adafruit. Documentado explícitamente
//  para no hacerlos pasar por algo que no son.
// ═══════════════════════════════════════════════════════
#define OLED_DISPLAY_WARNING_US  100000UL  // 100ms = ~4x el valor normal medido (~25ms)
#define OLED_DISPLAY_CRITICAL_US 1000000UL // 1000ms = 1s, orden de magnitud del timeout de hardware I2C documentado (ver informe)

uint32_t oledDisplayMinUs = 0xFFFFFFFF;
uint32_t oledDisplayMaxUs = 0;
uint64_t oledDisplaySumUs = 0;
uint32_t oledDisplayLastUs = 0;

bool     huboAnomaliaOled = false;
uint32_t firstAnomalySeq = 0;
unsigned long firstAnomalyMs = 0;
uint32_t firstAnomalyDurUs = 0;

uint32_t lastOkSeq = 0;
unsigned long lastOkMs = 0;
uint32_t lastOkDurUs = 0;


// Núcleo del sistema: escribe a Serial USB (igual que siempre) Y al
// buffer circular. `nivel` es un solo char: 'I' info, 'D' debug, 'W'
// warn, 'E' error. Los mensajes DEBUG se descartan en el buffer/consola
// virtual si debugEnabled==false (pero SÍ se siguen viendo por Serial
// USB — el USB nunca pierde nada, el filtro es solo del lado virtual).
void frankyLog(char nivel, const char* contexto, const String& msg) {
  String linea = "[" + String(nivel) + "][" + String(contexto) + "] " + msg;
  Serial.println(linea);
  if (nivel == 'D' && !debugEnabled) return; // USB ya lo vio arriba, el buffer virtual no lo necesita si DEBUG está apagado
  LogEntry& e = monitorBuf[monitorHead];
  e.seq = monitorSeq++;
  e.ms  = millis();
  linea.substring(0, MONITOR_MSG_LEN - 1).toCharArray(e.msg, MONITOR_MSG_LEN);
  monitorHead = (monitorHead + 1) % MONITOR_BUF_N;
}
// Atajo — usa el contexto automático del modo activo.
void flog(char nivel, const String& msg) { frankyLog(nivel, monitorContextoActual(), msg); }

// Throttling simple: hasta 8 "categorías" con su propio último-momento-
// de-log. Antes de loguear un valor que puede cambiar muy rápido
// (lectura de sensor en cada tick, decisiones de estado en un loop de
// 20ms), se consulta flogThrottle(categoria, minMs) — si no pasó
// suficiente tiempo desde el último log de esa categoría, no hace nada.
#define MONITOR_CAT_N 8
struct ThrottleCat { const char* nombre; uint32_t ultimoMs; };
ThrottleCat monitorCats[MONITOR_CAT_N] = {
  {"sumo_estado",0},{"sumo_sensor",0},{"blockly_bloque",0},
  {"manual_cmd",0},{"lab_pd",0},{"gen1",0},{"gen2",0},{"gen3",0}
};
bool flogThrottle(const char* categoria, uint32_t minMs) {
  for (int i = 0; i < MONITOR_CAT_N; i++) {
    if (strcmp(monitorCats[i].nombre, categoria) == 0) {
      uint32_t ahora = millis();
      if (ahora - monitorCats[i].ultimoMs < minMs) return false; // todavía no, no loguear
      monitorCats[i].ultimoMs = ahora;
      return true;
    }
  }
  return true; // categoría no registrada -- no bloquear, dejar pasar
}

unsigned long tModo       = 0;
unsigned long tSensor     = 0;
unsigned long tInicioModo = 0;
bool          retardoOK   = false;
float sensorTemp  = 0.0;
float sensorHum   = 0.0;
bool  alarmaActiva  = false;
bool  accesoAbierto = false;

DHT dht(PIN_DHT22, DHT22);
bool  dhtOK = false;

struct Instruccion { uint8_t op; int16_t val; };
Instruccion programa[MAX_INST];
// Unidad 2 (Etapa 2/Fase 2 P0) — variable única -> 4 variables con nombre.
// varGlobal queda como alias de varTabla[0] (macro, no una variable nueva)
// para que OP_VAR_SET/ADD/SUB (60/61/62, literal) y OP_ADC_READ/MILLIS_READ
// sigan funcionando exactamente igual que antes, sin tocar una sola línea
// de su propio case — compatibilidad total con firmware/.franky previos.
// Verificado: varGlobal no se lee desde ningún otro lugar del archivo
// (sin endpoint HTTP ni panel que la expongan), así que el alias cubre
// el 100% de los usos reales.
float    varTabla[4] = {0.0, 0.0, 0.0, 0.0};
#define  varGlobal   varTabla[0]
int      adcLast    = 0;
Servo    servoObj;


// Instancias de config por perfil
//
// velBusqueda/intGiro elegidos para RECONSTRUIR exactamente las
// velocidades de rueda de fábrica que ya tenía cada perfil (ver
// velExterna()/velInterna()): velBusqueda=(ext+int)/2, intGiro=ext-int.
// Mini: ext=210,int=80 -> velBusqueda=145, intGiro=130.
// Micro: ext=200,int=60 -> velBusqueda=130, intGiro=140.
// Ningún robot ya calibrado pierde su comportamiento físico por este
// cambio de nombres — ver también la migración de NVS en
// loadSumoConfig().
SumoConfig cfgMini = {
  0, 0, 2,            // perfil mini, sonar, 2 sensores
  20, 21, 6, 7,       // trigI, echoI, trigD, echoD
  0, 1, 1800,         // sharpPinI, sharpPinD, umbralSharp
  9, 6,               // optPinI, optPinD
  2, 0, 1, 1500,      // numBorde, bordePinI, bordePinD, umbralBorde
  30,                 // umbralDistCm
  255, 145, 130, 220, // spdAtaque, velBusqueda, intGiro, spdEvasion
  CABECEO_MS,         // durBarrido (ms) — valor de fábrica, igual al que ya usaba el barrido
  0                   // estrategia
};

SumoConfig cfgMicro = {
  1, 0, 1,            // perfil micro, sonar, 1 sensor
  20, 21, 0, 0,       // trigI, echoI (D no usado)
  0, 1, 1800,         // sharpPinI (D no usado)
  9, 0,               // optPinI (D no usado)
  1, 0, 1, 1500,      // numBorde=1, bordePinI=ADC0
  25,                 // umbralDistCm
  255, 130, 140, 200, // spdAtaque, velBusqueda, intGiro, spdEvasion
  CABECEO_MS,         // durBarrido — no usado por Micro (siempre CÍRCULO), se mantiene por simetría de struct
  0                   // estrategia (micro siempre círculo)
};

// Puntero a config activa
SumoConfig* cfgActiva = &cfgMini;

// ── Modo de inicio de Sumo + persistencia del perfil activo ──
// Fase "Persistencia Sumo": auditoría encontrada — cfgActiva SIEMPRE
// arrancaba apuntando a &cfgMini en cada reinicio (nunca se persistía
// cuál perfil había sido el último usado/guardado), y el botón físico
// del PCB (GPIO9/PIN_BTN) no tenía NINGÚN efecto sobre Sumo: su único
// uso en todo el firmware era en loopAcceso() (MODE_ACCESO) y como
// lectura pasiva de telemetría en /api ("btn") — ver informe de
// entrega, sección "Botón PCB", para el detalle completo de esa
// auditoría. Ambas cosas se vuelven persistentes acá, en el MISMO
// namespace NVS "sumo" que ya usa saveSumoConfig()/loadSumoConfig() —
// no se crea un segundo sistema de almacenamiento.
bool sumoInicioServidor = true;  // default = comportamiento actual (el servidor SIEMPRE pudo iniciar Sumo)
bool sumoInicioBoton    = false; // default = comportamiento actual (el boton NUNCA iniciaba Sumo antes de esta fase)

// Para telemetría Sharp en /api
int  sharpAdcValI = 0;  // último valor ADC leído del Sharp izq
int  sharpAdcValD = 0;
bool sharpDetI    = false;
bool sharpDetD    = false;

// Máquina de estados evasión borde (no bloqueante)
enum EvadeState { EVADE_IDLE=0, EVADE_BACK, EVADE_TURN, EVADE_BRAKE };
EvadeState evadeState = EVADE_IDLE;
unsigned long evadeTimer = 0;
bool evadeDirRight = true; // true=girar derecha, false=izquierda
bool evadeBoth = false;

bool   cabeceoDirDer  = true;
unsigned long tCabeceo = 0;

// ═══════════════════════════════════════════════════════
//  SUMO — memoria de última dirección del oponente + recuperación
//  acotada (fase "Cierre Sumo").
//
//  DIR_DESCONOCIDA/IZQUIERDA/DERECHA/CENTRO (enum declarado junto a
//  GpioMotivo/RobotMode, ver HALLAZGO_CTAGS) — actualizada ÚNICAMENTE
//  dentro de ejecutarSumo() y ÚNICAMENTE cuando cfg.numDistSensores==2
//  (dos sensores frontales independientes). Con 1 solo sensor,
//  leerOponente() ya deja oI==oD siempre (ver esa función) — nunca se
//  toca esta variable en ese caso, así que queda congelada en
//  DIR_DESCONOCIDA para siempre en un robot de 1 sensor. Esto es
//  intencional (sección 8 del pedido): jamás se infiere IZQUIERDA/
//  DERECHA a partir de un solo sensor ni del sentido del último giro.
// ═══════════════════════════════════════════════════════
DireccionOponente ultimaDirOponente   = DIR_DESCONOCIDA;
bool          oponentePresenteAnt     = false; // para detectar el flanco "oponente perdido"
bool          enRecuperacion          = false;
bool          recuperacionHaciaIzquierda = true;
unsigned long tRecuperacion           = 0;
int8_t        ultimoAtaqueDirLog      = -1;    // -1=sin ataque, 0=ambos, 1=izq, 2=der — solo para logging por flanco

// RECUPERACION_MS — cuánto dura la búsqueda sesgada hacia la última
// dirección conocida del oponente antes de volver a la estrategia de
// búsqueda normal (CÍRCULO o BARRIDO, sin cambios). Deliberadamente
// NO configurable desde el Server (sección 9 del pedido: "debe ser
// determinista, fácil de explicar... no la conviertas en una estrategia
// excesivamente compleja") — mismo criterio que ya usa este archivo
// para otras constantes de maniobra no configurables (RETARDO_SUMO,
// EVADE_FRENO_MS). Valor: el doble del CABECEO_MS de fábrica (2×250ms
// = 500ms) — un tiempo del mismo orden que una "pierna" de barrido,
// suficiente para sostener un giro perceptible hacia ese lado, pero
// corto para no comprometer al robot muchos grados de rumbo si el
// oponente ya no está ahí. Punto de partida para la primera prueba
// física, igual que ya se documentó para CABECEO_MS.
#define RECUPERACION_MS (CABECEO_MS * 2)

const char* direccionTexto(DireccionOponente d) {
  switch (d) {
    case DIR_IZQUIERDA: return "IZQUIERDA";
    case DIR_DERECHA:   return "DERECHA";
    case DIR_CENTRO:    return "CENTRO";
    default:             return "DESCONOCIDA";
  }
}

// ── Estado macro de Sumo, SOLO para el Monitor Serial ──
// No es una máquina de estados nueva que decida nada — es una etiqueta
// de lo que YA decidió ejecutarSumo() en cada tick (evasión/ataque/
// búsqueda/recuperación/espera), usada únicamente para no repetir el
// mismo mensaje en cada vuelta de 50ms (sección 11 del pedido: "no
// dupliques máquinas de estado solamente para mostrar mensajes").
// (enum EstadoSumoLog declarado junto a GpioMotivo/RobotMode, ver HALLAZGO_CTAGS)
EstadoSumoLog estadoSumoLogActual = ESL_ESPERA;
const char* estadoSumoLogTexto(EstadoSumoLog e) {
  switch (e) {
    case ESL_BUSCANDO:    return "BUSCANDO";
    case ESL_ATACANDO:    return "ATACANDO";
    case ESL_EVADIENDO:   return "EVADIENDO";
    case ESL_RECUPERANDO: return "RECUPERANDO";
    default:               return "ESPERA";
  }
}
void logEstadoSumo(EstadoSumoLog nuevo) {
  bool cambio = (nuevo != estadoSumoLogActual);
  estadoSumoLogActual = nuevo;
  if (cambio) flog('I', estadoSumoLogTexto(nuevo));
}
// Reinicia toda la memoria/latches de logging de un combate — llamada
// desde los 3 puntos de inicio de combate (handleSumoMicro/
// handleSumoMini/iniciarSumoDesdeBoton), igual que ya se hace con
// cabeceoDirDer/tCabeceo/evadeState. Un combate nuevo no hereda la
// "última dirección" del combate anterior.
void reiniciarMemoriaSumo() {
  ultimaDirOponente      = DIR_DESCONOCIDA;
  oponentePresenteAnt    = false;
  enRecuperacion         = false;
  estadoSumoLogActual    = ESL_ESPERA;
  ultimoAtaqueDirLog     = -1;
}

// Legacy: tipoMini int para compatibilidad con código existente
// Se calcula dinámicamente desde cfgMini al activar
int sumoTipoMini = 0;

int  sonarTrig   = 20;
int  sonarEcho   = 21;
int  sonarCm     = 0;
bool sonarActive = false;

int      servoGPIO = -1;
uint8_t  repeatCnt = 0;
uint8_t  repeatN   = 0;
uint8_t  repeatPC  = 0;
uint8_t  progLen   = 0;

// ═══════════════════════════════════════════════════════
//  ANÁLISIS ESTÁTICO DE RECURSOS DEL PROGRAMA BLOCKLY
//
//  Primer cambio aislado de la etapa "Runtime Global + Recursos" —
//  ver acuerdo explícito: esta función SOLO LEE programa[], nunca lo
//  modifica, nunca toca motores/OLED/I2C/currentMode/modeRunning.
//
//  Es un análisis ESTÁTICO ("recurso declarado por el programa"), no
//  dinámico ("recurso en uso en este instante exacto"). Ejemplo: un
//  programa con "SI distancia>20 → ADELANTE" marca progUsaMotores=true
//  aunque en un momento dado la condición sea falsa y el motor no esté
//  realmente girando — es la política conservadora acordada, documentada
//  acá explícitamente para que quede claro que es intencional.
//
//  No hace falta simular OP_JMP/OP_CALL/OP_RET: programa[] ya es una
//  lista lineal y completa (los bucles f_repeat de Blockly se
//  "desenrollan" en tiempo de compilación, del lado del navegador,
//  antes de subir las instrucciones — confirmado leyendo
//  parseBlock()/case "f_repeat" en bloques.html). Un barrido simple de
//  programa[0..progLen-1] alcanza.
// ═══════════════════════════════════════════════════════
bool progUsaMotores = false;
bool progUsaOled    = false;
bool progUsaSerial  = false;

void analizarRecursosPrograma() {
  progUsaMotores = false;
  progUsaOled    = false;
  progUsaSerial  = false;
  for (int i = 0; i < progLen; i++) {
    uint8_t op = programa[i].op;
    switch (op) {
      // Motores — certeza alta, opcodes dedicados
      case OP_ADE: case OP_ATR: case OP_IZQ: case OP_DER:
      case OP_STOP: case OP_FRENO:
        progUsaMotores = true;
        break;
      // OP_PWM_OUT: certeza alta pero NO obvia por el nombre — está
      // hardcodeado a GPIO3 (ledcAttachPin(3,8) en su propio case),
      // que es PIN_MB_IN1 (motor B). Documentado también en el punto
      // de ejecución real, no solo acá.
      case OP_PWM_OUT:
        progUsaMotores = true;
        break;
      // OP_DOUT / OP_SERVO: el pin es un parámetro guardado en
      // programa[i].val, decidido en tiempo de COMPILACIÓN (no de
      // ejecución) — se puede decodificar con certeza acá, no hace
      // falta ser conservador "a ciegas". Mismo cálculo que hace el
      // propio intérprete en ejecutarBloque() para estos opcodes.
      case OP_DOUT: {
        int gpio = programa[i].val / 10;
        if (gpio==2 || gpio==3 || gpio==4 || gpio==5) progUsaMotores = true;
        break;
      }
      case OP_SERVO: {
        int gpio = programa[i].val / 1000;
        if (gpio==2 || gpio==3 || gpio==4 || gpio==5) progUsaMotores = true;
        break;
      }
      // OLED — certeza alta, familia completa de opcodes dedicados.
      // Unidad 5 (Fase 2 P0) — HALLAZGO: OP_OLED_PRINT_VAR (125, salida
      // dinámica nueva) usa el mismo recurso físico que OP_OLED_PRINT
      // pero tiene un número FUERA del rango 101-109 en el que se
      // definieron originalmente los opcodes OLED — sin este case, un
      // programa que solo use "OLED valor" (sin ningún otro bloque OLED)
      // no sería detectado como usuario de OLED, y el Panel Industrial
      // podría pisarlo sin que hayConflictoRecurso() lo avisara. Mismo
      // tipo de hallazgo que la colisión de opcodes de la Unidad 2 —
      // encontrado y corregido antes de declarar la unidad completa
      // (condición 5/2 del usuario).
      case OP_OLED_INIT: case OP_OLED_CLEAR: case OP_OLED_CURSOR:
      case OP_OLED_PRINT: case OP_OLED_LINE: case OP_OLED_RECT:
      case OP_OLED_CIRCLE: case OP_OLED_DISPLAY: case OP_OLED_SPRITE:
      case OP_OLED_PRINT_VAR:
        progUsaOled = true;
        break;
      // Serial — certeza alta. Unidad 5: mismo hallazgo que arriba,
      // aplicado a OP_SERIAL_PRINT_VAR (124).
      case OP_SERIAL_PRINT:
      case OP_SERIAL_PRINT_VAR:
        progUsaSerial = true;
        break;
      // Sensores (IF_DIST, ADC_READ, IF_GT, IF_LT): lectura, recurso
      // compartible — documentado a propósito sin variable nueva
      // todavía (acordado explícitamente, no agregar progUsaSensores
      // en esta etapa).
      // LED onboard (LED_ON/LED_OFF): documentado sin variable nueva
      // todavía (acordado explícitamente, no agregar progUsaLed).
      // OP_BUZZER: no-op sin pin físico en esta placa — no es recurso.
      // Control de flujo/variables/tiempo (FIN, ESP, VAR_*, REPEAT,
      // PUSH, JMP, CALL, RET, MILLIS_READ): no tocan ningún recurso
      // físico, no necesitan entrada en este switch.
      default:
        break;
    }
  }
}
uint8_t  progPC    = 0;
unsigned long tBloque = 0;
bool     bEsperando   = false;
int16_t  bEsperaMs    = 0;

// Extensión de Laboratorio completada en esta actualización — pila de
// trabajo (parámetros de OLED/futuras instrucciones), pila de retorno
// (OP_CALL/OP_RET), y estado del cursor OLED (Adafruit_GFX no expone
// getCursorX/Y, así que lo llevamos aparte).
#define PILA_MAX 8
int16_t  pila[PILA_MAX];
uint8_t  pilaLen = 0;
int16_t  callStack[PILA_MAX];
uint8_t  callStackLen = 0;
// Unidad 7 (Fase 2 P0): pila de ciclos reales — paralela a pila[]/
// callStack[], mismo PILA_MAX=8 (ver OP_REPEAT/OP_REPEAT_END arriba). El
// viejo repeatCnt (una sola variable, nunca usada) no alcanza para
// ciclos anidados: cada repeat anidado necesita su propio contador de
// iteraciones restantes vivo al mismo tiempo que el de su ciclo
// contenedor.
int16_t  repeatStack[PILA_MAX];
uint8_t  repeatStackLen = 0;
bool     oledInicializado = false;
int16_t  oledCursorX = 0, oledCursorY = 0;
unsigned long oledDisplayCount = 0; // contador de OP_OLED_DISPLAY ejecutados desde el arranque

// ═══════════════════════════════════════════════════════
//  CAPA 3 — SEGURIDAD DE RECURSOS: helpers compartidos
//
//  Reutilizados por Panel (OLED), Gamepad (motores) y Sumo (motores) —
//  una sola implementación, no un chequeo distinto por endpoint.
//  Nota de orden de declaración: aunque stopMotors() se define más
//  abajo en el archivo, esto compila igual — el generador automático
//  de prototipos de Arduino ya resuelve las llamadas a funciones
//  definidas más adelante (el problema real, ya visto dos veces, es
//  con TIPOS — struct/enum — usados como parámetro, no con llamadas a
//  funciones comunes). detenerBlockly()/hayConflictoRecurso() solo
//  usan tipos primitivos (bool, const char*), sin ese riesgo.
// ═══════════════════════════════════════════════════════
bool hayConflictoRecurso(bool recursoUsadoPorPrograma) {
  return (currentMode == MODE_BLOQUES && modeRunning && recursoUsadoPorPrograma);
}

// Detiene Blockly de forma centralizada — mismo efecto que ya tenía
// handleBloquesStop() (modeRunning=false, currentMode=MODE_IDLE,
// stopMotors()), factorizado para que Panel/Gamepad/Sumo puedan
// invocarlo al resolver un conflicto sin duplicar la lógica. NUNCA
// toca programa[]/progLen/tablaTxt/tablaBitmap — el programa se
// conserva siempre, solo se detiene la ejecución.
void detenerBlockly(const char* motivo) {
  if (currentMode == MODE_BLOQUES && modeRunning) {
    flog('I', String("BLOCKLY detenido (") + motivo + ")");
  }
  RobotMode modoAnterior = currentMode;
  currentMode = MODE_IDLE;
  modeRunning = false;
  // Etapa 1 / Unit 1: ver comentario en handleBloquesRun(). Esto SÍ es
  // seguro de tocar acá: pila[]/callStack[] son estado de ejecución, no
  // "programa[]/progLen/tablaTxt/tablaBitmap" (que esta función
  // explícitamente preserva, ver comentario arriba de detenerBlockly).
  pilaLen=0; callStackLen=0; repeatStackLen=0; // Unidad 7: misma disciplina de reinicio que pila[]/callStack[]
  stopMotors();
  // BLOQUE D — mismo hallazgo que en Sumo: si el programa tenía el LED
  // encendido (OP_LED_ON) en el momento de detenerse, nada lo apagaba.
  digitalWrite(PIN_LED, HIGH);
  if (modoAnterior != currentMode) flog('I', String("MODE_CHANGE ") + modoTexto(modoAnterior) + " -> " + modoTexto(currentMode));
}

// ═══════════════════════════════════════════════════════
//  FASE 4.4 — TABLAS DE TEXTO Y SPRITE PARA BLOCKLY
//
//  struct Instruccion { uint8_t op; int16_t val; } no puede llevar una
//  cadena de texto ni un bitmap — un solo campo numérico. Mismo patrón
//  que ROBOARD (informe de referencia, sección 3.5): una tabla chica
//  aparte, el opcode viaja con el ÍNDICE de esa tabla en `val`, nunca
//  con el dato en sí. Se resetean en cada /bloques/clear (recompilación
//  completa del programa) — ver handleBloquesClear().
//
//  Texto: 8 entradas × 24 caracteres (+ terminador nulo) — 24, no 16,
//  para igualar exactamente el criterio ya validado en ROBOARD.
//  Sprite: 8 entradas × 32 bytes (16x16 píxeles, 1 bit por píxel).
// ═══════════════════════════════════════════════════════
#define TABLA_TXT_MAX     8
#define TABLA_TXT_LEN     25   // 24 caracteres + '\0'
#define TABLA_BITMAP_MAX  8
#define TABLA_BITMAP_BYTES 32  // 16x16 / 8

char    tablaTxt[TABLA_TXT_MAX][TABLA_TXT_LEN];
uint8_t tablaTxtLen = 0;
uint8_t tablaBitmap[TABLA_BITMAP_MAX][TABLA_BITMAP_BYTES];
uint8_t tablaBitmapLen = 0;

// ═══════════════════════════════════════════════════════
//  FASE 4.3 — PANEL INDUSTRIAL: OLED (paridad funcional con ROBOARD)
//
//  Detectar (0,96"/0,91"), Prueba, Limpiar, Logo MDE — todo desde una
//  instancia LOCAL de Adafruit_SSD1306, del tamaño que el usuario elige
//  en el selector de panel.html. Deliberadamente NO usa el objeto
//  global "display" (fijo 128x64, línea ~39) que consumen los opcodes
//  OP_OLED_* de Blockly — ese objeto queda para la Fase 4.4, que es la
//  que además necesita hacerlo consciente del tamaño real de pantalla.
//  Mismo criterio de separación que ya usa ROBOARD para esta función.
//
//  Los bitmaps del logo MDE fueron generados a partir del archivo real
//  provisto (logo_final_preview.png, 416x128, escala de grises, alto
//  contraste) — no son un logo inventado ni reemplazado. Por la
//  geometría real del archivo (ver informe de validación previo), hacen
//  falta DOS versiones: a ancho completo (128px) el logo escalado da
//  ~39px de alto, que entra en 0,96" (64px) pero NO en 0,91" (32px) —
//  por eso la versión de 0,91" está recortada por alto en vez de
//  reutilizar la de 0,96" estirada o cortada en el firmware.
// ═══════════════════════════════════════════════════════
// LOGO_MDE_96: 128x64, 1024 bytes
const uint8_t LOGO_MDE_96[] PROGMEM = {0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,127,0,0,0,31,128,127,255,255,224,15,255,255,255,128,0,127,128,0,0,63,192,255,255,255,248,15,255,255,255,128,0,255,128,0,0,127,224,255,255,255,252,15,255,255,255,128,1,255,192,0,0,255,240,255,255,255,252,15,255,255,255,128,1,255,224,0,1,255,240,255,255,255,252,15,255,255,255,128,1,255,240,0,1,255,240,255,255,255,255,15,255,255,255,0,1,255,240,0,3,255,240,0,0,15,254,0,0,0,0,0,1,255,248,0,7,255,240,0,0,7,255,128,0,0,0,0,1,255,248,0,15,255,240,0,0,1,255,128,0,0,0,0,1,255,248,0,31,255,224,0,0,1,255,128,0,0,0,0,3,255,252,0,63,255,225,254,0,0,255,159,255,255,248,0,3,253,255,0,127,255,225,254,0,0,255,159,255,255,248,0,3,253,254,0,255,191,227,254,0,0,255,159,255,255,248,0,3,253,255,1,255,63,227,254,0,0,255,159,255,255,248,0,3,252,255,131,254,63,227,254,0,0,255,159,255,255,248,0,3,240,127,135,252,63,227,254,0,1,255,63,255,255,248,0,7,240,127,199,248,63,131,254,0,1,255,63,255,255,240,0,7,240,63,207,240,63,131,252,0,1,255,63,224,0,0,0,7,240,63,255,240,63,131,252,0,3,255,63,224,0,0,0,7,240,31,255,240,127,135,252,0,7,254,63,224,0,0,0,7,240,15,255,192,255,135,252,0,15,252,63,224,0,0,0,7,240,7,255,128,255,135,252,0,63,252,63,128,0,0,15,7,224,7,255,0,255,135,255,255,255,248,63,255,255,249,240,15,224,3,254,0,255,7,255,255,255,240,127,255,255,252,0,15,224,3,252,0,255,7,255,255,255,224,255,255,255,252,0,15,224,3,248,0,255,7,255,255,255,192,255,255,255,248,0,15,224,1,240,0,255,7,255,255,255,0,255,255,255,240,0,15,224,0,224,1,255,15,255,255,252,0,255,255,255,240,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,63,0,0,0,0,0,0,0,0,0,0,0,0,0,0,31,255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,63,255,0,0,0,0,0,0,0,0,0,0,0,0,0,31,255,255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0};
// LOGO_MDE_91: 128x32, 512 bytes
const uint8_t LOGO_MDE_91[] PROGMEM = {0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,31,128,0,1,240,63,255,254,1,255,255,252,0,0,0,0,31,192,0,3,248,63,255,255,129,255,255,252,0,0,0,0,63,192,0,7,252,63,255,255,193,255,255,252,0,0,0,0,63,224,0,15,252,63,255,255,193,255,255,252,0,0,0,0,63,240,0,15,252,63,255,255,225,255,255,248,0,0,0,0,63,240,0,31,252,0,0,63,224,0,0,0,0,0,0,0,63,248,0,63,252,0,0,15,240,0,0,0,0,0,0,0,63,248,0,127,248,0,0,15,240,0,0,0,0,0,0,0,127,252,0,255,248,126,0,7,243,255,255,224,0,0,0,0,126,254,1,255,248,126,0,7,243,255,255,224,0,0,0,0,126,254,3,251,248,254,0,7,243,255,255,224,0,0,0,0,126,127,7,243,248,254,0,7,243,255,255,224,0,0,0,0,124,63,15,227,248,254,0,15,231,255,255,224,0,0,0,0,252,63,143,195,240,254,0,15,231,255,255,192,0,0,0,0,252,31,159,131,240,252,0,15,231,240,0,0,0,0,0,0,252,31,255,131,240,252,0,31,231,240,0,0,0,0,0,0,252,15,255,7,241,252,0,63,199,240,0,0,0,0,0,0,252,7,254,7,241,252,0,255,199,224,0,0,112,0,0,0,248,7,252,7,241,255,255,255,135,255,255,231,128,0,0,1,248,3,248,7,225,255,255,255,15,255,255,240,0,0,0,1,248,3,240,7,225,255,255,254,15,255,255,224,0,0,0,1,248,1,224,7,225,255,255,248,15,255,255,192,0,0,0,1,248,0,192,15,227,255,255,224,15,255,255,192,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,16,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,240,0,0,0,0,0,0,0,0,0,0,0,0,0,0,127,240,0,0,0,0,0,0,0,0,0,0,0,0,0,31,255,240,0};

uint8_t oledPanelAncho = 128, oledPanelAlto = 64; // último tamaño probado con éxito desde Panel Industrial
uint8_t oledPanelAddr  = 0x3C;                    // última dirección I2C detectada
bool    oledPanelDetectado = false;               // false hasta que /oled/test responda ok:true al menos una vez

// AUDITORÍA DE ESTABILIZACIÓN: esta función pasó de "intentar
// recuperación activa" a "diagnóstico puro" — ver informe. Es la única
// pieza de código, en toda la instrumentación agregada, que tocaba el
// periférico I2C DESPUÉS de una anomalía real (Wire.begin() +
// transacción de sondeo). No hay evidencia ni documentación que
// confirme si eso ayuda o empeora un bus ya en estado anómalo — en vez
// de seguir apostando a una hipótesis no confirmada, se elimina esa
// intervención. Ahora SOLO registra que la anomalía ocurrió, sin tocar
// Wire en absoluto. El nombre de la función se mantiene (para no
// romper la única llamada existente en OP_OLED_DISPLAY) pero ya no
// hace ningún intento real de recuperación.
bool intentarRecuperacionI2C() {
  flog('E', "I2C_ANOMALY sin intento de recuperacion activa (deshabilitado en esta version — ver auditoria)");
  prefs.begin("franky", false);
  prefs.putString("lastFault", "I2C_OLED_SLOW");
  prefs.putBool("lastFaultRecov", false);
  prefs.end();
  return false;
}

// ═══════════════════════════════════════════════════════
//  ESCALADO DE SPRITES — corrección adaptada de ROBOARD 6.0
//  (ROBOARD60_Firmware.ino, líneas ~140-169, sesiones 8.9-8.12).
//
//  Causa confirmada por auditoría comparativa (ver diagnóstico de
//  chat): display.drawBitmap() dibuja el sprite a escala física 1:1 —
//  16 píxeles reales, ~12% del ancho de una pantalla de 128px. ROBOARD
//  tuvo exactamente el mismo síntoma ("el sprite aparece de 3x3mm en
//  la pantalla, no del tamaño esperado") y lo corrigió dibujando cada
//  píxel LÓGICO del sprite como un bloque de SPRITE_SCALE×SPRITE_SCALE
//  píxeles FÍSICOS, vía fillRect() en vez de drawBitmap(). El editor
//  (grilla de 16x16 en el modal de Blockly) no tiene ningún bug de
//  escala — ese problema nunca estuvo ahí, por eso esta corrección no
//  toca ni Blockly ni el formato de datos del sprite (sigue siendo
//  16x16, 32 bytes, mismo hex).
//
//  SPRITE_SCALE=4 (16px*4=64px) es el máximo que entra en el alto
//  completo de una pantalla 0,96" (64px) sin recortarse — mismo valor
//  y mismo razonamiento que ROBOARD (su Sesión 8.12: probaron x5 y no
//  entraba). ADVERTENCIA heredada de ROBOARD, válida también acá: a
//  esta escala el sprite NO entra en una pantalla de 0,91" (128x32) —
//  se recorta por abajo. x/y siguen siendo la posición en píxeles
//  FÍSICOS reales (sin cambios de formato), el escalado es puramente
//  del lado del dibujo.
#define SPRITE_SCALE 4
void dibujarSpriteEscalado(int x, int y, const uint8_t* bitmap) {
  for (int fila = 0; fila < 16; fila++) {
    uint8_t b0 = bitmap[fila*2], b1 = bitmap[fila*2+1];
    for (int col = 0; col < 16; col++) {
      uint8_t byte = col < 8 ? b0 : b1;
      int bit = col < 8 ? (7-col) : (15-col);
      if ((byte >> bit) & 1) {
        display.fillRect(x + col*SPRITE_SCALE, y + fila*SPRITE_SCALE, SPRITE_SCALE, SPRITE_SCALE, SSD1306_WHITE);
      }
    }
  }
}

int16_t pilaPop() {
  if (pilaLen == 0) return 0; // pila vacía (programa mal formado) — nunca revienta
  return pila[--pilaLen];
}

// ═══════════════════════════════════════════════════════
//  FASE 4.1 — SISTEMA CENTRAL DE RESERVAS DE GPIO
//
//  Reemplaza la lógica dispersa que existía antes (pinBloqueadoPorBus()
//  hardcodeaba 6/7 y 20/21; validateSumoADC() validaba el límite de ADC
//  por separado). A partir de ahora TODA función que necesite saber
//  "¿este GPIO se puede usar ahora, y por qué está ocupado si no?" pasa
//  por acá — mismo patrón recomendado por la referencia de ROBOARD
//  (isGpioAvailable()), adaptado al pinout real de FRANKY.
//
//  Es un prerrequisito de Fase 4.2 (I2C en pines seleccionables) y de la
//  futura Fase 4.6 (Laberinto), NO agrega todavía UI ni cambia el
//  comportamiento visible de ningún endpoint existente en esta fase —
//  pinBloqueadoPorBus() se reimplementa sobre este sistema pero mantiene
//  exactamente su firma y su resultado actual para los 3 call-sites que
//  ya la usan (handleSumoConfig).
// ═══════════════════════════════════════════════════════

// Pines físicamente expuestos por el ESP32-C3 SuperMini (GPIO0-10, 20, 21).
// GPIO11-17 no existen en este listado porque no están expuestos (uso
// interno del flash embebido); no es una restricción de firmware.
const uint8_t GPIO_EXPUESTOS[13] = {0,1,2,3,4,5,6,7,8,9,10,20,21};
#define GPIO_RESERVA_N 13
GpioMotivo gpioReserva[GPIO_RESERVA_N]; // inicializado a GPIO_LIBRE (=0) por defecto en C++

// Traduce un número de GPIO real a un índice 0-12 de gpioReserva[], o -1
// si ese GPIO no existe en este SuperMini (protege contra valores fuera
// de rango que puedan llegar desde un endpoint HTTP o un import de
// proyecto malformado).
int gpioIndex(uint8_t pin) {
  for (int i = 0; i < GPIO_RESERVA_N; i++) if (GPIO_EXPUESTOS[i] == pin) return i;
  return -1;
}

bool gpioValido(uint8_t pin) { return gpioIndex(pin) >= 0; }

// Reserva un pin para un motivo. Devuelve false (y no reserva nada) si el
// pin ya está ocupado por un motivo DISTINTO — nunca pisa una reserva
// ajena en silencio. Si ya estaba reservado por el mismo motivo, es
// idempotente (permite volver a aplicar la misma config sin error).
bool gpioReservar(uint8_t pin, GpioMotivo motivo) {
  int idx = gpioIndex(pin);
  if (idx < 0) return false; // GPIO inexistente en este hardware
  if (gpioReserva[idx] != GPIO_LIBRE && gpioReserva[idx] != motivo) return false;
  gpioReserva[idx] = motivo;
  return true;
}

// Libera un pin — SOLO tiene efecto sobre reservas dinámicas (I2C, bus
// alternativo, sensores de Sumo/Laberinto). Las reservas de fábrica
// (motor, LED, botón, ADC fijo) son permanentes y esta función las
// ignora a propósito, para que un error de programación no pueda dejar,
// por ejemplo, el pin del LED como "libre".
void gpioLiberar(uint8_t pin) {
  int idx = gpioIndex(pin);
  if (idx < 0) return;
  GpioMotivo m = gpioReserva[idx];
  if (m == GPIO_MOTOR || m == GPIO_LED || m == GPIO_BOTON || m == GPIO_ADC_FIJO) return;
  gpioReserva[idx] = GPIO_LIBRE;
}

// Libera TODOS los pines que estén reservados por un motivo dado — usado
// al cambiar de par I2C (Fase 4.2): libera los 2 pines anteriores antes
// de reservar los 2 nuevos, sin tener que conocerlos de antemano.
void gpioLiberarPorMotivo(GpioMotivo motivo) {
  for (int i = 0; i < GPIO_RESERVA_N; i++)
    if (gpioReserva[i] == motivo) gpioReserva[i] = GPIO_LIBRE;
}

bool gpioDisponible(uint8_t pin) {
  int idx = gpioIndex(pin);
  if (idx < 0) return false; // un GPIO que no existe nunca está "disponible"
  return gpioReserva[idx] == GPIO_LIBRE;
}

GpioMotivo gpioMotivoActual(uint8_t pin) {
  int idx = gpioIndex(pin);
  if (idx < 0) return GPIO_MOTOR; // valor defensivo — nunca debería consultarse un pin inválido
  return gpioReserva[idx];
}

const char* gpioMotivoTexto(GpioMotivo m) {
  switch (m) {
    case GPIO_LIBRE:         return "libre";
    case GPIO_MOTOR:         return "motor";
    case GPIO_LED:           return "led";
    case GPIO_BOTON:         return "boton";
    case GPIO_ADC_FIJO:      return "adc_fijo";
    case GPIO_I2C:           return "i2c";
    case GPIO_BUS_ALT:       return "bus_alt";
    case GPIO_SENSOR_SUMO:   return "sensor_sumo";
    default:                 return "?";
  }
}

// Reservas de fábrica — se aplican una sola vez en setup(), nunca se
// liberan. Separado en su propia función para que quede visible como
// unidad y no se pierda entre el resto de la inicialización.
void gpioInicializarReservasDeFabrica() {
  gpioReservar(PIN_MA_IN1, GPIO_MOTOR);
  gpioReservar(PIN_MA_IN2, GPIO_MOTOR);
  gpioReservar(PIN_MB_IN1, GPIO_MOTOR); // ver HALLAZGO_DHT22 — este mismo GPIO3 es también PIN_DHT22
  gpioReservar(PIN_MB_IN2, GPIO_MOTOR);
  gpioReservar(PIN_LED,    GPIO_LED);
  gpioReservar(PIN_BTN,    GPIO_BOTON);
  gpioReservar(PIN_ADC0,   GPIO_ADC_FIJO); // nunca asignable a I2C/sensor — regla ya vigente, ahora centralizada
  gpioReservar(PIN_ADC1,   GPIO_ADC_FIJO); // ídem
}

// ═══════════════════════════════════════════════════════
//  HALLAZGO_DHT22 (auditoría Fase 4.1, informado — no corregido acá)
//
//  PIN_DHT22 = GPIO3 es EL MISMO pin físico que PIN_MB_IN1 (motor B,
//  soldado en la placa al driver RZ7899). No es un conflicto de nombres
//  como el de PIN_SPI_MISO/PIN_ADC1 (ese sí se corrigió arriba, porque
//  MISO nunca se usaba) — acá dht.begin() y loopVivero()/loopMeteo() SÍ
//  llaman activamente dht.readTemperature()/readHumidity() sobre este
//  pin, que al mismo tiempo tiene un canal LEDC enganchado para el motor
//  B. No hay un GPIO libre en el SuperMini para reubicar el DHT22 (los
//  13 pines expuestos ya están comprometidos, ver informe de auditoría).
//
//  No cambio el comportamiento de VIVERO/METEO en esta fase — sería
//  tomar una decisión funcional (deprecar esos modos, o aceptar que un
//  DHT22 real nunca puede convivir con el motor B) que no fue pedida ni
//  aprobada. Lo dejo documentado para que la definas antes de que
//  cualquier fase futura toque estos dos modos.
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  VALIDACIÓN ADC — Firmware-side
//  Retorna 0 si válido, >0 = cantidad de ADC necesarios
// ═══════════════════════════════════════════════════════
int contarADCUsados(const SumoConfig& cfg) {
  int adc = 0;
  // Sharp usa ADC
  if (cfg.tipoDistSensor == 2) adc += cfg.numDistSensores;
  // Borde usa ADC
  adc += cfg.numBorde;
  return adc;
}

bool validateSumoADC(const SumoConfig& cfg) {
  return contarADCUsados(cfg) <= 2;
}

// Verifica si un pin pertenece a un bus activo — Fase 4.1: reimplementada
// sobre el sistema central de reservas, misma firma y mismo resultado que
// antes para los call-sites existentes (handleSumoConfig). i2cEnabled y
// spiEnabled siguen siendo la fuente de verdad de si esos buses están
// activos; lo que cambia es que la reserva/liberación de GPIO0/1/6/7/20/21
// ahora vive en gpioReserva[], no en dos condicionales sueltos.
bool pinBloqueadoPorBus(uint8_t pin) {
  return !gpioDisponible(pin);
}

// Sincroniza gpioReserva[] con el estado actual de i2cEnabled/spiEnabled.
// Se llama después de cargar la config guardada (setup) y cada vez que
// el usuario cambia esos flags (handlePanelSave), para que el mapa de
// reservas nunca quede desincronizado del estado real de los buses.
void gpioSincronizarBuses() {
  gpioLiberarPorMotivo(GPIO_I2C);
  gpioLiberarPorMotivo(GPIO_BUS_ALT);
  if (i2cEnabled) { gpioReservar(i2cSda, GPIO_I2C); gpioReservar(i2cScl, GPIO_I2C); }
  if (spiEnabled) { gpioReservar(PIN_SPI_SCLK, GPIO_BUS_ALT); gpioReservar(PIN_SPI_MOSI, GPIO_BUS_ALT); }
  // Nota: PIN_SPI_CS (GPIO10) NO se reservaba en el comportamiento
  // original (pinBloqueadoPorBus() solo miraba 20/21) — se preserva ese
  // mismo comportamiento acá a propósito, para no cambiar nada más allá
  // de lo que esa fase se propuso. GPIO10 SÍ puede reservarse ahora por
  // GPIO_I2C si el usuario lo elige como SDA/SCL alternativo (Fase 4.2).
}

// ═══════════════════════════════════════════════════════
//  FASE 4.2 — I2C CON SDA/SCL SELECCIONABLES INDIVIDUALMENTE
//
//  El ESP32-C3 enruta I2C por GPIO Matrix — Wire.begin(sda,scl) acepta
//  cualquier par de pines válidos, no hace falta que sean "pines I2C
//  dedicados". Los 5 candidatos ofrecidos (6,7,10,20,21) son los mismos
//  5 pines no comprometidos con motor/LED/botón/ADC — GPIO0/GPIO1 NUNCA
//  se ofrecen acá, ni siquiera deshabilitados en una lista: son los
//  únicos 2 canales ADC (Sharp/borde) y están excluidos por diseño de
//  producto, no por una limitación de este código.
// ═══════════════════════════════════════════════════════
bool esPinI2CValido(uint8_t pin) {
  return pin==PIN_I2C_SDA || pin==PIN_I2C_SCL || pin==PIN_SPI_CS || pin==PIN_SPI_SCLK || pin==PIN_SPI_MOSI;
  // == pin==6 || pin==7 || pin==10 || pin==20 || pin==21 — escrito con
  // los #define para que quede explícito que es el mismo pool documentado
  // en el informe de auditoría, no una lista mágica nueva.
}

// Reserva en el sistema central los pines de sensor de la config de Sumo
// ACTUALMENTE ACTIVA (cfgActiva) — para que I2C (o cualquier otra función
// futura) pueda detectar el conflicto con "aplicarI2C()" de abajo. Solo
// reserva sonar/óptico: Sharp y borde ya viven exclusivamente en
// GPIO0/GPIO1, que gpioInicializarReservasDeFabrica() reserva para
// siempre como GPIO_ADC_FIJO — no hace falta (ni corresponde) volver a
// reservarlos acá.
//
// Alcance de esta fase: se reserva SOLO el perfil activo (cfgActiva), no
// simultáneamente cfgMini+cfgMicro — es una decisión de diseño acotada,
// no una limitación física; si preferís que ambos perfiles reserven sus
// pines al mismo tiempo (por ejemplo, porque en tu robot real mini y
// micro comparten el mismo cableado físico y querés que un conflicto se
// detecte aunque ese perfil no esté activo en este momento), lo ajusto —
// documentado para que lo confirmes, no lo asumo.
void gpioAplicarReservasSumoActivo() {
  gpioLiberarPorMotivo(GPIO_SENSOR_SUMO);
  if (cfgActiva->tipoDistSensor == 0) { // sonar
    gpioReservar(cfgActiva->trigI, GPIO_SENSOR_SUMO);
    gpioReservar(cfgActiva->echoI, GPIO_SENSOR_SUMO);
    if (cfgActiva->numDistSensores >= 2) {
      gpioReservar(cfgActiva->trigD, GPIO_SENSOR_SUMO);
      gpioReservar(cfgActiva->echoD, GPIO_SENSOR_SUMO);
    }
  } else if (cfgActiva->tipoDistSensor == 1) { // óptico digital
    gpioReservar(cfgActiva->optPinI, GPIO_SENSOR_SUMO);
    if (cfgActiva->numDistSensores >= 2) gpioReservar(cfgActiva->optPinD, GPIO_SENSOR_SUMO);
  }
}

// Intenta aplicar un nuevo par SDA/SCL. Devuelve true y actualiza
// i2cSda/i2cScl si es válido y ambos pines están libres (o ya eran del
// propio I2C); en caso de rechazo, deja el par anterior intacto — nunca
// un estado a medio aplicar. `err` se completa con el motivo, para que
// el endpoint HTTP pueda devolver un JSON de error claro (mismo criterio
// que sendJsonError() ya usa en el resto del firmware).
bool aplicarI2C(uint8_t sda, uint8_t scl, String& err) {
  if (!esPinI2CValido(sda) || !esPinI2CValido(scl)) {
    err = "GPIO invalido para I2C (solo 6,7,10,20,21)"; return false;
  }
  if (sda == scl) { err = "SDA y SCL no pueden ser el mismo GPIO"; return false; }

  // Liberar la reserva I2C actual ANTES de chequear disponibilidad, para
  // poder "mover" el bus de un par de pines a otro que reutilice alguno
  // de los dos actuales (ej. 6/7 -> 6/10) sin bloquearse a sí mismo.
  uint8_t sdaAnterior = i2cSda, sclAnterior = i2cScl;
  gpioLiberarPorMotivo(GPIO_I2C);

  if (!gpioDisponible(sda) || !gpioDisponible(scl)) {
    // Revertir: el par pedido choca con otra función (bus_alt o un
    // sensor de Sumo activo) — se restaura la reserva anterior tal cual
    // estaba, nunca se deja el sistema sin el I2C reservado.
    gpioReservar(sdaAnterior, GPIO_I2C); gpioReservar(sclAnterior, GPIO_I2C);
    err = "GPIO ocupado por otra funcion (" +
          String("sda=") + gpioMotivoTexto(gpioMotivoActual(sda)) +
          String(" scl=") + gpioMotivoTexto(gpioMotivoActual(scl)) + ")";
    return false;
  }

  gpioReservar(sda, GPIO_I2C); gpioReservar(scl, GPIO_I2C);
  i2cSda = sda; i2cScl = scl;
  return true;
}

// ═══════════════════════════════════════════════════════
//  PERSISTENCIA SUMO
//  Solo escribe al aplicar config (no en cada ciclo)
// ═══════════════════════════════════════════════════════
void saveSumoConfig() {
  prefs.begin("sumo", false);
  // Mini
  prefs.putUChar("m_tds",   cfgMini.tipoDistSensor);
  prefs.putUChar("m_nds",   cfgMini.numDistSensores);
  prefs.putUChar("m_trI",   cfgMini.trigI);
  prefs.putUChar("m_ecI",   cfgMini.echoI);
  prefs.putUChar("m_trD",   cfgMini.trigD);
  prefs.putUChar("m_ecD",   cfgMini.echoD);
  prefs.putUChar("m_spI",   cfgMini.sharpPinI);
  prefs.putUChar("m_spD",   cfgMini.sharpPinD);
  prefs.putUShort("m_us",   cfgMini.umbralSharp);
  prefs.putUChar("m_opI",   cfgMini.optPinI);
  prefs.putUChar("m_opD",   cfgMini.optPinD);
  prefs.putUChar("m_nb",    cfgMini.numBorde);
  prefs.putUChar("m_bpI",   cfgMini.bordePinI);
  prefs.putUChar("m_bpD",   cfgMini.bordePinD);
  prefs.putUShort("m_ub",   cfgMini.umbralBorde);
  prefs.putUChar("m_ud",    cfgMini.umbralDistCm);
  prefs.putUChar("m_atk",   cfgMini.spdAtaque);
  // FASE "CIERRE SUMO" — velBusqueda/intGiro reemplazan a spdBuscExt/
  // spdBuscInt (ver struct SumoConfig). Se escriben en claves NUEVAS
  // ("m_vel"/"m_int"), NO se sigue escribiendo "m_bex"/"m_bin" — la
  // migración de una NVS vieja que solo tenga esas dos claves ocurre en
  // loadSumoConfig() (lectura), nunca acá.
  prefs.putUChar("m_vel",   cfgMini.velBusqueda);
  prefs.putUChar("m_int",   cfgMini.intGiro);
  prefs.putUShort("m_dur",  cfgMini.durBarrido);
  prefs.putUChar("m_ev",    cfgMini.spdEvasion);
  prefs.putUChar("m_est",   cfgMini.estrategia);
  // Micro
  prefs.putUChar("u_tds",   cfgMicro.tipoDistSensor);
  prefs.putUChar("u_trI",   cfgMicro.trigI);
  prefs.putUChar("u_ecI",   cfgMicro.echoI);
  prefs.putUChar("u_spI",   cfgMicro.sharpPinI);
  prefs.putUShort("u_us",   cfgMicro.umbralSharp);
  prefs.putUChar("u_opI",   cfgMicro.optPinI);
  prefs.putUChar("u_nb",    cfgMicro.numBorde);
  prefs.putUChar("u_bpI",   cfgMicro.bordePinI);
  prefs.putUShort("u_ub",   cfgMicro.umbralBorde);
  prefs.putUChar("u_ud",    cfgMicro.umbralDistCm);
  prefs.putUChar("u_atk",   cfgMicro.spdAtaque);
  prefs.putUChar("u_vel",   cfgMicro.velBusqueda); // ver nota "m_vel"/"m_int" arriba, mismo criterio para Micro
  prefs.putUChar("u_int",   cfgMicro.intGiro);
  prefs.putUChar("u_ev",    cfgMicro.spdEvasion);
  // Trims globales
  prefs.putInt("trimA",  trimA);
  prefs.putInt("trimB",  trimB);
  // Perfil activo + modo de inicio — Fase "Persistencia Sumo" (ver nota
  // de diseño junto a la declaración de cfgActiva/sumoInicioServidor/
  // sumoInicioBoton más arriba en el archivo).
  prefs.putUChar("perfilAct", cfgActiva->perfil);
  prefs.putBool("inicioSrv",  sumoInicioServidor);
  prefs.putBool("inicioBtn",  sumoInicioBoton);
  prefs.end();
}

// Persiste SOLO el perfil activo — usada por handleSumoMicro()/
// handleSumoMini() (arrancar Sumo desde el servidor cambia cuál perfil
// queda "activo" para la próxima vez, ver sección 6/14 del pedido) sin
// pagar el costo de reescribir las ~30 claves completas que sí escribe
// saveSumoConfig() en cada combate iniciado. handleSumoConfig() (guardar
// configuración) sigue usando saveSumoConfig() completo, que también
// persiste esto mismo.
void persistirPerfilActivo() {
  prefs.begin("sumo", false);
  prefs.putUChar("perfilAct", cfgActiva->perfil);
  prefs.end();
}

void loadSumoConfig() {
  prefs.begin("sumo", true);
  // Mini
  cfgMini.tipoDistSensor  = prefs.getUChar("m_tds",  cfgMini.tipoDistSensor);
  cfgMini.numDistSensores = prefs.getUChar("m_nds",  cfgMini.numDistSensores);
  cfgMini.trigI           = prefs.getUChar("m_trI",  cfgMini.trigI);
  cfgMini.echoI           = prefs.getUChar("m_ecI",  cfgMini.echoI);
  cfgMini.trigD           = prefs.getUChar("m_trD",  cfgMini.trigD);
  cfgMini.echoD           = prefs.getUChar("m_ecD",  cfgMini.echoD);
  cfgMini.sharpPinI       = prefs.getUChar("m_spI",  cfgMini.sharpPinI);
  cfgMini.sharpPinD       = prefs.getUChar("m_spD",  cfgMini.sharpPinD);
  cfgMini.umbralSharp     = prefs.getUShort("m_us",  cfgMini.umbralSharp);
  cfgMini.optPinI         = prefs.getUChar("m_opI",  cfgMini.optPinI);
  cfgMini.optPinD         = prefs.getUChar("m_opD",  cfgMini.optPinD);
  cfgMini.numBorde        = prefs.getUChar("m_nb",   cfgMini.numBorde);
  cfgMini.bordePinI       = prefs.getUChar("m_bpI",  cfgMini.bordePinI);
  cfgMini.bordePinD       = prefs.getUChar("m_bpD",  cfgMini.bordePinD);
  cfgMini.umbralBorde     = prefs.getUShort("m_ub",  cfgMini.umbralBorde);
  cfgMini.umbralDistCm    = prefs.getUChar("m_ud",   cfgMini.umbralDistCm);
  cfgMini.spdAtaque       = prefs.getUChar("m_atk",  cfgMini.spdAtaque);
  // FASE "CIERRE SUMO" — migración desde NVS de cualquier firmware
  // anterior a esta fase. Si ya existen las claves nuevas ("m_vel"/
  // "m_int"), se leen directo. Si NO existen (robot que solo tiene la
  // NVS vieja, con "m_bex"/"m_bin" de una calibración real ya hecha en
  // hardware), se reconstruyen velBusqueda/intGiro a partir de esas dos
  // — MISMA fórmula inversa de velExterna()/velInterna() — para que un
  // robot ya calibrado en una competencia anterior no "pierda" su
  // calibración solo por actualizar el firmware. Si tampoco existen
  // (robot nuevo, NVS vacía), caen en el default del struct.
  if (prefs.isKey("m_vel")) {
    cfgMini.velBusqueda = prefs.getUChar("m_vel", cfgMini.velBusqueda);
    cfgMini.intGiro      = prefs.getUChar("m_int", cfgMini.intGiro);
  } else {
    uint8_t bexOld = prefs.getUChar("m_bex", 210);
    uint8_t binOld = prefs.getUChar("m_bin", 80);
    cfgMini.velBusqueda = (uint8_t)(((int)bexOld + (int)binOld) / 2);
    cfgMini.intGiro      = (uint8_t)((bexOld >= binOld) ? (bexOld - binOld) : 0);
  }
  cfgMini.durBarrido      = prefs.getUShort("m_dur", cfgMini.durBarrido); // no existía antes de esta fase -> default de struct (CABECEO_MS)
  cfgMini.spdEvasion      = prefs.getUChar("m_ev",   cfgMini.spdEvasion);
  cfgMini.estrategia      = prefs.getUChar("m_est",  cfgMini.estrategia);
  // Micro
  cfgMicro.tipoDistSensor = prefs.getUChar("u_tds",  cfgMicro.tipoDistSensor);
  cfgMicro.trigI          = prefs.getUChar("u_trI",  cfgMicro.trigI);
  cfgMicro.echoI          = prefs.getUChar("u_ecI",  cfgMicro.echoI);
  cfgMicro.sharpPinI      = prefs.getUChar("u_spI",  cfgMicro.sharpPinI);
  cfgMicro.umbralSharp    = prefs.getUShort("u_us",  cfgMicro.umbralSharp);
  cfgMicro.optPinI        = prefs.getUChar("u_opI",  cfgMicro.optPinI);
  cfgMicro.numBorde       = prefs.getUChar("u_nb",   cfgMicro.numBorde);
  cfgMicro.bordePinI      = prefs.getUChar("u_bpI",  cfgMicro.bordePinI);
  cfgMicro.umbralBorde    = prefs.getUShort("u_ub",  cfgMicro.umbralBorde);
  cfgMicro.umbralDistCm   = prefs.getUChar("u_ud",   cfgMicro.umbralDistCm);
  cfgMicro.spdAtaque      = prefs.getUChar("u_atk",  cfgMicro.spdAtaque);
  // Mismo criterio de migración que Mini (ver comentario arriba).
  if (prefs.isKey("u_vel")) {
    cfgMicro.velBusqueda = prefs.getUChar("u_vel", cfgMicro.velBusqueda);
    cfgMicro.intGiro      = prefs.getUChar("u_int", cfgMicro.intGiro);
  } else {
    uint8_t bexOld = prefs.getUChar("u_bex", 200);
    uint8_t binOld = prefs.getUChar("u_bin", 60);
    cfgMicro.velBusqueda = (uint8_t)(((int)bexOld + (int)binOld) / 2);
    cfgMicro.intGiro      = (uint8_t)((bexOld >= binOld) ? (bexOld - binOld) : 0);
  }
  cfgMicro.spdEvasion     = prefs.getUChar("u_ev",   cfgMicro.spdEvasion);
  // Trims
  trimA = prefs.getInt("trimA", 255);
  trimB = prefs.getInt("trimB", 255);
  // Perfil activo + modo de inicio — Fase "Persistencia Sumo". Defaults
  // elegidos para preservar EXACTAMENTE el comportamiento anterior en
  // cualquier robot que ya tuviera datos en NVS antes de esta fase (esas
  // 3 claves nunca existieron, así que Preferences devuelve el default):
  // perfilAct=0 (mini) es lo mismo que el inicializador estático previo
  // de cfgActiva (&cfgMini); inicioSrv=true es "el servidor siempre pudo
  // iniciar Sumo" (sin cambios); inicioBtn=false es "el boton nunca
  // iniciaba Sumo" (sin cambios — habilitarlo es 100% opt-in).
  uint8_t perfilGuardado = prefs.getUChar("perfilAct", 0);
  cfgActiva = (perfilGuardado == 1) ? &cfgMicro : &cfgMini;
  sumoInicioServidor = prefs.getBool("inicioSrv", true);
  sumoInicioBoton    = prefs.getBool("inicioBtn", false);
  prefs.end();
}

// ═══════════════════════════════════════════════════════
//  PROYECTO FRANKY — formato .franky (JSON) + import/export
//
//  Implementa el sistema de Proyectos pedido: un archivo .franky (JSON
//  versionado) que representa TODA la configuración persistente del
//  robot — Sumo (cfgMini + cfgMicro completos, no solo el perfil
//  activo), I2C (par SDA/SCL + habilitado), SPI (habilitado) y trim de
//  motores — para que un alumno pueda exportarla, guardarla, compartirla
//  e importarla en otro FRANKY 4.0 idéntico.
//
//  DISEÑO DELIBERADO — el archivo .franky NO se arma completo acá:
//  1) [ACTUALIZADO — fase "PROGRAMA FUENTE"] Antes este firmware no
//     conocía el XML del workspace Blockly (vivía solo en el
//     NAVEGADOR). Ahora el XML también se guarda en SPIFFS — ver la
//     sección "PROGRAMA FUENTE" más arriba, antes de "MOTORES con trim
//     diferencial" (guardarXmlBlocklySpiffs()/leerXmlBlocklySpiffs()).
//     GET /proyecto/export entrega TODO lo que el firmware conoce,
//     Sumo/I2C/SPI/trim COMO ANTES, y ahora también "blockly":{"xml":...}
//     tomado directamente de SPIFFS (no de localStorage) — así un
//     Proyecto FRANKY exportado desde CUALQUIER dispositivo incluye el
//     programa que el robot mismo tiene guardado, no el de "este
//     navegador". La página /proyecto.html sigue agregando "meta"
//     (nombre de proyecto, fecha) del lado del navegador — eso sigue
//     siendo metadata pedagógica, no configuración de hardware.
//  2) POST /proyecto/import es la única autoridad real: valida TODO
//     antes de aplicar CUALQUIER cosa (atomicidad — ver sección 8/9 del
//     pedido). El JSON recibido incluye también "blockly":{"xml":...} —
//     se valida (no vacío, con forma de XML, tamaño acotado) como parte
//     del "todo o nada", y AHORA también se aplica acá: si es válido,
//     se escribe a SPIFFS como parte del paso de aplicación (ver
//     handleProyectoImport(), es la PRIMERA escritura de ese paso,
//     antes de tocar Sumo/I2C/SPI/trim — si falla, se aborta el import
//     completo sin haber tocado nada más). El navegador YA NO necesita
//     aplicar el XML a localStorage tras un import exitoso (aunque
//     sigue pudiendo cachearlo ahí) — el robot queda como fuente de
//     verdad. Ver btnImportarProyecto()/confirmarImportacion() en
//     proyecto.html para el flujo completo del lado del navegador.
//
//  PARSER JSON — este archivo nunca tuvo un parser JSON (el resto del
//  server arma JSON a mano con concatenación de String, nunca lo lee) —
//  /proyecto/import es el primer punto que necesita leer JSON de una
//  fuente externa no confiable. Se decidió NO agregar una librería
//  nueva (ArduinoJson u otra) para esto — ver justificación en el
//  informe de entrega — y en cambio escribir un lector JSON MÍNIMO,
//  dirigido por clave (no un parser genérico de gramática JSON
//  completa): busca "clave":valor respetando profundidad de
//  llaves/corchetes y literales de string (para que una clave falsa
//  escondida dentro de un string — por ejemplo dentro del propio XML de
//  Blockly — nunca pueda hacerse pasar por una clave real), extrae el
//  valor con el tipo esperado, y lo valida con los MISMOS rangos que ya
//  usa handleSumoConfig()/handleSumoTrim()/aplicarI2C() ("no inventes
//  rangos nuevos"). Si falta cualquier clave esperada o el valor no
//  pasa validación, se rechaza el import completo ANTES de tocar ningún
//  global — no hay aplicación parcial posible.
// ═══════════════════════════════════════════════════════

// ── Núcleo del lector JSON dirigido por clave ──────────────────────

// Dado el índice de una comilla de apertura, devuelve el índice
// INMEDIATAMENTE DESPUÉS de la comilla de cierre (sin escapar), o -1 si
// el string nunca cierra. Respeta \" y \\ — no interpreta el contenido,
// solo lo salta correctamente para no desincronizar el conteo de
// llaves/corchetes de jsonSkipValue()/jsonFindValueStart().
int jsonSkipString(const String& s, int idx) {
  int n = s.length();
  if (idx >= n || s[idx] != '"') return -1;
  idx++;
  while (idx < n) {
    char c = s[idx];
    if (c == '\\') { idx += 2; continue; } // salta el caracter escapado, sea cual sea
    if (c == '"') return idx + 1;
    idx++;
  }
  return -1; // nunca cerró — string mal formado
}

// Salta un valor JSON completo (string, objeto, arreglo, numero,
// true/false/null) a partir de `idx` (debe apuntar al primer caracter
// no-blanco del valor). Devuelve el índice siguiente al valor, o -1 si
// está mal formado. Cuenta profundidad de {}/[] respetando strings, para
// que un "{" o "}" dentro de un string (por ejemplo, dentro del XML de
// Blockly) nunca desincronice el conteo.
int jsonSkipValue(const String& s, int idx) {
  int n = s.length();
  while (idx < n && isSpace(s[idx])) idx++;
  if (idx >= n) return -1;
  char c = s[idx];
  if (c == '"') return jsonSkipString(s, idx);
  if (c == '{' || c == '[') {
    char open = c, close = (c=='{') ? '}' : ']';
    int depth = 1; idx++;
    while (idx < n && depth > 0) {
      char ch = s[idx];
      if (ch == '"') { idx = jsonSkipString(s, idx); if (idx < 0) return -1; continue; }
      if (ch == open) depth++;
      else if (ch == close) depth--;
      idx++;
    }
    return (depth == 0) ? idx : -1;
  }
  // numero / true / false / null — termina en un delimitador
  while (idx < n) {
    char ch = s[idx];
    if (ch==',' || ch=='}' || ch==']' || isSpace(ch)) break;
    idx++;
  }
  return idx;
}

// Busca "clave": dentro de `s`, pero SOLO a profundidad 1 (es decir,
// directamente dentro del PRIMER objeto/arreglo que aparezca en `s`, sin
// importar si hay espacio en blanco antes) y NUNCA dentro de un string
// literal — así una clave falsa escondida dentro de un valor string (por
// ejemplo, dentro del propio XML de Blockly, que viaja como string
// JSON) nunca puede hacerse pasar por una clave real. Cada llamada
// re-escanea `s` desde el principio con su propia profundidad local, así
// que es seguro llamarla sobre un objeto ya extraído por
// jsonExtractObject() (anidamiento arbitrario, sin colisión entre
// secciones). Devuelve el índice del primer caracter del VALOR (después
// de los dos puntos y los espacios), o -1 si no se encontró.
int jsonFindValueStart(const String& s, const String& key) {
  int n = s.length();
  String pattern = "\"" + key + "\"";
  int depth = 0;
  int idx = 0;
  while (idx < n) {
    char c = s[idx];
    if (c == '"') {
      if (depth == 1 && s.substring(idx, idx + pattern.length()) == pattern) {
        int after = idx + pattern.length();
        while (after < n && isSpace(s[after])) after++;
        if (after < n && s[after] == ':') {
          after++;
          while (after < n && isSpace(s[after])) after++;
          return after;
        }
      }
      int nxt = jsonSkipString(s, idx);
      if (nxt < 0) return -1;
      idx = nxt;
      continue;
    }
    if (c == '{' || c == '[') depth++;
    else if (c == '}' || c == ']') depth--;
    idx++;
  }
  return -1;
}

bool jsonExtractObject(const String& s, const String& key, String& out) {
  int start = jsonFindValueStart(s, key);
  if (start < 0 || start >= (int)s.length() || s[start] != '{') return false;
  int end = jsonSkipValue(s, start);
  if (end < 0) return false;
  out = s.substring(start, end);
  return true;
}

bool jsonExtractString(const String& s, const String& key, String& out) {
  int start = jsonFindValueStart(s, key);
  if (start < 0 || start >= (int)s.length()) return false;
  if (s[start] != '"') return false; // incluye el caso "null" — no es un string
  int end = jsonSkipString(s, start);
  if (end < 0) return false;
  // Desescapar el contenido (sin comillas) — \" \\ \/ \b \f \n \r \t \uXXXX
  String raw = s.substring(start + 1, end - 1);
  String res; res.reserve(raw.length());
  for (int i = 0; i < (int)raw.length(); i++) {
    char c = raw[i];
    if (c == '\\' && i + 1 < (int)raw.length()) {
      char e = raw[++i];
      switch (e) {
        case '"':  res += '"';  break;
        case '\\': res += '\\'; break;
        case '/':  res += '/';  break;
        case 'b':  res += '\b'; break;
        case 'f':  res += '\f'; break;
        case 'n':  res += '\n'; break;
        case 'r':  res += '\r'; break;
        case 't':  res += '\t'; break;
        case 'u': {
          if (i + 4 < (int)raw.length()) {
            String hex = raw.substring(i + 1, i + 5);
            long cp = strtol(hex.c_str(), NULL, 16);
            // Sin soporte UTF-16 completo acá: ni los campos internos
            // (GPIO, umbrales) ni el XML de Blockly necesitan caracteres
            // fuera de ASCII para esta validación superficial — se
            // guarda el byte bajo tal cual, suficiente para no romper
            // el resto del parseo.
            res += (char)(cp & 0xFF);
            i += 4;
          }
          break;
        }
        default: res += e; break;
      }
    } else {
      res += c;
    }
  }
  out = res;
  return true;
}

bool jsonExtractLong(const String& s, const String& key, long& out) {
  int start = jsonFindValueStart(s, key);
  if (start < 0 || start >= (int)s.length()) return false;
  int n = s.length();
  int idx = start;
  bool neg = false;
  if (idx < n && s[idx] == '-') { neg = true; idx++; }
  int digitsStart = idx;
  while (idx < n && isDigit(s[idx])) idx++;
  if (idx == digitsStart) return false; // no había dígitos — no es un número
  out = s.substring(digitsStart, idx).toInt();
  if (neg) out = -out;
  return true;
}

bool jsonExtractBool(const String& s, const String& key, bool& out) {
  int start = jsonFindValueStart(s, key);
  if (start < 0) return false;
  if (s.substring(start, start + 4) == "true")  { out = true;  return true; }
  if (s.substring(start, start + 5) == "false") { out = false; return true; }
  return false;
}

// true solo si la clave existe y su valor es JSON null — usado para
// blockly.xml, donde "sin programa Blockly todavía" es un valor
// legítimo (no un error de formato).
bool jsonIsNull(const String& s, const String& key) {
  int start = jsonFindValueStart(s, key);
  if (start < 0) return false;
  return s.substring(start, start + 4) == "null";
}

String jsonEscape(const String& in) {
  String out; out.reserve(in.length() + 8);
  for (int i = 0; i < (int)in.length(); i++) {
    unsigned char c = (unsigned char)in[i];
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (c < 0x20) { char buf[8]; snprintf(buf, sizeof(buf), "\\u%04x", c); out += buf; }
        else out += (char)c;
    }
  }
  return out;
}

// ── Lectura de un entero JSON con rango — helper común a todas las
//    secciones. Usa EXACTAMENTE los mismos límites que ya aplica
//    handleSumoConfig()/handleSumoTrim() vía constrain() — "no inventes
//    rangos nuevos" (sección 9 del pedido).
bool proyectoLeerEntero(const String& obj, const char* key, long lo, long hi, long& out, String& err) {
  if (!jsonExtractLong(obj, key, out)) {
    err = "falta o no es numero: " + String(key);
    return false;
  }
  if (out < lo || out > hi) {
    err = "fuera de rango: " + String(key) + "=" + String(out);
    return false;
  }
  return true;
}

// ── Validación de una sección Sumo (mini o micro) contra un objeto JSON.
//    `completo` indica si se esperan/validan los campos "de derecha"
//    (trigD/echoD/sharpPinD/optPinD/bordePinD/numDistSensores/estrategia)
//    — true solo para mini, el ÚNICO perfil que realmente persiste esos
//    campos en NVS (ver saveSumoConfig()/loadSumoConfig() más arriba:
//    micro nunca tuvo esas claves "u_*" — no se inventa simetría que la
//    persistencia real no tiene). `destino` se deja en un estado
//    parcialmente escrito si devuelve false — el llamador NUNCA debe
//    copiarlo a cfgMini/cfgMicro reales en ese caso (ver
//    handleProyectoImport(), que solo aplica si TODAS las secciones
//    validan ok).
bool proyectoValidarSumo(const String& obj, SumoConfig& destino, bool completo, String& err) {
  long v;

  if (!proyectoLeerEntero(obj, "tipoDistSensor", 0, 2, v, err)) return false;
  destino.tipoDistSensor = (uint8_t)v;

  if (!proyectoLeerEntero(obj, "numDistSensores", 1, 2, v, err)) return false;
  destino.numDistSensores = (uint8_t)v;
  if (!completo) destino.numDistSensores = 1; // micro es siempre 1 sensor — no se persiste distinto

  if (!proyectoLeerEntero(obj, "trigI", 0, 255, v, err)) return false;
  destino.trigI = (uint8_t)v;
  if (!proyectoLeerEntero(obj, "echoI", 0, 255, v, err)) return false;
  destino.echoI = (uint8_t)v;
  if (!gpioValido(destino.trigI) || !gpioValido(destino.echoI)) {
    err = "trigI/echoI: GPIO fuera del hardware real (ESP32-C3 SuperMini)"; return false;
  }

  if (completo) {
    if (!proyectoLeerEntero(obj, "trigD", 0, 255, v, err)) return false;
    destino.trigD = (uint8_t)v;
    if (!proyectoLeerEntero(obj, "echoD", 0, 255, v, err)) return false;
    destino.echoD = (uint8_t)v;
    if (!gpioValido(destino.trigD) || !gpioValido(destino.echoD)) {
      err = "trigD/echoD: GPIO fuera del hardware real (ESP32-C3 SuperMini)"; return false;
    }
  } else { destino.trigD = 0; destino.echoD = 0; }

  if (!proyectoLeerEntero(obj, "sharpPinI", 0, 1, v, err)) return false;
  destino.sharpPinI = (uint8_t)v;
  if (completo) {
    if (!proyectoLeerEntero(obj, "sharpPinD", 0, 1, v, err)) return false;
    destino.sharpPinD = (uint8_t)v;
  } else destino.sharpPinD = 0;

  if (!proyectoLeerEntero(obj, "umbralSharp", 100, 4095, v, err)) return false;
  destino.umbralSharp = (uint16_t)v;

  if (!proyectoLeerEntero(obj, "optPinI", 0, 255, v, err)) return false;
  destino.optPinI = (uint8_t)v;
  if (!gpioValido(destino.optPinI)) { err = "optPinI: GPIO fuera del hardware real (ESP32-C3 SuperMini)"; return false; }
  if (completo) {
    if (!proyectoLeerEntero(obj, "optPinD", 0, 255, v, err)) return false;
    destino.optPinD = (uint8_t)v;
    if (!gpioValido(destino.optPinD)) { err = "optPinD: GPIO fuera del hardware real (ESP32-C3 SuperMini)"; return false; }
  } else destino.optPinD = 0;

  if (!proyectoLeerEntero(obj, "numBorde", 0, 2, v, err)) return false;
  destino.numBorde = (uint8_t)v;
  if (!proyectoLeerEntero(obj, "bordePinI", 0, 1, v, err)) return false;
  destino.bordePinI = (uint8_t)v;
  if (completo) {
    if (!proyectoLeerEntero(obj, "bordePinD", 0, 1, v, err)) return false;
    destino.bordePinD = (uint8_t)v;
  } else destino.bordePinD = 0;
  if (!proyectoLeerEntero(obj, "umbralBorde", 100, 4095, v, err)) return false;
  destino.umbralBorde = (uint16_t)v;

  if (!proyectoLeerEntero(obj, "umbralDistCm", 2, 200, v, err)) return false;
  destino.umbralDistCm = (uint8_t)v;

  if (!proyectoLeerEntero(obj, "spdAtaque", 0, 255, v, err)) return false;
  destino.spdAtaque = (uint8_t)v;

  // FASE "CIERRE SUMO" — velBusqueda/intGiro (nombres nuevos, version 2
  // de .franky) reemplazan a spdBuscExt/spdBuscInt (version 1). Se
  // intenta primero el par nuevo; si el archivo no lo trae (.franky
  // exportado por un firmware anterior a esta fase), se migra desde el
  // par viejo con la misma fórmula inversa que usa loadSumoConfig() —
  // ningún proyecto exportado antes pierde su calibración al importarse
  // en este firmware (sección 17 del pedido: "mantené compatibilidad
  // con proyectos existentes").
  long velTmp;
  if (jsonExtractLong(obj, "velBusqueda", velTmp)) {
    if (velTmp < 0 || velTmp > 255) { err = "fuera de rango: velBusqueda=" + String(velTmp); return false; }
    destino.velBusqueda = (uint8_t)velTmp;
    if (!proyectoLeerEntero(obj, "intGiro", 0, 255, v, err)) return false;
    destino.intGiro = (uint8_t)v;
  } else {
    long ext, intr;
    if (!proyectoLeerEntero(obj, "spdBuscExt", 0, 255, ext, err)) return false;
    if (!proyectoLeerEntero(obj, "spdBuscInt", 0, 255, intr, err)) return false;
    destino.velBusqueda = (uint8_t)(((ext + intr)) / 2);
    destino.intGiro      = (uint8_t)((ext >= intr) ? (ext - intr) : 0);
  }

  if (!proyectoLeerEntero(obj, "spdEvasion", 0, 255, v, err)) return false;
  destino.spdEvasion = (uint8_t)v;

  if (completo) {
    if (!proyectoLeerEntero(obj, "estrategia", 0, 1, v, err)) return false;
    destino.estrategia = (uint8_t)v;
    // "Duración del barrido" — nueva en esta fase, opcional (un .franky
    // viejo, o cualquiera que todavía no la tenga, no la trae): si
    // falta, se conserva CABECEO_MS de fábrica, el mismo valor que ya
    // usaba el barrido antes de ser configurable.
    long durTmp;
    if (jsonExtractLong(obj, "durBarrido", durTmp)) {
      if (durTmp < 50 || durTmp > 3000) { err = "fuera de rango: durBarrido=" + String(durTmp); return false; }
      destino.durBarrido = (uint16_t)durTmp;
    } else {
      destino.durBarrido = CABECEO_MS;
    }
  } else {
    destino.estrategia = 0;        // micro siempre círculo — no configurable, ver struct init de cfgMicro
    destino.durBarrido  = CABECEO_MS; // micro no usa barrido — valor de fábrica, no relevante
  }

  // Misma validación que handleSumoConfig() — nunca más de 2 canales
  // ADC (Sharp+Borde comparten GPIO0/GPIO1, únicos disponibles).
  if (!validateSumoADC(destino)) {
    err = "la combinacion Sharp+Borde supera los 2 canales ADC disponibles";
    return false;
  }
  return true;
}

bool proyectoValidarI2C(const String& obj, uint8_t& sda, uint8_t& scl, bool& enabled, String& err) {
  long v;
  if (!proyectoLeerEntero(obj, "sda", 0, 255, v, err)) return false;
  sda = (uint8_t)v;
  if (!proyectoLeerEntero(obj, "scl", 0, 255, v, err)) return false;
  scl = (uint8_t)v;
  if (!jsonExtractBool(obj, "enabled", enabled)) { err = "i2c.enabled: falta o invalido"; return false; }
  // Misma regla que aplicarI2C()/esPinI2CValido() — pool fijo {6,7,10,20,21}.
  if (!esPinI2CValido(sda) || !esPinI2CValido(scl)) { err = "GPIO invalido para I2C (solo 6,7,10,20,21)"; return false; }
  if (sda == scl) { err = "SDA y SCL no pueden ser el mismo GPIO"; return false; }
  return true;
}

bool proyectoValidarSpi(const String& obj, bool& enabled, String& err) {
  if (!jsonExtractBool(obj, "enabled", enabled)) { err = "spi.enabled: falta o invalido"; return false; }
  return true;
}

bool proyectoValidarTrim(const String& obj, int& trimA_, int& trimB_, String& err) {
  long v;
  if (!proyectoLeerEntero(obj, "motorA", 0, 255, v, err)) return false;
  trimA_ = (int)v;
  if (!proyectoLeerEntero(obj, "motorB", 0, 255, v, err)) return false;
  trimB_ = (int)v;
  return true;
}

// Validación SUPERFICIAL de blockly.xml — este firmware no puede
// interpretar Blockly (vive solo en el navegador), pero sí puede
// negarse a validar el resto del import si esta sección no tiene ni la
// forma mínima de un XML de Blockly — atomicidad real ("si BLOCKLY
// falla, no aplicar nada"), aunque el firmware nunca vaya a persistir
// este campo. null (o string vacío) es un valor VÁLIDO — proyecto sin
// programa Blockly todavía.
bool proyectoValidarBlockly(const String& obj, String& err) {
  if (jsonIsNull(obj, "xml")) return true;
  String xml;
  if (!jsonExtractString(obj, "xml", xml)) { err = "blockly.xml: falta, o no es texto ni null"; return false; }
  String t = xml; t.trim();
  if (t.length() == 0) return true; // equivalente a "sin programa"
  if (t.length() > 40000) { err = "blockly.xml: demasiado grande (>40000 caracteres)"; return false; }
  if (!t.startsWith("<xml")) { err = "blockly.xml: no tiene forma de XML de Blockly (debe empezar con <xml)"; return false; }
  if (!t.endsWith("</xml>") && !t.endsWith("/>")) { err = "blockly.xml: no parece un XML de Blockly bien formado"; return false; }
  return true;
}

// ── Generación del export — solo lo que el firmware realmente conoce
//    (ver nota de diseño arriba: "meta" y "blockly" los agrega el
//    navegador antes de descargar el archivo).
// FASE "CIERRE SUMO" — sigue emitiendo "spdBuscExt"/"spdBuscInt"
// (calculados desde velExterna()/velInterna(), NUNCA leídos de un campo
// que ya no existe en el struct) ADEMÁS de "velBusqueda"/"intGiro" —
// así un .franky exportado por este firmware sigue siendo importable
// por CUALQUIER versión anterior que solo entienda spdBuscExt/
// spdBuscInt (compatibilidad en los dos sentidos, no solo hacia
// adelante). "durBarrido" es nueva, solo en la sección "completo".
String proyectoJsonSumo(const SumoConfig& c, bool completo) {
  String j = "{";
  j += "\"tipoDistSensor\":" + String(c.tipoDistSensor) + ",";
  if (completo) j += "\"numDistSensores\":" + String(c.numDistSensores) + ",";
  j += "\"trigI\":" + String(c.trigI) + ",";
  j += "\"echoI\":" + String(c.echoI) + ",";
  if (completo) { j += "\"trigD\":" + String(c.trigD) + ","; j += "\"echoD\":" + String(c.echoD) + ","; }
  j += "\"sharpPinI\":" + String(c.sharpPinI) + ",";
  if (completo) j += "\"sharpPinD\":" + String(c.sharpPinD) + ",";
  j += "\"umbralSharp\":" + String(c.umbralSharp) + ",";
  j += "\"optPinI\":" + String(c.optPinI) + ",";
  if (completo) j += "\"optPinD\":" + String(c.optPinD) + ",";
  j += "\"numBorde\":" + String(c.numBorde) + ",";
  j += "\"bordePinI\":" + String(c.bordePinI) + ",";
  if (completo) j += "\"bordePinD\":" + String(c.bordePinD) + ",";
  j += "\"umbralBorde\":" + String(c.umbralBorde) + ",";
  j += "\"umbralDistCm\":" + String(c.umbralDistCm) + ",";
  j += "\"spdAtaque\":" + String(c.spdAtaque) + ",";
  j += "\"velBusqueda\":" + String(c.velBusqueda) + ",";
  j += "\"intGiro\":" + String(c.intGiro) + ",";
  j += "\"spdBuscExt\":" + String(velExterna(c)) + ","; // legado — reconstruido, no un campo real del struct
  j += "\"spdBuscInt\":" + String(velInterna(c)) + ","; // ídem
  j += "\"spdEvasion\":" + String(c.spdEvasion);
  if (completo) {
    j += ",\"estrategia\":" + String(c.estrategia);
    j += ",\"durBarrido\":" + String(c.durBarrido);
  }
  j += "}";
  return j;
}

String generarProyectoJson() {
  String j = "{";
  j += "\"format\":\"FRANKY\",";
  // FASE "CIERRE SUMO" — version 2: agrega "velBusqueda"/"intGiro"/
  // "durBarrido" dentro de "sumo.mini"/"sumo.micro" (ver
  // proyectoJsonSumo()). handleProyectoImport() sigue aceptando
  // version 1 (los .franky de cualquier fase anterior no dejan de
  // importar — proyectoValidarSumo() migra spdBuscExt/spdBuscInt si no
  // encuentra los campos nuevos, ver esa función).
  j += "\"version\":2,";
  j += "\"firmware\":\"" + jsonEscape(String(FW_VER)) + "\",";
  j += "\"sumo\":{";
  j +=   "\"mini\":"  + proyectoJsonSumo(cfgMini, true) + ",";
  j +=   "\"micro\":" + proyectoJsonSumo(cfgMicro, false) + ",";
  // NUEVO — Fase "Persistencia Sumo": perfilActivo + inicio quedan
  // dentro del MISMO objeto "sumo" del formato .franky ya existente
  // (sección 15 del pedido — "no crear un segundo formato"). Campos
  // agregados sin tocar "version" (sigue en 1): un .franky exportado
  // ANTES de esta fase no los tenía, y un .franky de ANTES sigue
  // importando bien en un firmware CON esta fase porque
  // handleProyectoImport() los trata como opcionales (ver más abajo).
  j +=   "\"perfilActivo\":" + String(cfgActiva->perfil) + ",";
  j +=   "\"inicio\":{\"servidor\":" + String(sumoInicioServidor?"true":"false") +
                    ",\"boton\":"    + String(sumoInicioBoton?"true":"false")    + "}";
  j += "},";
  j += "\"i2c\":{\"enabled\":" + String(i2cEnabled?"true":"false") + ",\"sda\":" + String(i2cSda) + ",\"scl\":" + String(i2cScl) + "},";
  j += "\"spi\":{\"enabled\":" + String(spiEnabled?"true":"false") + "},";
  j += "\"trim\":{\"motorA\":" + String(trimA) + ",\"motorB\":" + String(trimB) + "},";
  // NUEVO — fase "PROGRAMA FUENTE": el XML de Blockly ahora lo conoce
  // el firmware (SPIFFS), se incluye acá igual que cualquier otro campo
  // que el firmware sí conoce — ya no depende de que proyecto.html lo
  // complete leyendo localStorage.
  String xmlGuardado;
  bool hayXmlGuardado = leerXmlBlocklySpiffs(xmlGuardado);
  j += "\"blockly\":{\"xml\":";
  j += (hayXmlGuardado && xmlGuardado.length() > 0) ? ("\"" + jsonEscape(xmlGuardado) + "\"") : "null";
  j += "}";
  j += "}";
  return j;
}

void handleProyectoExport() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "application/json", generarProyectoJson());
}

// POST /proyecto/import — cuerpo: JSON completo del archivo .franky
// (texto plano, ver nota de Content-Type en proyecto.html). Implementa
// el flujo exigido: LECTURA → VALIDACIÓN COMPLETA → ¿TODO OK? →
// SÍ→aplicar todo / NO→no modificar nada.
void handleProyectoImport() {
  if (!server.hasArg("plain") || server.arg("plain").length() == 0) {
    sendJsonError(400, "Cuerpo de la peticion vacio (se espera el JSON del archivo .franky)");
    return;
  }
  String body = server.arg("plain");
  // Protege el heap del ESP32-C3 (RAM limitada) de un archivo corrupto
  // o desproporcionado — ver "no confies ciegamente en archivos
  // externos", seccion 9 del pedido.
  if (body.length() > 49152) {
    sendJsonError(413, "Archivo demasiado grande (maximo 48KB)"); return;
  }

  String err;

  // 1) Formato/version — primero, antes de tocar nada.
  String formato;
  if (!jsonExtractString(body, "format", formato) || formato != "FRANKY") {
    sendJsonError(400, "No es un archivo de Proyecto FRANKY valido (falta \"format\":\"FRANKY\")");
    return;
  }
  long version;
  if (!jsonExtractLong(body, "version", version)) {
    sendJsonError(400, "Falta \"version\" en el archivo"); return;
  }
  // FASE "CIERRE SUMO": este firmware exporta version 2 (agrega
  // velBusqueda/intGiro/durBarrido, ver generarProyectoJson()), pero
  // sigue aceptando version 1 en import — proyectoValidarSumo() ya
  // migra los campos viejos (spdBuscExt/spdBuscInt) si los nuevos no
  // están presentes en el JSON, sin importar qué "version" declare el
  // archivo. No se rompe ningún .franky exportado antes de esta fase.
  if (version != 1 && version != 2) {
    sendJsonError(400, ("Version de proyecto no soportada por este firmware: " + String(version)).c_str());
    return;
  }

  // 2) Extraer y VALIDAR cada seccion en variables de staging — nada se
  // aplica todavia. Si CUALQUIERA falla, se sale sin haber tocado ningun
  // global real (atomicidad).
  String sumoObj, miniObj, microObj, i2cObj, spiObj, trimObj, blocklyObj;
  if (!jsonExtractObject(body, "sumo", sumoObj))            { sendJsonError(400, "Falta la seccion \"sumo\"");    return; }
  if (!jsonExtractObject(sumoObj, "mini", miniObj))         { sendJsonError(400, "Falta \"sumo.mini\"");          return; }
  if (!jsonExtractObject(sumoObj, "micro", microObj))       { sendJsonError(400, "Falta \"sumo.micro\"");         return; }
  if (!jsonExtractObject(body, "i2c", i2cObj))              { sendJsonError(400, "Falta la seccion \"i2c\"");     return; }
  if (!jsonExtractObject(body, "spi", spiObj))              { sendJsonError(400, "Falta la seccion \"spi\"");     return; }
  if (!jsonExtractObject(body, "trim", trimObj))            { sendJsonError(400, "Falta la seccion \"trim\"");    return; }
  if (!jsonExtractObject(body, "blockly", blocklyObj))      { sendJsonError(400, "Falta la seccion \"blockly\""); return; }

  SumoConfig stagingMini  = cfgMini;  // copia — cfgMini/cfgMicro reales NUNCA se tocan hasta el paso 3
  SumoConfig stagingMicro = cfgMicro;
  if (!proyectoValidarSumo(miniObj, stagingMini, true, err))    { sendJsonError(400, ("sumo.mini invalido: "  + err).c_str()); return; }
  if (!proyectoValidarSumo(microObj, stagingMicro, false, err)) { sendJsonError(400, ("sumo.micro invalido: " + err).c_str()); return; }

  uint8_t stagingSda = i2cSda, stagingScl = i2cScl;
  bool stagingI2cEnabled = i2cEnabled;
  if (!proyectoValidarI2C(i2cObj, stagingSda, stagingScl, stagingI2cEnabled, err)) {
    sendJsonError(400, ("i2c invalido: " + err).c_str()); return;
  }

  bool stagingSpiEnabled = spiEnabled;
  if (!proyectoValidarSpi(spiObj, stagingSpiEnabled, err)) { sendJsonError(400, ("spi invalido: " + err).c_str()); return; }

  int stagingTrimA = trimA, stagingTrimB = trimB;
  if (!proyectoValidarTrim(trimObj, stagingTrimA, stagingTrimB, err)) { sendJsonError(400, ("trim invalido: " + err).c_str()); return; }

  if (!proyectoValidarBlockly(blocklyObj, err)) { sendJsonError(400, ("blockly invalido: " + err).c_str()); return; }

  // Extraer el XML ya validado por proyectoValidarBlockly() arriba —
  // jsonIsNull cubre el caso "sin programa" (blockly.xml == null), que
  // no debe tocar el programa ya guardado en el robot (import parcial
  // de un proyecto sin programa de Bloques no borra el que ya había).
  String stagingXml;
  bool hayXmlImportado = false;
  if (!jsonIsNull(blocklyObj, "xml")) {
    jsonExtractString(blocklyObj, "xml", stagingXml); // ya validado arriba, no puede fallar acá
    hayXmlImportado = stagingXml.length() > 0;
  }

  // Perfil activo + modo de inicio — Fase "Persistencia Sumo". OPCIONALES
  // a propósito: un .franky exportado ANTES de esta fase no trae estos
  // campos dentro de "sumo", y debe seguir importando sin error — se
  // dejan el perfil activo y el modo de inicio del robot exactamente
  // como estaban (nunca se fuerza un default "de fábrica" por encima de
  // lo que el robot ya tenía configurado, a diferencia de sumo/i2c/spi/
  // trim/blockly, que sí son secciones obligatorias del formato).
  long stagingPerfilActivo = cfgActiva->perfil;
  { long v; String errTmp; if (proyectoLeerEntero(sumoObj, "perfilActivo", 0, 1, v, errTmp)) stagingPerfilActivo = v; }

  bool stagingInicioServidor = sumoInicioServidor;
  bool stagingInicioBoton    = sumoInicioBoton;
  String inicioObj;
  if (jsonExtractObject(sumoObj, "inicio", inicioObj)) {
    bool bTmp;
    if (jsonExtractBool(inicioObj, "servidor", bTmp)) stagingInicioServidor = bTmp;
    if (jsonExtractBool(inicioObj, "boton", bTmp))    stagingInicioBoton    = bTmp;
  }

  // 3) TODO válido — recién ahora se aplica. El XML de Blockly se
  // escribe en SPIFFS PRIMERO, antes de tocar cualquier otro dato: es
  // la única escritura de este import que puede fallar por una causa
  // externa (SPIFFS sin espacio) — si falla acá, se aborta el import
  // COMPLETO sin haber tocado Sumo/I2C/SPI/trim, preservando la
  // atomicidad de "todo o nada" también para esta pieza nueva.
  if (hayXmlImportado) {
    String errXml;
    if (!guardarXmlBlocklySpiffs(stagingXml, errXml)) {
      sendJsonError(500, ("No se pudo guardar el programa Blockly importado: " + errXml).c_str());
      return;
    }
    // El bytecode compilado (programa[]/NVS "bloques") NO cambia con un
    // import — este firmware nunca compila XML server-side (ver diseño
    // arriba). Se invalida la marca de sincronización para que quede
    // indicado explícitamente, hasta que el usuario recompile desde
    // bloques.html/programa.html, que este XML importado puede no
    // corresponder al bytecode que ya estaba cargado.
    prefs.begin("bloques", false);
    prefs.putUInt("xmlhash", 0);
    prefs.end();
  }

  cfgMini  = stagingMini;
  cfgMicro = stagingMicro;
  i2cSda = stagingSda; i2cScl = stagingScl; i2cEnabled = stagingI2cEnabled;
  spiEnabled = stagingSpiEnabled;
  trimA = stagingTrimA; trimB = stagingTrimB;
  // Perfil activo + modo de inicio — ver extracción arriba. Mismo
  // criterio de seguridad que handleSumoConfig(): no se reasigna
  // cfgActiva si Sumo está efectivamente corriendo (no debería estarlo
  // durante un import, pero se mantiene la misma guarda por las dudas).
  if (currentMode == MODE_IDLE) cfgActiva = (stagingPerfilActivo == 1) ? &cfgMicro : &cfgMini;
  sumoInicioServidor = stagingInicioServidor;
  sumoInicioBoton    = stagingInicioBoton;

  saveSumoConfig();
  prefs.begin("franky", false);
  prefs.putBool("i2c", i2cEnabled);
  prefs.putBool("spi", spiEnabled);
  prefs.putUChar("i2csda", i2cSda);
  prefs.putUChar("i2cscl", i2cScl);
  prefs.end();

  flog('I', "PROYECTO importado y aplicado — reiniciando para reconfigurar perifericos");

  // Mismo patrón que handlePanelSave()/handleI2CSet(): se reinicia para
  // que Wire.begin() se reconstruya limpio con el par SDA/SCL que puede
  // haber cambiado — no se intenta reconfigurar I2C en caliente en
  // ningún otro punto del firmware, no se inventa un camino nuevo solo
  // para este endpoint. loadSumoConfig()/loadConfig() del próximo
  // setup() releen exactamente lo que acabamos de persistir arriba.
  server.send(200, "application/json", "{\"ok\":true,\"mensaje\":\"Proyecto aplicado. Reiniciando...\"}");
  delay(1500);
  ESP.restart();
}

// ═══════════════════════════════════════════════════════
//  SPIFFS helpers
// ═══════════════════════════════════════════════════════
String getContentType(const String& path) {
  if      (path.endsWith(".html")) return "text/html";
  else if (path.endsWith(".css"))  return "text/css";
  else if (path.endsWith(".js"))   return "application/javascript";
  else if (path.endsWith(".json")) return "application/json";
  else if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  else if (path.endsWith(".png"))  return "image/png";
  else if (path.endsWith(".ico"))  return "image/x-icon";
  return "text/plain";
}

bool serveFile(const String& path) {
  String realPath = path;
  if (realPath == "/") realPath = "/index.html";
  if (!SPIFFS.exists(realPath)) return false;
  File f = SPIFFS.open(realPath, "r");
  if (!f) return false;
  server.sendHeader("Cache-Control","max-age=3600");
  server.streamFile(f, getContentType(realPath));
  f.close();
  return true;
}

void handleNotFound() {
  if (!serveFile(server.uri()))
    server.send(404,"text/plain","Archivo no encontrado: "+server.uri());
}

// ═══════════════════════════════════════════════════════
//  PROGRAMA FUENTE — persistencia del XML de Blockly en SPIFFS
//
//  Evolución pedida sobre el Proyecto FRANKY ya entregado: hasta acá el
//  firmware NUNCA conocía el XML del workspace Blockly (vivía solo en
//  localStorage del navegador — ver nota de diseño en la sección
//  "PROYECTO FRANKY" más abajo, ahora actualizada). El pedido es que un
//  programa armado en una PC pueda recuperarse y EJECUTARSE desde
//  cualquier otro dispositivo (por ejemplo un celular, en plena
//  competencia) sin depender del navegador/PC original — para eso el
//  robot mismo tiene que guardar el XML, no solo el bytecode.
//
//  Se distinguen 3 conceptos, a propósito, sin mezclarlos:
//   1) PROGRAMA FUENTE   — el XML de Blockly (editable, "el dibujo").
//      NUEVO en esta fase: vive en SPIFFS, archivo BLOCKLY_XML_PATH.
//   2) PROGRAMA EJECUTABLE — el bytecode programa[]/progLen. Sin
//      cambios: sigue viviendo en NVS ("bloques", ver guardarProg()/
//      cargarProg()), lo sube /bloques/add como siempre.
//   3) ESTADO DE EJECUCIÓN — currentMode/modeRunning/progPC. Volátil,
//      sin cambios, no persiste nunca (arranca siempre detenido).
//
//  Este firmware NO compila XML a bytecode (y no debe hacerlo — ver
//  informe de entrega, "el XML es la fuente portable, no algo que el
//  ESP32 necesite entender"). Eso significa que guardar un XML nuevo
//  puede dejarlo temporalmente desincronizado del bytecode ya
//  compilado (por ejemplo: el usuario edita en la PC, guarda el XML,
//  pero todavía no volvió a presionar "Ejecutar" para recompilar y
//  subir el bytecode nuevo). Nunca se permite que eso quede oculto: se
//  usa un hash FNV-1a de 32 bits, calculado en el NAVEGADOR sobre el
//  XML que efectivamente se acaba de compilar y subir, y confirmado acá
//  vía POST /bloques/marcarFuente — handleBloquesXmlGet() recalcula el
//  MISMO hash sobre el archivo SPIFFS actual y expone "sincronizado" en
//  su respuesta, así bloques.html y la nueva /programa.html pueden
//  avisar con claridad cuando el XML guardado no corresponde al
//  bytecode actualmente cargado (ver punto 7 del pedido: "nunca de
//  forma silenciosa").
//
//  ATÓMICO frente a cortes de energía: guardarXmlBlocklySpiffs() escribe
//  siempre a un archivo temporal y recién al final hace rename() sobre
//  el archivo real — el mismo patrón "todo o nada" que ya usa
//  /proyecto/import para NVS, aplicado acá a SPIFFS.
// ═══════════════════════════════════════════════════════

#define BLOCKLY_XML_PATH     "/bloques_prog.xml"
#define BLOCKLY_XML_PATH_TMP "/bloques_prog.xml.tmp"
#define BLOCKLY_XML_MAX_LEN  40000

// FNV-1a 32 bits — mismo algoritmo, mismos offset/prime que el
// equivalente en JavaScript (ver fnv1a32() en bloques.html/programa.html):
// ambos operan sobre la MISMA secuencia de bytes UTF-8 (TextEncoder en
// JS, el cuerpo crudo que llega por server.arg("plain") acá) y ambos
// dejan que la multiplicación de 32 bits desborde igual (uint32_t acá,
// Math.imul()+">>>0" allá) — por diseño, el resultado es bit a bit
// idéntico en los dos lados sin necesitar transmitir el XML completo
// para comparar.
uint32_t fnv1a32(const uint8_t* data, size_t len) {
  uint32_t h = 2166136261UL;
  for (size_t i = 0; i < len; i++) {
    h ^= data[i];
    h *= 16777619UL;
  }
  return h;
}
uint32_t fnv1a32Str(const String& s) {
  return fnv1a32((const uint8_t*)s.c_str(), s.length());
}

// Escritura atómica: temporal + rename. Si algo falla a mitad de
// camino (SPIFFS sin espacio, corte de energía), el archivo bueno
// anterior queda intacto — nunca se deja un BLOCKLY_XML_PATH a medio
// escribir.
bool guardarXmlBlocklySpiffs(const String& xml, String& err) {
  if (xml.length() > BLOCKLY_XML_MAX_LEN) { err = "XML demasiado grande (maximo " + String(BLOCKLY_XML_MAX_LEN) + " caracteres)"; return false; }
  File f = SPIFFS.open(BLOCKLY_XML_PATH_TMP, "w");
  if (!f) { err = "No se pudo abrir archivo temporal en SPIFFS"; return false; }
  size_t escritos = f.print(xml);
  f.close();
  if (escritos != xml.length()) {
    SPIFFS.remove(BLOCKLY_XML_PATH_TMP);
    err = "Escritura incompleta (SPIFFS sin espacio?)";
    return false;
  }
  if (SPIFFS.exists(BLOCKLY_XML_PATH)) SPIFFS.remove(BLOCKLY_XML_PATH);
  if (!SPIFFS.rename(BLOCKLY_XML_PATH_TMP, BLOCKLY_XML_PATH)) {
    err = "No se pudo confirmar la escritura del archivo (rename fallo)";
    return false;
  }
  return true;
}

// Devuelve true si existe un programa fuente guardado (aunque esté
// vacío — ver handleBloquesXmlSet(), guardar "" es una forma válida de
// "vaciar" el programa fuente sin borrar el archivo).
bool leerXmlBlocklySpiffs(String& out) {
  if (!SPIFFS.exists(BLOCKLY_XML_PATH)) { out = ""; return false; }
  File f = SPIFFS.open(BLOCKLY_XML_PATH, "r");
  if (!f) { out = ""; return false; }
  out = f.readString();
  f.close();
  return true;
}

// GET /bloques/xml — {"existe":bool,"xml":str|null,"bytes":N,"sincronizado":bool}
void handleBloquesXmlGet() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String xml;
  bool existe = leerXmlBlocklySpiffs(xml);
  String j = "{";
  j += "\"existe\":" + String(existe ? "true" : "false") + ",";
  if (existe) {
    j += "\"xml\":\"" + jsonEscape(xml) + "\",";
    j += "\"bytes\":" + String(xml.length()) + ",";
    prefs.begin("bloques", true);
    uint32_t hashGuardado = prefs.getUInt("xmlhash", 0);
    prefs.end();
    // hashGuardado==0 se trata siempre como "no sincronizado" — es el
    // valor inicial antes de la primera vez que se compila/marca, y
    // también el valor que handleBloquesXmlSet()/handleProyectoImport()
    // fuerzan deliberadamente cada vez que el XML cambia sin haberse
    // recompilado todavía.
    uint32_t hashActual = fnv1a32Str(xml);
    bool sincronizado = (hashGuardado != 0) && (hashGuardado == hashActual);
    j += "\"sincronizado\":" + String(sincronizado ? "true" : "false");
  } else {
    j += "\"xml\":null,\"bytes\":0,\"sincronizado\":false";
  }
  j += "}";
  server.send(200, "application/json", j);
}

// POST /bloques/xml — cuerpo: XML de Blockly en texto plano (no JSON:
// mismo formato crudo que ya exporta/importa "Exportar XML"/"Importar
// XML" en bloques.html, evita otra capa de escapado). Guarda el
// PROGRAMA FUENTE en SPIFFS. Vacío es válido (equivale a "sin
// programa"). Cada guardado invalida la marca de sincronización — recién
// vuelve a marcarse "sincronizado" cuando el navegador compila y sube
// el bytecode correspondiente (ver /bloques/marcarFuente).
void handleBloquesXmlSet() {
  if (!server.hasArg("plain")) {
    sendJsonError(400, "Cuerpo vacio (se espera el XML de Blockly en texto plano)");
    return;
  }
  String xml = server.arg("plain");
  String t = xml; t.trim();
  if (t.length() > BLOCKLY_XML_MAX_LEN) {
    sendJsonError(413, "XML demasiado grande (maximo 40000 caracteres)"); return;
  }
  if (t.length() > 0) {
    if (!t.startsWith("<xml")) { sendJsonError(400, "No tiene forma de XML de Blockly (debe empezar con <xml)"); return; }
    if (!t.endsWith("</xml>") && !t.endsWith("/>")) { sendJsonError(400, "XML de Blockly mal formado"); return; }
  }
  String err;
  if (!guardarXmlBlocklySpiffs(xml, err)) { sendJsonError(500, err.c_str()); return; }
  prefs.begin("bloques", false);
  prefs.putUInt("xmlhash", 0); // nueva fuente — invalida sincronizacion hasta el proximo compilado
  prefs.end();
  flog('I', "PROGRAMA fuente (Blockly XML) guardado en SPIFFS (" + String(xml.length()) + " bytes)");
  server.send(200, "application/json", "{\"ok\":true,\"bytes\":" + String(xml.length()) + "}");
}

// POST /bloques/marcarFuente?hash=N — el navegador llama esto justo
// después de subir con éxito el bytecode compilado a partir de un XML
// dado, pasando el FNV-1a de ESE XML. No hay forma de que el firmware
// "sepa" que XML corresponde a que bytecode sin esto (no compila XML) —
// es la única pieza de confianza que necesita, y es best-effort: si esta
// llamada falla o nunca llega, lo peor que pasa es que
// "sincronizado" quede en false de más (nunca al revés, nunca miente
// diciendo sincronizado=true sin fundamento), que es el lado seguro.
void handleBloquesMarcarFuente() {
  if (!server.hasArg("hash")) { sendJsonError(400, "Falta el parametro hash"); return; }
  uint32_t hash = (uint32_t) strtoul(server.arg("hash").c_str(), NULL, 10);
  prefs.begin("bloques", false);
  prefs.putUInt("xmlhash", hash);
  prefs.end();
  server.send(200, "application/json", "{\"ok\":true}");
}

// ═══════════════════════════════════════════════════════
//  MOTORES con trim diferencial
// ═══════════════════════════════════════════════════════
int applyTrim(int spd, int trim) {
  if (trim >= 255) return spd;
  return (int)((long)spd * trim / 255);
}

void stopMotors() {
  ledcWrite(CH_A1,0); ledcWrite(CH_A2,0);
  ledcWrite(CH_B1,0); ledcWrite(CH_B2,0);
  pwmA = 0; pwmB = 0;
}

// Fase 4.2 — freno activo (mismo principio que OP_FRENO, opcode 11, que
// ya existía para uso manual/educativo desde Blockly): ambos canales
// LEDC de cada motor a 255 simultáneamente en vez de a 0. En un puente H
// de dos entradas como el RZ7899 (dos entradas activas al mismo tiempo)
// esto cortocircuita ambos bornes del motor en vez de dejarlos en alta
// impedancia — frena por contra-EMF en lugar de dejar el motor en punto
// muerto (coast). stopMotors() se mantiene sin cambios para paradas no
// críticas (fin de programa, botón STOP manual); brakeMotors() es
// específicamente para el instante de mayor sensibilidad de una
// maniobra automática de evasión, donde la inercia residual importa.
//
// SIN delay(): la regla ya establecida del proyecto ("Blocking delay()
// calls are forbidden in robot control loops") aplica también acá. Esta
// función solo aplica el patrón de PWM de frenado UNA VEZ; la duración
// del freno la gobierna tickEvasion() como un estado más de su máquina
// de estados (EVADE_BRAKE, ver abajo), exactamente igual que ya hace con
// EVADE_BACK/EVADE_TURN — nunca un delay() bloqueante.
void brakeMotors() {
  ledcWrite(CH_A1,255); ledcWrite(CH_A2,255);
  ledcWrite(CH_B1,255); ledcWrite(CH_B2,255);
  pwmA = 255; pwmB = 255;
}

void move(const String& d, int spd = -1) {
  if (spd < 0) spd = motorSpeed;
  int sA = applyTrim(spd, trimA);
  int sB = applyTrim(spd, trimB);
  ledcWrite(CH_A1,0); ledcWrite(CH_A2,0);
  ledcWrite(CH_B1,0); ledcWrite(CH_B2,0);
  if      (d == "f") { ledcWrite(CH_A1,sA); ledcWrite(CH_B1,sB); }
  else if (d == "b") { ledcWrite(CH_A2,sA); ledcWrite(CH_B2,sB); }
  else if (d == "l") { ledcWrite(CH_A2,sA); ledcWrite(CH_B1,sB); }
  else if (d == "r") { ledcWrite(CH_A1,sA); ledcWrite(CH_B2,sB); }
  pwmA = sA; pwmB = sB;
}

void moveDiff(int spdA, int spdB) {
  int rA = applyTrim(abs(spdA), trimA);
  int rB = applyTrim(abs(spdB), trimB);
  ledcWrite(CH_A1, spdA > 0 ? rA : 0);
  ledcWrite(CH_A2, spdA < 0 ? rA : 0);
  ledcWrite(CH_B1, spdB > 0 ? rB : 0);
  ledcWrite(CH_B2, spdB < 0 ? rB : 0);
  pwmA = rA; pwmB = rB;
}

// ═══════════════════════════════════════════════════════
//  LECTURA DE SENSORES — Funciones centralizadas
// ═══════════════════════════════════════════════════════

// leerSonar: usa instancia NewPing temporal pero con max_cm acotado
// para minimizar tiempo de espera del ping (NewPing ya tiene timeout interno)
int leerSonar(int trig, int echo) {
  NewPing sonar(trig, echo, SONAR_MAX_CM);
  int cm = (int)sonar.ping_cm();
  return (cm == 0) ? 999 : cm;
}

// sharpDetectado: detección DIGITAL por umbral — no distancia continua.
// El Sharp 2Y0A21 tiene respuesta no lineal bajo ~6cm (zona ciega inversa).
// Usarlo como detector ON/OFF elimina la ambigüedad de esa zona.
// Un valor ADC MAYOR que el umbral → objeto detectado en rango válido.
bool sharpDetectado(uint8_t adcPin, uint16_t umbral) {
  int pin = (adcPin == 0) ? PIN_ADC0 : PIN_ADC1;
  int val = analogRead(pin);
  // Actualizar telemetría
  if (adcPin == 0) { sharpAdcValI = val; sharpDetI = (val > (int)umbral); return sharpDetI; }
  else             { sharpAdcValD = val; sharpDetD = (val > (int)umbral); return sharpDetD; }
}

// readBorder: lectura sensor de borde analógico
bool readBorder(uint8_t adcPin, uint16_t umbral) {
  int pin = (adcPin == 0) ? PIN_ADC0 : PIN_ADC1;
  return analogRead(pin) > (int)umbral;
}

// ═══════════════════════════════════════════════════════
//  INTERPRETE BLOQUES
// ═══════════════════════════════════════════════════════
void ejecutarBloque() {
  // CORRECCIÓN DE SEGURIDAD (única modificación autorizada en esta
  // entrega — ver acuerdo de aislamiento experimental): antes, al
  // llegar al final del programa (o con progLen==0), el intérprete
  // reiniciaba progPC=0 SIN detener los motores primero. Ahora se
  // detienen los motores ANTES de reiniciar el estado del intérprete.
  // No se toca modeRunning ni ninguna otra variable — un programa sin
  // bloque "Detener" sigue repitiéndose como antes (esa es una
  // decisión pedagógica aparte, no tomada acá); lo único que cambia es
  // que los motores quedan en 0 en cada vuelta al inicio, no solo si
  // el programa tenía un bloque STOP explícito.
  if (progLen == 0 || progPC >= progLen) { stopMotors(); progPC = 0; return; }
  if (bEsperando) {
    if (millis() - tBloque >= (unsigned long)bEsperaMs) { bEsperando=false; progPC++; }
    return;
  }
  Instruccion ins = programa[progPC];
  switch (ins.op) {
    case OP_ADE:     move("f", ins.val>0?ins.val:motorSpeed); if(flogThrottle("blockly_bloque",300)) flog('D',"Adelante vel="+String(ins.val>0?ins.val:motorSpeed)); progPC++; break;
    case OP_ATR:     move("b", ins.val>0?ins.val:motorSpeed); if(flogThrottle("blockly_bloque",300)) flog('D',"Atras vel="+String(ins.val>0?ins.val:motorSpeed)); progPC++; break;
    case OP_IZQ:     move("l", ins.val>0?ins.val:motorSpeed); if(flogThrottle("blockly_bloque",300)) flog('D',"Izquierda vel="+String(ins.val>0?ins.val:motorSpeed)); progPC++; break;
    case OP_DER:     move("r", ins.val>0?ins.val:motorSpeed); if(flogThrottle("blockly_bloque",300)) flog('D',"Derecha vel="+String(ins.val>0?ins.val:motorSpeed)); progPC++; break;
    case OP_STOP:    stopMotors(); progPC++; break;
    case OP_LED_ON:  digitalWrite(PIN_LED,LOW);  progPC++; break;
    case OP_LED_OFF: digitalWrite(PIN_LED,HIGH); progPC++; break;
    case OP_ESP:     tBloque=millis(); bEsperaMs=ins.val; bEsperando=true; break;
    case OP_IF_DIST: progPC += (analogRead(PIN_ADC0)>ins.val) ? 2 : 1; break;
    case OP_FRENO:
      ledcWrite(CH_A1,255); ledcWrite(CH_A2,255);
      ledcWrite(CH_B1,255); ledcWrite(CH_B2,255);
      progPC++; break;
    case OP_DOUT: {
      int gpio=ins.val/10, nivel=ins.val%10;
      pinMode(gpio,OUTPUT); digitalWrite(gpio,nivel); progPC++; break;
    }
    case OP_PWM_OUT:
      ledcSetup(8,5000,8); ledcAttachPin(3,8); ledcWrite(8,ins.val); progPC++; break;
    case OP_ADC_READ:
      adcLast=analogRead(ins.val>=0?ins.val:PIN_ADC0); varGlobal=adcLast; progPC++; break;
    case OP_SERVO: {
      int gpio=ins.val/1000, ang=ins.val%1000;
      if(servoGPIO!=gpio){ if(servoGPIO>=0)servoObj.detach(); servoObj.attach(gpio); servoGPIO=gpio; }
      servoObj.write(ang); progPC++; break;
    }
    case OP_VAR_SET: varGlobal=(float)ins.val; progPC++; break;
    case OP_JMP: progPC=ins.val; break; // salto incondicional — sin ins.val al índice absoluto, no progPC++
    case OP_VAR_ADD: varGlobal+=(float)ins.val; progPC++; break;
    case OP_VAR_SUB: varGlobal-=(float)ins.val; progPC++; break;
    case OP_IF_GT:   adcLast=analogRead(PIN_ADC0); progPC+=(adcLast>ins.val)?2:1; break;
    case OP_IF_LT:   adcLast=analogRead(PIN_ADC0); progPC+=(adcLast<ins.val)?2:1; break;
    case OP_PUSH:
      if(pilaLen<PILA_MAX) pila[pilaLen++]=ins.val;
      progPC++; break;
    case OP_CALL:
      if(callStackLen<PILA_MAX) callStack[callStackLen++]=progPC+1;
      progPC=ins.val; break;
    case OP_RET:
      progPC = (callStackLen>0) ? callStack[--callStackLen] : progPC+1;
      break;
    // Unidad 7 (Fase 2 P0) — ciclo real (reemplaza el desenrollado en
    // tiempo de compilación). Ver comentario completo junto a
    // #define OP_REPEAT_END, arriba. OP_REPEAT se ejecuta UNA sola vez
    // por cada vez que se entra al ciclo (el salto de OP_REPEAT_END
    // vuelve al inicio del CUERPO, no a OP_REPEAT) — por eso alcanza con
    // empujar val sin lógica de "primera vez".
    case OP_REPEAT:
      if (repeatStackLen<PILA_MAX) repeatStack[repeatStackLen++]=(int16_t)ins.val;
      progPC++; break;
    case OP_REPEAT_END:
      if (repeatStackLen>0) {
        repeatStack[repeatStackLen-1]--;
        if (repeatStack[repeatStackLen-1] > 0) { progPC = ins.val; }
        else { repeatStackLen--; progPC++; }
      } else {
        progPC++; // pila de ciclos vacía (programa mal formado) — nunca revienta, mismo criterio que pilaPop()
      }
      break;
    // TP5 Actividad 13 (programación no bloqueante con millis()) — antes
    // escribía en varGlobal, pero bloques.html nunca llegó a emitir este
    // opcode (compileExpr() no tenía case para "f_millis" -> el bloque
    // siempre compilaba a la constante 0, ver informe), así que no hay
    // programa real que haya dependido de esa escritura. Ahora empuja a
    // pila[] como el resto de los PUSH_* (OP_PUSH_VAR/OP_PUSH_ADC/
    // OP_PUSH_SONAR), para poder usarse dentro de expresiones
    // (variables_set, operaciones, comparaciones).
    //
    // millis() es de 32 bits pero pila[] es int16_t (16 bits) — no entra
    // entero. Se toman los 16 bits bajos y se reinterpretan como
    // int16_t (NUNCA constrain()/saturar: eso congelaría el valor en
    // 32767 para siempre apenas pasan ~32.7s de uptime). Esto replica el
    // truco estándar de Arduino de comparar por RESTA: mientras el
    // intervalo real entre dos lecturas sea menor a 32768 ms (~32s, sobra
    // para cualquier ejemplo de la Actividad 13), "actual - anterior" da
    // el elapsed correcto aunque el contador haya envuelto entre una
    // lectura y la otra.
    case OP_MILLIS_READ: {
      unsigned long ms = millis();
      int16_t v16 = (int16_t)(uint16_t)(ms & 0xFFFFUL);
      if (pilaLen<PILA_MAX) pila[pilaLen++] = v16;
      progPC++; break;
    }

    // Unidad 2 (Etapa 2/Fase 2 P0) — variables con fuente dinámica.
    // Dominio entero saturado en pila[] (int16_t) — ver addendum de
    // verificaciones (precisión numérica) para el porqué: hoy ningún
    // valor fraccionario real llega a varTabla[], y constrain() evita
    // un desborde silencioso de int16_t en vez de dejarlo indefinido.
    case OP_PUSH_VAR: {
      int idx = constrain((int)ins.val, 0, 3);
      long v = (long)varTabla[idx];
      if (pilaLen<PILA_MAX) pila[pilaLen++] = (int16_t)constrain(v, -32768L, 32767L);
      progPC++; break;
    }
    case OP_PUSH_ADC: {
      // val = pin*100+N (mismo empaquetado que OP_PUSH_SONAR/OP_DOUT) —
      // N = cantidad de muestras a promediar, igual que ya ofrece el
      // bloque f_adc existente ("Leer ADC prom N", 1-16). N=1 es una
      // lectura simple; se promedia siempre con el mismo criterio que
      // pedía el bloque, no queda como límite documentado sin cubrir.
      int pin = ins.val / 100;
      int nMuestras = ins.val % 100; if (nMuestras<1) nMuestras=1;
      long sum = 0;
      for (int i=0;i<nMuestras;i++) sum += analogRead(pin);
      int v = (int)(sum / nMuestras);
      if (pilaLen<PILA_MAX) pila[pilaLen++] = (int16_t)constrain(v, -32768, 32767);
      progPC++; break;
    }
    case OP_PUSH_SONAR: {
      // val = trig*100+echo (mismo empaquetado que ya usan OP_DOUT/OP_SERVO
      // para pin+parametro). Trae SUS PROPIOS pines, igual que ya hace el
      // bloque f_ultrasonic existente (TRIG/ECHO por dropdown) — no
      // depende de sonarTrig/sonarEcho (esos son del endpoint /sonar/read,
      // un estado global aparte). Reusa leerSonar(), ya validado en
      // detección de oponente Sumo, y funciona independiente de si hay
      // una estrategia Sumo corriendo (condición 6 del usuario).
      int trig = ins.val / 100, echo = ins.val % 100;
      int cm = leerSonar(trig, echo);
      if (pilaLen<PILA_MAX) pila[pilaLen++] = (int16_t)constrain(cm, -32768, 32767);
      progPC++; break;
    }
    case OP_POP_ADD: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(int16_t)constrain(a+b,-32768L,32767L); progPC++; break; }
    case OP_POP_SUB: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(int16_t)constrain(a-b,-32768L,32767L); progPC++; break; }
    // OP_POP_SUB_T — igual que OP_POP_SUB pero ENVUELVE el resultado en 16
    // bits ((int16_t)(uint16_t)x, igual criterio ya usado en
    // OP_MILLIS_READ más abajo) en vez de saturar con constrain(). Único
    // emisor: compileExpr() para "millis() - variable". Ver comentario
    // junto a #define OP_POP_SUB_T para la causa raíz completa.
    case OP_POP_SUB_T: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(int16_t)(uint16_t)(a-b); progPC++; break; }
    case OP_POP_MUL: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(int16_t)constrain(a*b,-32768L,32767L); progPC++; break; }
    case OP_POP_DIV: {
      long b=pilaPop(), a=pilaPop();
      long r = (b!=0) ? (a/b) : 0; // división entera; b==0 -> 0, documentado (no-op seguro, no crashea)
      if (pilaLen<PILA_MAX) pila[pilaLen++]=(int16_t)constrain(r,-32768L,32767L);
      progPC++; break;
    }
    case OP_VAR_SET_EXPR: { int idx=constrain((int)ins.val,0,3); varTabla[idx]=(float)pilaPop(); progPC++; break; }
    case OP_VAR_ADD_EXPR: { int idx=constrain((int)ins.val,0,3); varTabla[idx]+=(float)pilaPop(); progPC++; break; }
    case OP_VAR_SUB_EXPR: { int idx=constrain((int)ins.val,0,3); varTabla[idx]-=(float)pilaPop(); progPC++; break; }

    // Unidad 4 (Fase 2 P0) — condicionales y lógica genéricos. Ver
    // comentario junto a los #define (arriba) para las dos familias
    // (comparación directa+salto vs. comparación que empuja 0/1 + lógica
    // booleana + consumo final). Ninguno toca pila[]/varTabla fuera de lo
    // ya establecido por pilaPop()/push ya existentes.
    case OP_IF_GT_EXPR: { long b=pilaPop(), a=pilaPop(); progPC += (a>b) ? 2 : 1; break; }
    case OP_IF_LT_EXPR: { long b=pilaPop(), a=pilaPop(); progPC += (a<b) ? 2 : 1; break; }
    case OP_IF_EQ_EXPR: { long b=pilaPop(), a=pilaPop(); progPC += (a==b) ? 2 : 1; break; }
    case OP_IF_GE_EXPR: { long b=pilaPop(), a=pilaPop(); progPC += (a>=b) ? 2 : 1; break; }
    case OP_IF_LE_EXPR: { long b=pilaPop(), a=pilaPop(); progPC += (a<=b) ? 2 : 1; break; }
    case OP_IF_NE_EXPR: { long b=pilaPop(), a=pilaPop(); progPC += (a!=b) ? 2 : 1; break; }
    case OP_PUSH_CMP_GT: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a>b)?1:0; progPC++; break; }
    case OP_PUSH_CMP_LT: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a<b)?1:0; progPC++; break; }
    case OP_PUSH_CMP_EQ: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a==b)?1:0; progPC++; break; }
    case OP_PUSH_CMP_GE: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a>=b)?1:0; progPC++; break; }
    case OP_PUSH_CMP_LE: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a<=b)?1:0; progPC++; break; }
    case OP_PUSH_CMP_NE: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a!=b)?1:0; progPC++; break; }
    case OP_POP_AND: { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a!=0 && b!=0)?1:0; progPC++; break; }
    case OP_POP_OR:  { long b=pilaPop(), a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a!=0 || b!=0)?1:0; progPC++; break; }
    case OP_POP_NOT: { long a=pilaPop(); if(pilaLen<PILA_MAX) pila[pilaLen++]=(a==0)?1:0; progPC++; break; }
    case OP_IF_TRUE: { long a=pilaPop(); progPC += (a!=0) ? 2 : 1; break; }

    case OP_OLED_INIT:
      // Corrección: antes esto marcaba oledInicializado=true SIN
      // importar si display.begin() realmente tuvo éxito — si el
      // módulo no respondía en 0x3C (o el bus no estaba listo en ese
      // instante), el flag quedaba en true igual y todos los dibujos
      // siguientes se ejecutaban "en el aire", sin ningún error visible.
      // Ahora se respeta el resultado real y se reintenta 0x3D como
      // alternativa — mismo criterio que ya usa /oled/test del Panel
      // Industrial (Fase 4.3).
      //
      // CORRECCIÓN CONFIRMADA (auditoría comparativa contra ROBOARD
      // 6.0, bug ya documentado y resuelto ahí en su Sesión 8.12):
      // display.begin() inicializa el controlador SSD1306 pero NO fija
      // color ni tamaño de texto — eso es estado de Adafruit_GFX
      // (textcolor/textsize), no de la pantalla. Sin setTextColor()
      // explícito, display.print() puede dibujar en un color que no
      // contrasta contra el fondo (texto invisible), aunque no arroje
      // ningún error — exactamente el síntoma reportado ("Server
      // informa impresión exitosa, pantalla física en blanco"). Esta
      // línea faltaba en TODO el archivo para el objeto global
      // `display` (verificado por grep: nunca se llamaba). Los objetos
      // LOCALES de Panel Industrial (/oled/test) ya lo hacían, por eso
      // ese camino de código no tenía este bug específico.
      if (!oledInicializado) {
        bool ok = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
        if (!ok) ok = display.begin(SSD1306_SWITCHCAPVCC, 0x3D);
        oledInicializado = ok;
        if (ok) { display.setTextSize(1); display.setTextColor(SSD1306_WHITE); }
      }
      progPC++; break;
    case OP_OLED_CLEAR:
      if(oledInicializado) display.clearDisplay();
      oledCursorX=0; oledCursorY=0; progPC++; break;
    case OP_OLED_CURSOR: {
      int16_t y=pilaPop(), x=pilaPop();
      oledCursorX=x; oledCursorY=y;
      if(oledInicializado) display.setCursor(x,y);
      progPC++; break;
    }
    case OP_OLED_PRINT:
      // Fase 4.4: ahora sí imprime texto real. ins.val es el ÍNDICE a
      // tablaTxt[] (no el texto en sí — ver tabla arriba). El cursor ya
      // fue posicionado por el OP_OLED_CURSOR inmediatamente anterior
      // (el bloque f_oled_text de Blockly siempre genera CURSOR antes
      // que PRINT), así que alcanza con imprimir en la posición actual.
      if (oledInicializado && ins.val >= 0 && ins.val < TABLA_TXT_MAX) {
        display.print(tablaTxt[ins.val]);
      }
      progPC++; break;
    case OP_OLED_PRINT_VAR: {
      // Unidad 5 (Fase 2 P0): mismo supuesto que OP_OLED_PRINT (el cursor
      // ya fue posicionado por OLED_CURSOR, emitido justo antes por
      // f_oled_print_var) pero el valor es dinámico — viene de pila[]
      // (cualquier expresión: variable, ADC, sonar, operación), no de un
      // índice a tablaTxt[]. display.print() de Adafruit_GFX acepta
      // numéricos directamente (misma clase Print que Serial).
      int16_t v = pilaPop();
      if (oledInicializado) display.print(v);
      progPC++; break;
    }
    case OP_OLED_LINE: {
      int16_t y1=pilaPop(), x1=pilaPop(), y0=pilaPop(), x0=pilaPop();
      if(oledInicializado) display.drawLine(x0,y0,x1,y1,SSD1306_WHITE);
      progPC++; break;
    }
    case OP_OLED_RECT: {
      int16_t h=pilaPop(), w=pilaPop(), y=pilaPop(), x=pilaPop();
      if(oledInicializado) display.drawRect(x,y,w,h,SSD1306_WHITE);
      progPC++; break;
    }
    case OP_OLED_CIRCLE: {
      int16_t r=pilaPop(), cy=pilaPop(), cx=pilaPop();
      if(oledInicializado) display.drawCircle(cx,cy,r,SSD1306_WHITE);
      progPC++; break;
    }
    case OP_OLED_DISPLAY:
      if (oledInicializado) {
        // Instrumentación (Etapa de diagnóstico avanzado): la línea que
        // realmente toca OLED — display.display() — es EXACTAMENTE la
        // misma de siempre, sin ningún cambio. Todo lo demás acá es
        // medición/clasificación alrededor, no una modificación del
        // comportamiento funcional.
        oledDisplayCount++;
        unsigned long t0 = micros();
        display.display();
        unsigned long dur = micros() - t0;

        // Estadísticas acumuladas (min/max/avg/last) — primitivas, sin
        // struct nuevo.
        if (dur < oledDisplayMinUs) oledDisplayMinUs = dur;
        if (dur > oledDisplayMaxUs) oledDisplayMaxUs = dur;
        oledDisplaySumUs += dur;
        oledDisplayLastUs = dur;

        // Clasificación NORMAL/WARNING/CRITICAL — umbrales internos de
        // diagnóstico de FRANKY (ver #define arriba), no valores
        // oficiales de ningún fabricante.
        if (dur >= OLED_DISPLAY_CRITICAL_US) {
          flog('E', "OLED_DISPLAY #" + String(oledDisplayCount) + " DUR=" + String(dur/1000.0,1) + "ms CRITICAL");
          if (!huboAnomaliaOled) {
            huboAnomaliaOled = true;
            firstAnomalySeq = monitorSeq; firstAnomalyMs = millis(); firstAnomalyDurUs = dur;
          }
          // DETECTAR ya ocurrió (arriba). REGISTRAR ya ocurrió (flog
          // recién). Ahora DIAGNOSTICAR/INTENTAR RECUPERAR/VERIFICAR —
          // ver intentarRecuperacionI2C(). Deliberadamente NO reinicia
          // el ESP32 en esta etapa (ver informe de entrega, sección I).
          flog('E', "I2C_ANOMALY reason=OLED_DISPLAY_SLOW duration_ms=" + String(dur/1000.0,1));
          // Lectura de mejor esfuerzo del estado físico de las líneas —
          // NO garantizado 100% confiable mientras Wire tiene el
          // periférico I2C activo sobre estos mismos GPIO (el propio
          // ESP32 puede seguir permitiendo digitalRead() de entrada
          // aunque el pin esté muxeado a un periférico, pero esto no
          // está verificado contra el datasheet — se marca como tal en
          // el propio log, no se presenta como una medición certera).
          flog('W', String("SDA=") + (digitalRead(i2cSda)?"HIGH":"LOW") +
                     " SCL=" + (digitalRead(i2cScl)?"HIGH":"LOW") +
                     " (lectura best-effort, no verificado contra datasheet)");
          bool recuperado = intentarRecuperacionI2C();
          flog(recuperado?'I':'E', String("SYSTEM_RECOVERY status=") + (recuperado?"CONTINUE":"DEGRADED_NO_REBOOT"));
        } else if (dur >= OLED_DISPLAY_WARNING_US) {
          flog('W', "OLED_DISPLAY #" + String(oledDisplayCount) + " DUR=" + String(dur/1000.0,1) + "ms WARNING");
        } else {
          lastOkSeq = monitorSeq; lastOkMs = millis(); lastOkDurUs = dur;
          if (flogThrottle("gen1", 2000)) {
            flog('I', "OLED_DISPLAY #" + String(oledDisplayCount) + " DUR=" + String(dur/1000.0,1) + "ms OK");
          }
        }
      }
      progPC++; break;
    case OP_OLED_SPRITE: {
      // x,y llegan por la pila (mismo mecanismo que OP_OLED_LINE/RECT/
      // CIRCLE), ins.val es el índice a tablaBitmap[]. CORREGIDO: antes
      // usaba display.drawBitmap() a escala 1:1 (bug confirmado por
      // auditoría comparativa con ROBOARD — ver dibujarSpriteEscalado()
      // más arriba). Mismo formato de datos, mismas coordenadas x/y —
      // solo cambia CÓMO se dibuja, no qué se guarda ni cómo se edita.
      int16_t y = pilaPop(), x = pilaPop();
      if (oledInicializado && ins.val >= 0 && ins.val < TABLA_BITMAP_MAX) {
        dibujarSpriteEscalado(x, y, tablaBitmap[ins.val]);
      }
      progPC++; break;
    }
    case OP_SERIAL_PRINT:
      // Fase 4.4: ídem OP_OLED_PRINT — ins.val es el índice a tablaTxt[].
      if (ins.val >= 0 && ins.val < TABLA_TXT_MAX) {
        Serial.println(tablaTxt[ins.val]); // sin cambios — sigue existiendo la salida Serial física
        // Etapa de diagnóstico: además, ahora también visible en
        // Monitor/LOG — throttled (categoría "gen2") para no inundar si
        // el programa imprime en un loop rápido.
        if (flogThrottle("gen2", 500)) flog('I', String("SERIAL_PRINT: ") + tablaTxt[ins.val]);
      }
      progPC++; break;
    case OP_SERIAL_PRINT_VAR: {
      // Unidad 5 (Fase 2 P0): ídem OP_SERIAL_PRINT pero con un valor
      // dinámico de pila[] (variable/ADC/sonar/operación) en vez de un
      // índice a tablaTxt[]. Serial.println() acepta numéricos
      // directamente. Mismo throttle de Monitor/LOG que el texto fijo.
      int16_t v = pilaPop();
      Serial.println(v);
      if (flogThrottle("gen2", 500)) flog('I', String("SERIAL_PRINT_VAR: ") + String(v));
      progPC++; break;
    }
    case OP_BUZZER:
      // Sin pin de buzzer en esta placa (confirmado contra el BOM real)
      // — no-op documentado, no bloquea el resto del programa.
      pilaPop(); pilaPop(); // descarta freq/duracion igual que los consumiría un buzzer real
      progPC++; break;
    // OP_FIN (0): fin del programa compilado. Antes volvía SIEMPRE a
    // progPC=0, reiniciando el programa entero en cada vuelta — no había
    // forma de distinguir "una sola vez al principio" (setup) de "se
    // repite" (loop). Corrección (separación Al iniciar/Repetir
    // continuamente): el compilador (bloques.html, wsToInstructions(),
    // que corre en el navegador — este .ino solo INTERPRETA lo que ya
    // llega compilado) ahora manda en programa[i].val el índice absoluto
    // al que hay que volver — 0 si el programa no usa los bloques nuevos
    // (idéntico al comportamiento de siempre, compatibilidad hacia
    // atrás con programas Blockly anteriores a esta corrección), o el
    // índice justo después de "Al iniciar" cuando sí los usa, para que
    // esa parte no se repita. repeatCnt se sigue reseteando igual que
    // antes: una "vuelta" nueva del ciclo principal no debe arrastrar un
    // conteo de "Repetir N veces" a medio terminar de la vuelta previa.
    case OP_FIN: stopMotors(); progPC=ins.val; repeatCnt=0; break;
    default: stopMotors(); progPC=0; repeatCnt=0; break; // opcode desconocido/corrupto — fallback de seguridad sin cambios
  }
}

void guardarProg() {
  prefs.begin("bloques",false);
  prefs.putUInt("len",progLen);
  for(int i=0;i<progLen;i++){
    prefs.putUChar(("o"+String(i)).c_str(),programa[i].op);
    prefs.putShort(("v"+String(i)).c_str(),programa[i].val);
  }
  // Fase 4.4: persistir también las tablas de texto/sprite del programa
  // actual — de lo contrario, un reinicio del robot perdería los
  // mensajes/dibujos aunque el programa (opcodes) sí sobreviviera.
  prefs.putUChar("tlen", tablaTxtLen);
  prefs.putBytes("ttxt", tablaTxt, sizeof(tablaTxt));
  prefs.putUChar("blen", tablaBitmapLen);
  prefs.putBytes("tbmp", tablaBitmap, sizeof(tablaBitmap));
  prefs.end();
}

void cargarProg() {
  prefs.begin("bloques",true);
  progLen=(uint8_t)min((unsigned int)prefs.getUInt("len",0),(unsigned int)MAX_INST);
  for(int i=0;i<progLen;i++){
    programa[i].op =prefs.getUChar(("o"+String(i)).c_str(),OP_FIN);
    programa[i].val=prefs.getShort(("v"+String(i)).c_str(),0);
  }
  // Fase 4.4: cargar tablas — si el firmware anterior a esta fase nunca
  // escribió estas keys (primer arranque tras la actualización),
  // getBytes() devuelve 0 y se deja todo en blanco explícitamente, en
  // vez de dejar lo que haya en la RAM sin inicializar.
  tablaTxtLen = (uint8_t) min((unsigned int)prefs.getUChar("tlen",0), (unsigned int)TABLA_TXT_MAX);
  if (prefs.getBytes("ttxt", tablaTxt, sizeof(tablaTxt)) != sizeof(tablaTxt)) {
    memset(tablaTxt, 0, sizeof(tablaTxt));
  }
  tablaBitmapLen = (uint8_t) min((unsigned int)prefs.getUChar("blen",0), (unsigned int)TABLA_BITMAP_MAX);
  if (prefs.getBytes("tbmp", tablaBitmap, sizeof(tablaBitmap)) != sizeof(tablaBitmap)) {
    memset(tablaBitmap, 0, sizeof(tablaBitmap));
  }
  prefs.end();
}

// ═══════════════════════════════════════════════════════
//  SUMO/LABERINTO — Máquina de estados de evasión (NO BLOQUEANTE)
//  Reemplaza los delay() que bloqueaban server.handleClient()
//
//  Fase 4.2: se agrega el estado EVADE_BRAKE al final de la maniobra.
//  Antes, EVADE_TURN terminaba en stopMotors() (motor en punto muerto,
//  coast) — el robot quedaba con inercia residual justo en el instante
//  de decidir la siguiente maniobra. Ahora termina en un freno activo
//  breve (brakeMotors(), ambos canales LEDC a 255) antes de soltar. No
//  hay selector de "tipo de freno" en la UI — es un comportamiento fijo
//  del sistema, tal como se definió en la especificación funcional.
// ═══════════════════════════════════════════════════════
#define EVADE_FRENO_MS 40 // ESTIMACIÓN de partida, no un valor medido — ver plan de prueba física del changelog

void iniciarEvasion(bool borderLeft, bool borderRight) {
  evadeState = EVADE_BACK;
  evadeTimer = millis();
  evadeBoth = (borderLeft && borderRight);
  evadeDirRight = borderLeft; // si borde izq → girar derecha (alejarse)
  // Evento real (no un valor continuo) — se loguea siempre, sin
  // throttling, porque solo ocurre una vez por maniobra de evasión.
  flog('I', String("BORDE ") + (evadeBoth?"AMBOS":(borderLeft?"IZQUIERDO":"DERECHO")));
  flog('I', "Estado = ESCAPE");
}

// Retorna true mientras la maniobra de evasión está en curso
bool tickEvasion(uint8_t spdEv) {
  if (evadeState == EVADE_IDLE) return false;
  unsigned long ahora = millis();
  switch (evadeState) {
    case EVADE_BACK:
      move("b", spdEv);
      if (ahora - evadeTimer >= 150) {
        evadeTimer = ahora;
        evadeState = EVADE_TURN;
      }
      return true;
    case EVADE_TURN:
      if (evadeBoth) move(evadeDirRight ? "r" : "l", 180);
      else           move(evadeDirRight ? "r" : "l", 180);
      if (ahora - evadeTimer >= (evadeBoth ? 440 : 220)) {
        evadeTimer = ahora;
        brakeMotors();          // Fase 4.2: freno activo, reemplaza el stopMotors() que había acá
        evadeState = EVADE_BRAKE;
      }
      return true;
    case EVADE_BRAKE:
      // brakeMotors() ya escribió el patrón de frenado en el tick
      // anterior — no hace falta repetirlo en cada vuelta de loop(),
      // los canales LEDC mantienen su valor hasta la próxima escritura.
      if (ahora - evadeTimer >= EVADE_FRENO_MS) {
        stopMotors();
        evadeState = EVADE_IDLE;
      }
      return true;
    default:
      evadeState = EVADE_IDLE;
      return false;
  }
}

// ═══════════════════════════════════════════════════════
//  SUMO — abstracción pedagógica de búsqueda (fase "Cierre Sumo")
//
//  El alumno configura "Velocidad de búsqueda" (velBusqueda) e
//  "Intensidad del giro" (intGiro) — NO las velocidades de rueda
//  externa/interna directamente. Estas dos funciones son la ÚNICA
//  traducción entre esa abstracción y el par de ruedas real que ya
//  usaban searchCircle()/searchSweep() desde la fase "Persistencia
//  Sumo" (misma idea de "rueda externa rápida / interna lenta" — el
//  mecanismo físico no cambia, solo con qué nombres se lo configura):
//    velExterna = velBusqueda + intGiro/2
//    velInterna = velBusqueda - intGiro/2
//  Recortado a [0,255] — el único límite que importa es el que impone
//  el hardware (PWM de 8 bits). "intGiro" es un control DIFERENCIAL
//  RELATIVO: no representa un ángulo ni un radio exactos (dependen de
//  motores, batería, superficie, adherencia y peso del robot — sección
//  3 del pedido), pero SÍ garantiza una propiedad concreta y verificable
//  en código: velInterna nunca baja de 0 (la rueda interna nunca gira
//  en reversa durante la búsqueda) — esto evita estructuralmente que un
//  "intensidad de giro" muy alto reproduzca el pivote-en-el-lugar que
//  tenía el cabeceo antes de la fase "Botón+Cabeceo", sin inventar una
//  garantía geométrica que el hardware no puede dar (sección 6).
// ═══════════════════════════════════════════════════════
uint8_t velExterna(const SumoConfig& cfg) {
  int v = (int)cfg.velBusqueda + (int)(cfg.intGiro / 2);
  if (v > 255) v = 255;
  if (v < 0) v = 0;
  return (uint8_t)v;
}
uint8_t velInterna(const SumoConfig& cfg) {
  int v = (int)cfg.velBusqueda - (int)(cfg.intGiro / 2);
  if (v < 0) v = 0;
  if (v > 255) v = 255;
  return (uint8_t)v;
}

// ═══════════════════════════════════════════════════════
//  SUMO — Estrategias de búsqueda
// ═══════════════════════════════════════════════════════
void searchCircle(const SumoConfig& cfg) {
  moveDiff(velInterna(cfg), velExterna(cfg));
}

// searchSweep() — "Cabeceo", revisado en la fase "Sumo: sincronización
// del botón físico + mejora de estrategia de cabeceo".
//
// AUDITORÍA DEL COMPORTAMIENTO ANTERIOR (antes de tocar nada, como pediste):
// la versión previa hacía moveDiff(+spdBuscExt, -spdBuscExt) — es decir,
// las dos ruedas a velocidad MÁXIMA configurada y en sentidos OPUESTOS: un
// pivote puro sobre el propio eje, no un barrido. Cada CABECEO_MS (300ms)
// invertía las dos ruedas de golpe (de +spdBuscExt/-spdBuscExt a
// -spdBuscExt/+spdBuscExt), un cambio de sentido brusco en ambos motores a
// la vez. Confirmado por lectura: NO es un "cabeceo" en el sentido de un
// barrido angular acotado — es un giro alternado sobre el lugar a máxima
// velocidad, tal como sospechaba el pedido (sección 10).
//
// DISEÑO NUEVO: se reemplaza el pivote por una CURVA — misma idea que ya
// usa searchCircle() para el círculo (una rueda "externa" rápida, la otra
// "interna" lenta, moveDiff(spdBuscExt, spdBuscInt)), pero alternando
// PERIÓDICAMENTE cuál rueda es la externa. Las dos ruedas giran SIEMPRE
// hacia adelante (nunca en reversa) — el robot traza una curva hacia un
// lado durante CABECEO_MS, después una curva hacia el otro lado, en vez de
// girar en el lugar. Ventajas directas sobre el pivote anterior, con la
// MISMA reutilización de parámetros que ya pedías (spdBuscExt/spdBuscInt/
// CABECEO_MS, sin agregar ningún parámetro nuevo):
//   - Radio de giro acotado por la diferencia (spdBuscExt-spdBuscInt), no
//     por spdBuscExt solo — a los valores de fábrica (210/80 en Mini) la
//     tasa de rotación efectiva es notoriamente menor que la del pivote
//     anterior (que giraba a la velocidad plena de spdBuscExt en ambas
//     ruedas), así que el barrido de cada pierna cubre un arco más chico
//     y controlado en el mismo tiempo.
//   - En la transición entre piernas ninguna rueda invierte de sentido
//     (las dos siguen "adelante", solo cambia CUÁL es la rápida) — mucho
//     menos brusco mecánicamente que el pivote anterior, que revertía
//     ambos motores de golpe.
//   - Sigue sin usar delay() — máquina de estados basada en millis(),
//     igual que antes, el servidor sigue respondiendo durante Sumo.
// La prioridad de borde NO se tocó: ejecutarSumo() sigue llamando a
// leerBordes() ANTES de invocar cualquier estrategia de búsqueda, en cada
// tick de 50ms, sin importar en qué pierna del barrido esté esta función.
//
// FASE "CIERRE SUMO" — dos cambios sobre lo anterior, ninguno toca la
// mecánica del barrido en sí (sigue siendo la misma curva alternada):
//   1) spdBuscExt/spdBuscInt -> velExterna(cfg)/velInterna(cfg), la
//      misma traducción que ahora usa searchCircle() (ver más arriba).
//   2) CABECEO_MS (constante global, no configurable) -> cfg.durBarrido
//      ("Duración del barrido", persistida por perfil, configurable
//      desde sumo.html — sección 3/16 del pedido). CABECEO_MS se
//      conserva como el valor de FÁBRICA de durBarrido (ver
//      cfgMini/cfgMicro) y como resguardo defensivo si durBarrido
//      llegara en 0 por cualquier motivo.
void searchSweep(const SumoConfig& cfg) {
  unsigned long ahora = millis();
  uint16_t duracion = (cfg.durBarrido > 0) ? cfg.durBarrido : CABECEO_MS;
  if (ahora - tCabeceo >= duracion) { tCabeceo = ahora; cabeceoDirDer = !cabeceoDirDer; }
  if (cabeceoDirDer) moveDiff((int)velExterna(cfg), (int)velInterna(cfg)); // curva hacia un lado
  else               moveDiff((int)velInterna(cfg), (int)velExterna(cfg)); // curva hacia el otro lado
}

// ═══════════════════════════════════════════════════════
//  SUMO — Lectura de oponente (unificada)
//  Rellena oI y oD según tipo de sensor configurado
// ═══════════════════════════════════════════════════════
void leerOponente(const SumoConfig& cfg, bool& oI, bool& oD) {
  oI = false; oD = false;
  switch (cfg.tipoDistSensor) {
    case 0: { // sonar
      bool detI = (leerSonar(cfg.trigI, cfg.echoI) < cfg.umbralDistCm);
      if (cfg.numDistSensores >= 2) {
        oI = detI;
        oD = (leerSonar(cfg.trigD, cfg.echoD) < cfg.umbralDistCm);
      } else {
        oI = detI; oD = detI;
      }
      break;
    }
    case 1: { // óptico digital
      bool detI = false, detD = false;
      pinMode(cfg.optPinI, INPUT_PULLUP);
      detI = (digitalRead(cfg.optPinI) == LOW);
      if (cfg.numDistSensores >= 2) {
        pinMode(cfg.optPinD, INPUT_PULLUP);
        detD = (digitalRead(cfg.optPinD) == LOW);
        oI = detI; oD = detD;
      } else {
        oI = detI; oD = detI;
      }
      break;
    }
    case 2: { // Sharp — detección DIGITAL por umbral
      bool detI = sharpDetectado(cfg.sharpPinI, cfg.umbralSharp);
      if (cfg.numDistSensores >= 2) {
        bool detD = sharpDetectado(cfg.sharpPinD, cfg.umbralSharp);
        oI = detI; oD = detD;
      } else {
        oI = detI; oD = detI;
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════
//  SUMO — Lectura de bordes
// ═══════════════════════════════════════════════════════
void leerBordes(const SumoConfig& cfg, bool& bI, bool& bD) {
  bI = false; bD = false;
  if (cfg.numBorde >= 1) bI = readBorder(cfg.bordePinI, cfg.umbralBorde);
  if (cfg.numBorde >= 2) bD = readBorder(cfg.bordePinD, cfg.umbralBorde);
}

// ═══════════════════════════════════════════════════════
//  SUMO — Núcleo de combate unificado (micro y mini)
//
//  FASE "CIERRE SUMO" — orden de decisión SIN CAMBIOS respecto a todas
//  las fases anteriores (sección 20 del pedido: evasión > borde >
//  oponente/ataque > búsqueda). Lo nuevo son tres cosas, todas dentro
//  de la rama de "sin borde, sin ataque inmediato": (1) actualizar la
//  memoria de última dirección del oponente, (2) detectar el instante
//  en que se lo pierde y arrancar una recuperación acotada hacia ese
//  lado, y (3) loguear al Monitor Serial qué decidió el robot. Ninguna
//  de las tres puede interrumpir ni retrasar evasión/borde/ataque —
//  todas están DESPUÉS de esos returns tempranos, igual que la
//  búsqueda normal ya estaba.
// ═══════════════════════════════════════════════════════
void ejecutarSumo(const SumoConfig& cfg) {
  if (!retardoOK) {
    if (millis() - tInicioModo < RETARDO_SUMO) {
      digitalWrite(PIN_LED, (millis()/250)%2==0 ? LOW : HIGH);
      return;
    }
    retardoOK = true;
    evadeState = EVADE_IDLE;
    digitalWrite(PIN_LED, HIGH);
    // flog() en vez de Serial.println() directo — mismo texto de
    // siempre, pero ahora también visible en el Monitor Serial del
    // Server (antes solo llegaba al USB), completando la secuencia
    // Inicio/Cuenta regresiva/Autónomo pedida (sección 15): "Inicio" y
    // "Cuenta regresiva" ya se loguean en el punto de arranque (ver
    // handleSumoMicro()/handleSumoMini()/iniciarSumoDesdeBoton()).
    flog('I', cfg.perfil == 0 ? "Autonomo (MINISUMO)" : "Autonomo (MICROSUMO)");
  }

  // Si hay evasión en curso, ejecutarla y salir — prioridad absoluta,
  // sin cambios.
  if (tickEvasion(cfg.spdEvasion)) { logEstadoSumo(ESL_EVADIENDO); return; }

  // Leer bordes — SIEMPRE antes que oponente/búsqueda, sin cambios.
  bool bI = false, bD = false;
  leerBordes(cfg, bI, bD);
  if (bI || bD) {
    enRecuperacion = false; // el borde corta cualquier recuperación en curso, sin excepción
    iniciarEvasion(bI, bD);
    logEstadoSumo(ESL_EVADIENDO);
    return;
  }

  // Leer oponente
  bool oI = false, oD = false;
  leerOponente(cfg, oI, oD);
  bool oponentePresente = oI || oD;

  // ── Diagnóstico detallado (sección 14 del pedido: "niveles de
  // diagnóstico" — reutiliza el interruptor DEBUG que ya existía en el
  // Monitor Serial, sin agregar una interfaz nueva). Con DEBUG apagado
  // (default) solo se ven los eventos/decisiones de arriba/abajo — con
  // DEBUG encendido, además se ve un snapshot de sensores y de estado a
  // ritmo controlado (categorías "sumo_sensor"/"sumo_estado", ya
  // reservadas en monitorCats desde que existe el Monitor Serial).
  if (debugEnabled && flogThrottle("sumo_sensor", 500)) {
    flog('D', "Sensores: borde I=" + String(bI?1:0) + " D=" + String(bD?1:0) +
               " oponente I=" + String(oI?1:0) + " D=" + String(oD?1:0));
  }
  if (debugEnabled && flogThrottle("sumo_estado", 2000)) {
    flog('D', "Estado=" + String(estadoSumoLogTexto(estadoSumoLogActual)) +
               " ultimaDireccion=" + direccionTexto(ultimaDirOponente));
  }

  // ── Memoria de última dirección — SOLO con 2 sensores independientes
  // (sección 8 del pedido: nunca inventar IZQUIERDA/DERECHA con un solo
  // sensor). Con 1 sensor, leerOponente() ya deja oI==oD siempre — este
  // bloque no se ejecuta nunca en ese caso y ultimaDirOponente queda
  // congelada en DIR_DESCONOCIDA, que es la respuesta honesta. Tabla de
  // verdad exacta pedida en la sección 7: IZQ=1/DER=0->IZQUIERDA,
  // IZQ=0/DER=1->DERECHA, IZQ=1/DER=1->CENTRO. Si no hay oponente este
  // tick (oI==oD==false) NO se toca — es memoria, no lectura instantánea.
  if (cfg.numDistSensores >= 2 && oponentePresente) {
    DireccionOponente nueva = (oI && oD) ? DIR_CENTRO : (oI ? DIR_IZQUIERDA : DIR_DERECHA);
    if (nueva != ultimaDirOponente) {
      ultimaDirOponente = nueva;
      flog('I', String("OPONENTE -> ") + direccionTexto(nueva));
    }
  }

  // ── Transición "oponente perdido" — el evento de log vale para 1 o 2
  // sensores por igual ("ya no se detecta" es verdad con cualquier
  // sensor); el SESGO de recuperación hacia un lado solo se activa si
  // hay de verdad una última dirección lateral confiable (nunca con
  // DIR_DESCONOCIDA ni DIR_CENTRO — sección 9: recuperación orientada
  // SOLO cuando existe IZQUIERDA/DERECHA válida).
  if (oponentePresenteAnt && !oponentePresente) {
    flog('I', "Oponente perdido");
    if (ultimaDirOponente == DIR_IZQUIERDA || ultimaDirOponente == DIR_DERECHA) {
      flog('I', String("Ultima direccion conocida: ") + direccionTexto(ultimaDirOponente));
      enRecuperacion = true;
      tRecuperacion = millis();
      recuperacionHaciaIzquierda = (ultimaDirOponente == DIR_IZQUIERDA);
      flog('I', String("RECUPERACION -> ULTIMA DIRECCION: ") + direccionTexto(ultimaDirOponente));
    }
  }
  oponentePresenteAnt = oponentePresente;

  // Ataque — corta cualquier recuperación en curso (el oponente volvió
  // a aparecer, ya no hace falta "adivinar" dónde está).
  if (oI || oD) {
    enRecuperacion = false;
    logEstadoSumo(ESL_ATACANDO);
    int8_t dirAtaque = (oI && oD) ? 0 : (oI ? 1 : 2); // 0=ambos,1=izq,2=der
    if (dirAtaque != ultimoAtaqueDirLog) {
      ultimoAtaqueDirLog = dirAtaque;
      flog('I', String("ATAQUE -> ") + (dirAtaque==0?"AMBOS":(dirAtaque==1?"IZQUIERDA":"DERECHA")));
    }
    if (oI && oD)       moveDiff(cfg.spdAtaque, cfg.spdAtaque);
    else if (oI && !oD) moveDiff(-(int)cfg.spdAtaque, (int)cfg.spdAtaque); // girar izq
    else                 moveDiff((int)cfg.spdAtaque, -(int)cfg.spdAtaque); // girar der
    return;
  }
  ultimoAtaqueDirLog = -1; // no hay ataque este tick — el próximo ataque siempre se anuncia de nuevo

  // Búsqueda — recuperación acotada primero (si está activa), después
  // la estrategia normal (CÍRCULO o BARRIDO), sin cambios en cuál de
  // las dos usa cada perfil/estrategia.
  if (enRecuperacion) {
    if (millis() - tRecuperacion >= RECUPERACION_MS) {
      enRecuperacion = false;
    } else {
      logEstadoSumo(ESL_RECUPERANDO);
      if (recuperacionHaciaIzquierda) moveDiff(velInterna(cfg), velExterna(cfg));
      else                             moveDiff(velExterna(cfg), velInterna(cfg));
      return;
    }
  }

  logEstadoSumo(ESL_BUSCANDO);
  if (cfg.perfil == 1 || cfg.estrategia == 0) searchCircle(cfg);
  else                                         searchSweep(cfg);
}

// Wrappers para compatibilidad con MODE_MICRO / MODE_MINI
void ejecutarMicro() { ejecutarSumo(cfgMicro); }
void ejecutarMini()  { ejecutarSumo(cfgMini);  }

// ═══════════════════════════════════════════════════════
//  AUTOMATIZACIONES (sin cambios)
// ═══════════════════════════════════════════════════════
void loopVivero() {
  if (millis()-tSensor>3000) {
    tSensor=millis();
    float t=dht.readTemperature(), h=dht.readHumidity();
    if (!isnan(t)&&!isnan(h)) { sensorTemp=t; sensorHum=h; dhtOK=true; }
    else {
      sensorTemp=20.0+(analogRead(PIN_ADC0)/4095.0)*15.0;
      sensorHum =40.0+(analogRead(PIN_ADC0)/4095.0)*40.0; dhtOK=false;
    }
    digitalWrite(PIN_LED, sensorHum<50.0?LOW:HIGH);
  }
}
void loopMeteo() {
  if (millis()-tSensor>2000) {
    tSensor=millis();
    float t=dht.readTemperature(), h=dht.readHumidity();
    if (!isnan(t)&&!isnan(h)) { sensorTemp=t; sensorHum=h; dhtOK=true; }
    else {
      float r=analogRead(PIN_ADC0)/4095.0;
      sensorTemp=15.0+r*25.0; sensorHum=30.0+r*60.0; dhtOK=false;
    }
  }
}
void loopAlarma()  { if (!alarmaActiva&&analogRead(PIN_ADC0)>2000){alarmaActiva=true;digitalWrite(PIN_LED,LOW);} }
void loopAcceso()  { if (!accesoAbierto&&digitalRead(PIN_BTN)==LOW) accesoAbierto=true; }

// ═══════════════════════════════════════════════════════
//  API REST — /api extendida con telemetría SUMO unificada
// ═══════════════════════════════════════════════════════
void handleAPI() {
  int a0 = analogRead(PIN_ADC0);
  int a1 = spiEnabled ? 0 : analogRead(PIN_ADC1);
  bool btn = digitalRead(PIN_BTN);

  // Calcular ADC en uso por la config activa
  int adcUsed = contarADCUsados(*cfgActiva);

  // Actualizar telemetría Sharp si corresponde
  if (cfgActiva->tipoDistSensor == 2) {
    sharpAdcValI = (cfgActiva->sharpPinI == 0) ? a0 : a1;
    sharpDetI    = (sharpAdcValI > cfgActiva->umbralSharp);
    if (cfgActiva->numDistSensores >= 2) {
      sharpAdcValD = (cfgActiva->sharpPinD == 0) ? a0 : a1;
      sharpDetD    = (sharpAdcValD > cfgActiva->umbralSharp);
    }
  }

  String j = "{";
  // ADC raw
  j += "\"a0\":";       j += a0;               j += ",";
  j += "\"a1\":";       j += a1;               j += ",";
  j += "\"btn\":";      j += (btn?1:0);         j += ",";
  // Telemetría general
  j += "\"temp\":";     j += String(sensorTemp,2); j += ",";
  j += "\"hum\":";      j += String(sensorHum,2);  j += ",";
  j += "\"mode\":";     j += (int)currentMode;  j += ",";
  j += "\"running\":";  j += (modeRunning?1:0); j += ",";
  j += "\"proglen\":";  j += progLen;           j += ",";
  j += "\"i2c\":";      j += (i2cEnabled?1:0);  j += ",";
  j += "\"spi\":";      j += (spiEnabled?1:0);  j += ",";
  j += "\"dht\":";      j += (dhtOK?1:0);       j += ",";
  // Motor
  j += "\"pwmA\":";     j += pwmA;              j += ",";
  j += "\"pwmB\":";     j += pwmB;              j += ",";
  j += "\"trimA\":";    j += trimA;             j += ",";
  j += "\"trimB\":";    j += trimB;             j += ",";
  j += "\"motorSpeed\":"; j += motorSpeed;      j += ",";
  // ADC disponibilidad
  j += "\"adc_used\":"; j += adcUsed;           j += ",";
  j += "\"adc_avail\":";  j += (2 - adcUsed);  j += ",";
  // Sharp telemetría
  j += "\"sharp_adc_i\":"; j += sharpAdcValI;  j += ",";
  j += "\"sharp_adc_d\":"; j += sharpAdcValD;  j += ",";
  j += "\"sharp_det_i\":"; j += (sharpDetI?1:0); j += ",";
  j += "\"sharp_det_d\":"; j += (sharpDetD?1:0); j += ",";
  // Config activa (snapshot para UI)
  j += "\"s_perfil\":";   j += cfgActiva->perfil;          j += ",";
  j += "\"s_tipo\":";     j += cfgActiva->tipoDistSensor;  j += ",";
  j += "\"s_nds\":";      j += cfgActiva->numDistSensores; j += ",";
  j += "\"s_nb\":";       j += cfgActiva->numBorde;        j += ",";
  j += "\"s_udist\":";    j += cfgActiva->umbralDistCm;    j += ",";
  j += "\"s_usharp\":";   j += cfgActiva->umbralSharp;     j += ",";
  j += "\"s_uborde\":";   j += cfgActiva->umbralBorde;     j += ",";
  j += "\"s_atk\":";      j += cfgActiva->spdAtaque;       j += ",";
  // FASE "CIERRE SUMO" — s_bex/s_bin (rueda externa/interna) quedan
  // reemplazados por s_vel/s_int (abstracción pedagógica) + s_bex/
  // s_bin RECONSTRUIDOS (no leídos del struct, que ya no los tiene) por
  // si alguna página vieja en caché todavía los espera.
  j += "\"s_vel\":";      j += cfgActiva->velBusqueda;     j += ",";
  j += "\"s_int\":";      j += cfgActiva->intGiro;         j += ",";
  j += "\"s_dur\":";      j += cfgActiva->durBarrido;      j += ",";
  j += "\"s_bex\":";      j += velExterna(*cfgActiva);     j += ",";
  j += "\"s_bin\":";      j += velInterna(*cfgActiva);     j += ",";
  j += "\"s_ev\":";       j += cfgActiva->spdEvasion;      j += ",";
  j += "\"s_est\":";      j += cfgActiva->estrategia;      j += ",";
  // Memoria de última dirección del oponente (sección 12 del pedido —
  // "debe poder observarse explícitamente"). 0=DESCONOCIDA,1=IZQUIERDA,
  // 2=DERECHA,3=CENTRO — mismos valores que el enum DireccionOponente.
  j += "\"s_dir\":";      j += (int)ultimaDirOponente;     j += ",";
  j += "\"s_dirTxt\":\""; j += direccionTexto(ultimaDirOponente); j += "\"";
  j += "}";

  server.sendHeader("Access-Control-Allow-Origin","*");
  server.send(200,"application/json",j);
}

// ═══════════════════════════════════════════════════════
//  HANDLERS SUMO
// ═══════════════════════════════════════════════════════
void sendJsonError(int code, const char* msg) {
  server.send(code, "application/json",
    String("{\"ok\":false,\"error\":\"") + msg + "\"}");
}

void handleSumoConfig() {
  // Determinar perfil objetivo desde arg "modo" (mini/micro) o "perfil" (0/1)
  SumoConfig* cfg = &cfgMini; // default mini
  if (server.hasArg("modo")) {
    cfg = (server.arg("modo") == "micro") ? &cfgMicro : &cfgMini;
  } else if (server.hasArg("perfil")) {
    cfg = (server.arg("perfil").toInt() == 1) ? &cfgMicro : &cfgMini;
  }

  // FASE "CIERRE SUMO" — sección 15 del pedido ("[CONFIG] Velocidad de
  // búsqueda -> 150" cuando un alumno cambia un parámetro). Snapshot de
  // los campos pedagógicos ANTES de aplicar ningún cambio, para poder
  // loguear solo los que realmente cambiaron — no se loguea nada acá
  // todavía, solo se guarda el valor "antes" para comparar más abajo,
  // justo antes de saveSumoConfig().
  uint8_t antVel = cfg->velBusqueda, antInt = cfg->intGiro, antAtk = cfg->spdAtaque,
          antEv  = cfg->spdEvasion,  antEst = cfg->estrategia;
  uint16_t antDur = cfg->durBarrido;

  // Modo de inicio de Sumo (servidor/boton) — Fase "Persistencia Sumo".
  // Es una configuración GLOBAL (no por perfil), pero se acepta acá
  // como argumentos opcionales para que "Guardar Configuración" en
  // sumo.html sea una única acción atómica (perfil + modo de inicio en
  // el mismo POST) — no se crea un endpoint aparte para esto. Si no
  // vienen, no se tocan (permite seguir llamando a /sumo/config solo
  // para campos de sensores, como ya hacía iniciarSumo() antes de esta
  // fase).
  if (server.hasArg("inicioServidor")) sumoInicioServidor = (server.arg("inicioServidor").toInt() != 0);
  if (server.hasArg("inicioBoton"))    sumoInicioBoton    = (server.arg("inicioBoton").toInt() != 0);

  // Parsear tipo de sensor de distancia
  if (server.hasArg("tipo")) {
    String t = server.arg("tipo");
    if (t=="sonar")       cfg->tipoDistSensor = 0;
    else if (t=="optico") cfg->tipoDistSensor = 1;
    else if (t=="sharp")  cfg->tipoDistSensor = 2;
  }
  if (server.hasArg("numDist"))  cfg->numDistSensores = constrain(server.arg("numDist").toInt(), 1, 2);

  // Sonar
  if (server.hasArg("trigI"))   cfg->trigI = server.arg("trigI").toInt();
  if (server.hasArg("echoI"))   cfg->echoI = server.arg("echoI").toInt();
  if (server.hasArg("trigD"))   cfg->trigD = server.arg("trigD").toInt();
  if (server.hasArg("echoD"))   cfg->echoD = server.arg("echoD").toInt();

  // Óptico
  if (server.hasArg("optI"))    cfg->optPinI = server.arg("optI").toInt();
  if (server.hasArg("optD"))    cfg->optPinD = server.arg("optD").toInt();

  // Sharp — pins ADC independientes por perfil
  if (server.hasArg("sharpI"))  cfg->sharpPinI = constrain(server.arg("sharpI").toInt(), 0, 1);
  if (server.hasArg("sharpD"))  cfg->sharpPinD = constrain(server.arg("sharpD").toInt(), 0, 1);
  if (server.hasArg("umbral_sharp")) cfg->umbralSharp = constrain(server.arg("umbral_sharp").toInt(), 100, 4095);

  // Borde
  if (server.hasArg("numBorde")) cfg->numBorde = constrain(server.arg("numBorde").toInt(), 0, 2);
  if (server.hasArg("bordeI"))   cfg->bordePinI = constrain(server.arg("bordeI").toInt(), 0, 1);
  if (server.hasArg("bordeD"))   cfg->bordePinD = constrain(server.arg("bordeD").toInt(), 0, 1);

  // Umbrales
  if (server.hasArg("umbral_dist"))        cfg->umbralDistCm = constrain(server.arg("umbral_dist").toInt(), 2, 200);
  if (server.hasArg("umbral_dist_mini"))   cfg->umbralDistCm = constrain(server.arg("umbral_dist_mini").toInt(), 2, 200);
  if (server.hasArg("umbral_borde"))       cfg->umbralBorde  = constrain(server.arg("umbral_borde").toInt(), 100, 4095);
  if (server.hasArg("umbral_borde_mini"))  cfg->umbralBorde  = constrain(server.arg("umbral_borde_mini").toInt(), 100, 4095);

  // Velocidades independientes
  if (server.hasArg("spdAtaque"))  cfg->spdAtaque  = constrain(server.arg("spdAtaque").toInt(), 0, 255);

  // FASE "CIERRE SUMO" — "Velocidad de búsqueda"/"Intensidad de giro"
  // (velBusqueda/intGiro) reemplazan a spdBuscExt/spdBuscInt como los
  // nombres PRIMARIOS de este endpoint. Se siguen aceptando los 4
  // nombres viejos (spdBuscExt/spdBuscInt/circuloExt/circuloInt) por
  // compatibilidad con cualquier página cacheada que todavía los use —
  // si en la misma petición llegan los dos estilos, gana el nuevo.
  bool tieneVelNueva = server.hasArg("velBusqueda");
  bool tieneIntNueva = server.hasArg("intGiro");
  if (tieneVelNueva) cfg->velBusqueda = constrain(server.arg("velBusqueda").toInt(), 0, 255);
  if (tieneIntNueva) cfg->intGiro     = constrain(server.arg("intGiro").toInt(), 0, 255);
  bool tieneExtVieja = server.hasArg("spdBuscExt") || server.hasArg("circuloExt");
  bool tieneIntVieja = server.hasArg("spdBuscInt") || server.hasArg("circuloInt");
  if (tieneExtVieja || tieneIntVieja) {
    int extViejo = tieneExtVieja
      ? constrain((server.hasArg("spdBuscExt") ? server.arg("spdBuscExt") : server.arg("circuloExt")).toInt(), 0, 255)
      : velExterna(*cfg);
    int intViejo = tieneIntVieja
      ? constrain((server.hasArg("spdBuscInt") ? server.arg("spdBuscInt") : server.arg("circuloInt")).toInt(), 0, 255)
      : velInterna(*cfg);
    if (!tieneVelNueva) cfg->velBusqueda = (uint8_t)((extViejo + intViejo) / 2);
    if (!tieneIntNueva) cfg->intGiro     = (uint8_t)((extViejo >= intViejo) ? (extViejo - intViejo) : 0);
  }
  if (server.hasArg("spdEvasion")) cfg->spdEvasion = constrain(server.arg("spdEvasion").toInt(), 0, 255);

  // Estrategia
  if (server.hasArg("estrategia")) cfg->estrategia = constrain(server.arg("estrategia").toInt(), 0, 1);
  // "Duración del barrido" — nueva en esta fase, solo tiene efecto real
  // en Mini/estrategia=BARRIDO, pero se acepta el argumento para
  // cualquier perfil (si se manda para Micro, queda guardado sin uso —
  // mismo criterio ya establecido para "estrategia" en Micro).
  if (server.hasArg("durBarrido")) cfg->durBarrido = constrain(server.arg("durBarrido").toInt(), 50, 3000);

  // ── VALIDACIÓN ADC ──
  if (!validateSumoADC(*cfg)) {
    int used = contarADCUsados(*cfg);
    String err = "ADC limit exceeded: need " + String(used) + " ADC pins, only 2 available";
    sendJsonError(400, err.c_str());
    return;
  }

  // ── VALIDACIÓN GPIO / BUSES ──
  // CORRECCIÓN (reporte de Martín): antes de validar, hay que liberar
  // la reserva GPIO_SENSOR_SUMO que la propia config ya tenía puesta
  // desde la última vez que se activó este perfil — si no, un perfil
  // se bloqueaba a SÍ MISMO al querer volver a guardar (o al iniciar
  // combate, que primero guarda y después arranca): pinBloqueadoPorBus()
  // veía sus propios pines "ocupados" y tiraba el error de conflicto
  // aunque I2C/SPI estuvieran apagados y nada más los estuviera usando.
  // Se libera acá, se valida contra lo que quede (I2C/bus_alt/otro
  // perfil), y se vuelve a reservar más abajo, tanto si la validación
  // pasa como si no — ver el segundo cambio de esta corrección.
  gpioLiberarPorMotivo(GPIO_SENSOR_SUMO);

  // Verificar pines sonar vs buses activos
  if (cfg->tipoDistSensor == 0) {
    if (pinBloqueadoPorBus(cfg->trigI) || pinBloqueadoPorBus(cfg->echoI) ||
        (cfg->numDistSensores >= 2 && (pinBloqueadoPorBus(cfg->trigD) || pinBloqueadoPorBus(cfg->echoD)))) {
      gpioAplicarReservasSumoActivo(); // restaurar la reserva del perfil realmente activo antes de salir con error
      sendJsonError(409, "GPIO conflict: sonar pin used by active I2C/SPI bus");
      return;
    }
  }
  if (cfg->tipoDistSensor == 1) {
    if (pinBloqueadoPorBus(cfg->optPinI) ||
        (cfg->numDistSensores >= 2 && pinBloqueadoPorBus(cfg->optPinD))) {
      gpioAplicarReservasSumoActivo(); // ídem
      sendJsonError(409, "GPIO conflict: optical pin used by active I2C/SPI bus");
      return;
    }
  }

  // Perfil activo — Fase "Persistencia Sumo": guardar un perfil lo
  // convierte en "el" perfil activo del robot (una sola fuente de
  // verdad — sección 6 del pedido), para que el botón físico del PCB y
  // el próximo arranque sepan cuál usar sin depender de que el
  // navegador se los vuelva a decir (ver auditoría: antes de esta fase
  // cfgActiva nunca se persistía y siempre volvía a &cfgMini al
  // reiniciar). Se omite mientras Sumo está efectivamente en combate
  // (MODE_MICRO/MODE_MINI) para no quitarle en caliente los pines
  // reservados al perfil que sí está corriendo si alguien guarda el
  // OTRO perfil desde otra pestaña/dispositivo mientras tanto — la
  // config del perfil no-activo igual queda guardada en NVS más abajo,
  // solo no se activa hasta que el robot vuelva a IDLE.
  if (currentMode == MODE_IDLE) cfgActiva = cfg;

  // FASE "CIERRE SUMO", sección 15 del pedido — loguear al Monitor
  // Serial SOLO los parámetros pedagógicos que realmente cambiaron
  // respecto al snapshot tomado al principio de esta función. Se
  // loguea siempre (nivel "evento principal", no throttled — un
  // guardado de configuración es un evento raro, no un valor que
  // cambia varias veces por segundo).
  if (cfg->velBusqueda != antVel) flog('I', "[CONFIG] Velocidad de busqueda -> " + String(cfg->velBusqueda));
  if (cfg->intGiro     != antInt) flog('I', "[CONFIG] Intensidad de giro -> " + String(cfg->intGiro));
  if (cfg->durBarrido  != antDur) flog('I', "[CONFIG] Duracion de barrido -> " + String(cfg->durBarrido) + "ms");
  if (cfg->spdAtaque   != antAtk) flog('I', "[CONFIG] Velocidad de ataque -> " + String(cfg->spdAtaque));
  if (cfg->spdEvasion  != antEv)  flog('I', "[CONFIG] Velocidad de evasion -> " + String(cfg->spdEvasion));
  if (cfg->estrategia  != antEst) flog('I', String("[CONFIG] Estrategia -> ") + (cfg->estrategia==0?"CIRCULO":"BARRIDO"));

  // Guardar persistencia (incluye perfilActivo/inicioServidor/
  // inicioBoton — ver saveSumoConfig() más arriba en el archivo)
  saveSumoConfig();
  flog('I', "[CONFIG] Configuracion Sumo guardada");
  // Fase 4.2 (corregido acá): se resincroniza SIEMPRE, no solo cuando
  // cfg==cfgActiva — gpioAplicarReservasSumoActivo() ya internamente usa
  // cfgActiva (no la variable local "cfg"), así que llamarla siempre es
  // seguro y necesario: si se edita un perfil que NO está activo, esto
  // restaura la reserva del que SÍ lo está (que arriba se había
  // liberado para poder validar sin bloquearse a sí mismo).
  gpioAplicarReservasSumoActivo();
  server.send(200,"application/json","{\"ok\":true}");
}

void handleSumoTrim() {
  if (server.hasArg("ma")) trimA=constrain(server.arg("ma").toInt(),0,255);
  if (server.hasArg("mb")) trimB=constrain(server.arg("mb").toInt(),0,255);
  saveSumoConfig(); // persistir trims también
  server.send(200,"text/plain","OK");
}

// GET /sumo/estado — Fase "Persistencia Sumo". Snapshot COMPLETO de la
// configuración persistente de Sumo, para que sumo.html se restaure a
// sí misma al abrirse (en cualquier dispositivo/navegador — ver sección
// 5 del pedido) en vez de arrancar siempre desde los valores estáticos
// del HTML como hacía antes de esta fase (auditoría: no existía ningún
// endpoint de lectura, solo de escritura — ver informe de entrega).
// Reutiliza proyectoJsonSumo(), la MISMA función que ya arma el bloque
// "sumo" del archivo .franky — no se inventa un segundo formato para
// representar lo mismo dos veces.
void handleSumoEstado() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String j = "{";
  j += "\"mini\":"  + proyectoJsonSumo(cfgMini, true) + ",";
  j += "\"micro\":" + proyectoJsonSumo(cfgMicro, false) + ",";
  j += "\"perfilActivo\":" + String(cfgActiva->perfil) + ",";
  j += "\"inicio\":{\"servidor\":" + String(sumoInicioServidor?"true":"false") +
                  ",\"boton\":"    + String(sumoInicioBoton?"true":"false")    + "},";
  j += "\"trim\":{\"motorA\":" + String(trimA) + ",\"motorB\":" + String(trimB) + "}";
  j += "}";
  server.send(200, "application/json", j);
}

void handleSumoMicro() {
  // Modo de inicio — Fase "Persistencia Sumo": si el usuario deshabilitó
  // "iniciar desde el servidor" (sumo.html → Modo de inicio), este
  // endpoint no debe arrancar Sumo aunque se lo llame. El botón físico
  // (chequearBotonSumo()) tiene su propio gate independiente
  // (sumoInicioBoton) — no comparten camino, cada uno respeta SU propio
  // permiso.
  if (!sumoInicioServidor) {
    sendJsonError(403, "Inicio desde el servidor deshabilitado (ver \"Modo de inicio\" en Sumo)");
    return;
  }
  if (hayConflictoRecurso(progUsaMotores) && server.arg("forzar") != "1") {
    flog('W', "MOTORES ocupado por BLOCKLY (Sumo intento Microsumo)");
    server.send(409, "application/json", "{\"conflicto\":true,\"recurso\":\"motores\",\"mensaje\":\"Blockly esta utilizando los motores.\"}");
    return;
  }
  if (hayConflictoRecurso(progUsaMotores)) detenerBlockly("conflicto motores, Sumo tomo control");
  RobotMode modoAnterior1 = currentMode;
  cfgActiva = &cfgMicro;
  persistirPerfilActivo(); // Fase "Persistencia Sumo" — para que el próximo arranque/botón use este perfil
  gpioAplicarReservasSumoActivo(); // Fase 4.2 — resincroniza reservas al cambiar de perfil activo
  currentMode=MODE_MICRO; modeRunning=true; retardoOK=false;
  tInicioModo=millis(); cabeceoDirDer=true; tCabeceo=millis();
  evadeState=EVADE_IDLE;
  reiniciarMemoriaSumo(); // fase "Cierre Sumo" — última dirección/recuperación/log no heredan el combate anterior
  stopMotors();
  Serial.println("MICROSUMO activado — retardo 5s...");
  if (modoAnterior1 != currentMode) flog('I', String("MODE_CHANGE ") + modoTexto(modoAnterior1) + " -> " + modoTexto(currentMode));
  flog('I', "Inicio");
  flog('I', "Cuenta regresiva (" + String(RETARDO_SUMO/1000) + "s)");
  flog('I', "Configuracion cargada (Microsumo)");
  flog('I', "Sensor=" + String(cfgActiva->tipoDistSensor==0?"sonar":cfgActiva->tipoDistSensor==1?"optico":"sharp") +
             " Velocidad ataque=" + String(cfgActiva->spdAtaque));
  server.send(200,"text/plain","OK");
}
void handleSumoMini() {
  // Ver comentario equivalente en handleSumoMicro() — mismo gate.
  if (!sumoInicioServidor) {
    sendJsonError(403, "Inicio desde el servidor deshabilitado (ver \"Modo de inicio\" en Sumo)");
    return;
  }
  if (hayConflictoRecurso(progUsaMotores) && server.arg("forzar") != "1") {
    flog('W', "MOTORES ocupado por BLOCKLY (Sumo intento Minisumo)");
    server.send(409, "application/json", "{\"conflicto\":true,\"recurso\":\"motores\",\"mensaje\":\"Blockly esta utilizando los motores.\"}");
    return;
  }
  if (hayConflictoRecurso(progUsaMotores)) detenerBlockly("conflicto motores, Sumo tomo control");
  RobotMode modoAnterior2 = currentMode;
  cfgActiva = &cfgMini;
  persistirPerfilActivo(); // Fase "Persistencia Sumo" — para que el próximo arranque/botón use este perfil
  gpioAplicarReservasSumoActivo(); // Fase 4.2 — resincroniza reservas al cambiar de perfil activo
  currentMode=MODE_MINI; modeRunning=true; retardoOK=false;
  tInicioModo=millis(); cabeceoDirDer=true; tCabeceo=millis();
  evadeState=EVADE_IDLE;
  reiniciarMemoriaSumo(); // fase "Cierre Sumo" — última dirección/recuperación/log no heredan el combate anterior
  stopMotors();
  Serial.println("MINISUMO activado — retardo 5s...");
  if (modoAnterior2 != currentMode) flog('I', String("MODE_CHANGE ") + modoTexto(modoAnterior2) + " -> " + modoTexto(currentMode));
  flog('I', "Inicio");
  flog('I', "Cuenta regresiva (" + String(RETARDO_SUMO/1000) + "s)");
  flog('I', "Configuracion cargada (Minisumo)");
  flog('I', "Sensor=" + String(cfgActiva->tipoDistSensor==0?"sonar":cfgActiva->tipoDistSensor==1?"optico":"sharp") +
             " Velocidad ataque=" + String(cfgActiva->spdAtaque));
  server.send(200,"text/plain","OK");
}
void handleSumoStop() {
  RobotMode modoAnterior3 = currentMode;
  currentMode=MODE_IDLE; modeRunning=false; evadeState=EVADE_IDLE;
  enRecuperacion=false; estadoSumoLogActual=ESL_ESPERA; ultimoAtaqueDirLog=-1; // fase "Cierre Sumo" — no dejar latches "colgados" tras detener
  stopMotors();
  // BLOQUE D — corrección de auditoría: si el usuario detiene Sumo
  // DURANTE los 5s de retardo de seguridad, ejecutarSumo() nunca vuelve
  // a correr y el LED (que parpadea durante ese retardo, ver
  // ejecutarSumo()) queda congelado en el estado en que estaba en ese
  // instante — a veces encendido. ejecutarSumo() solo lo apaga cuando
  // el retardo termina naturalmente; STOP debe hacer lo mismo.
  digitalWrite(PIN_LED, HIGH);
  if (modoAnterior3 != currentMode) flog('I', String("MODE_CHANGE ") + modoTexto(modoAnterior3) + " -> " + modoTexto(currentMode));
  server.send(200,"text/plain","OK");
}

// ═══════════════════════════════════════════════════════
//  BOTÓN FÍSICO DEL PCB — inicio de Sumo (Fase "Persistencia Sumo")
//
//  AUDITORÍA PREVIA (obligatoria antes de tocar el botón, sección 8 del
//  pedido): PIN_BTN (GPIO9, INPUT_PULLUP, activo en LOW) tenía, antes de
//  esta fase, EXACTAMENTE dos usos en todo el firmware — (1)
//  loopAcceso() (MODE_ACCESO): un digitalRead() directo, sin debounce,
//  que abre el acceso (accesoAbierto=true) una sola vez; (2)
//  handleAPI(): una lectura pasiva expuesta como "btn" en el JSON,
//  usada solo para mostrar "LIBRE"/"PRES." en la UI — sin ningún efecto
//  sobre el robot. Ningún otro modo (Blockly, Vivero, Meteo, Alarma)
//  usa el botón. No existía debounce ni máquina de estados de botón en
//  ningún lado.
//
//  Lo nuevo acá es COMPLETAMENTE ADITIVO: una función de polling propia
//  (chequearBotonSumo(), llamada desde loop(), ver más abajo) con su
//  propio debounce y su propio estado — no comparte ninguna variable
//  con loopAcceso() ni con handleAPI(), y ambos siguen leyendo el pin
//  exactamente igual que antes (un digitalRead() no tiene efectos
//  secundarios; dos lectores independientes del mismo pin conviven sin
//  interferirse). loopAcceso() solo corre cuando currentMode==MODE_ACCESO;
//  chequearBotonSumo() solo actúa cuando currentMode==MODE_IDLE — nunca
//  se solapan.
//
//  Doble gate de seguridad (sección 9/12 del pedido — "la configuración
//  guardada NUNCA debe arrancar Sumo por sí sola"):
//   1) sumoInicioBoton debe estar habilitado (persistente, default
//      false — ver nota de diseño junto a su declaración).
//   2) currentMode debe ser MODE_IDLE — el robot debe estar realmente
//      libre (esto también evita cualquier conflicto con Blockly/otros
//      modos sin duplicar hayConflictoRecurso(): si Blockly está
//      corriendo, currentMode==MODE_BLOQUES, no IDLE, así que el botón
//      simplemente no hace nada hasta que se detenga).
//  Recién con ambos gates en true, una pulsación (flanco a LOW, con
//  debounce) dispara el mismo efecto que ya dispara el servidor al
//  iniciar Sumo — usando SIEMPRE cfgActiva tal cual está (nunca
//  reconstruye ni reasigna la configuración, sección 12 del pedido).
// ═══════════════════════════════════════════════════════
bool btnSumoEstadoEstable  = HIGH; // HIGH=suelto (INPUT_PULLUP), LOW=presionado
bool btnSumoUltimaLectura  = HIGH;
unsigned long btnSumoTUltimoCambio = 0;
#define BOTON_SUMO_DEBOUNCE_MS 50

// Mismo efecto que arrancar Sumo desde el servidor (handleSumoMicro()/
// handleSumoMini()) pero usando el perfil YA activo — el botón no elige
// ni reconstruye configuración, solo dispara lo que ya está guardado.
void iniciarSumoDesdeBoton() {
  RobotMode modoAnteriorBtn = currentMode;
  currentMode = (cfgActiva->perfil == 1) ? MODE_MICRO : MODE_MINI;
  modeRunning = true; retardoOK = false;
  tInicioModo = millis(); cabeceoDirDer = true; tCabeceo = millis();
  evadeState = EVADE_IDLE;
  reiniciarMemoriaSumo(); // fase "Cierre Sumo" — última dirección/recuperación/log no heredan el combate anterior
  stopMotors();
  gpioAplicarReservasSumoActivo(); // mismo resync defensivo que ya hacen handleSumoMicro()/handleSumoMini()
  if (modoAnteriorBtn != currentMode) flog('I', String("MODE_CHANGE ") + modoTexto(modoAnteriorBtn) + " -> " + modoTexto(currentMode) + " (boton PCB)");
  flog('I', String("Sumo iniciado desde el boton PCB — perfil activo: ") + (cfgActiva->perfil==1?"MICRO":"MINI"));
  flog('I', "Inicio");
  flog('I', "Cuenta regresiva (" + String(RETARDO_SUMO/1000) + "s)");
}

void chequearBotonSumo() {
  if (!sumoInicioBoton || currentMode != MODE_IDLE) {
    // Reset defensivo: si el botón se deshabilita o el robot deja de
    // estar IDLE mientras el botón sigue físicamente apretado, no debe
    // quedar "guardado" un flanco pendiente que dispare un inicio
    // atrasado apenas se vuelva a habilitar/quedar libre.
    btnSumoEstadoEstable = digitalRead(PIN_BTN);
    btnSumoUltimaLectura = btnSumoEstadoEstable;
    return;
  }
  bool lectura = digitalRead(PIN_BTN);
  if (lectura != btnSumoUltimaLectura) {
    btnSumoTUltimoCambio = millis();
    btnSumoUltimaLectura = lectura;
  }
  if (millis() - btnSumoTUltimoCambio > BOTON_SUMO_DEBOUNCE_MS && lectura != btnSumoEstadoEstable) {
    btnSumoEstadoEstable = lectura;
    if (btnSumoEstadoEstable == LOW) iniciarSumoDesdeBoton(); // flanco estable a presionado
  }
}

// ═══════════════════════════════════════════════════════
//  RESTO DE HANDLERS (sin cambios respecto a v3.1)
// ═══════════════════════════════════════════════════════
void handleBloquesListAPI() {
  String j="[";
  for(int i=0;i<progLen;i++){ if(i>0)j+=","; j+="{\"op\":"+String(programa[i].op)+",\"val\":"+String(programa[i].val)+"}"; }
  j+="]";
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.send(200,"application/json",j);
}
void handleMove()    {
  String d = server.arg("d");
  if (hayConflictoRecurso(progUsaMotores) && server.arg("forzar") != "1") {
    flog('W', "MOTORES ocupado por BLOCKLY (Gamepad intento mover)");
    server.send(409, "application/json", "{\"conflicto\":true,\"recurso\":\"motores\",\"mensaje\":\"Blockly esta utilizando los motores.\"}");
    return;
  }
  if (hayConflictoRecurso(progUsaMotores)) detenerBlockly("conflicto motores, Gamepad tomo control");
  move(d);
  if (flogThrottle("manual_cmd", 250)) {
    String nombre = (d=="f")?"Adelante":(d=="b")?"Atras":(d=="l")?"Izquierda":(d=="r")?"Derecha":d;
    flog('I', nombre + "  A=" + String(pwmA) + " B=" + String(pwmB));
  }
  server.send(200,"text/plain","OK");
}
void handleSonarRead() {
  sonarTrig=server.arg("trig").toInt(); sonarEcho=server.arg("echo").toInt();
  NewPing sonar(sonarTrig,sonarEcho,400);
  sonarCm=(int)sonar.ping_cm();
  server.send(200,"application/json","{\"cm\":"+String(sonarCm)+"}");
}
void handleSonarStop() { sonarActive=false; server.send(200,"text/plain","OK"); }
void handleDhtPin()    { server.send(200,"text/plain","OK"); }
void handleGpioRead() {
  int pin=server.arg("pin").toInt();
  if(pin==2||pin==3||pin==4||pin==5){server.send(400,"text/plain","Pin motor");return;}
  pinMode(pin,INPUT_PULLUP);
  server.send(200,"application/json","{\"pin\":"+String(pin)+",\"val\":"+String(digitalRead(pin))+"}");
}
void handleSumoUmbral(){ server.send(200,"text/plain","OK"); }
void handleStop()      { stopMotors(); server.send(200,"text/plain","OK"); }
void handleSpeed()     { motorSpeed=server.arg("val").toInt(); server.send(200,"text/plain","OK"); }
void handleStopAll()   {
  RobotMode modoAnteriorPT = currentMode;
  currentMode=MODE_IDLE; modeRunning=false; evadeState=EVADE_IDLE;
  stopMotors();
  digitalWrite(PIN_LED,HIGH);
  // Auditoría "PARAR TODO": el resto del estado (progPC/progLen/
  // programa[]) NO se toca a propósito — cambiar currentMode a
  // MODE_IDLE ya alcanza para que loop() deje de llamar a
  // ejecutarBloque()/ejecutarSumo()/loopVivero()/loopMeteo() (el switch
  // de loop() no tiene case para MODE_IDLE, cae al default) — no hace
  // falta resetear progPC para que el robot quede seguro, y resetearlo
  // borraría el punto donde estaba el programa sin que el usuario lo
  // pidiera. El programa Blockly NO se borra — confirmado, coincide
  // con la definición que pediste (STOP != CLEAR).
  if (modoAnteriorPT != currentMode) flog('W', String("PARAR_TODO ") + modoTexto(modoAnteriorPT) + " -> IDLE");
  server.sendHeader("Location","/");server.send(303);
}
void handleLedOn()     { digitalWrite(PIN_LED,LOW);  server.send(200,"text/plain","OK"); }
void handleLedOff()    { digitalWrite(PIN_LED,HIGH); server.send(200,"text/plain","OK"); }
void handleLedBrillo() { analogWrite(PIN_LED,server.arg("val").toInt()); server.send(200,"text/plain","OK"); }
void handleGpioOut()  {
  int pin=server.arg("pin").toInt(), val=server.arg("val").toInt();
  if(pin==2||pin==3||pin==4||pin==5){server.send(400,"text/plain","Pin ocupado por motor");return;}
  pinMode(pin,OUTPUT); digitalWrite(pin,val?HIGH:LOW); server.send(200,"text/plain","OK");
}
void handleBloquesAdd() {
  if(progLen<MAX_INST){
    uint8_t op = (uint8_t)server.arg("op").toInt();
    int16_t val = (int16_t)server.arg("val").toInt();

    // Fase 4.4: OP_OLED_PRINT/OP_SERIAL_PRINT llegan con un parámetro
    // "txt" (texto libre) además de op/val — se guarda en tablaTxt[] y
    // el índice de esa tabla reemplaza a "val" en la instrucción
    // guardada. Si el cliente manda "txt" para un opcode que no lo usa,
    // se ignora (no rompe nada, simplemente no hay tabla que llenar).
    if ((op == OP_OLED_PRINT || op == OP_SERIAL_PRINT) && server.hasArg("txt")) {
      if (tablaTxtLen >= TABLA_TXT_MAX) {
        server.send(400, "text/plain", "Tabla de texto llena (maximo 8 mensajes distintos por programa)");
        return;
      }
      String t = server.arg("txt");
      if (t.length() > TABLA_TXT_LEN - 1) t = t.substring(0, TABLA_TXT_LEN - 1);
      strncpy(tablaTxt[tablaTxtLen], t.c_str(), TABLA_TXT_LEN - 1);
      tablaTxt[tablaTxtLen][TABLA_TXT_LEN - 1] = '\0';
      val = tablaTxtLen;
      tablaTxtLen++;
    }

    // Fase 4.4: OP_OLED_SPRITE llega con "bitmap" — 64 caracteres hex
    // (32 bytes, 16x16 1bpp), generados por el editor modal de Blockly.
    if (op == OP_OLED_SPRITE && server.hasArg("bitmap")) {
      if (tablaBitmapLen >= TABLA_BITMAP_MAX) {
        server.send(400, "text/plain", "Tabla de sprites llena (maximo 8 dibujos distintos por programa)");
        return;
      }
      String hex = server.arg("bitmap");
      uint8_t* dst = tablaBitmap[tablaBitmapLen];
      memset(dst, 0, TABLA_BITMAP_BYTES);
      int n = min((int)(hex.length()/2), TABLA_BITMAP_BYTES);
      for (int i = 0; i < n; i++) {
        dst[i] = (uint8_t) strtol(hex.substring(i*2, i*2+2).c_str(), NULL, 16);
      }
      val = tablaBitmapLen;
      tablaBitmapLen++;
    }

    programa[progLen++]={op, val};
    guardarProg();
    server.send(200,"text/plain","OK");
  } else {
    // Antes: se descartaba la instrucción en silencio y igual respondía
    // "OK" — un estudiante nunca se enteraba de por qué su programa no
    // hacía lo esperado. Ver FRANKY LAB, informe de migración de Fase 3.
    server.send(400,"text/plain","Programa lleno (maximo 64 instrucciones)");
  }
}
void handleBloquesDel() {
  int i=server.arg("idx").toInt();
  if(i>=0&&i<progLen){for(int j=i;j<progLen-1;j++)programa[j]=programa[j+1];progLen--;guardarProg();}
  server.send(200,"text/plain","OK");
}
void handleBloquesRun()  {
  RobotMode modoAnterior4 = currentMode;
  // Etapa 1 / Unit 1 — fix de bug latente: pilaLen/callStackLen nunca se
  // reseteaban en ningún punto (ni acá, ni en Stop, ni en Clear). En uso
  // normal cada PUSH es consumido por la instrucción siguiente en el
  // mismo tick, así que vuelven solas a 0 — pero si un programa se
  // detiene justo entre un PUSH y su consumidor (Detener a mitad de una
  // instrucción OLED/buzzer con parámetros, por ejemplo), el valor
  // queda apilado. Sin este reset, la siguiente ejecución arrancaría con
  // la pila sucia y podría ir acumulando basura entre corridas hasta
  // desbordar PILA_MAX. No afecta a programa[]/progLen/tablaTxt/
  // tablaBitmap ni a ningún opcode existente — solo al estado interno
  // de ejecución de la pila de parámetros/retorno.
  pilaLen=0; callStackLen=0; repeatStackLen=0; // Unidad 7: misma disciplina de reinicio que pila[]/callStack[]
  // Unidad 2 (condición 3 del usuario, Fase 2 P0): varTabla[4] también se
  // reinicia a 0 en CADA corrida nueva (Run), igual que pilaLen/callStack.
  // Antes de esta unidad no existía varTabla (era un único varGlobal sin
  // contrato de reinicio documentado), así que esto no rompe ningún
  // comportamiento previo acordado. Deliberadamente NO se resetea en
  // detenerBlockly()/Stop: ahí las variables son estado de usuario válido
  // que puede querer inspeccionarse (p. ej. vía Serial/OLED, Unidad 5)
  // justo después de detener el programa, a diferencia de pila[]/
  // callStack[] que son basura de ejecución a mitad de instrucción.
  varTabla[0]=varTabla[1]=varTabla[2]=varTabla[3]=0.0f;
  progPC=0;bEsperando=false;currentMode=MODE_BLOQUES;modeRunning=true;
  // Único punto de llamada de analizarRecursosPrograma() — el programa
  // ya está completo en este instante (la subida de instrucciones
  // siempre termina justo antes de llamar a /bloques/run, ver
  // toggleRun() en bloques.html). No se llama en cada /bloques/add
  // (evita trabajo repetitivo, según lo acordado) ni dentro de loop().
  analizarRecursosPrograma();
  if (modoAnterior4 != currentMode) flog('I', String("MODE_CHANGE ") + modoTexto(modoAnterior4) + " -> " + modoTexto(currentMode));
  flog('I',"Programa iniciado ("+String(progLen)+" instrucciones)");
  flog('I', "Recursos: OLED=" + String(progUsaOled?1:0) + " MOTOR=" + String(progUsaMotores?1:0) + " SERIAL=" + String(progUsaSerial?1:0));
  server.send(200,"text/plain","OK");
}
// Centralizado en detenerBlockly() (CAPA 3) — mismo efecto exacto que
// antes (modeRunning=false, currentMode=MODE_IDLE, stopMotors()), sin
// tocar programa[]/progLen. Se llama con motivo "detenido por usuario"
// para diferenciar en el log de un detenido por conflicto de recurso.
void handleBloquesStop() { detenerBlockly("detenido por usuario"); server.send(200,"text/plain","OK"); }
void handleBloquesClear(){
  progLen=0;progPC=0;
  pilaLen=0; callStackLen=0; repeatStackLen=0; // Unidad 7: misma disciplina de reinicio que pila[]/callStack[] // Etapa 1 / Unit 1: ver comentario en handleBloquesRun()
  varTabla[0]=varTabla[1]=varTabla[2]=varTabla[3]=0.0f; // Unidad 2, condición 3: ver comentario en handleBloquesRun()
  tablaTxtLen=0; tablaBitmapLen=0; // Fase 4.4: recompilación completa arranca las tablas de cero
  // "Programa modificado" también incluye limpiarlo — con progLen=0 el
  // resultado de analizarRecursosPrograma() sería trivialmente false en
  // los 3 casos, así que se asigna directo en vez de llamar a la
  // función completa (evita trabajo innecesario, mismo criterio que
  // ya se pidió para el punto de llamada de /bloques/run).
  progUsaMotores=false; progUsaOled=false; progUsaSerial=false;
  guardarProg();server.send(200,"text/plain","OK");
}
void handleAutoVivero()  { currentMode=MODE_VIVERO; modeRunning=true;server.send(200,"text/plain","OK"); }
void handleAutoMeteo()   { currentMode=MODE_METEO;  modeRunning=true;server.send(200,"text/plain","OK"); }
void handleAutoAlarma()  { currentMode=MODE_ALARMA; modeRunning=true;alarmaActiva=false;server.send(200,"text/plain","OK"); }
void handleAutoAcceso()  { currentMode=MODE_ACCESO; modeRunning=true;server.send(200,"text/plain","OK"); }
void handleAutoStop()    { currentMode=MODE_IDLE;   modeRunning=false;stopMotors();server.send(200,"text/plain","OK"); }
void handleAlarmaReset() { alarmaActiva=false;digitalWrite(PIN_LED,HIGH);server.send(200,"text/plain","OK"); }
void handlePanelConfig() { serveFile("/panel_config.html"); }
void handlePanelSave() {
  i2cEnabled=server.hasArg("i2c"); spiEnabled=server.hasArg("spi");
  prefs.begin("franky",false); prefs.putBool("i2c",i2cEnabled); prefs.putBool("spi",spiEnabled); prefs.end();
  // El firmware reinicia igual después de esto (ESP.restart() dos líneas
  // más abajo, comportamiento sin cambios), así que gpioSincronizarBuses()
  // se va a volver a ejecutar en el próximo setup() de todos modos — se
  // llama también acá para que /gpio/estado refleje el cambio real incluso
  // en la ventana de 2s antes del reinicio, útil para verificar en banco.
  gpioSincronizarBuses();
  server.send(200,"text/plain","OK. Reiniciando..."); delay(2000); ESP.restart();
}

// Fase 4.2 — GET/POST /i2c/set?sda=X&scl=Y. Valida, aplica, persiste y
// reinicia (mismo patrón que handlePanelSave(), para que Wire.begin() se
// reconstruya limpio en el próximo setup() — no se intenta reconfigurar
// el bus I2C "en caliente"). Si la validación falla, responde 409 con el
// motivo y NO reinicia ni persiste nada.
void handleI2CSet() {
  if (!server.hasArg("sda") || !server.hasArg("scl")) {
    sendJsonError(400, "Faltan parametros sda/scl"); return;
  }
  uint8_t sda = (uint8_t)server.arg("sda").toInt();
  uint8_t scl = (uint8_t)server.arg("scl").toInt();
  String err;
  if (!aplicarI2C(sda, scl, err)) { sendJsonError(409, err.c_str()); return; }
  prefs.begin("franky",false); prefs.putUChar("i2csda",i2cSda); prefs.putUChar("i2cscl",i2cScl); prefs.end();
  server.send(200,"text/plain","OK. Reiniciando..."); delay(2000); ESP.restart();
}

// Fase 4.1 — introspección del mapa de reservas de GPIO. Endpoint nuevo,
// de solo lectura, sin efectos secundarios: pensado para verificar esta
// fase en banco (curl o navegador) antes de que exista cualquier UI que
// lo consuma (esa UI llega en Fase 4.2 con la página de I2C). Devuelve
// los 13 pines expuestos con su motivo de reserva actual.
// GET /monitor/log?since=N — devuelve las entradas del buffer circular
// con seq > N (o todo el buffer si no se manda "since"). Polling, no
// WebSocket — ver justificación en el informe de diseño. Solo lectura,
// sin efectos secundarios.
// ═══════════════════════════════════════════════════════
//  BLOQUE A — LOG TÉCNICO (bitácora cruda, texto plano)
//
//  Distinto del Monitor Serie Virtual (que sigue existiendo tal cual,
//  como herramienta VISUAL). Esto es la "caja negra" del sistema:
//  texto plano, pensado para copiar/pegar y compartir (con otra
//  persona, con soporte técnico, o con una IA), no para verse lindo.
//  Reutiliza el MISMO buffer circular (monitorBuf[]) que ya usa el
//  Monitor — no es un segundo sistema de logging, es una segunda
//  FORMA de leer el mismo buffer, con un encabezado de estado vivo
//  del sistema agregado adelante.
// ═══════════════════════════════════════════════════════
String formatearUptime(unsigned long ms) {
  unsigned long s = ms / 1000;
  unsigned long hh = s / 3600;
  unsigned long mm = (s % 3600) / 60;
  unsigned long ss = s % 60;
  char buf[16];
  snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", hh, mm, ss);
  return String(buf);
}

// esp_reset_reason() es una función estándar de ESP-IDF (esp_system.h),
// disponible en cualquier proyecto Arduino-ESP32 sin librerías nuevas.
// Se mapean los casos más comunes; cualquier otro cae en un texto
// genérico con el número crudo — nunca se inventa un motivo que no
// se pueda confirmar.
String motivoReset() {
  esp_reset_reason_t r = esp_reset_reason();
  switch (r) {
    case ESP_RST_POWERON:  return "POWERON (encendido normal)";
    case ESP_RST_SW:       return "SW (reinicio por software, ej. ESP.restart())";
    case ESP_RST_PANIC:    return "PANIC (excepcion/crash del firmware)";
    case ESP_RST_INT_WDT:  return "INT_WDT (watchdog de interrupciones)";
    case ESP_RST_TASK_WDT: return "TASK_WDT (watchdog de tarea)";
    case ESP_RST_WDT:      return "WDT (watchdog generico)";
    case ESP_RST_BROWNOUT: return "BROWNOUT (caida de tension)";
    case ESP_RST_SDIO:     return "SDIO";
    default:                return "otro (codigo " + String((int)r) + ")";
  }
}

String generarLogTexto() {
  String o;
  o += "FRANKY SERVER DIAGNOSTIC LOG\n";
  o += "--------------------------------\n";
  o += "Firmware: " + String(FW_VER) + "\n";
  o += "Uptime: " + formatearUptime(millis()) + "\n";
  o += "Reset reason: " + motivoReset() + "\n";
  o += "Free heap: " + String(ESP.getFreeHeap()) + " bytes\n";
  o += "WiFi AP: " + String(WIFI_SSID) + "  IP: " + WiFi.softAPIP().toString() +
       "  Clientes: " + String(WiFi.softAPgetStationNum()) + "\n";
  o += "I2C: " + String(i2cEnabled ? "habilitado" : "deshabilitado") +
       "  SDA=" + String(i2cSda) + " SCL=" + String(i2cScl) + " CLOCK=400000\n";
  o += "OLED: " + String(oledPanelDetectado ? "detectado" : "sin detectar") +
       (oledPanelDetectado ? (" direccion=0x" + String(oledPanelAddr, HEX) +
        " " + String(oledPanelAncho) + "x" + String(oledPanelAlto)) : "") +
       "  Blockly OLED inicializado=" + String(oledInicializado ? "si" : "no") +
       "  DISPLAY ejecutados=" + String(oledDisplayCount) + "\n";
  o += "Modo actual: " + String(monitorContextoActual()) +
       "  ejecutando=" + String(modeRunning ? "si" : "no") + "\n";
  o += "Blockly: progLen=" + String(progLen) + " progPC=" + String(progPC) +
       "  recursos: OLED=" + String(progUsaOled?1:0) + " MOTOR=" + String(progUsaMotores?1:0) +
       " SERIAL=" + String(progUsaSerial?1:0) + "\n";

  // Etapa de diagnóstico avanzado — estadísticas OLED_DISPLAY.
  o += "--------------------------------\n";
  o += "ESTADISTICAS OLED_DISPLAY\n";
  o += "--------------------------------\n";
  o += "count=" + String(oledDisplayCount);
  if (oledDisplayCount > 0) {
    o += " min_us=" + String(oledDisplayMinUs) +
         " max_us=" + String(oledDisplayMaxUs) +
         " avg_us=" + String((uint32_t)(oledDisplaySumUs / oledDisplayCount)) +
         " last_us=" + String(oledDisplayLastUs);
  }
  o += "\n";
  o += "Umbrales de diagnostico FRANKY (internos, no valores oficiales de fabricante): " +
       String("NORMAL<") + String(OLED_DISPLAY_WARNING_US/1000) + "ms  WARNING>=" +
       String(OLED_DISPLAY_WARNING_US/1000) + "ms  CRITICAL>=" + String(OLED_DISPLAY_CRITICAL_US/1000) + "ms\n";
  if (lastOkSeq > 0) {
    o += "LAST_OK: SEQ=" + String(lastOkSeq) + " T=" + String(lastOkMs) + "ms DUR_US=" + String(lastOkDurUs) + "\n";
  }
  if (huboAnomaliaOled) {
    o += "FIRST_ANOMALY: SEQ=" + String(firstAnomalySeq) + " T=" + String(firstAnomalyMs) + "ms DUR_US=" + String(firstAnomalyDurUs) + "\n";
  } else {
    o += "FIRST_ANOMALY: ninguna registrada en esta sesion\n";
  }

  // Último fallo crítico persistido en NVS (sobrevive a un reinicio,
  // si alguna vez ocurre uno) — informativo, se sobreescribe con el
  // próximo evento crítico, nunca se limpia solo.
  prefs.begin("franky", true);
  String ultimoFallo = prefs.getString("lastFault", "");
  bool ultimoFalloRecuperado = prefs.getBool("lastFaultRecov", false);
  prefs.end();
  if (ultimoFallo.length() > 0) {
    o += "PREVIOUS_FAULT=" + ultimoFallo + " recovered=" + String(ultimoFalloRecuperado?"si":"no") + "\n";
  }

  o += "--------------------------------\n";
  o += "EVENTOS (buffer circular, hasta " + String(MONITOR_BUF_N) + " mas recientes)\n";
  o += "--------------------------------\n";

  // Mismo recorrido cronologico que ya usa handleMonitorLog() — se
  // reutiliza la logica, no se duplica un segundo buffer.
  int total = (monitorSeq < MONITOR_BUF_N) ? (int)monitorSeq : MONITOR_BUF_N;
  int start = (monitorSeq < MONITOR_BUF_N) ? 0 : monitorHead;
  if (total == 0) o += "(sin eventos registrados todavia)\n";
  for (int i = 0; i < total; i++) {
    LogEntry& e = monitorBuf[(start + i) % MONITOR_BUF_N];
    o += "[SEQ=" + String(e.seq) + "][T=" + String(e.ms) + "ms] " + String(e.msg) + "\n";
  }
  return o;
}

void handleLogTexto() {
  server.send(200, "text/plain", generarLogTexto());
}

void handleMonitorLog() {
  uint32_t since = server.hasArg("since") ? (uint32_t) server.arg("since").toInt() : 0;
  // Cuántas entradas válidas hay y desde dónde empieza la más vieja
  // cronológicamente -- mientras el buffer no dio la vuelta todavía
  // (monitorSeq < MONITOR_BUF_N), son las primeras monitorSeq
  // posiciones, en orden, desde el índice 0. Una vez que dio la vuelta,
  // son las MONITOR_BUF_N posiciones completas, empezando en monitorHead
  // (el próximo lugar a escribir es, por definición, el más viejo).
  int total = (monitorSeq < MONITOR_BUF_N) ? (int)monitorSeq : MONITOR_BUF_N;
  int start = (monitorSeq < MONITOR_BUF_N) ? 0 : monitorHead;
  String j = "{\"debug\":" + String(debugEnabled?"true":"false") + ",\"entradas\":[";
  bool primero = true;
  for (int i = 0; i < total; i++) {
    LogEntry& e = monitorBuf[(start + i) % MONITOR_BUF_N];
    if (e.seq <= since) continue;
    if (!primero) j += ",";
    String msgEsc = String(e.msg);
    msgEsc.replace("\\", "\\\\"); msgEsc.replace("\"", "\\\"");
    j += "{\"seq\":" + String(e.seq) + ",\"ms\":" + String(e.ms) + ",\"msg\":\"" + msgEsc + "\"}";
    primero = false;
  }
  j += "]}";
  server.send(200, "application/json", j);
}

// GET /monitor/debug?on=1 — activa/desactiva mensajes DEBUG en el
// monitor virtual (Serial USB los sigue mostrando siempre, esto solo
// filtra lo que entra al buffer que lee el navegador).
void handleMonitorDebug() {
  if (server.hasArg("on")) debugEnabled = (server.arg("on") == "1");
  server.send(200, "application/json", "{\"debug\":" + String(debugEnabled?"true":"false") + "}");
}

// CAPA 2 — GET /runtime/estado, solo lectura. Reutiliza exactamente
// las variables ya existentes (currentMode, modeRunning, progLen,
// progPC, progUsaMotores/Oled/Serial) — no duplica ningún dato nuevo.
void handleRuntimeEstado() {
  String j = "{";
  j += "\"modo\":" + String((int)currentMode) + ",";
  j += "\"modoTexto\":\"" + String(monitorContextoActual()) + "\",";
  j += "\"ejecutando\":" + String(modeRunning ? "true" : "false") + ",";
  j += "\"progLen\":" + String(progLen) + ",";
  j += "\"progPC\":" + String(progPC) + ",";
  j += "\"progUsaMotores\":" + String(progUsaMotores ? "true" : "false") + ",";
  j += "\"progUsaOled\":" + String(progUsaOled ? "true" : "false") + ",";
  j += "\"progUsaSerial\":" + String(progUsaSerial ? "true" : "false");
  j += "}";
  server.send(200, "application/json", j);
}

// Etapa de diagnóstico — PAGE_ENTER. Se llama desde Monitor.setContext(),
// que YA se invoca en cada página existente — no hace falta agregar
// código nuevo a cada HTML, solo extender lo que ya llaman todas.
void handleRuntimePagina() {
  String pagina = server.hasArg("p") ? server.arg("p") : "?";
  flog('I', "PAGE_ENTER " + pagina);
  server.send(200, "text/plain", "OK");
}

// Etapa de diagnóstico — errores capturados del lado del NAVEGADOR
// (window.onerror, fetch fallido). El ESP32 no puede detectar esto por
// sí mismo — es información que el cliente aporta cuando puede. Se
// distingue explícitamente de los eventos que el firmware sí puede
// demostrar (nunca se etiqueta como "I2C_ERROR" algo que en realidad
// es un error del navegador).
void handleRuntimeNavegador() {
  String tipo = server.hasArg("tipo") ? server.arg("tipo") : "?";
  String pagina = server.hasArg("pagina") ? server.arg("pagina") : "?";
  String msg = server.hasArg("msg") ? server.arg("msg") : "";
  msg = msg.substring(0, 120); // acotado — esto viene de un cliente externo, nunca confiar en su longitud
  flog('W', "[BROWSER] tipo=" + tipo + " pagina=" + pagina + " msg=" + msg);
  server.send(200, "text/plain", "OK");
}

void handleGpioEstado() {
  String j = "[";
  for (int i = 0; i < GPIO_RESERVA_N; i++) {
    if (i) j += ",";
    j += "{\"gpio\":" + String(GPIO_EXPUESTOS[i]) +
         ",\"libre\":" + (gpioReserva[i]==GPIO_LIBRE?"true":"false") +
         ",\"motivo\":\"" + String(gpioMotivoTexto(gpioReserva[i])) + "\"}";
  }
  // Fase 4.2 — se agrega el par I2C activo al mismo JSON, para que la
  // futura página de configuración (o una prueba manual con curl) no
  // necesite un segundo endpoint solo para saber qué pines están en uso.
  j += "],\"i2c_sda\":" + String(i2cSda) + ",\"i2c_scl\":" + String(i2cScl);
  j = "{\"pines\":" + j + "}";
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.send(200,"application/json",j);
}

// ── Fase 4.3 — OLED / Panel Industrial ──────────────────────────────

// GET /i2c/scan — barre direcciones 1-126, devuelve las que respondan.
// Solo lectura, no depende de qué tamaño de OLED haya conectado (sirve
// para cualquier dispositivo I2C, no solo el display).
void handleI2cScan() {
  if (!i2cEnabled) { sendJsonError(409, "I2C deshabilitado (ver Configurar I2C/SPI)"); return; }
  String j = "[";
  bool primero = true;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      if (!primero) j += ",";
      j += "\"0x" + String(addr, HEX) + "\"";
      primero = false;
    }
  }
  j += "]";
  server.send(200,"application/json",j);
}

// GET /oled/test?size=96|91&addr=0x3C — crea una instancia LOCAL de
// Adafruit_SSD1306 del tamaño pedido, intenta begin() en la dirección
// indicada (o prueba 0x3C y despues 0x3D si no se especifica una que
// funcione), imprime un texto de diagnóstico REAL (SDA/SCL activos, no
// un valor fijo) y guarda el resultado en oledPanel* para que
// /oled/clear y /oled/logo no tengan que volver a escanear.
void handleOledTest() {
  if (hayConflictoRecurso(progUsaOled) && server.arg("forzar") != "1") {
    flog('W', "OLED ocupado por BLOCKLY (Panel intento Probar)");
    server.send(409, "application/json", "{\"conflicto\":true,\"recurso\":\"oled\",\"mensaje\":\"Blockly esta utilizando la pantalla OLED.\"}");
    return;
  }
  if (hayConflictoRecurso(progUsaOled)) detenerBlockly("conflicto OLED, Panel tomo control (Probar)");
  Serial.println("=== OLED DIAGNOSTIC: /oled/test ===");
  Serial.print("I2C enabled: "); Serial.println(i2cEnabled);
  if (!i2cEnabled) { Serial.println("-> ABORT: I2C deshabilitado"); sendJsonError(409, "I2C deshabilitado (ver Configurar I2C/SPI)"); return; }
  Serial.print("SDA: "); Serial.print(i2cSda); Serial.print("  SCL: "); Serial.println(i2cScl);
  uint8_t w = 128, h = 64;
  if (server.hasArg("size") && server.arg("size") == "91") h = 32;
  uint8_t addr = 0x3C;
  if (server.hasArg("addr")) addr = (uint8_t) strtol(server.arg("addr").c_str(), NULL, 0);
  Serial.print("Tamano pedido: "); Serial.print(w); Serial.print("x"); Serial.println(h);
  Serial.print("Direccion pedida: 0x"); Serial.println(addr, HEX);

  Adafruit_SSD1306 testDisp(w, h, &Wire, -1);
  Serial.println("testDisp construido (objeto local, stack)");
  bool ok = testDisp.begin(SSD1306_SWITCHCAPVCC, addr);
  Serial.print("testDisp.begin(0x"); Serial.print(addr,HEX); Serial.print(") -> "); Serial.println(ok?"OK":"FALLO");
  if (!ok) {
    addr = (addr == 0x3C) ? 0x3D : 0x3C;
    ok = testDisp.begin(SSD1306_SWITCHCAPVCC, addr);
    Serial.print("Reintento testDisp.begin(0x"); Serial.print(addr,HEX); Serial.print(") -> "); Serial.println(ok?"OK":"FALLO");
  }
  if (ok) {
    testDisp.clearDisplay();
    Serial.println("testDisp.clearDisplay() ejecutado");
    testDisp.setTextSize(1);
    testDisp.setTextColor(SSD1306_WHITE);
    Serial.println("testDisp.setTextSize(1)+setTextColor(WHITE) ejecutado");
    testDisp.setCursor(0,0);
    testDisp.println("FRANKY 4.0");
    testDisp.print("SDA="); testDisp.print(i2cSda);
    testDisp.print(" SCL="); testDisp.println(i2cScl);
    testDisp.print(w); testDisp.print("x"); testDisp.println(h);
    Serial.println("Texto de diagnostico escrito en el buffer local");
    testDisp.display();
    Serial.println("testDisp.display() ejecutado (buffer -> pantalla fisica via I2C)");
    oledPanelAncho = w; oledPanelAlto = h; oledPanelAddr = addr;
    oledPanelDetectado = true;
    Serial.println("oledPanelDetectado = true");
    flog('I', "OLED detectado 0x" + String(addr,HEX) + " (" + String(w) + "x" + String(h) + ")");
  } else {
    Serial.println("-> testDisp NUNCA respondio, ok=false final. oledPanelDetectado no se toca.");
  }
  Serial.println("=== FIN DIAGNOSTIC /oled/test ===");
  String j = "{\"ok\":" + String(ok?"true":"false") +
             ",\"w\":" + String(w) + ",\"h\":" + String(h) +
             ",\"addr\":\"0x" + String(addr,HEX) + "\"}";
  server.send(200,"application/json",j);
}

// GET /oled/clear — reutiliza el último tamaño/dirección detectados por
// /oled/test. Si todavía no se probó ninguna pantalla en esta sesión,
// responde 409 en vez de adivinar un tamaño — evita limpiar "a ciegas"
// una pantalla que puede no ser del tamaño que el firmware supone.
void handleOledClear() {
  if (hayConflictoRecurso(progUsaOled) && server.arg("forzar") != "1") {
    flog('W', "OLED ocupado por BLOCKLY (Panel intento Limpiar)");
    server.send(409, "application/json", "{\"conflicto\":true,\"recurso\":\"oled\",\"mensaje\":\"Blockly esta utilizando la pantalla OLED.\"}");
    return;
  }
  if (hayConflictoRecurso(progUsaOled)) detenerBlockly("conflicto OLED, Panel tomo control (Limpiar)");
  Serial.println("=== OLED DIAGNOSTIC: /oled/clear ===");
  Serial.print("oledPanelDetectado: "); Serial.println(oledPanelDetectado);
  if (!oledPanelDetectado) { Serial.println("-> ABORT: no se corrio Probar antes"); sendJsonError(409, "Ejecutar Probar antes de Limpiar"); return; }
  Serial.print("Reusando tamano/addr de la ultima prueba: "); Serial.print(oledPanelAncho); Serial.print("x"); Serial.print(oledPanelAlto);
  Serial.print(" @0x"); Serial.println(oledPanelAddr, HEX);
  Adafruit_SSD1306 d(oledPanelAncho, oledPanelAlto, &Wire, -1);
  bool ok = d.begin(SSD1306_SWITCHCAPVCC, oledPanelAddr);
  Serial.print("d.begin() -> "); Serial.println(ok?"OK":"FALLO");
  if (!ok) {
    Serial.println("-> ABORT: el OLED no respondio en esta llamada (aunque si lo hizo en /oled/test)");
    sendJsonError(409, "OLED no responde en la ultima direccion detectada"); return;
  }
  d.clearDisplay();
  Serial.println("d.clearDisplay() ejecutado");
  d.display();
  Serial.println("d.display() ejecutado");
  Serial.println("=== FIN DIAGNOSTIC /oled/clear ===");
  server.send(200,"text/plain","OK");
}

// GET /oled/logo — muestra el logo MDE real (ver bitmaps PROGMEM al
// principio del archivo), en el tamaño detectado por /oled/test.
void handleOledLogo() {
  if (hayConflictoRecurso(progUsaOled) && server.arg("forzar") != "1") {
    flog('W', "OLED ocupado por BLOCKLY (Panel intento Logo MDE)");
    server.send(409, "application/json", "{\"conflicto\":true,\"recurso\":\"oled\",\"mensaje\":\"Blockly esta utilizando la pantalla OLED.\"}");
    return;
  }
  if (hayConflictoRecurso(progUsaOled)) detenerBlockly("conflicto OLED, Panel tomo control (Logo MDE)");
  Serial.println("=== OLED DIAGNOSTIC: /oled/logo ===");
  Serial.print("oledPanelDetectado: "); Serial.println(oledPanelDetectado);
  if (!oledPanelDetectado) { Serial.println("-> ABORT: no se corrio Probar antes"); sendJsonError(409, "Ejecutar Probar antes de mostrar el Logo"); return; }
  Serial.print("Reusando tamano/addr de la ultima prueba: "); Serial.print(oledPanelAncho); Serial.print("x"); Serial.print(oledPanelAlto);
  Serial.print(" @0x"); Serial.println(oledPanelAddr, HEX);
  Adafruit_SSD1306 d(oledPanelAncho, oledPanelAlto, &Wire, -1);
  bool ok = d.begin(SSD1306_SWITCHCAPVCC, oledPanelAddr);
  Serial.print("d.begin() -> "); Serial.println(ok?"OK":"FALLO");
  if (!ok) {
    Serial.println("-> ABORT: el OLED no respondio en esta llamada");
    sendJsonError(409, "OLED no responde en la ultima direccion detectada"); return;
  }
  d.clearDisplay();
  if (oledPanelAlto == 32) { d.drawBitmap(0,0,LOGO_MDE_91,128,32,SSD1306_WHITE); Serial.println("drawBitmap LOGO_MDE_91 (128x32)"); }
  else                     { d.drawBitmap(0,0,LOGO_MDE_96,128,64,SSD1306_WHITE); Serial.println("drawBitmap LOGO_MDE_96 (128x64)"); }
  d.display();
  Serial.println("d.display() ejecutado");
  Serial.println("=== FIN DIAGNOSTIC /oled/logo ===");
  server.send(200,"text/plain","OK");
}

void loadConfig() {
  prefs.begin("franky",true);
  i2cEnabled=prefs.getBool("i2c",false); spiEnabled=prefs.getBool("spi",false);
  i2cSda=prefs.getUChar("i2csda",PIN_I2C_SDA); i2cScl=prefs.getUChar("i2cscl",PIN_I2C_SCL);
  prefs.end();
  // Defensivo: si por algún motivo quedó persistido un par inválido (ej.
  // firmware anterior, dato corrupto), volver al default de fábrica en
  // vez de arrancar con un GPIO fuera del pool permitido.
  if (!esPinI2CValido(i2cSda) || !esPinI2CValido(i2cScl) || i2cSda==i2cScl) {
    i2cSda = PIN_I2C_SDA; i2cScl = PIN_I2C_SCL;
  }
}
void handleDebug() {
  String out="=== SPIFFS ===\n";
  File root=SPIFFS.open("/"); File f=root.openNextFile();
  while(f){out+=String(f.name())+" ("+String(f.size())+"b)\n";f=root.openNextFile();}
  out+="\nFW: "+String(FW_VER)+"\nTrimA: "+String(trimA)+"\nTrimB: "+String(trimB);
  out+="\nMini: tipo="+String(cfgMini.tipoDistSensor)+" nds="+String(cfgMini.numDistSensores);
  out+=" nb="+String(cfgMini.numBorde)+" usharp="+String(cfgMini.umbralSharp);
  out+="\nMicro: tipo="+String(cfgMicro.tipoDistSensor)+" usharp="+String(cfgMicro.umbralSharp);
  server.send(200,"text/plain",out);
}

// ═══════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Franky 4.0 v" + String(FW_VER) + " ===");
  pinMode(PIN_LED,OUTPUT); digitalWrite(PIN_LED,HIGH);
  pinMode(PIN_BTN,INPUT_PULLUP);
  dht.begin();

  ledcSetup(CH_A1,PWM_FREQ,PWM_RES); ledcAttachPin(PIN_MA_IN1,CH_A1);
  ledcSetup(CH_A2,PWM_FREQ,PWM_RES); ledcAttachPin(PIN_MA_IN2,CH_A2);
  ledcSetup(CH_B1,PWM_FREQ,PWM_RES); ledcAttachPin(PIN_MB_IN1,CH_B1);
  ledcSetup(CH_B2,PWM_FREQ,PWM_RES); ledcAttachPin(PIN_MB_IN2,CH_B2);

  // Fase 4.1: reservas de fábrica primero (motor/LED/botón/ADC), después
  // se carga la config guardada y recién ahí se sincronizan las reservas
  // dinámicas (I2C/bus alternativo) contra el estado real cargado — en
  // ese orden, nunca al revés, para que loadConfig() no pueda pisar una
  // reserva de fábrica.
  gpioInicializarReservasDeFabrica();

  loadConfig();
  gpioSincronizarBuses();
  loadSumoConfig();
  gpioAplicarReservasSumoActivo(); // Fase 4.2 — reserva los pines del perfil activo también al arrancar, no solo al cambiar de modo en caliente
  cargarProg();

  // Fase 4.2: Wire.begin() explícito sobre el par SDA/SCL realmente
  // configurado — antes de esta fase no se llamaba en ningún lado del
  // .ino; el único punto que toca I2C (OP_OLED_INIT, vía
  // display.begin()) dependía del comportamiento por defecto de la
  // librería Adafruit_SSD1306/Wire, que no necesariamente coincide con
  // GPIO6/7. Se llama solo si i2cEnabled, para no inicializar un bus que
  // el usuario dejó apagado desde Panel Industrial.
  Serial.println("=== OLED DIAGNOSTIC: setup() ===");
  Serial.print("I2C enabled (cargado de NVS): "); Serial.println(i2cEnabled);
  Serial.print("i2cSda: "); Serial.print(i2cSda); Serial.print("  i2cScl: "); Serial.println(i2cScl);
  if (i2cEnabled) {
    Wire.begin(i2cSda, i2cScl);
    // ÚNICO CAMBIO DE ESTA ENTREGA — ver acuerdo de aislamiento total.
    // Wire.setClock() debe llamarse DESPUÉS de Wire.begin() (antes no
    // tendría efecto, begin() reinicializa el periférico I2C). Pasa el
    // bus de 100kHz (por defecto, nunca se había fijado explícitamente
    // en ningún lado del archivo — confirmado por grep) a 400kHz
    // ("Fast Mode" I2C estándar). Según el cálculo de la auditoría
    // anterior, esto reduce el tiempo estimado de un display.display()
    // completo (1024 bytes) de ~90-110ms a ~23-28ms — no se mide todavía
    // en esta entrega (eso es instrumentación, acordado para después),
    // es un cambio de configuración puro.
    Wire.setClock(400000);
    Serial.print("Wire.begin("); Serial.print(i2cSda); Serial.print(","); Serial.print(i2cScl); Serial.println(") ejecutado");
    Serial.println("Wire.setClock(400000) ejecutado");
  } else {
    Serial.println("Wire.begin() NO ejecutado (I2C deshabilitado) -- display global sin bus inicializado");
  }
  Serial.println("=== FIN DIAGNOSTIC setup() ===");

  if(!SPIFFS.begin(true)) { Serial.println("ERROR: SPIFFS fallo!"); }
  else {
    Serial.println("SPIFFS OK");
    File root=SPIFFS.open("/"); File f=root.openNextFile();
    while(f){Serial.println("  "+String(f.name()));f=root.openNextFile();}
  }

  WiFi.softAP(WIFI_SSID,WIFI_PASS);
  Serial.println("AP: "+String(WIFI_SSID)+" IP: "+WiFi.softAPIP().toString());
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
  // Monitor Serie Virtual — mensajes de arranque, mismos datos que ya
  // se ven por Serial USB, ahora también disponibles por WiFi sin cable.
  flog('I', "FRANKY Server iniciado (FW " + String(FW_VER) + ")");
  flog('I', "WiFi AP: " + String(WIFI_SSID) + "  IP: " + WiFi.softAPIP().toString());
  flog('I', String("I2C: ") + (i2cEnabled ? "ENABLED" : "disabled") +
             (i2cEnabled ? (" SDA=" + String(i2cSda) + " SCL=" + String(i2cScl)) : ""));
  server.on("/api",             handleAPI);
  server.on("/debug",           handleDebug);
  server.on("/bloques/list",    handleBloquesListAPI);
  server.on("/mv",              handleMove);
  server.on("/st",              handleStop);
  server.on("/spd",             handleSpeed);
  server.on("/stopall",         handleStopAll);
  server.on("/sumo/config",     handleSumoConfig);
  server.on("/sumo/trim",       handleSumoTrim);
  server.on("/sumo/micro",      handleSumoMicro);
  server.on("/sumo/mini",       handleSumoMini);
  server.on("/sumo/stop",       handleSumoStop);
  server.on("/sumo/estado",     handleSumoEstado); // Persistencia Sumo — nuevo, lectura para restaurar sumo.html
  server.on("/bloques/add",     handleBloquesAdd);
  server.on("/bloques/del",     handleBloquesDel);
  server.on("/bloques/run",     handleBloquesRun);
  server.on("/bloques/stop",    handleBloquesStop);
  server.on("/bloques/clear",   handleBloquesClear);
  server.on("/bloques/xml",     HTTP_GET,  handleBloquesXmlGet);       // PROGRAMA FUENTE — nuevo
  server.on("/bloques/xml",     HTTP_POST, handleBloquesXmlSet);       // PROGRAMA FUENTE — nuevo
  server.on("/bloques/marcarFuente", HTTP_POST, handleBloquesMarcarFuente); // PROGRAMA FUENTE — nuevo
  server.on("/auto/vivero",     handleAutoVivero);
  server.on("/auto/meteo",      handleAutoMeteo);
  server.on("/auto/alarma",     handleAutoAlarma);
  server.on("/auto/alarma/reset", handleAlarmaReset);
  server.on("/auto/acceso",     handleAutoAcceso);
  server.on("/auto/stop",       handleAutoStop);
  server.on("/panel/config",    handlePanelConfig);
  server.on("/panel/save",      handlePanelSave);
  server.on("/gpio/estado",     handleGpioEstado); // Fase 4.1 — nuevo, no rompe nada existente
  server.on("/runtime/estado",  handleRuntimeEstado); // CAPA 2 — nuevo
  server.on("/runtime/pagina",  handleRuntimePagina);   // Diagnóstico avanzado — PAGE_ENTER
  server.on("/runtime/navegador", handleRuntimeNavegador); // Diagnóstico avanzado — BROWSER_ERROR/FETCH_ERROR
  server.on("/monitor/log",     handleMonitorLog);   // Monitor Serie Virtual — nuevo
  server.on("/monitor/debug",   handleMonitorDebug); // Monitor Serie Virtual — nuevo
  server.on("/log",             handleLogTexto); // BLOQUE A — bitácora tecnica, texto plano
  server.on("/log.txt",         handleLogTexto); // alias, mismo contenido
  server.on("/LOG",             handleLogTexto); // alias en mayusculas — el WebServer distingue mayus/minus, se registra explicito
  server.on("/i2c/set",         handleI2CSet);      // Fase 4.2 — nuevo, no rompe nada existente
  server.on("/i2c/scan",        handleI2cScan);      // Fase 4.3 — nuevo
  server.on("/oled/test",       handleOledTest);     // Fase 4.3 — nuevo
  server.on("/oled/clear",      handleOledClear);    // Fase 4.3 — nuevo
  server.on("/oled/logo",       handleOledLogo);      // Fase 4.3 — nuevo
  server.on("/proyecto/export", handleProyectoExport);            // Proyecto FRANKY — nuevo
  server.on("/proyecto/import", HTTP_POST, handleProyectoImport); // Proyecto FRANKY — nuevo
  server.on("/led/on",          handleLedOn);
  server.on("/led/off",         handleLedOff);
  server.on("/led/brillo",      handleLedBrillo);
  server.on("/gpio/out",        handleGpioOut);
  server.on("/sumo/umbral",     handleSumoUmbral);
  server.on("/sonar/read",      handleSonarRead);
  server.on("/sonar/stop",      handleSonarStop);
  server.on("/dht/pin",         handleDhtPin);
  server.on("/gpio/read",       handleGpioRead);

  server.on("/",                [](){serveFile("/index.html");});
  server.on("/gamepad",         [](){serveFile("/gamepad.html");});
  server.on("/sumo",            [](){serveFile("/sumo.html");});
  server.on("/bloques",         [](){serveFile("/bloques.html");});
  server.on("/auto",            [](){serveFile("/auto.html");});
  server.on("/panel",           [](){serveFile("/panel.html");});
  server.on("/proyecto",        [](){serveFile("/proyecto.html");});
  server.on("/programa",        [](){serveFile("/programa.html");});   // PROGRAMA FUENTE — Modo Ver/Ejecutar, nuevo
  server.on("/programa.html",   [](){serveFile("/programa.html");});
  // CAPA 5 — /LOG con mayúsculas exactas como se pidió (el WebServer de
  // Arduino-ESP32 usa comparación exacta de string en server.on(), sí
  // distingue mayúsculas/minúsculas — confirmado por su implementación
  // estándar de enrutado). Se registra /log como alias por comodidad,
  // ambos sirven el mismo archivo.
  // BLOQUE A — /monitor sirve la pagina completa del Monitor Serie
  // Virtual (herramienta VISUAL, se conserva tal cual — NO es el LOG
  // tecnico, que ahora vive en /log como texto plano, ver arriba).
  // Útil especialmente en pantallas chicas donde el widget flotante de
  // las demás páginas puede quedar incómodo.
  server.on("/monitor",         [](){serveFile("/monitor.html");});
  server.on("/panel_config",    [](){serveFile("/panel_config.html");});
  server.on("/manual",          [](){serveFile("/manual.html");});
  server.on("/camera",          [](){serveFile("/camera.html");});
  server.on("/index.html",      [](){serveFile("/index.html");});
  server.on("/gamepad.html",    [](){serveFile("/gamepad.html");});
  server.on("/sumo.html",       [](){serveFile("/sumo.html");});
  server.on("/bloques.html",    [](){
    server.sendHeader("Cache-Control","no-cache, no-store, must-revalidate");
    server.sendHeader("Pragma","no-cache"); server.sendHeader("Expires","0");
    serveFile("/bloques.html");
  });
  server.on("/auto.html",           [](){serveFile("/auto.html");});
  server.on("/panel.html",          [](){serveFile("/panel.html");});
  server.on("/proyecto.html",       [](){serveFile("/proyecto.html");});
  server.on("/panel_config.html",   [](){serveFile("/panel_config.html");});
  server.on("/manual.html",         [](){serveFile("/manual.html");});
  server.on("/camera.html",         [](){serveFile("/camera.html");});
  server.on("/style.css",           [](){serveFile("/style.css");});
  server.on("/logo.jpg",            [](){serveFile("/logo.jpg");});
  server.on("/bly_core_1.js",       [](){serveFile("/bly_core_1.js");});
  server.on("/bly_core_2.js",       [](){serveFile("/bly_core_2.js");});
  server.on("/bly_core_3.js",       [](){serveFile("/bly_core_3.js");});
  server.on("/bly_core_4.js",       [](){serveFile("/bly_core_4.js");});
  server.on("/bly_core_5.js",       [](){serveFile("/bly_core_5.js");});
  server.on("/bly_blocks.js",       [](){serveFile("/bly_blocks.js");});
  server.on("/bly_js.js",           [](){serveFile("/bly_js.js");});
  server.on("/bly_msg.js",          [](){serveFile("/bly_msg.js");});
  server.onNotFound(handleNotFound);

  server.begin();
  Serial.println("HTTP OK — http://192.168.4.1");
  for(int i=0;i<3;i++){digitalWrite(PIN_LED,LOW);delay(150);digitalWrite(PIN_LED,HIGH);delay(150);}
}

// ═══════════════════════════════════════════════════════
//  LOOP — No bloqueante
// ═══════════════════════════════════════════════════════
void loop() {
  server.handleClient();
  chequearBotonSumo(); // Fase "Persistencia Sumo" — independiente del switch de abajo, ver nota de diseño junto a su definición
  switch(currentMode){
    case MODE_MICRO:
      if(modeRunning&&millis()-tModo>50){tModo=millis();ejecutarMicro();}
      break;
    case MODE_MINI:
      if(modeRunning&&millis()-tModo>50){tModo=millis();ejecutarMini();}
      break;
    case MODE_BLOQUES:
      if(modeRunning&&millis()-tModo>20){tModo=millis();ejecutarBloque();}
      break;
    case MODE_VIVERO:  loopVivero(); break;
    case MODE_METEO:   loopMeteo();  break;
    case MODE_ALARMA:
      if(millis()-tModo>200){tModo=millis();loopAlarma();}
      break;
    case MODE_ACCESO:
      if(millis()-tModo>100){tModo=millis();loopAcceso();}
      break;
    default: break;
  }
}
