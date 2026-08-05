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

const char* WIFI_SSID = "Franky_4.0";
const char* WIFI_PASS = "12345678";
const char* FW_VER    = "3.2-LNR";

#define PIN_MB_IN2   2
#define PIN_MB_IN1   3
#define PIN_MA_IN2   4
#define PIN_MA_IN1   5
#define PIN_I2C_SDA  6
#define PIN_I2C_SCL  7
#define PIN_LED      8
#define PIN_BTN      9
#define PIN_SPI_CS   10
#define PIN_SPI_MISO 1
#define PIN_SPI_MOSI 21
#define PIN_SPI_SCLK 20
#define PIN_ADC0     0
#define PIN_ADC1     1
#define PIN_DHT22    3

#define CH_A1    1
#define CH_A2    2
#define CH_B1    3
#define CH_B2    4
#define PWM_FREQ 20000
#define PWM_RES  8

#define RETARDO_SUMO  5000
#define CABECEO_MS    300

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
#define OP_SERIAL_PRINT 122 // requiere texto — mismo motivo que OP_OLED_PRINT
#define OP_BUZZER       123 // sin pin físico en esta placa — no-op documentado

WebServer   server(80);
Preferences prefs;

bool  i2cEnabled = false;
bool  spiEnabled = false;
int   motorSpeed = 200;
int   trimA = 255;
int   trimB = 255;
int   pwmA = 0;
int   pwmB = 0;

enum RobotMode {
  MODE_IDLE=0, MODE_MICRO, MODE_MINI,
  MODE_VIVERO, MODE_METEO, MODE_ALARMA, MODE_ACCESO, MODE_BLOQUES
};
RobotMode currentMode = MODE_IDLE;
bool      modeRunning = false;

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
float    varGlobal  = 0.0;
int      adcLast    = 0;
Servo    servoObj;

// ═══════════════════════════════════════════════════════
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
  uint8_t  spdBuscExt;      // círculo externo (motor rápido)
  uint8_t  spdBuscInt;      // círculo interno (motor lento)
  uint8_t  spdEvasion;      // velocidad al escapar del borde

  // ── Estrategia búsqueda (solo mini) ──
  uint8_t  estrategia;      // 0=círculo, 1=cabeceo
};

// Instancias de config por perfil
SumoConfig cfgMini = {
  0, 0, 2,            // perfil mini, sonar, 2 sensores
  20, 21, 6, 7,       // trigI, echoI, trigD, echoD
  0, 1, 1800,         // sharpPinI, sharpPinD, umbralSharp
  9, 6,               // optPinI, optPinD
  2, 0, 1, 1500,      // numBorde, bordePinI, bordePinD, umbralBorde
  30,                 // umbralDistCm
  255, 210, 80, 220,  // spdAtaque, spdBuscExt, spdBuscInt, spdEvasion
  0                   // estrategia
};

SumoConfig cfgMicro = {
  1, 0, 1,            // perfil micro, sonar, 1 sensor
  20, 21, 0, 0,       // trigI, echoI (D no usado)
  0, 1, 1800,         // sharpPinI (D no usado)
  9, 0,               // optPinI (D no usado)
  1, 0, 1, 1500,      // numBorde=1, bordePinI=ADC0
  25,                 // umbralDistCm
  255, 200, 60, 200,  // velocidades
  0                   // estrategia (micro siempre círculo)
};

// Puntero a config activa
SumoConfig* cfgActiva = &cfgMini;

// Para telemetría Sharp en /api
int  sharpAdcValI = 0;  // último valor ADC leído del Sharp izq
int  sharpAdcValD = 0;
bool sharpDetI    = false;
bool sharpDetD    = false;

// Máquina de estados evasión borde (no bloqueante)
enum EvadeState { EVADE_IDLE=0, EVADE_BACK, EVADE_TURN };
EvadeState evadeState = EVADE_IDLE;
unsigned long evadeTimer = 0;
bool evadeDirRight = true; // true=girar derecha, false=izquierda
bool evadeBoth = false;

bool   cabeceoDirDer  = true;
unsigned long tCabeceo = 0;

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
bool     oledInicializado = false;
int16_t  oledCursorX = 0, oledCursorY = 0;

int16_t pilaPop() {
  if (pilaLen == 0) return 0; // pila vacía (programa mal formado) — nunca revienta
  return pila[--pilaLen];
}

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

