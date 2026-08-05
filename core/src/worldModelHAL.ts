/**
 * FRANKY LAB — Core / MCU concreto respaldado por World Model
 *
 * La única implementación de RobotHAL que existe hoy. Lee/escribe
 * exclusivamente contra un WorldModel — nunca contra el Motor de
 * Simulación directamente (principio ya validado en ADR ADR-002/003).
 */
import { RobotHAL } from "./robotHal.js";
import { WorldModel, getRobot } from "./worldModel.js";

export class WorldModelHAL implements RobotHAL {
  constructor(
    private world: WorldModel,
    private robotId: string,
  ) {}

  millis(): number {
    return this.world.clock.simTime;
  }
  analogRead(pin: number): number {
    return getRobot(this.world, this.robotId).pins.analog[pin] ?? 4095;
  }
  digitalRead(pin: number): number {
    return getRobot(this.world, this.robotId).pins.digital[pin] ?? 1;
  }
  digitalWrite(pin: number, value: number): void {
    getRobot(this.world, this.robotId).pins.digital[pin] = value ? 1 : 0;
  }
  pwmWrite(pin: number, duty: number): void {
    getRobot(this.world, this.robotId).pins.pwm[pin] = Math.max(0, Math.min(255, duty));
  }
}
