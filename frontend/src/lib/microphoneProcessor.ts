import { LocalAudioTrack, Track, type AudioProcessorOptions, type Room, type TrackProcessor } from "livekit-client";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type { NoiseProcessor, RnnoisePreset } from "./media";
import { resumeAudioContext } from "./audioContext";
import { AudioFlowGuard } from "./audioFlowGuard";

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

export class MicrophoneProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
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
  private silentClock?: GainNode;
  private inputMeter?: AnalyserNode;
  private outputMeter?: AnalyserNode;
  private healthTimer?: ReturnType<typeof setInterval>;
  private bypassed = false;

  constructor(private volume: number, private gateMode: "soft" | "noisy", private engine: NoiseProcessor, private preset: RnnoisePreset) {}

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
    this.hostContext = audioContext;
    // Capture must not depend on the playback context, which LiveKit may close
    // or suspend when output devices, remote audio or the room change.
    this.ownedContext = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    audioContext = this.ownedContext;
    this.bypassed = false;
    this.context = audioContext;
    // WebView2 can supply a suspended host context, even with a live USB input.
    // Publishing its MediaStreamDestination would otherwise send silent audio.
    await this.resume();
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.highpass = audioContext.createBiquadFilter();
    this.highpass.channelCount = 1;
    this.highpass.channelCountMode = "explicit";
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
    this.destination.channelCount = 1;
    this.destination.channelCountMode = "explicit";
    this.source.connect(this.highpass);
    let input: AudioNode = this.highpass;
    if (this.engine === "rnnoise") {
      if (!audioContext.audioWorklet || audioContext.sampleRate !== 48000) {
        throw new Error("RNNoise требует AudioWorklet с частотой 48 кГц. Выбери обработку браузера.");
      }
      const wasmBinary = await loadRnnoiseProcessor(audioContext);
      this.rnnoise = new RnnoiseWorkletNode(audioContext, { wasmBinary, maxChannels: 1 });
      this.rnnoise.channelCount = 1;
      this.rnnoise.channelCountMode = "explicit";
      this.rnnoise.addEventListener("processorerror", () => this.bypassDenoiser());
      input.connect(this.rnnoise);
      input = this.rnnoise;
      // A parallel dry signal arrives earlier than RNNoise and sounds like a second voice.
      // Presets adjust only a gate after the processed signal.
      try {
        await loadSoftGate(audioContext);
        this.gate = new AudioWorkletNode(audioContext, "coherent-soft-gate");
        this.gate.addEventListener("processorerror", () => this.bypassDenoiser());
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
        this.gate.addEventListener("processorerror", () => this.bypassDenoiser());
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
    // WebView2 can render analysers while a destination-only capture stream
    // still emits zeroes. A silent output keeps the device clock pulling this
    // dedicated context; microphone audio is never played through the speakers.
    this.silentClock = audioContext.createGain();
    this.silentClock.gain.value = 0;
    this.limiter.connect(this.silentClock);
    this.silentClock.connect(audioContext.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.setVolume(this.volume);
    this.watchFlow(track);
  }

  private bypassDenoiser() {
    if (this.bypassed || !this.highpass || !this.gain) return;
    this.bypassed = true;
    // Replace the path rather than mixing dry/processed signals. Keep the same
    // published track, user volume (including zero), compressor and limiter.
    this.highpass.disconnect();
    this.rnnoise?.disconnect();
    this.gate?.disconnect();
    this.highpass.connect(this.gain);
    window.dispatchEvent(new Event("coherent-microphone-processing-fallback"));
  }

  private watchFlow(track: MediaStreamTrack) {
    const context = this.context;
    if (!context || !this.source || !this.limiter) return;
    this.inputMeter = context.createAnalyser();
    this.outputMeter = context.createAnalyser();
    this.inputMeter.fftSize = this.outputMeter.fftSize = 1024;
    this.source.connect(this.inputMeter);
    this.limiter.connect(this.outputMeter);
    const input = new Float32Array(1024), output = new Float32Array(1024);
    const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const guard = new AudioFlowGuard();
    this.healthTimer = setInterval(() => {
      if (track.readyState !== "live" || !track.enabled || this.volume === 0 || this.bypassed) return;
      if (context.state !== "running") { void this.resume().catch(() => undefined); return; }
      this.inputMeter?.getFloatTimeDomainData(input);
      this.outputMeter?.getFloatTimeDomainData(output);
      if (guard.check(rms(input), rms(output), performance.now())) this.bypassDenoiser();
    }, 500);
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
  usesFallback(): boolean { return this.bypassed; }
  signalHealth() {
    const input = new Float32Array(1024), output = new Float32Array(1024);
    this.inputMeter?.getFloatTimeDomainData(input); this.outputMeter?.getFloatTimeDomainData(output);
    const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    return { state: this.context?.state, time: this.context?.currentTime, inputRms: rms(input), outputRms: rms(output) };
  }

  async resume(): Promise<void> {
    const context = this.context;
    if (!context) throw new Error("Звуковой движок недоступен.");
    await resumeAudioContext(context);
  }

  async destroy(): Promise<void> {
    this.bypassed = true;
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.inputMeter?.disconnect(); this.outputMeter?.disconnect();
    this.inputMeter = undefined; this.outputMeter = undefined;
    this.source?.disconnect();
    this.highpass?.disconnect();
    this.gate?.port.postMessage({ type: "stop" });
    this.gate?.port.close();
    this.gate?.disconnect();
    this.rnnoise?.disconnect();
    this.rnnoise?.destroy();
    this.rnnoise?.port.close();
    this.gain?.disconnect();
    this.compressor?.disconnect();
    this.limiter?.disconnect();
    this.destination?.disconnect();
    this.silentClock?.disconnect(); this.silentClock = undefined;
    this.processedTrack?.stop();
    if (this.ownedContext && this.ownedContext.state !== "closed") await this.ownedContext.close();
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
    this.context = undefined;
  }
}

export async function applyMicrophoneProcessing(room: Room, volume: number, gateMode: "soft" | "noisy", engine: NoiseProcessor, preset: RnnoisePreset): Promise<void> {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) return;
  const processor = track.getProcessor();
  if (processor instanceof MicrophoneProcessor && processor.getEngine() === engine) {
    await processor.resume();
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
