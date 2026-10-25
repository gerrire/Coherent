class CoherentSystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.frames = 0;
    this.peak = 0;
    this.underruns = 0;
    this.port.onmessage = (event) => {
      this.queue.push(event.data);
      // Bound the queue if the WebView falls behind the native capture thread.
      if (this.queue.length > 20) {
        this.queue.shift();
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    for (let frame = 0; frame < output[0].length; frame++) {
      while (this.queue.length && this.offset >= this.queue[0].length) {
        this.queue.shift();
        this.offset = 0;
      }
      if (this.queue.length) {
        const packet = this.queue[0];
        output[0][frame] = packet[this.offset] / 32768;
        output[1][frame] = packet[this.offset + 1] / 32768;
        this.peak = Math.max(this.peak, Math.abs(output[0][frame]), Math.abs(output[1][frame]));
        this.offset += 2;
      } else {
        output[0][frame] = 0;
        output[1][frame] = 0;
        this.underruns++;
      }
    }
    this.frames += output[0].length;
    if (this.frames >= 480000) {
      this.port.postMessage({ frames: this.frames, peak: Math.round(this.peak * 32768), underruns: this.underruns });
      this.frames = 0;
      this.peak = 0;
      this.underruns = 0;
    }
    return true;
  }
}

registerProcessor("coherent-system-audio", CoherentSystemAudioProcessor);
