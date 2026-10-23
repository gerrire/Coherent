import { LocalAudioTrack, Track, type AudioProcessorOptions, type Room, type TrackProcessor } from "livekit-client";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type { NoiseProcessor, RnnoisePreset } from "./media";

const loadedWorklets = new WeakMap<AudioContext, Promise<void>>();
const loadedRnnoiseWorklets = new WeakMap<AudioContext, Promise<void>>();
let rnnoiseBinary: Promise<ArrayBuffer> | undefined;

function loadRnnoiseProcessor(context: AudioContext): Promise<ArrayBuffer> {
  rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((error: unknown) => {
    rnnoiseBinary = undefined;
    throw error;
  });
  let worklet = loadedRnnoiseWorklets.get(context);
  if (!worklet) {
    worklet = context.audioWorklet.addModule(rnnoiseWorkletUrl).catch((error: unknown) => {
      loadedRnnoiseWorklets.delete(context);
      throw error;
    });
    loadedRnnoiseWorklets.set(context, worklet);
  }
  return Promise.all([rnnoiseBinary, worklet]).then(([binary]) => binary);
}

export async function prepareRnnoise(): Promise<void> {
  rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((error: unknown) => {
    rnnoiseBinary = undefined;
    throw error;
  });
  await rnnoiseBinary;
}

function loadSoftGate(context: AudioContext): Promise<void> {
  let loading = loadedWorklets.get(context);
  if (!loading) {
    loading = context.audioWorklet.addModule("/mic-soft-gate.js");
    loadedWorklets.set(context, loading);
  }
  return loading;
}

class MicrophoneProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "coherent-microphone-level";
  processedTrack?: MediaStreamTrack;
  private context?: AudioContext;
  private hostContext?: AudioContext;
  private ownedContext?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gate?: AudioWorkletNode;
  private rnnoise?: RnnoiseWorkletNode;
  private gain?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private limiter?: DynamicsCompressorNode;
  private highpass?: BiquadFilterNode;
  private destination?: MediaStreamAudioDestinationNode;

  constructor(private volume: number, private gateMode: "soft" | "noisy", private engine: NoiseProcessor, private preset: RnnoisePreset) {}

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
    this.hostContext = audioContext;
    if (this.engine === "rnnoise" && audioContext.sampleRate !== 48000) {
      this.ownedContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      audioContext = this.ownedContext;
      await audioContext.resume();
    }
    this.context = audioContext;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.highpass = audioContext.createBiquadFilter();
    this.highpass.type = "highpass";
    this.highpass.frequency.value = 85;
    this.gain = audioContext.createGain();
    this.compressor = audioContext.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.18;
    this.limiter = audioContext.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    this.destination = audioContext.createMediaStreamDestination();
    this.source.connect(this.highpass);
    let input: AudioNode = this.highpass;
    if (this.engine === "rnnoise") {
      if (!audioContext.audioWorklet || audioContext.sampleRate !== 48000) {
        throw new Error("RNNoise требует AudioWorklet с частотой 48 кГц. Выбери обработку браузера.");
      }
      const wasmBinary = await loadRnnoiseProcessor(audioContext);
      this.rnnoise = new RnnoiseWorkletNode(audioContext, { wasmBinary, maxChannels: 1 });
      input.connect(this.rnnoise);
      input = this.rnnoise;
      // A parallel dry signal arrives earlier than RNNoise and sounds like a second voice.
      // Presets adjust only a gate after the processed signal.
      try {
        await loadSoftGate(audioContext);
        this.gate = new AudioWorkletNode(audioContext, "coherent-soft-gate");
        input.connect(this.gate);
        input = this.gate;
      } catch {
        // RNNoise still works when the optional gate cannot be loaded.
      }
      this.setRnnoisePreset(this.preset);
    }
    if (this.engine === "browser" && audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        await loadSoftGate(audioContext);
        this.gate = new AudioWorkletNode(audioContext, "coherent-soft-gate");
        this.gate.port.postMessage({ mode: this.gateMode });
        input.connect(this.gate);
        input = this.gate;
      } catch {
        // The microphone level still works in browsers without AudioWorklet.
      }
    }
    input.connect(this.gain);
    this.gain.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.setVolume(this.volume);
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    const context = options.audioContext ?? this.hostContext;
    await this.destroy();
    if (!context) throw new Error("Звуковой движок недоступен.");
    await this.init({ ...options, audioContext: context });
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime((volume / 100) * 2, this.context.currentTime, 0.015);
    }
  }

  setGateMode(mode: "soft" | "noisy"): void {
    this.gateMode = mode;
    if (this.engine === "browser") this.gate?.port.postMessage({ mode });
  }

  setRnnoisePreset(preset: RnnoisePreset): void {
    this.preset = preset;
    if (this.engine === "rnnoise") this.gate?.port.postMessage({ mode: `rnnoise-${preset}` });
  }

  getEngine(): NoiseProcessor { return this.engine; }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.highpass?.disconnect();
    this.gate?.disconnect();
    this.rnnoise?.disconnect();
    this.rnnoise?.destroy();
    this.gain?.disconnect();
    this.compressor?.disconnect();
    this.limiter?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    if (this.ownedContext) await this.ownedContext.close();
    this.processedTrack = undefined;
    this.source = undefined;
    this.highpass = undefined;
    this.gate = undefined;
    this.rnnoise = undefined;
    this.gain = undefined;
    this.compressor = undefined;
    this.limiter = undefined;
    this.destination = undefined;
    this.ownedContext = undefined;
    this.hostContext = undefined;
  }
}

export async function applyMicrophoneProcessing(room: Room, volume: number, gateMode: "soft" | "noisy", engine: NoiseProcessor, preset: RnnoisePreset): Promise<void> {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) return;
  const processor = track.getProcessor();
  if (processor instanceof MicrophoneProcessor && processor.getEngine() === engine) {
    processor.setVolume(volume);
    processor.setGateMode(gateMode);
    processor.setRnnoisePreset(preset);
    return;
  }
  const replacement = new MicrophoneProcessor(volume, gateMode, engine, preset);
  try {
    await track.setProcessor(replacement);
  } catch (error) {
    await replacement.destroy();
    throw error;
  }
}