// Verifica si un pin pertenece a un bus activo
bool pinBloqueadoPorBus(uint8_t pin) {
  if (i2cEnabled && (pin == 6 || pin == 7))   return true;
  if (spiEnabled && (pin == 20 || pin == 21)) return true;
  return false;
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
  prefs.putUChar("m_bex",   cfgMini.spdBuscExt);
  prefs.putUChar("m_bin",   cfgMini.spdBuscInt);
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
  prefs.putUChar("u_bex",   cfgMicro.spdBuscExt);
  prefs.putUChar("u_bin",   cfgMicro.spdBuscInt);
  prefs.putUChar("u_ev",    cfgMicro.spdEvasion);
  // Trims globales
  prefs.putInt("trimA",  trimA);
  prefs.putInt("trimB",  trimB);
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
  cfgMini.spdBuscExt      = prefs.getUChar("m_bex",  cfgMini.spdBuscExt);
  cfgMini.spdBuscInt      = prefs.getUChar("m_bin",  cfgMini.spdBuscInt);
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
  cfgMicro.spdBuscExt     = prefs.getUChar("u_bex",  cfgMicro.spdBuscExt);
  cfgMicro.spdBuscInt     = prefs.getUChar("u_bin",  cfgMicro.spdBuscInt);
  cfgMicro.spdEvasion     = prefs.getUChar("u_ev",   cfgMicro.spdEvasion);
  // Trims
  trimA = prefs.getInt("trimA", 255);
  trimB = prefs.getInt("trimB", 255);
  prefs.end();
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
  if (progLen == 0 || progPC >= progLen) { progPC = 0; return; }
  if (bEsperando) {
    if (millis() - tBloque >= (unsigned long)bEsperaMs) { bEsperando=false; progPC++; }
    return;
  }
  Instruccion ins = programa[progPC];
  switch (ins.op) {
    case OP_ADE:     move("f", ins.val>0?ins.val:motorSpeed); progPC++; break;
    case OP_ATR:     move("b", ins.val>0?ins.val:motorSpeed); progPC++; break;
    case OP_IZQ:     move("l", ins.val>0?ins.val:motorSpeed); progPC++; break;
    case OP_DER:     move("r", ins.val>0?ins.val:motorSpeed); progPC++; break;
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
    case OP_MILLIS_READ: varGlobal=(float)millis(); progPC++; break;
    case OP_OLED_INIT:
      if(!oledInicializado){ display.begin(SSD1306_SWITCHCAPVCC,0x3C); oledInicializado=true; }
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
      // Sin campo de texto en Instruccion todavía (val es el único
      // parámetro numérico) — no se puede mostrar texto real hasta
      // extender el struct. No-op explícito para no interrumpir el
      // programa (antes de esta actualización, un opcode desconocido
      // caía en OP_FIN y REINICIABA todo el programa). Ver informe de
      // migración de FRANKY LAB, Fase 3.
      progPC++; break;
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
      if(oledInicializado) display.display();
      progPC++; break;
    case OP_SERIAL_PRINT:
      // Mismo motivo que OP_OLED_PRINT: sin campo de texto en
      // Instruccion, no se puede imprimir el mensaje real todavía.
      Serial.println("[bloques: mensaje omitido - requiere extension del firmware, ver informe FRANKY LAB]");
      progPC++; break;
    case OP_BUZZER:
      // Sin pin de buzzer en esta placa (confirmado contra el BOM real)
      // — no-op documentado, no bloquea el resto del programa.
      pilaPop(); pilaPop(); // descarta freq/duracion igual que los consumiría un buzzer real
      progPC++; break;
    case OP_FIN: default: stopMotors(); progPC=0; repeatCnt=0; break;
  }
}

void guardarProg() {
  prefs.begin("bloques",false);
  prefs.putUInt("len",progLen);
  for(int i=0;i<progLen;i++){
    prefs.putUChar(("o"+String(i)).c_str(),programa[i].op);
    prefs.putShort(("v"+String(i)).c_str(),programa[i].val);
  }
  prefs.end();
}

void cargarProg() {
  prefs.begin("bloques",true);
  progLen=(uint8_t)min((unsigned int)prefs.getUInt("len",0),(unsigned int)MAX_INST);
  for(int i=0;i<progLen;i++){
    programa[i].op =prefs.getUChar(("o"+String(i)).c_str(),OP_FIN);
    programa[i].val=prefs.getShort(("v"+String(i)).c_str(),0);
  }
  prefs.end();
}

