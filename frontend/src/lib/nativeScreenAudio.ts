import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AudioPresets, Track, type Room } from "livekit-client";
import { resumeAudioContext } from "./audioContext";

let operations: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = operations.then(operation, operation);
  operations = next.catch(() => undefined);
  return next;
}

interface AudioPacket { captureId: number; sequence: number; pcm: string }
interface AudioFailure { captureId: number; message: string }

export class NativeScreenAudio {
  private context: AudioContext | null = null;
  private source: AudioWorkletNode | null = null;
  private track: MediaStreamTrack | null = null;
  private captureId: number | null = null;
  private unlisten: UnlistenFn[] = [];
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private started = false;
  private room: Room;

  constructor(room: Room) { this.room = room; }

  start(onError: (message: string) => void): Promise<void> {
    if (!isTauri() || this.started || this.stopped) return Promise.resolve();
    this.started = true;
    return serialize(async () => {
      if (this.stopped) return;
      try {
        const context = new AudioContext({ sampleRate: 48000 });
        this.context = context;
        await context.audioWorklet.addModule("/system-audio-worklet.js");
        if (this.stopped) return;
        const source = new AudioWorkletNode(context, "coherent-system-audio", { numberOfInputs: 0, outputChannelCount: [2] });
        this.source = source;
        source.port.onmessage = ({ data }: MessageEvent<{ type?: string; captureId?: number; sequence?: number; frames: number; peak: number; underruns: number }>) => {
          if (data.type === "ack") {
            void invoke("desktop_audio_ack", { captureId: data.captureId, sequence: data.sequence }).catch(() => undefined);
            return;
          }
          if (this.stopped || this.captureId === null) return;
          void invoke("desktop_audio_bridge_status", { captureId: this.captureId,
            frames: data.frames, peak: data.peak, underruns: data.underruns }).catch(() => undefined);
        };
        const destination = context.createMediaStreamDestination();
        this.track = destination.stream.getAudioTracks()[0] ?? null;
        if (!this.track) throw new Error("Не удалось создать дорожку системного звука.");
        source.connect(destination);
        let pendingError: AudioFailure | null = null;
        this.unlisten.push(await listen<AudioPacket>("coherent:system-audio", ({ payload }) => {
          if (this.stopped || payload.captureId !== this.captureId) {
            void invoke("desktop_audio_ack", { captureId: payload.captureId, sequence: payload.sequence }).catch(() => undefined);
            return;
          }
          const bytes = Uint8Array.from(atob(payload.pcm), (char) => char.charCodeAt(0));
          const samples = new Int16Array(bytes.buffer);
          source.port.postMessage({ samples, captureId: payload.captureId, sequence: payload.sequence }, [samples.buffer]);
        }));
        this.unlisten.push(await listen<AudioFailure>("coherent:system-audio-error", ({ payload }) => {
          if (this.stopped) return;
          if (this.captureId === null) { pendingError = payload; return; }
          if (payload.captureId !== this.captureId) return;
          onError(payload.message);
          void this.stop();
        }));
        if (this.stopped) return;
        await resumeAudioContext(context);
        this.captureId = await invoke<number>("start_system_audio");
        if (pendingError && (pendingError as AudioFailure).captureId === this.captureId)
          throw new Error((pendingError as AudioFailure).message);
        if (this.stopped) return;
        await this.room.localParticipant.publishTrack(this.track, {
          source: Track.Source.ScreenShareAudio,
          audioPreset: AudioPresets.musicHighQualityStereo, dtx: false, red: true,
        });
      } catch (reason) {
        this.stopped = true;
        await this.cleanup();
        throw reason;
      } finally {
        if (this.stopped) await this.cleanup();
      }
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.stopPromise ??= serialize(() => this.cleanup());
    return this.stopPromise;
  }

  private async cleanup(): Promise<void> {
    this.unlisten.splice(0).forEach((remove) => remove());
    const captureId = this.captureId;
    this.captureId = null;
    if (captureId !== null) await invoke("stop_system_audio", { captureId }).catch(() => undefined);
    const track = this.track;
    this.track = null;
    if (track) {
      track.stop();
      await this.room.localParticipant.unpublishTrack(track).catch(() => undefined);
    }
    this.source?.port.postMessage({ type: "stop" });
    this.source?.disconnect();
    this.source?.port.close();
    this.source = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}
