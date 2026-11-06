const pauseGain = { "rnnoise-natural": 0.62, "rnnoise-balanced": 0.32, "rnnoise-strong": 0.18 };

class CoherentSoftGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "soft";
    this.gain = 1;
    this.noise = 0.0008;
    this.voice = 0.012;
    this.hold = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "stop") this.stopped = true;
      else this.mode = data.mode;
    };
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!input?.length) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    let energy = 0;
    let peak = 0;
    for (const sample of input) {
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(energy / input.length);
    const duration = input.length / sampleRate;
    const smooth = (seconds) => 1 - Math.exp(-duration / seconds);
    let target = 1;
    if (this.mode === "noisy" || this.mode in pauseGain) {
      const ai = this.mode !== "noisy";
      const click = peak > 0.025 && peak > rms * 5.5;
      const speech = rms > Math.max(ai ? 0.0018 : 0.0025, this.noise * 3.2);
      // A slow, capped rise lets the floor follow fans and mic hiss without
      // learning normal voiced syllables as background.
      this.noise += (Math.min(rms, ai ? 0.006 : 0.012) - this.noise)
        * smooth(rms < this.noise ? 0.12 : speech ? 5 : 0.55);
      this.hold = speech && !click ? 0.18 : Math.max(0, this.hold - duration);
      if (ai && speech && !click) {
        this.voice += (rms - this.voice) * smooth(rms > this.voice ? 0.07 : 0.35);
      }
      const active = this.hold > 0 || (speech && ai);
      target = active ? ai ? Math.max(1, Math.min(5, 0.035 / this.voice)) : 1
        : ai ? pauseGain[this.mode] : 0.4;
    }
    const previous = this.gain;
    this.gain = previous + (target - previous) * smooth(target > previous ? 0.025 : 0.09);
    for (const channel of output) {
      for (let i = 0; i < channel.length; i++) {
        channel[i] = input[i] * (previous + (this.gain - previous) * (i + 1) / channel.length);
      }
    }
    return true;
  }
}

registerProcessor("coherent-soft-gate", CoherentSoftGate);
