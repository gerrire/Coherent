class CoherentSoftGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "soft";
    this.gain = 1;
    this.speechHold = 0;
    this.speechFrames = 0;
    this.port.onmessage = (event) => { this.mode = event.data.mode || "soft"; };
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
    let peak = 0;
    for (const channel of input) {
      for (const sample of channel) {
        energy += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      count += channel.length;
    }
    const rms = Math.sqrt(energy / Math.max(1, count));
    let target = 1;
    if (this.mode === "soft") {
      // A low floor reduces hiss between words without silencing quiet syllables.
      const level = Math.min(1, Math.max(0, (rms - 0.0025) / 0.009));
      target = 0.3 + 0.7 * level;
      this.gain += (target - this.gain) * (target > this.gain ? 0.35 : 0.015);
    } else {
      // Brief, high-crest-factor clicks in pauses are attenuated; sustained speech remains at full level.
      const crest = peak / Math.max(rms, 0.00001);
      const isolatedClick = this.speechHold === 0 && rms > 0.0035 && peak > 0.025 && crest > 4.5;
      target = isolatedClick ? 0.25 : 1;
      this.gain = target;
      this.speechHold = Math.max(0, this.speechHold - 1);
      this.speechFrames = rms > 0.007 && crest < 4.5 ? Math.min(8, this.speechFrames + 1) : 0;
      if (this.speechFrames >= 4) this.speechHold = 90;
    }
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
