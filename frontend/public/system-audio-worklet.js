class CoherentSystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
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
        this.offset += 2;
      } else {
        output[0][frame] = 0;
        output[1][frame] = 0;
      }
    }
    return true;
  }
}

registerProcessor("coherent-system-audio", CoherentSystemAudioProcessor);
