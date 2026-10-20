class CoherentSoftGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.gain = 1;
    this.port.onmessage = (event) => { this.enabled = event.data.enabled === true; };
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
    const level = Math.min(1, Math.max(0, (rms - 0.0025) / 0.009));
    const target = this.enabled ? 0.3 + 0.7 * level : 1;
    this.gain += (target - this.gain) * (target > this.gain ? 0.35 : 0.015);
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