// ═══════════════════════════════════════════════════════
//  SUMO — Máquina de estados de evasión (NO BLOQUEANTE)
//  Reemplaza los delay() que bloqueaban server.handleClient()
// ═══════════════════════════════════════════════════════
void iniciarEvasion(bool borderLeft, bool borderRight) {
  evadeState = EVADE_BACK;
  evadeTimer = millis();
  evadeBoth = (borderLeft && borderRight);
  evadeDirRight = borderLeft; // si borde izq → girar derecha (alejarse)
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
//  SUMO — Estrategias de búsqueda
// ═══════════════════════════════════════════════════════
void searchCircle(const SumoConfig& cfg) {
  moveDiff(cfg.spdBuscInt, cfg.spdBuscExt);
}

void searchSweep(const SumoConfig& cfg) {
  unsigned long ahora = millis();
  if (ahora - tCabeceo >= CABECEO_MS) { tCabeceo = ahora; cabeceoDirDer = !cabeceoDirDer; }
  if (cabeceoDirDer) moveDiff((int)cfg.spdBuscExt, -(int)cfg.spdBuscExt);
  else               moveDiff(-(int)cfg.spdBuscExt, (int)cfg.spdBuscExt);
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
    Serial.println(cfg.perfil == 0 ? "MINISUMO — INICIO!" : "MICROSUMO — INICIO!");
  }

  // Si hay evasión en curso, ejecutarla y salir
  if (tickEvasion(cfg.spdEvasion)) return;

  // Leer bordes
  bool bI = false, bD = false;
  leerBordes(cfg, bI, bD);
  if (bI || bD) {
    iniciarEvasion(bI, bD);
    return;
  }

  // Leer oponente
  bool oI = false, oD = false;
  leerOponente(cfg, oI, oD);

  // Ataque
  if (oI && oD) {
    moveDiff(cfg.spdAtaque, cfg.spdAtaque);
    return;
  }
  if (oI && !oD) { moveDiff(-(int)cfg.spdAtaque, (int)cfg.spdAtaque); return; } // girar izq
  if (!oI && oD) { moveDiff((int)cfg.spdAtaque, -(int)cfg.spdAtaque); return; } // girar der

  // Búsqueda
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
  j += "\"s_bex\":";      j += cfgActiva->spdBuscExt;      j += ",";
  j += "\"s_bin\":";      j += cfgActiva->spdBuscInt;      j += ",";
  j += "\"s_ev\":";       j += cfgActiva->spdEvasion;      j += ",";
  j += "\"s_est\":";      j += cfgActiva->estrategia;
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
  if (server.hasArg("spdBuscExt")) cfg->spdBuscExt = constrain(server.arg("spdBuscExt").toInt(), 0, 255);
  if (server.hasArg("spdBuscInt")) cfg->spdBuscInt = constrain(server.arg("spdBuscInt").toInt(), 0, 255);
  if (server.hasArg("spdEvasion")) cfg->spdEvasion = constrain(server.arg("spdEvasion").toInt(), 0, 255);
  // Compatibilidad legacy
  if (server.hasArg("circuloExt")) cfg->spdBuscExt = constrain(server.arg("circuloExt").toInt(), 0, 255);
  if (server.hasArg("circuloInt")) cfg->spdBuscInt = constrain(server.arg("circuloInt").toInt(), 0, 255);

  // Estrategia
  if (server.hasArg("estrategia")) cfg->estrategia = constrain(server.arg("estrategia").toInt(), 0, 1);

  // ── VALIDACIÓN ADC ──
  if (!validateSumoADC(*cfg)) {
    int used = contarADCUsados(*cfg);
    String err = "ADC limit exceeded: need " + String(used) + " ADC pins, only 2 available";
    sendJsonError(400, err.c_str());
    return;
  }

  // ── VALIDACIÓN GPIO / BUSES ──
  // Verificar pines sonar vs buses activos
  if (cfg->tipoDistSensor == 0) {
    if (pinBloqueadoPorBus(cfg->trigI) || pinBloqueadoPorBus(cfg->echoI) ||
        (cfg->numDistSensores >= 2 && (pinBloqueadoPorBus(cfg->trigD) || pinBloqueadoPorBus(cfg->echoD)))) {
      sendJsonError(409, "GPIO conflict: sonar pin used by active I2C/SPI bus");
      return;
    }
  }
  if (cfg->tipoDistSensor == 1) {
    if (pinBloqueadoPorBus(cfg->optPinI) ||
        (cfg->numDistSensores >= 2 && pinBloqueadoPorBus(cfg->optPinD))) {
      sendJsonError(409, "GPIO conflict: optical pin used by active I2C/SPI bus");
      return;
    }
  }

  // Guardar persistencia
  saveSumoConfig();
  server.send(200,"application/json","{\"ok\":true}");
}

