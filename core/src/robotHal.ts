/**
 * FRANKY LAB — Core / MCU (interfaz)
 *
 * Contrato genérico de "qué puede hacer un microcontrolador": leer/escribir
 * pines por número, medir tiempo. Nunca sabe qué representa un pin en
 * términos del robot (eso es Board) ni del firmware (eso es Firmware
 * Runtime). Cualquier MCU concreto (ESP32-C3, ATmega328P...) implementa esto.
 */
export interface RobotHAL {
  millis(): number;
  analogRead(pin: number): number;
  digitalRead(pin: number): number;
  digitalWrite(pin: number, value: number): void;
  /** PWM crudo por pin (0-255). La Board decide qué pin mover para qué efecto. */
  pwmWrite(pin: number, duty: number): void;
}
