import { getRobot } from "./worldModel.js";
export class WorldModelHAL {
    world;
    robotId;
    constructor(world, robotId) {
        this.world = world;
        this.robotId = robotId;
    }
    millis() {
        return this.world.clock.simTime;
    }
    analogRead(pin) {
        return getRobot(this.world, this.robotId).pins.analog[pin] ?? 4095;
    }
    digitalRead(pin) {
        return getRobot(this.world, this.robotId).pins.digital[pin] ?? 1;
    }
    digitalWrite(pin, value) {
        getRobot(this.world, this.robotId).pins.digital[pin] = value ? 1 : 0;
    }
    pwmWrite(pin, duty) {
        getRobot(this.world, this.robotId).pins.pwm[pin] = Math.max(0, Math.min(255, duty));
    }
}
