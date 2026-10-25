import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Track, type Room } from "livekit-client";
import { screenSharePublish, type MediaPreferences } from "./media";
import { SharedVideo } from "./sharedVideo";

export interface ScreenSource {
  id: string;
  name: string;
  kind: "monitor" | "window";
  appName: string | null;
  processId: number | null;
  width: number;
  height: number;
  minimized: boolean;
}

interface ScreenFrame {
  captureId: number;
  width: number;
  height: number;
  jpeg?: string;
}

export const screenSources = () => invoke<ScreenSource[]>("desktop_screen_sources");
let previewRequest = Date.now();
export function screenPreview(sourceId: string) {
  const requestId = ++previewRequest;
  return {
    result: invoke<string>("desktop_screen_preview", { sourceId, requestId }),
    cancel: () => { void invoke("desktop_screen_preview_cancel", { requestId }).catch(() => undefined); },
  };
}

async function checkScreenBridge(encode: boolean): Promise<string> {
  const source = (await screenSources()).find((item) => item.kind === "monitor");
  if (!source) throw new Error("Монитор не найден.");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Не удалось создать видеопоток.");
  let captureId: number | null = null;
  const tracks: MediaStreamTrack[] = [];
  let received = 0;
  let resolveFrames: (() => void) | null = null;
  let rejectFrames: ((error: Error) => void) | null = null;
  const complete = new Promise<void>((resolve, reject) => { resolveFrames = resolve; rejectFrames = reject; });
  let resolveTrack: ((track: MediaStreamTrack) => void) | null = null;
  let rejectTrack: ((error: Error) => void) | null = null;
  const trackReady = new Promise<MediaStreamTrack>((resolve, reject) => { resolveTrack = resolve; rejectTrack = reject; });
  void complete.catch(() => undefined);
  void trackReady.catch(() => undefined);
  const unlisten = await listen<ScreenFrame>("coherent:screen-frame", (event) => {
    const frame = event.payload;
    if (captureId !== null && frame.captureId !== captureId) return;
    if (captureId === null) captureId = frame.captureId;
    void (async () => {
      try {
        const bytes = Uint8Array.from(atob(frame.jpeg ?? ""), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        try {
          if (canvas.width !== frame.width || canvas.height !== frame.height) {
            canvas.width = frame.width; canvas.height = frame.height;
          }
          context.drawImage(bitmap, 0, 0);
          if (tracks.length === 0) {
            const track = canvas.captureStream(15).getVideoTracks()[0];
            if (!track) throw new Error("Не удалось получить видеодорожку.");
            tracks.push(track);
            resolveTrack?.(track);
          }
          received += 1;
          if (received >= 30) resolveFrames?.();
        } finally { bitmap.close(); }
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        rejectTrack?.(error);
        rejectFrames?.(error);
      } finally {
        void invoke("desktop_screen_ack", { captureId: frame.captureId }).catch(() => undefined);
      }
    })();
  });
  const timeout = window.setTimeout(() => {
    const error = new Error("Поток кадров перестал отвечать.");
    rejectTrack?.(error);
    rejectFrames?.(error);
  }, 10000);
  try {
    const startedId = await invoke<number>("desktop_screen_start", { sourceId: source.id, frameRate: 15 });
    captureId = startedId;
    if (encode) await runLocalVideoEncoding(await trackReady);
    await complete;
    return encode
      ? `Клиент обработал и закодировал ${received} кадров без звонка и отправки в сеть.`
      : `Клиент обработал ${received} кадров без звонка и передачи видео.`;
  } finally {
    window.clearTimeout(timeout);
    unlisten();
    tracks.forEach((track) => track.stop());
    if (captureId !== null) await invoke("desktop_screen_stop", { captureId }).catch(() => undefined);
  }
}

export const checkScreenBridgeOnly = () => checkScreenBridge(false);
export const checkScreenEncoder = () => checkScreenBridge(true);

async function runLocalVideoEncoding(track: MediaStreamTrack): Promise<void> {
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  sender.onicecandidate = (event) => { if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(() => undefined); };
  receiver.onicecandidate = (event) => { if (event.candidate) void sender.addIceCandidate(event.candidate).catch(() => undefined); };
  try {
    sender.addTrack(track);
    const vp8 = RTCRtpReceiver.getCapabilities("video")?.codecs.filter((codec) => /video\/vp8|video\/rtx/i.test(codec.mimeType)) ?? [];
    if (vp8.length) sender.getTransceivers()[0]?.setCodecPreferences(vp8);
    await sender.setLocalDescription(await sender.createOffer());
    await waitForLocalCandidates(sender);
    await receiver.setRemoteDescription(sender.localDescription!);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await waitForLocalCandidates(receiver);
    await sender.setRemoteDescription(receiver.localDescription!);
    const started = performance.now();
    while (performance.now() - started < 7000) {
      const stats = await receiver.getStats();
      if ([...stats.values()].some((entry) => entry.type === "inbound-rtp" && ((entry as RTCInboundRtpStreamStats).framesDecoded ?? 0) > 0)) return;
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    throw new Error("Локальное кодирование видео не запустилось.");
  } finally {
    sender.close();
    receiver.close();
  }
}

function waitForLocalCandidates(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", check);
      reject(new Error("Локальное соединение не удалось установить."));
    }, 5000);
    const check = () => {
      if (peer.iceGatheringState !== "complete") return;
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", check);
  });
}

