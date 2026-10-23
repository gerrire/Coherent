import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { AudioPresets, Track, type Room } from "livekit-client";

export class NativeScreenAudio {
  private context: AudioContext | null = null;
  private track: MediaStreamTrack | null = null;
  private unlisten: UnlistenFn[] = [];
  private room: Room;

  constructor(room: Room) { this.room = room; }

  async start(onError: (message: string) => void): Promise<void> {
    if (!isTauri() || this.context) return;
    try {
      const context = new AudioContext({ sampleRate: 48000 });
      this.context = context;
      await context.audioWorklet.addModule("/system-audio-worklet.js");
      const source = new AudioWorkletNode(context, "coherent-system-audio", {
        outputChannelCount: [2],
      });
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      this.unlisten.push(await listen<string>("coherent:system-audio", (event) => {
        const bytes = Uint8Array.from(atob(event.payload), (char) => char.charCodeAt(0));
        const samples = new Int16Array(bytes.buffer);
        source.port.postMessage(samples, [samples.buffer]);
      }));
      this.unlisten.push(await listen<string>("coherent:system-audio-error", (event) => {
        onError(event.payload);
        void this.stop();
      }));
      await context.resume();
      await invoke("start_system_audio");
      this.track = destination.stream.getAudioTracks()[0];
      await this.room.localParticipant.publishTrack(this.track, {
        source: Track.Source.ScreenShareAudio,
        audioPreset: AudioPresets.musicHighQualityStereo,
        dtx: false,
        red: true,
      });
    } catch (reason) {
      await this.stop();
      throw reason;
    }
  }

  async stop(): Promise<void> {
    this.unlisten.forEach((remove) => remove());
    this.unlisten = [];
    await invoke("stop_system_audio").catch(() => undefined);
    const track = this.track;
    this.track = null;
    if (track) {
      await this.room.localParticipant.unpublishTrack(track).catch(() => undefined);
      track.stop();
    }
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => undefined);
  }
}
