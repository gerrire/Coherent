import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import type { TranslationWorkerRequest, TranslationWorkerResponse } from "../src/lib/translation/protocol";
import type { Caption } from "../src/lib/translation/transport";

const doubles = vi.hoisted(() => ({
  captures: [] as Array<{ track: MediaStreamTrack; audio: (audio: Float32Array) => void; error: (message: string) => void; close: ReturnType<typeof vi.fn> }>,
  inbound: undefined as ((caption: Caption) => void) | undefined,
  publish: vi.fn<() => Promise<void>>(),
  transportClose: vi.fn(),
}));

vi.mock("../src/lib/translation/capture", () => ({
  captureMicrophone: vi.fn(async (track: MediaStreamTrack, audio: (audio: Float32Array) => void, error: (message: string) => void) => {
    const handle = { track, audio, error, close: vi.fn() };
    doubles.captures.push(handle);
    return handle;
  }),
}));
vi.mock("../src/lib/translation/transport", () => ({
  createCaptionTransport: vi.fn((_room: Room, _callId: string, inbound: (caption: Caption) => void) => {
    doubles.inbound = inbound;
    return { publish: doubles.publish, close: doubles.transportClose };
  }),
}));

import { startTranslationSession } from "../src/lib/translation/session";

class TestWorker {
  static all: TestWorker[] = [];
  requests: TranslationWorkerRequest[] = [];
  onmessage: ((event: MessageEvent<TranslationWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() { TestWorker.all.push(this); }
  postMessage(request: TranslationWorkerRequest, transfer: Transferable[] = []) {
    // Model the real Worker boundary: transferred PCM is detached in the UI.
    this.requests.push(structuredClone(request, { transfer }));
  }
  emit(data: TranslationWorkerResponse) { this.onmessage?.({ data } as MessageEvent<TranslationWorkerResponse>); }
}

function fixture(patch: { recognize?: boolean; targetLanguage?: "en" | "ru" } = {}) {
  const callbacks = { onCaption: vi.fn(), onStatus: vi.fn(), onError: vi.fn(), onDropped: vi.fn() };
  const session = startTranslationSession({
    room: { localParticipant: { identity: "self" } } as Room,
    callId: "call", sourceLanguage: "ru", targetLanguage: "en", recognize: true,
    ...callbacks, ...patch,
  });
  const track = { enabled: true, muted: false, readyState: "live" } as MediaStreamTrack;
  return { session, track, ...callbacks };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const remote = (): Caption => ({ id: "segment", speakerId: "other", text: "Hello", receivedAt: Date.now() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubGlobal("Worker", TestWorker);
  TestWorker.all = [];
  doubles.captures.length = 0;
  doubles.inbound = undefined;
  doubles.publish.mockReset().mockResolvedValue(undefined);
  doubles.transportClose.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("local translation session lifecycle", () => {
  it("can be closed immediately without creating a Worker, capture, or model download", async () => {
    const { session, onStatus } = fixture();
    session.close(); session.close();
    await tick();
    expect(TestWorker.all).toHaveLength(0);
    expect(doubles.captures).toHaveLength(0);
    expect(doubles.inbound).toBeUndefined();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("receives English captions without starting any model or processing its microphone", async () => {
    const { session, track, onCaption } = fixture({ recognize: false });
    session.setMicrophoneTrack(track);
    await tick();
    const caption = remote();
    doubles.inbound!(caption);
    expect(TestWorker.all).toHaveLength(0);
    expect(doubles.captures).toHaveLength(0);
    expect(onCaption).toHaveBeenCalledWith(caption);
    session.close();
  });

  it("waits for initialization before translating queued remote captions", async () => {
    const { session, onCaption } = fixture({ recognize: false, targetLanguage: "ru" });
    await tick();
    const worker = TestWorker.all[0];
    expect(worker.requests).toEqual([{ id: 0, type: "init", recognize: false, sourceLanguage: "ru", targetLanguage: "ru" }]);
    const caption = remote();
    doubles.inbound!(caption);
    expect(worker.requests).toHaveLength(1);
    worker.emit({ type: "ready", id: 0 });
    expect(worker.requests[1]).toEqual({ id: 1, type: "translate", text: "Hello" });
    worker.emit({ type: "result", id: 1, text: "Привет" });
    expect(onCaption).toHaveBeenCalledWith({ ...caption, text: "Привет" });
    expect(doubles.captures).toHaveLength(0);
    session.close();
  });

  it("publishes recognition results after the real PCM transfer has detached the caller buffer", async () => {
    const { session, track, onCaption } = fixture();
    session.setMicrophoneTrack(track);
    await tick();
    const worker = TestWorker.all[0];
    worker.emit({ type: "ready", id: 0 });
    await tick();
    const audio = new Float32Array(16_000);
    doubles.captures[0].audio(audio);
    expect(audio.byteLength).toBe(0);
    expect(worker.requests[1]).toEqual({ id: 1, type: "recognize", audio: expect.any(Float32Array) });
    worker.emit({ type: "result", id: 1, text: "Hello" });
    expect(doubles.publish).toHaveBeenCalledWith("Hello");
    expect(onCaption).toHaveBeenCalledWith(expect.objectContaining({ speakerId: "self", text: "Hello" }));
    session.close();
  });

  it("drops in-flight and queued own speech when muted, including after unmuting", async () => {
    const { session, track, onCaption } = fixture();
    session.setMicrophoneTrack(track);
    await tick();
    const worker = TestWorker.all[0];
    worker.emit({ type: "ready", id: 0 });
    await tick();
    doubles.captures[0].audio(new Float32Array(16_000));
    doubles.captures[0].audio(new Float32Array(16_000));
    session.setMicrophoneTrack(null);
    expect(doubles.captures[0].close).toHaveBeenCalledOnce();
    session.setMicrophoneTrack(track);
    await tick();
    worker.emit({ type: "result", id: 1, text: "Speech before muting" });
    expect(doubles.publish).not.toHaveBeenCalled();
    expect(onCaption).not.toHaveBeenCalled();
    expect(worker.requests).toHaveLength(2);
    doubles.captures[1].audio(new Float32Array(16_000));
    worker.emit({ type: "result", id: 2, text: "Speech after unmuting" });
    expect(doubles.publish).toHaveBeenCalledExactlyOnceWith("Speech after unmuting");
    session.close();
  });

  it("ignores errors and callbacks from a retired microphone capture", async () => {
    const { session, track, onError } = fixture();
    session.setMicrophoneTrack(track);
    await tick();
    const worker = TestWorker.all[0];
    worker.emit({ type: "ready", id: 0 });
    await tick();
    const previous = doubles.captures[0];
    session.setMicrophoneTrack(null);
    session.setMicrophoneTrack(track);
    await tick();
    previous.audio(new Float32Array(16_000));
    previous.error("Retired processor failed");
    expect(worker.requests).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
    session.close();
  });

  it("drops stale recognition instead of publishing delayed speech", async () => {
    const { session, track, onDropped } = fixture();
    session.setMicrophoneTrack(track);
    await tick();
    const worker = TestWorker.all[0];
    worker.emit({ type: "ready", id: 0 });
    await tick();
    doubles.captures[0].audio(new Float32Array(16_000));
    vi.advanceTimersByTime(20_001);
    worker.emit({ type: "result", id: 1, text: "Stale speech" });
    expect(doubles.publish).not.toHaveBeenCalled();
    expect(onDropped).toHaveBeenCalledOnce();
    session.close();
  });

  it("ends a stalled job, terminates its Worker, and ignores late results", async () => {
    const { session, onError, onCaption } = fixture({ recognize: false, targetLanguage: "ru" });
    await tick();
    const worker = TestWorker.all[0];
    worker.emit({ type: "ready", id: 0 });
    doubles.inbound!(remote());
    vi.advanceTimersByTime(30_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(doubles.transportClose).toHaveBeenCalledOnce();
    worker.emit({ type: "result", id: 1, text: "Поздно" });
    expect(onCaption).not.toHaveBeenCalled();
    session.close();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cleans up capture, transport, Worker and deadlines exactly once on close", async () => {
    const { session, track, onError, onCaption } = fixture();
    session.setMicrophoneTrack(track);
    await tick();
    const worker = TestWorker.all[0];
    worker.emit({ type: "ready", id: 0 });
    await tick();
    const capture = doubles.captures[0];
    capture.audio(new Float32Array(16_000));
    session.close(); session.close();
    expect(capture.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(doubles.transportClose).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300_001);
    worker.emit({ type: "result", id: 1, text: "Late" });
    doubles.inbound!(remote());
    expect(onError).not.toHaveBeenCalled();
    expect(onCaption).not.toHaveBeenCalled();
  });
});
