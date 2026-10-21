class CoherentSoftGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "soft";
    this.gain = 1;
    this.port.onmessage = (event) => { this.mode = event.data.mode || "off"; };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    let energy = 0;
    let count = 0;
    for (const channel of input) {
      for (const sample of channel) energy += sample * sample;
      count += channel.length;
    }
    const rms = Math.sqrt(energy / Math.max(1, count));
    // A low floor and gradual envelope reduce hiss between words without silencing quiet syllables.
    const strong = this.mode === "strong";
    const level = Math.min(1, Math.max(0, (rms - (strong ? 0.012 : 0.0025)) / (strong ? 0.016 : 0.009)));
    const target = this.mode === "off" ? 1 : (strong ? 0.035 : 0.3) + (strong ? 0.965 : 0.7) * level;
    this.gain += (target - this.gain) * (target > this.gain ? (strong ? 0.16 : 0.35) : (strong ? 0.025 : 0.015));
    for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
      const source = input[channelIndex] ?? input[0];
      const destination = output[channelIndex];
      for (let index = 0; index < destination.length; index++) {
        destination[index] = (source[index] ?? 0) * this.gain;
      }
    }
    return true;
  }
}

registerProcessor("coherent-soft-gate", CoherentSoftGate);
