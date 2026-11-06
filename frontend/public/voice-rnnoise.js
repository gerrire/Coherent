const FRAME_SIZE = 480;
const PCM_SCALE = 32768;
const MAX_SPEECH_GAIN = 12;
const PAUSE_GAIN = { "rnnoise-natural": 1, "rnnoise-balanced": 0.48, "rnnoise-strong": 0.28 };

class VoiceLevel {
  speech = 0;
  noise = 0.00065;
  voicedFrames = 0;
  hangover = 0;
  gain = 1;
  pause = 1;

  process(frame, probability, pauseGain) {
    let energy = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const sample = frame[i];
      energy += sample * sample;
      const absolute = sample < 0 ? -sample : sample;
      if (absolute > peak) peak = absolute;
    }
    const rms = Math.sqrt(energy / frame.length) / PCM_SCALE;
    const aboveNoise = rms > Math.max(0.0004, this.noise * 1.35);
    this.voicedFrames = probability >= 0.58 && aboveNoise ? Math.min(3, this.voicedFrames + 1) : 0;
    const confirmed = this.voicedFrames >= 2;
    this.hangover = confirmed || (this.hangover > 0 && probability >= 0.48 && aboveNoise)
      ? 14 : Math.max(0, this.hangover - 1);
    if (confirmed) {
      if (!this.speech) this.speech = rms;
      else this.speech += (rms - this.speech) * (rms > this.speech ? 0.09 : 0.018);
    }
    if ((probability < 0.30 || !aboveNoise) && !this.hangover) {
      this.noise += (Math.max(0.0001, rms) - this.noise) * (rms > this.noise ? 0.06 : 0.025);
    }

    // Rise slowly after confirmed voice. A release hold preserves consonants
    // and brief gaps, while the measured noise caps the available gain.
    const target = this.hangover && this.speech
      ? Math.max(1, Math.min(MAX_SPEECH_GAIN, 0.055 / this.speech, 0.0035 / this.noise))
      : 1;
    const gainBefore = this.gain;
    this.gain += (target - this.gain) * (target > this.gain ? 0.035 : 0.15);
    const pauseBefore = this.pause;
    const pauseTarget = this.hangover || (probability >= 0.40 && aboveNoise) ? 1 : pauseGain;
    this.pause += (pauseTarget - this.pause) * (pauseTarget > this.pause ? 0.65 : 0.11);

    const peakGain = peak > 1 ? (0.82 * PCM_SCALE) / peak : MAX_SPEECH_GAIN;
    const start = Math.min(peakGain, gainBefore * pauseBefore) / PCM_SCALE;
    const end = Math.min(peakGain, this.gain * this.pause) / PCM_SCALE;
    const step = (end - start) / frame.length;
    for (let i = 0; i < frame.length; i++) frame[i] *= start + step * (i + 1);
  }
}

async function openRnnoise(bytes) {
  let heap;
  const { instance } = await WebAssembly.instantiate(bytes, {
    env: {
      emscripten_memcpy_big(destination, source, count) {
        heap.copyWithin(destination, source, source + count);
      },
      emscripten_resize_heap: () => 0,
      __assert_fail() { throw new Error("RNNoise WASM assertion failed"); },
    },
  });
  const wasm = instance.exports;
  heap = new Uint8Array(wasm.memory.buffer);
  wasm.emscripten_stack_init();
  wasm.__wasm_call_ctors();
  if (wasm.rnnoise_get_frame_size() !== FRAME_SIZE) throw new Error("Unexpected RNNoise frame size");
  const state = wasm.rnnoise_create(0);
  const input = wasm.malloc(FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT);
  const output = wasm.malloc(FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT);
  const destroy = () => {
    if (state) wasm.rnnoise_destroy(state);
    if (input) wasm.free(input);
    if (output) wasm.free(output);
  };
  if (!state || !input || !output) {
    destroy();
    throw new Error("RNNoise WASM allocation failed");
  }
  const result = {
    input: new Float32Array(wasm.memory.buffer, input, FRAME_SIZE),
    output: new Float32Array(wasm.memory.buffer, output, FRAME_SIZE),
    process: () => wasm.rnnoise_process_frame(state, output, input),
    destroy,
  };
  result.output.fill(0);
  return result;
}

class CoherentSoftGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasmBinary, mode } = options?.processorOptions ?? {};
    this.mode = mode ?? "soft";
    this.denoising = Boolean(wasmBinary);
    this.position = 0;
    this.previousProbability = 0;
    this.framesUntilHeartbeat = 1;
    this.stopped = false;
    this.level = new VoiceLevel();
    this.port.onmessage = ({ data }) => {
      if (data?.type === "stop" || data === "destroy") {
        this.stopped = true;
        this.rnnoise?.destroy();
        this.rnnoise = undefined;
      } else if (typeof data?.mode === "string") {
        this.mode = data.mode;
      }
    };
    if (wasmBinary) {
      if (sampleRate !== 48000) {
        this.port.postMessage({ type: "error" });
        return;
      }
      void openRnnoise(wasmBinary).then(engine => {
        if (this.stopped) engine.destroy();
        else {
          this.rnnoise = engine;
          this.port.postMessage({ type: "ready" });
        }
      }).catch(() => this.port.postMessage({ type: "error" }));
    }
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;
    if (!input || (this.denoising && !this.rnnoise)) {
      output.fill(0);
    } else if (!this.rnnoise) {
      output.set(input);
    } else {
      const engine = this.rnnoise;
      for (let offset = 0; offset < output.length;) {
        const count = Math.min(output.length - offset, FRAME_SIZE - this.position);
        for (let i = 0; i < count; i++) {
          const sample = input[offset + i];
          output[offset + i] = engine.output[this.position + i];
          engine.input[this.position + i] = (sample >= -1 && sample <= 1
            ? sample : sample > 1 ? 1 : sample < -1 ? -1 : 0) * PCM_SCALE;
        }
        offset += count;
        this.position += count;
        if (this.position === FRAME_SIZE) {
          const probability = engine.process();
          // The model analyses a window overlapping two adjacent frames.
          this.level.process(engine.output, Math.max(probability, this.previousProbability), PAUSE_GAIN[this.mode] ?? 1);
          this.previousProbability = probability;
          this.position = 0;
          if (--this.framesUntilHeartbeat === 0) {
            this.port.postMessage({ type: "active" });
            this.framesUntilHeartbeat = 200;
          }
        }
      }
    }
    for (let i = 1; i < channels.length; i++) channels[i].set(output);
    return true;
  }
}

registerProcessor("coherent-soft-gate", CoherentSoftGate);
