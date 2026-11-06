import { LocalAudioTrack, Track, type AudioCaptureOptions, type AudioProcessorOptions, type Room, type TrackProcessor } from "livekit-client";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { enableMicrophone, microphoneCapture, microphoneProcessingConstraints, type MediaPreferences } from "./media";
import { resumeAudioContext } from "./audioContext";

let rnnoiseBinary: Promise<ArrayBuffer> | undefined;

function loadRnnoiseBinary(): Promise<ArrayBuffer> {
  rnnoiseBinary ??= import("@sapphi-red/web-noise-suppressor")
    .then(({ loadRnnoise }) => loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }))
    .catch((error: unknown) => {
      rnnoiseBinary = undefined;
      throw error;
    });
  return rnnoiseBinary;
}

export async function prepareRnnoise(): Promise<void> {
  await loadRnnoiseBinary();
}

export class MicrophoneProcessorError extends Error {}

function ready(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      node.removeEventListener("processorerror", failed);
      node.port.onmessage = null;
      if (error) reject(error); else resolve();
    };
    const failed = () => finish(new MicrophoneProcessorError("RNNoise не смог запуститься."));
    const timer = window.setTimeout(failed, 4500);
    node.addEventListener("processorerror", failed, { once: true });
    node.port.onmessage = ({ data }) => {
      if (data?.type === "ready") finish();
      if (data?.type === "error") failed();
    };
  });
}

export class MicrophoneProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "coherent-rnnoise";
  processedTrack?: MediaStreamTrack;
  private capture: AudioCaptureOptions;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private highpass?: BiquadFilterNode;
  private node?: AudioWorkletNode;
  private silentClock?: GainNode;
  private timer = 0;
  private failed = false;

  constructor(private media: MediaPreferences, private readonly onFailure?: () => void) {
    this.capture = microphoneProcessingConstraints(media);
  }

  async init({ track }: AudioProcessorOptions): Promise<void> {
    try {
      // Keep the capture clock independent of the playback sink, including WebView2.
      const context = this.context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      await resumeAudioContext(context);
      if (!context.audioWorklet || context.sampleRate !== 48000) throw new Error("Нужен AudioWorklet с частотой 48 кГц.");
      const [wasmBinary] = await Promise.all([loadRnnoiseBinary(), context.audioWorklet.addModule("/voice-rnnoise.js?v=1")]);
      const node = this.node = new AudioWorkletNode(context, "coherent-soft-gate", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
        processorOptions: { wasmBinary, mode: `rnnoise-${this.media.rnnoisePreset}` },
      });
      await ready(node);
      if (this.context !== context) throw new Error("Обработка остановлена.");
      this.failed = false;
      let lastFrame = performance.now();
      const fail = () => {
        if (this.node !== node || this.failed) return;
        this.failed = true;
        this.onFailure?.();
      };
      node.addEventListener("processorerror", fail, { once: true });
      node.port.onmessage = ({ data }) => {
        if (data?.type === "active") lastFrame = performance.now();
        if (data?.type === "error") fail();
      };
      this.source = context.createMediaStreamSource(new MediaStream([track]));
      this.highpass = context.createBiquadFilter();
      this.highpass.type = "highpass";
      this.highpass.frequency.value = 65;
      this.highpass.channelCount = 1;
      this.highpass.channelCountMode = "explicit";
      this.source.connect(this.highpass);
      this.highpass.connect(node);
      const destination = new MediaStreamAudioDestinationNode(context, { channelCount: 1, channelCountMode: "explicit" });
      node.connect(destination);
      this.silentClock = context.createGain();
      this.silentClock.gain.value = 0;
      node.connect(this.silentClock);
      this.silentClock.connect(context.destination);
      this.processedTrack = destination.stream.getAudioTracks()[0];
      this.timer = window.setInterval(() => {
        if (context.state !== "running" || document.hidden || !track.enabled || track.muted || track.readyState !== "live") {
          lastFrame = performance.now();
          return;
        }
        if (performance.now() - lastFrame > 7500) fail();
      }, 2000);
    } catch (error) {
      await this.destroy();
      if (error instanceof MicrophoneProcessorError) throw error;
      throw new MicrophoneProcessorError("RNNoise не смог запуститься.", { cause: error });
    }
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await options.track.applyConstraints(this.capture);
    await this.init(options);
  }

  setProfile(media: MediaPreferences): void {
    this.media = media;
    this.capture = microphoneProcessingConstraints(media);
    this.node?.port.postMessage({ mode: `rnnoise-${media.rnnoisePreset}` });
  }

  usesFallback(): boolean { return this.failed; }

  async resume(): Promise<void> {
    if (!this.context) throw new MicrophoneProcessorError("Обработка не запущена.");
    await resumeAudioContext(this.context);
  }

  async destroy(): Promise<void> {
    window.clearInterval(this.timer);
    const { context, node } = this;
    this.context = this.node = undefined;
    node?.port.postMessage({ type: "stop" });
    node?.port.close();
    node?.disconnect();
    this.source?.disconnect();
    this.highpass?.disconnect();
    this.silentClock?.disconnect();
    this.processedTrack?.stop();
    this.processedTrack = this.source = this.highpass = this.silentClock = undefined;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}

