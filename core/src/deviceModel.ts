/**
 * FRANKY LAB — Device Model real (reemplaza el manifest estático de la
 * Fase 1, que quedó desactualizado y nunca se conectó a nada).
 *
 * Cada dispositivo describe: pines usados, bus, recurso compartido (para
 * detectar conflictos reales, ej. dos dispositivos I2C en el mismo bus no
 * chocan, pero un GPIO usado por dos cosas distintas sí), y qué opcodes
 * del Runtime BLOQUES indican que un programa lo está usando — esto es
 * lo que el Hardware Workspace consulta para decidir qué mostrar.
 *
 * Opcodes 0-74: reales, ya en el firmware físico.
 * Opcodes 90+: extensión de Laboratorio (Fase 3) — ver informe de
 * migración para qué falta incorporar al firmware oficial.
 */

export type Bus = "gpio" | "i2c" | "spi" | "uart" | "pwm" | "adc" | "none";

export interface DeviceDescriptor {
  id: string;
  name: string;
  bus: Bus;
  pins: number[]; // pines FIJOS conocidos de antemano (los dinámicos, ej. GPIO de un servo elegido en el bloque, no se listan acá)
  sharedResource: string | null; // ej. "i2c-bus-0" — dos dispositivos con el mismo valor comparten bus, no es conflicto por sí solo
  opcodes: number[]; // qué opcodes, si aparecen en el programa cargado, activan este dispositivo en el Hardware Workspace
  real: boolean; // true = existe tal cual en el firmware físico hoy; false = extensión de Laboratorio (Fase 3)
}

export const DEVICE_MODEL: DeviceDescriptor[] = [
  { id: "motores", name: "Motores", bus: "gpio", pins: [5, 4, 3, 2], sharedResource: null, opcodes: [1, 2, 3, 4, 5, 11, 22], real: true },
  { id: "led", name: "LED", bus: "gpio", pins: [8], sharedResource: null, opcodes: [7, 8], real: true },
  { id: "gpio", name: "GPIO / Salidas", bus: "gpio", pins: [], sharedResource: null, opcodes: [20], real: true },
  { id: "boton", name: "Botón START", bus: "gpio", pins: [9], sharedResource: null, opcodes: [], real: true },
  { id: "sensores_adc", name: "Sensores (ADC0/ADC1)", bus: "adc", pins: [0, 1], sharedResource: null, opcodes: [9, 30, 70, 71, 120, 121, 110, 111, 112, 114], real: true },
  { id: "linea_centro", name: "Línea — sensor centro (digital)", bus: "gpio", pins: [6], sharedResource: null, opcodes: [113], real: true },
  { id: "servo", name: "Servo", bus: "pwm", pins: [], sharedResource: null, opcodes: [40], real: true },
  { id: "variables", name: "Variables", bus: "none", pins: [], sharedResource: null, opcodes: [60, 61, 62, 90, 94, 95, 96, 97, 98, 99, 100], real: true },
  {
    id: "oled", name: "OLED I²C 128x64", bus: "i2c", pins: [6, 7], sharedResource: "i2c-bus-0",
    opcodes: [101, 102, 103, 104, 105, 106, 107, 108], real: false,
  },
  {
    id: "serial", name: "Monitor Serie", bus: "uart", pins: [], sharedResource: null,
    opcodes: [122], real: false,
  },
  {
    id: "buzzer", name: "Buzzer", bus: "pwm", pins: [], sharedResource: null,
    opcodes: [123], real: false,
  },
  {
    id: "mcp3208", name: "MCP3208 (ADC externo, 8 canales)", bus: "spi", pins: [], sharedResource: "spi-bus-0",
    opcodes: [], real: false, // sin opcode todavía — ver informe de migración
  },
  {
    id: "qtr8a", name: "QTR-8A (array de línea, vía MCP3208)", bus: "spi", pins: [], sharedResource: "spi-bus-0",
    opcodes: [], real: false,
  },
];

/** Dado el programa cargado (lista de opcodes), qué dispositivos están realmente en uso. */
export function devicesUsedByProgram(opcodes: number[]): DeviceDescriptor[] {
  const used = new Set(opcodes);
  return DEVICE_MODEL.filter((d) => d.opcodes.some((op) => used.has(op)));
}

/**
 * Conflictos de hardware reales detectables con lo que ya sabemos: dos
 * dispositivos en uso que reclaman el MISMO pin fijo, y no comparten
 * `sharedResource` (si lo comparten, ej. dos cosas en el mismo bus I2C,
 * no es conflicto). Ejemplo real ya encontrado en este mismo proyecto:
 * OLED (I2C, GPIO6/7) y el sensor centro de Línea (GPIO6, digital) usan
 * el MISMO pin — si un programa usara ambos a la vez, chocarían de
 * verdad en el robot físico.
 */
export function detectPinConflicts(devices: DeviceDescriptor[]): { pin: number; devices: string[] }[] {
  const byPin = new Map<number, DeviceDescriptor[]>();
  for (const d of devices) {
    for (const pin of d.pins) {
      if (!byPin.has(pin)) byPin.set(pin, []);
      byPin.get(pin)!.push(d);
    }
  }
  const conflicts: { pin: number; devices: string[] }[] = [];
  for (const [pin, ds] of byPin) {
    if (ds.length < 2) continue;
    const distinctResources = new Set(ds.map((d) => d.sharedResource ?? d.id));
    if (distinctResources.size > 1) conflicts.push({ pin, devices: ds.map((d) => d.name) });
  }
  return conflicts;
}
