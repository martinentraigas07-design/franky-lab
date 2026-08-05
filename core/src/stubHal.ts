/** FRANKY LAB — Core / StubHAL: RobotHAL controlable a mano, para tests aislados. */
import { RobotHAL } from "./robotHal.js";

export class StubHAL implements RobotHAL {
  private manualClock = 0;
  private analogValues = new Map<number, number>([[0, 0], [1, 0]]);
  private digitalValues = new Map<number, number>([[9, 1]]);
  private pwmValues = new Map<number, number>();

  millis(): number { return this.manualClock; }
  advance(ms: number): void { this.manualClock += ms; }

  analogRead(pin: number): number { return this.analogValues.get(pin) ?? 4095; }
  digitalRead(pin: number): number { return this.digitalValues.get(pin) ?? 1; }
  digitalWrite(pin: number, value: number): void { this.digitalValues.set(pin, value); }
  pwmWrite(pin: number, duty: number): void { this.pwmValues.set(pin, Math.max(0, Math.min(255, duty))); }

  setAnalog(pin: number, value: number): void { this.analogValues.set(pin, Math.max(0, Math.min(4095, value))); }
  getPwm(pin: number): number { return this.pwmValues.get(pin) ?? 0; }
  getDigital(pin: number): number { return this.digitalValues.get(pin) ?? 1; }
}