function microphoneTrack(room: Room): LocalAudioTrack | undefined {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  return track instanceof LocalAudioTrack ? track : undefined;
}

export function browserMicrophoneFallback(media: MediaPreferences): MediaPreferences {
  return { ...media, noiseProcessor: "browser", noiseSuppression: true, autoGainControl: true };
}

export function createMicrophoneProcessor(media: MediaPreferences): MicrophoneProcessor {
  return new MicrophoneProcessor(media);
}

async function attachProcessor(track: LocalAudioTrack, media: MediaPreferences): Promise<void> {
  const processor = new MicrophoneProcessor(media, () => {
    window.dispatchEvent(new CustomEvent("coherent-microphone-processing-fallback", { detail: track }));
  });
  try {
    await track.setProcessor(processor);
  } catch (error) {
    await processor.destroy();
    if (track.getProcessor() === processor) await track.stopProcessor().catch(() => undefined);
    throw error instanceof MicrophoneProcessorError ? error : new MicrophoneProcessorError("Не удалось подключить RNNoise.", { cause: error });
  }
}

export async function enableCallMicrophone(room: Room, media: MediaPreferences): Promise<void> {
  if (microphoneTrack(room)) await applyMicrophoneProcessing(room, media);
  await enableMicrophone(room, media, media.noiseProcessor === "rnnoise" ? track => attachProcessor(track, media) : undefined);
}

export async function restartCallMicrophone(room: Room, media: MediaPreferences): Promise<void> {
  const track = microphoneTrack(room);
  if (!track) { await enableCallMicrophone(room, media); return; }
  const processor = track.getProcessor();
  if (media.noiseProcessor === "browser" && processor instanceof MicrophoneProcessor) {
    await track.mute();
    await track.stopProcessor();
  } else if (media.noiseProcessor === "rnnoise" && !(processor instanceof MicrophoneProcessor)) {
    await attachProcessor(track, media);
  } else if (processor instanceof MicrophoneProcessor) {
    processor.setProfile(media);
  }
  await track.restartTrack(microphoneCapture(media));
  await applyMicrophoneProcessing(room, media);
  if (track.isMuted) await track.unmute();
}

export async function applyMicrophoneProcessing(room: Room, media: MediaPreferences): Promise<void> {
  const track = microphoneTrack(room);
  if (!track) return;
  const processor = track.getProcessor();
  if (media.noiseProcessor === "browser") {
    if (processor instanceof MicrophoneProcessor) await track.stopProcessor();
    const source = track.mediaStream?.getAudioTracks()[0];
    const capture = microphoneProcessingConstraints(media);
    const active = source?.getConstraints();
    if (source?.readyState === "live" && active && Object.entries(capture).some(([key, value]) => active[key as keyof MediaTrackConstraints] !== value)) {
      await source.applyConstraints(capture);
    }
    return;
  }
  if (processor instanceof MicrophoneProcessor && !processor.usesFallback()) {
    processor.setProfile(media);
    await processor.resume();
    return;
  }
  await attachProcessor(track, media);
}
