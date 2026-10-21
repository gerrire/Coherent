import { LocalAudioTrack, Track, type AudioProcessorOptions, type Room, type TrackProcessor } from "livekit-client";

const loadedWorklets = new WeakMap<AudioContext, Promise<void>>();

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
  private source?: MediaStreamAudioSourceNode;
  private gate?: AudioWorkletNode;
  private gain?: GainNode;
  private compressor?: DynamicsCompressorNode;
  private limiter?: DynamicsCompressorNode;
  private highpass?: BiquadFilterNode;
  private destination?: MediaStreamAudioDestinationNode;

  constructor(private volume: number, private gateMode: "off" | "soft" | "strong") {}

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
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
    if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
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
    const context = options.audioContext ?? this.context;
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

  setGateMode(mode: "off" | "soft" | "strong"): void {
    this.gateMode = mode;
    this.gate?.port.postMessage({ mode });
  }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.highpass?.disconnect();
    this.gate?.disconnect();
    this.gain?.disconnect();
    this.compressor?.disconnect();
    this.limiter?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.source = undefined;
    this.highpass = undefined;
    this.gate = undefined;
    this.gain = undefined;
    this.compressor = undefined;
    this.limiter = undefined;
    this.destination = undefined;
  }
}

export async function applyMicrophoneProcessing(room: Room, volume: number, gateMode: "off" | "soft" | "strong"): Promise<void> {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) return;
  const processor = track.getProcessor();
  if (processor instanceof MicrophoneProcessor) {
    processor.setVolume(volume);
    processor.setGateMode(gateMode);
    return;
  }
  await track.setProcessor(new MicrophoneProcessor(volume, gateMode));
}