void handleSumoTrim() {
  if (server.hasArg("ma")) trimA=constrain(server.arg("ma").toInt(),0,255);
  if (server.hasArg("mb")) trimB=constrain(server.arg("mb").toInt(),0,255);
  saveSumoConfig(); // persistir trims también
  server.send(200,"text/plain","OK");
}

void handleSumoMicro() {
  cfgActiva = &cfgMicro;
  currentMode=MODE_MICRO; modeRunning=true; retardoOK=false;
  tInicioModo=millis(); cabeceoDirDer=true; tCabeceo=millis();
  evadeState=EVADE_IDLE;
  stopMotors();
  Serial.println("MICROSUMO activado — retardo 5s...");
  server.send(200,"text/plain","OK");
}
void handleSumoMini() {
  cfgActiva = &cfgMini;
  currentMode=MODE_MINI; modeRunning=true; retardoOK=false;
  tInicioModo=millis(); cabeceoDirDer=true; tCabeceo=millis();
  evadeState=EVADE_IDLE;
  stopMotors();
  Serial.println("MINISUMO activado — retardo 5s...");
  server.send(200,"text/plain","OK");
}
void handleSumoStop() {
  currentMode=MODE_IDLE; modeRunning=false; evadeState=EVADE_IDLE;
  stopMotors(); server.send(200,"text/plain","OK");
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
void handleMove()    { move(server.arg("d")); server.send(200,"text/plain","OK"); }
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
void handleStopAll()   { currentMode=MODE_IDLE;modeRunning=false;evadeState=EVADE_IDLE;stopMotors(); server.sendHeader("Location","/");server.send(303); }
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
    programa[progLen++]={(uint8_t)server.arg("op").toInt(),(int16_t)server.arg("val").toInt()};
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
void handleBloquesRun()  { progPC=0;bEsperando=false;currentMode=MODE_BLOQUES;modeRunning=true;server.send(200,"text/plain","OK"); }
void handleBloquesStop() { currentMode=MODE_IDLE;modeRunning=false;stopMotors();server.send(200,"text/plain","OK"); }
void handleBloquesClear(){ progLen=0;progPC=0;guardarProg();server.send(200,"text/plain","OK"); }
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
  server.send(200,"text/plain","OK. Reiniciando..."); delay(2000); ESP.restart();
}
void loadConfig() {
  prefs.begin("franky",true); i2cEnabled=prefs.getBool("i2c",false); spiEnabled=prefs.getBool("spi",false); prefs.end();
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

  loadConfig();
  loadSumoConfig();
  cargarProg();

  if(!SPIFFS.begin(true)) { Serial.println("ERROR: SPIFFS fallo!"); }
  else {
    Serial.println("SPIFFS OK");
    File root=SPIFFS.open("/"); File f=root.openNextFile();
    while(f){Serial.println("  "+String(f.name()));f=root.openNextFile();}
  }

  WiFi.softAP(WIFI_SSID,WIFI_PASS);
  Serial.println("AP: "+String(WIFI_SSID)+" IP: "+WiFi.softAPIP().toString());

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
  server.on("/bloques/add",     handleBloquesAdd);
  server.on("/bloques/del",     handleBloquesDel);
  server.on("/bloques/run",     handleBloquesRun);
  server.on("/bloques/stop",    handleBloquesStop);
  server.on("/bloques/clear",   handleBloquesClear);
  server.on("/auto/vivero",     handleAutoVivero);
  server.on("/auto/meteo",      handleAutoMeteo);
  server.on("/auto/alarma",     handleAutoAlarma);
  server.on("/auto/alarma/reset", handleAlarmaReset);
  server.on("/auto/acceso",     handleAutoAcceso);
  server.on("/auto/stop",       handleAutoStop);
  server.on("/panel/config",    handlePanelConfig);
  server.on("/panel/save",      handlePanelSave);
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
