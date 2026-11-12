// Capture only the caller's existing microphone track. Never acquire another mic.
class TranslationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(16000 * 6);
    this.preroll = new Float32Array(3200);
    this.preIndex = 0;
    this.preCount = 0;
    this.length = 0;
    this.voiced = 0;
    this.silence = 0;
    this.active = false;
    this.sum = 0;
    this.weight = 0;
    this.ratio = sampleRate / 16000;
    this.frame = new Float32Array(320);
    this.frameLength = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "reset") {
        this.length = this.voiced = this.silence = this.preCount = this.preIndex = this.frameLength = 0;
        this.sum = this.weight = 0;
        this.active = false;
      }
    };
  }

  emit() {
    if (this.voiced >= 4800) {
      const audio = this.samples.slice(0, this.length);
      this.port.postMessage({ type: "audio", audio }, [audio.buffer]);
    }
    this.length = this.voiced = this.silence = 0;
    this.active = false;
    this.preCount = this.preIndex = 0;
  }

  acceptFrame() {
    let energy = 0;
    for (const value of this.frame) energy += value * value;
    const speech = Math.sqrt(energy / this.frame.length) >= 0.006;
    if (!this.active && speech) {
      this.active = true;
      for (let i = 0; i < this.preCount; i++) {
        this.samples[this.length++] = this.preroll[(this.preIndex - this.preCount + i + this.preroll.length) % this.preroll.length];
      }
    }
    if (this.active) {
      this.samples.set(this.frame, this.length);
      this.length += this.frame.length;
      if (speech) { this.voiced += this.frame.length; this.silence = 0; }
      else this.silence += this.frame.length;
      if (this.length >= this.samples.length || this.silence >= 9600) this.emit();
    } else {
      for (const value of this.frame) {
        this.preroll[this.preIndex] = value;
        this.preIndex = (this.preIndex + 1) % this.preroll.length;
        this.preCount = Math.min(this.preCount + 1, this.preroll.length);
      }
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // Streaming area resampling keeps fractional sample positions across quanta,
    // including 44.1 kHz devices. Whisper always receives mono PCM at 16 kHz.
    for (const sample of channel) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const portion = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * portion;
        this.weight += portion;
        remaining -= portion;
        if (this.weight >= this.ratio - 1e-8) {
          this.frame[this.frameLength++] = this.sum / this.ratio;
          this.sum = this.weight = 0;
          if (this.frameLength === this.frame.length) {
            this.acceptFrame();
            this.frameLength = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("coherent-translation-capture", TranslationCapture);