function frameSize(width: number, height: number, quality: MediaPreferences["screenShareQuality"]) {
  const bounds = { "720p": [1280, 720], "1080p": [1920, 1080], "1440p": [2560, 1440], "2160p": [3840, 2160], native: [width, height] }[quality];
  const scale = Math.min(1, bounds[0] / width, bounds[1] / height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))] as const;
}

export class NativeScreenShare {
  private captureId: number | null = null;
  private track: MediaStreamTrack | null = null;
  private unlisten: UnlistenFn[] = [];
  private stopped = false;
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private refreshTimer = 0;
  private shared: SharedVideo | null = null;
  private room: Room;

  constructor(room: Room) { this.room = room; }

  start(sourceId: string, media: MediaPreferences, onEnded: () => void): Promise<void> {
    if (this.started || this.stopped) return Promise.reject(new Error("Демонстрация уже запускалась."));
    this.started = true;
    return serializeScreen(async () => {
      if (this.stopped) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Не удалось создать видеопоток демонстрации.");
      let resolveReady: (() => void) | null = null;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; this.rejectReady = reject; });
      void ready.catch(() => undefined);
      let timer = 0;
      let busy = false;
      const pendingFrames = new Map<number, ScreenFrame>();
      const deferFrame = (frame: ScreenFrame) => {
        if (pendingFrames.size >= 4) pendingFrames.delete(pendingFrames.keys().next().value!);
        pendingFrames.set(frame.captureId, frame);
      };
      const fail = (error: Error) => {
        if (this.stopped) return;
        this.rejectReady?.(error);
        onEnded();
        void this.stop();
      };
      try {
        const consume = (frame: ScreenFrame) => {
          if (this.stopped || busy) return;
          if (this.captureId === null) { deferFrame(frame); return; }
          if (frame.captureId !== this.captureId) return;
          if (!frame.jpeg && !this.shared?.has(frame.captureId)) { deferFrame(frame); return; }
          pendingFrames.delete(frame.captureId);
          busy = true;
          void (async () => {
            try {
              const bitmap = frame.jpeg
                ? await createImageBitmap(new Blob([Uint8Array.from(atob(frame.jpeg), (char) => char.charCodeAt(0))], { type: "image/jpeg" }))
                : this.shared!.frame(frame.captureId, frame.width, frame.height);
              try {
                if (this.stopped) return;
                const [width, height] = frameSize(frame.width, frame.height, media.screenShareQuality);
                if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
                context.drawImage(bitmap, 0, 0, width, height);
              } finally { bitmap.close(); }
              resolveReady?.();
              resolveReady = null;
            } catch (reason) {
              fail(reason instanceof Error ? reason : new Error(String(reason)));
            } finally {
              void invoke("desktop_screen_ack", { captureId: frame.captureId }).catch(() => undefined);
              busy = false;
            }
          })();
        };
        this.shared = SharedVideo.create(() => {
          const frame = this.captureId === null ? null : pendingFrames.get(this.captureId);
          if (frame) consume(frame);
        });
        this.unlisten.push(await listen<ScreenFrame>("coherent:screen-frame", ({ payload }) => consume(payload)));
        this.unlisten.push(await listen<number>("coherent:screen-ended", ({ payload }) => {
          if (payload === this.captureId) fail(new Error("Выбранный источник больше недоступен."));
        }));
        if (this.stopped) return;
        const frameRate = this.shared ? media.screenShareFrameRate : Math.min(media.screenShareFrameRate, 15);
        const captureId = await invoke<number>("desktop_screen_start", { sourceId, frameRate, sharedMemory: Boolean(this.shared) });
        this.captureId = captureId;
        this.shared?.select(captureId);
        const pendingFrame = pendingFrames.get(captureId);
        pendingFrames.clear();
        if (pendingFrame) consume(pendingFrame);
        if (this.stopped) return;
        timer = window.setTimeout(() => this.rejectReady?.(new Error("Не получен кадр от выбранного экрана.")), 7000);
        await ready;
        window.clearTimeout(timer);
        if (this.stopped) return;
        const track = canvas.captureStream(frameRate).getVideoTracks()[0];
        if (!track) throw new Error("Не удалось создать видеодорожку демонстрации.");
        track.contentHint = media.screenShareContent === "motion" ? "motion" : "detail";
        this.track = track;
        await this.room.localParticipant.publishTrack(track, {
          ...screenSharePublish(this.shared ? media : {
            ...media, screenShareQuality: "720p", screenShareFrameRate: 15,
            screenShareCodec: "vp8", screenShareBitrateMbps: Math.min(media.screenShareBitrateMbps, 6),
          }),
          source: Track.Source.ScreenShare, simulcast: false, screenShareSimulcastLayers: [],
        });
        // WGC only produces frames when a window changes. A static first frame
        // may predate the WebRTC encoder/subscription. Repaint the retained canvas
        // after publication and periodically so late subscribers get a keyframe.
        const refresh = () => {
          if (this.stopped) return;
          context.drawImage(canvas, 0, 0);
          (track as CanvasCaptureMediaStreamTrack).requestFrame?.();
        };
        refresh();
        if (!this.stopped) this.refreshTimer = window.setInterval(refresh, 1000);
      } catch (reason) {
        this.stopped = true;
        await this.cleanup();
        throw reason;
      } finally {
        window.clearTimeout(timer);
        this.rejectReady = null;
        if (this.stopped) await this.cleanup();
      }
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.rejectReady?.(new Error("Демонстрация остановлена."));
    this.stopPromise ??= serializeScreen(() => this.cleanup());
    return this.stopPromise;
  }

  private async cleanup(): Promise<void> {
    window.clearInterval(this.refreshTimer);
    this.refreshTimer = 0;
    this.unlisten.splice(0).forEach((remove) => remove());
    const captureId = this.captureId;
    this.captureId = null;
    if (captureId !== null) await invoke("desktop_screen_stop", { captureId }).catch(() => undefined);
    this.shared?.dispose();
    this.shared = null;
    const track = this.track;
    this.track = null;
    if (track) {
      track.stop();
      await this.room.localParticipant.unpublishTrack(track).catch(() => undefined);
    }
  }
}

let screenOperations: Promise<unknown> = Promise.resolve();
function serializeScreen<T>(operation: () => Promise<T>): Promise<T> {
  const next = screenOperations.then(operation, operation);
  screenOperations = next.catch(() => undefined);
  return next;
}
