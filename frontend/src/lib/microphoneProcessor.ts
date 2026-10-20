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
  private destination?: MediaStreamAudioDestinationNode;

  constructor(private volume: number, private softGate: boolean) {}

  async init({ track, audioContext }: AudioProcessorOptions): Promise<void> {
    this.context = audioContext;
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.gain = audioContext.createGain();
    this.destination = audioContext.createMediaStreamDestination();
    let input: AudioNode = this.source;
    if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        await loadSoftGate(audioContext);
        this.gate = new AudioWorkletNode(audioContext, "coherent-soft-gate");
        this.gate.port.postMessage({ enabled: this.softGate });
        input.connect(this.gate);
        input = this.gate;
      } catch {
        // The microphone level still works in browsers without AudioWorklet.
      }
    }
    input.connect(this.gain);
    this.gain.connect(this.destination);
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
      this.gain.gain.setTargetAtTime(volume / 100, this.context.currentTime, 0.015);
    }
  }

  setSoftGate(enabled: boolean): void {
    this.softGate = enabled;
    this.gate?.port.postMessage({ enabled });
  }

  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.gate?.disconnect();
    this.gain?.disconnect();
    this.destination?.disconnect();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.source = undefined;
    this.gate = undefined;
    this.gain = undefined;
    this.destination = undefined;
  }
}

export async function applyMicrophoneProcessing(room: Room, volume: number, softGate: boolean): Promise<void> {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!(track instanceof LocalAudioTrack)) return;
  const processor = track.getProcessor();
  if (processor instanceof MicrophoneProcessor) {
    processor.setVolume(volume);
    processor.setSoftGate(softGate);
    return;
  }
  await track.setProcessor(new MicrophoneProcessor(volume, softGate));
}
