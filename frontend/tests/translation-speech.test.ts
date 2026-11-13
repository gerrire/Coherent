import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLocalSpeech, localVoiceFor } from "../src/lib/translation/speech";
import type { SpeechWorkerRequest, SpeechWorkerResponse } from "../src/lib/translation/speechProtocol";
import { createTranslationMetrics, type TranslationMetrics } from "../src/lib/translation/metrics";

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (message: { data: SpeechWorkerResponse }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  requests: SpeechWorkerRequest[] = [];
  terminate = vi.fn();
  constructor() { TestWorker.instances.push(this); }
  postMessage(request: SpeechWorkerRequest) { this.requests.push(request); }
  reply(message: SpeechWorkerResponse) { this.onmessage?.({ data: message }); }
}

class TestAudioContext {
  static instances: TestAudioContext[] = [];
  destination = {};
  sources: Array<{ onended: (() => void) | null; buffer: unknown; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }));
  constructor() { TestAudioContext.instances.push(this); }
  createBufferSource() {
    const source = { onended: null as (() => void) | null, buffer: undefined as unknown, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    this.sources.push(source);
    return source;
  }
}

const nativeSpeech = {
  getVoices: vi.fn((): SpeechSynthesisVoice[] => []),
  addEventListener: vi.fn(), removeEventListener: vi.fn(), speak: vi.fn(), cancel: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  TestWorker.instances = [];
  TestAudioContext.instances = [];
  nativeSpeech.getVoices.mockReturnValue([]);
  vi.stubGlobal("window", { speechSynthesis: nativeSpeech });
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("SpeechSynthesisUtterance", class { voice?: SpeechSynthesisVoice; lang?: string; onend?: () => void; onerror?: () => void; constructor(readonly text: string) {} });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function create(metrics?: TranslationMetrics) {
  const callbacks = { onStatus: vi.fn(), onError: vi.fn(), onSpeakingChange: vi.fn() };
  const speech = createLocalSpeech({ language: "ru", metrics, ...callbacks });
  return { speech, ...callbacks };
}

async function ready(speech: ReturnType<typeof createLocalSpeech>) {
  const preparing = speech.prepare();
  await vi.advanceTimersByTimeAsync(301);
  const worker = TestWorker.instances[0];
  worker.reply({ id: 0, type: "ready" });
  await preparing;
  return worker;
}

test("prefers only a matching local system voice and never chooses a remote/default voice", async () => {
  const remote = { lang: "ru-RU", localService: false } as SpeechSynthesisVoice;
  const local = { lang: "ru_RU", localService: true } as SpeechSynthesisVoice;
  nativeSpeech.getVoices.mockReturnValue([remote, { lang: "en-US", localService: true } as SpeechSynthesisVoice, local]);
  expect(localVoiceFor("ru")).toBe(local);
  const { speech, onSpeakingChange } = create();
  await speech.prepare();
  expect(TestWorker.instances).toHaveLength(0);
  speech.speak("Привет");
  expect(nativeSpeech.speak).toHaveBeenCalledWith(expect.objectContaining({ text: "Привет", voice: local }));
  expect(onSpeakingChange).toHaveBeenCalledWith(true);
  speech.close();
  expect(nativeSpeech.cancel).toHaveBeenCalledOnce();
});

test("unlocks audio immediately, then uses the local Russian worker if no local voice exists", async () => {
  const { speech } = create();
  const preparing = speech.prepare();
  expect(TestAudioContext.instances[0].resume).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(301);
  expect(TestWorker.instances[0].requests).toEqual([{ id: 0, type: "init" }]);
  TestWorker.instances[0].reply({ id: 0, type: "ready" });
  await preparing;
  speech.speak("Локальное озвучивание");
  expect(TestWorker.instances[0].requests[1]).toEqual({ id: 1, type: "speak", text: "Локальное озвучивание" });
  speech.close();
});

test("does not create a forced voice worker after closing before audio unlock settles", async () => {
  const metrics = createTranslationMetrics();
  const speech = createLocalSpeech({ language: "ru", downloadedVoice: true, metrics, onStatus: vi.fn(), onError: vi.fn(), onSpeakingChange: vi.fn() });
  const preparing = speech.prepare();
  speech.close();
  await preparing;
  await vi.advanceTimersByTimeAsync(301);
  expect(TestWorker.instances).toHaveLength(0);
  expect(metrics.getSnapshot()).toMatchObject({ activeWorkers: 0, speech: { phase: "idle" } });
});

test("recreates a failed synthesis worker when the sound check prepares it again", async () => {
  const { speech } = create();
  const worker = await ready(speech);
  speech.speak("Первая попытка");
  worker.reply({ id: 1, type: "error", message: "Сбой синтеза" });
  expect(worker.terminate).toHaveBeenCalledOnce();
  const preparing = speech.prepare();
  await vi.advanceTimersByTimeAsync(301);
  const retriedWorker = TestWorker.instances[1];
  expect(retriedWorker).toBeDefined();
  retriedWorker.reply({ id: 0, type: "ready" });
  await preparing;
  speech.speak("Повторная попытка");
  expect(retriedWorker.requests.at(-1)).toMatchObject({ type: "speak", text: "Повторная попытка" });
  speech.close();
});

test("sends the entire allowed caption to speech instead of silently truncating at 300 characters", async () => {
  const { speech, onError } = create();
  const worker = await ready(speech);
  const text = "Это целая реплика. ".repeat(25);
  expect(text.length).toBeGreaterThan(300);
  speech.speak(text);
  expect(worker.requests.at(-1)).toMatchObject({ type: "speak", text: text.trim() });
  speech.speak("а".repeat(601));
  expect(onError).toHaveBeenCalledWith("Фраза для озвучивания слишком длинная.");
  speech.close();
});

test("plays generated PCM and retains only the newest waiting phrase", async () => {
  const { speech } = create();
  const worker = await ready(speech);
  speech.speak("first"); speech.speak("discarded"); speech.speak("latest");
  expect(worker.requests).toHaveLength(2);
  worker.reply({ id: 1, type: "audio", pcm: new Float32Array(2205).buffer, sampleRate: 22050 });
  const context = TestAudioContext.instances[0];
  expect(context.sources[0].start).toHaveBeenCalledOnce();
  context.sources[0].onended?.();
  expect(worker.requests[2]).toEqual({ id: 2, type: "speak", text: "latest" });
  speech.close();
});

test("measures local synthesis separately from playback and ends worker metrics on close", async () => {
  let clock = 0;
  const metrics = createTranslationMetrics(() => clock);
  const { speech } = create(metrics);
  const worker = await ready(speech);
  speech.speak("Привет");
  clock += 250;
  worker.reply({ id: 1, type: "audio", pcm: new Float32Array(22_050).buffer, sampleRate: 22050 });
  clock += 1_000;
  expect(metrics.getSnapshot()).toMatchObject({ activeWorkers: 1, speech: { phase: "idle", completed: 1, lastInferenceMs: 250 } });
  TestAudioContext.instances[0].sources[0].onended?.();
  speech.speak("Ещё");
  speech.close();
  expect(metrics.getSnapshot()).toMatchObject({ activeWorkers: 0, speech: { phase: "idle", completed: 1 } });
});

test("cancelled synthesis never plays late and cannot build a queue of cancelled jobs", async () => {
  const { speech } = create();
  const worker = await ready(speech);
  speech.speak("old"); speech.cancel(); speech.speak("new");
  expect(worker.requests).toHaveLength(2);
  worker.reply({ id: 1, type: "audio", pcm: new Float32Array(2205).buffer, sampleRate: 22050 });
  expect(TestAudioContext.instances[0].sources).toHaveLength(0);
  expect(worker.requests[2]).toMatchObject({ text: "new" });
  speech.close();
});

test("closing stops playback, terminates the worker and ignores late replies", async () => {
  const { speech, onError } = create();
  const worker = await ready(speech);
  speech.speak("Привет");
  worker.reply({ id: 1, type: "audio", pcm: new Float32Array(2205).buffer, sampleRate: 22050 });
  const context = TestAudioContext.instances[0];
  speech.close(); speech.close();
  expect(context.sources[0].stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
  worker.reply({ id: 9, type: "error", message: "late" });
  await vi.advanceTimersByTimeAsync(400_000);
  expect(onError).not.toHaveBeenCalled();
});

test("a hung local calculation times out without keeping a background worker", async () => {
  const { speech, onError } = create();
  const worker = await ready(speech);
  speech.speak("Привет");
  await vi.advanceTimersByTimeAsync(30_001);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledOnce();
  speech.close();
});

test("does not read old captions after the initial voice download finally completes", async () => {
  const { speech } = create();
  const preparing = speech.prepare();
  await vi.advanceTimersByTimeAsync(301);
  speech.speak("already old conversation");
  await vi.advanceTimersByTimeAsync(15_001);
  const worker = TestWorker.instances[0];
  worker.reply({ id: 0, type: "ready" });
  await preparing;
  expect(worker.requests).toEqual([{ id: 0, type: "init" }]);
  speech.close();
});

test("an advertised but failing Russian system voice switches to the downloadable local voice", async () => {
  nativeSpeech.getVoices.mockReturnValue([{ lang: "ru-RU", localService: true } as SpeechSynthesisVoice]);
  const { speech, onError } = create();
  await speech.prepare();
  speech.speak("Привет");
  const native = nativeSpeech.speak.mock.calls[0][0] as SpeechSynthesisUtterance;
  native.onerror?.({} as SpeechSynthesisErrorEvent);
  await vi.advanceTimersByTimeAsync(1);
  expect(TestWorker.instances[0].requests).toEqual([{ id: 0, type: "init" }]);
  TestWorker.instances[0].reply({ id: 0, type: "ready" });
  await vi.advanceTimersByTimeAsync(1);
  expect(TestWorker.instances[0].requests[1]).toMatchObject({ type: "speak", text: "Привет" });
  expect(onError).not.toHaveBeenCalled();
  speech.close();
});
