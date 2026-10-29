/** Detect a dead DSP graph, without treating a quiet microphone as a failure. */
export class AudioFlowGuard {
  private silentSamples = 0;
  private lastInputAt = 0;
  check(inputRms: number, outputRms: number, now: number): boolean {
    if (outputRms > 0.000001 || now - this.lastInputAt > 3000) this.silentSamples = 0;
    if (inputRms > 0.004) {
      this.lastInputAt = now;
      if (outputRms <= 0.000001) this.silentSamples++;
    }
    return this.silentSamples >= 6;
  }
}
