import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationWorkerRequest, TranslationWorkerResponse } from "../src/lib/translation/protocol";

const runtime = vi.hoisted(() => ({
  env: { backends: { onnx: { wasm: {} } } } as Record<string, any>,
  pipeline: vi.fn(), recognize: vi.fn(), translate: vi.fn(),
  disposeRecognizer: vi.fn(), disposeTranslator: vi.fn(),
}));
vi.mock("@huggingface/transformers", () => ({ env: runtime.env, pipeline: runtime.pipeline }));

let receive: (event: { data: TranslationWorkerRequest }) => void;
let messages: TranslationWorkerResponse[];

beforeEach(async () => {
  vi.resetModules();
  messages = [];
  runtime.pipeline.mockReset().mockImplementation(async task => task === "translation"
    ? Object.assign(runtime.translate, { dispose: runtime.disposeTranslator })
    : Object.assign(runtime.recognize, { dispose: runtime.disposeRecognizer }));
  runtime.recognize.mockReset().mockResolvedValue({ text: " Привет, как дела? " });
  runtime.translate.mockReset().mockResolvedValue([{ translation_text: " Привет. " }]);
  runtime.disposeRecognizer.mockReset().mockResolvedValue(undefined);
  runtime.disposeTranslator.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("self", {
    addEventListener(_type: string, callback: typeof receive) { receive = callback; },
    postMessage(message: TranslationWorkerResponse) { messages.push(message); },
  });
  await import("../src/lib/translation/model.worker");
});
afterEach(() => vi.unstubAllGlobals());

async function send(request: TranslationWorkerRequest): Promise<TranslationWorkerResponse> {
  receive({ data: request });
  await vi.waitFor(() => expect(messages.some(message => message.id === request.id && message.type !== "progress")).toBe(true));
  return messages.find(message => message.id === request.id && message.type !== "progress")!;
}

describe("local translation worker", () => {
  it("preserves Russian captions verbatim without a round trip or any model", async () => {
    expect(await send({ id: 1, type: "init", recognize: false, sourceLanguage: "en", targetLanguage: "ru" }))
      .toEqual({ id: 1, type: "ready" });
    expect(await send({ id: 2, type: "translate", text: " Привет, как дела? ", sourceLanguage: "ru" }))
      .toEqual({ id: 2, type: "result", text: "Привет, как дела?" });
    expect(runtime.pipeline).not.toHaveBeenCalled();
    expect(runtime.env.allowLocalModels).toBe(false);
    expect(runtime.env.backends.onnx.wasm).toMatchObject({ numThreads: 1, proxy: false });
    expect(runtime.env.backends.onnx.wasm.wasmPaths.mjs).toContain("ort-wasm-simd-threaded.jsep.mjs");
  });

  it("loads exactly the direct English-to-Russian translator on demand", async () => {
    await send({ id: 1, type: "init", recognize: false, sourceLanguage: "ru", targetLanguage: "ru" });
    expect(runtime.pipeline).not.toHaveBeenCalled();
    expect(await send({ id: 2, type: "translate", text: "Hello", sourceLanguage: "en" }))
      .toEqual({ id: 2, type: "result", text: "Привет." });
    expect(runtime.pipeline).toHaveBeenCalledExactlyOnceWith("translation", "Xenova/opus-mt-en-ru", expect.objectContaining({
      revision: "e050376e960175e8ddc5cff85025dc8436cddd68", device: "wasm", dtype: "q8",
    }));
    expect(runtime.translate).toHaveBeenCalledWith("Hello", expect.objectContaining({ num_beams: 1 }));
    await send({ id: 3, type: "translate", text: "Another phrase", sourceLanguage: "en" });
    expect(runtime.pipeline).toHaveBeenCalledOnce();
  });

  it("translates Russian directly to English", async () => {
    await send({ id: 1, type: "init", recognize: false, sourceLanguage: "en", targetLanguage: "en" });
    runtime.translate.mockResolvedValue([{ translation_text: "Hello" }]);
    expect(await send({ id: 2, type: "translate", text: "Привет", sourceLanguage: "ru" }))
      .toEqual({ id: 2, type: "result", text: "Hello" });
    expect(runtime.pipeline).toHaveBeenCalledExactlyOnceWith("translation", "Xenova/opus-mt-ru-en", expect.objectContaining({
      revision: "afe8c6c738ec81b6d033fd8f44f9678a639a7c67",
    }));
  });

  it("uses only one loaded Marian model during a non-English language pair", async () => {
    const events: string[] = [];
    runtime.pipeline.mockImplementation(async (_task, model) => {
      events.push(`load:${model}`);
      return Object.assign(runtime.translate, { dispose: runtime.disposeTranslator });
    });
    runtime.disposeTranslator.mockImplementation(async () => { events.push("dispose"); });
    runtime.translate.mockResolvedValueOnce([{ translation_text: "Hello" }]).mockResolvedValueOnce([{ translation_text: "Привет" }]);
    await send({ id: 1, type: "init", recognize: false, sourceLanguage: "ru", targetLanguage: "ru" });
    expect(await send({ id: 2, type: "translate", text: "Bonjour", sourceLanguage: "fr" }))
      .toEqual({ id: 2, type: "result", text: "Привет" });
    expect(events).toEqual(["load:Xenova/opus-mt-fr-en", "dispose", "load:Xenova/opus-mt-en-ru"]);
    expect(runtime.translate.mock.calls.map(call => call[0])).toEqual(["Bonjour", "Hello"]);
  });

  it("translates each sentence so an earlier negation is not omitted by Marian", async () => {
    await send({ id: 1, type: "init", recognize: false, sourceLanguage: "ru", targetLanguage: "ru" });
    runtime.translate.mockResolvedValueOnce([{ translation_text: "Я тебя не слышу." }])
      .mockResolvedValueOnce([{ translation_text: "Повтори последнее предложение." }]);
    expect(await send({ id: 2, type: "translate", text: "I cannot hear you. Could you repeat the last sentence?", sourceLanguage: "en" }))
      .toEqual({ id: 2, type: "result", text: "Я тебя не слышу. Повтори последнее предложение." });
    expect(runtime.translate.mock.calls.map(call => call[0])).toEqual(["I cannot hear you.", "Could you repeat the last sentence?"]);
    expect(runtime.pipeline).toHaveBeenCalledOnce();
  });

  it.each([
    ["balanced", "Xenova/whisper-base", "64da57285918e20ea79ea5c88eed7197933abaa8"],
    ["light", "Xenova/whisper-tiny", "5332fcc35e32a33b86612b9a57a89be7906102b1"],
  ] as const)("selects %s recognition while preserving the original language", async (quality, model, revision) => {
    await send({ id: 1, type: "init", recognize: true, sourceLanguage: "ru", targetLanguage: "ru", quality });
    expect(runtime.pipeline).toHaveBeenCalledExactlyOnceWith("automatic-speech-recognition", model, expect.objectContaining({ revision, device: "wasm", dtype: "q8" }));
    expect(await send({ id: 2, type: "recognize", audio: new Float32Array(16_000) }))
      .toEqual({ id: 2, type: "result", text: "Привет, как дела?" });
    expect(runtime.recognize).toHaveBeenCalledWith(expect.any(Float32Array), expect.objectContaining({ language: "russian", task: "transcribe", num_beams: 1 }));
  });

  it("serializes recognition and translation without changing the transcription language", async () => {
    await send({ id: 1, type: "init", recognize: true, sourceLanguage: "ru", targetLanguage: "ru" });
    let finishRecognition!: (value: { text: string }) => void;
    runtime.recognize.mockImplementation(() => new Promise(resolve => { finishRecognition = resolve; }));
    receive({ data: { id: 2, type: "recognize", audio: new Float32Array(16_000) } });
    receive({ data: { id: 3, type: "translate", text: "Hello", sourceLanguage: "en" } });
    await vi.waitFor(() => expect(runtime.recognize).toHaveBeenCalledOnce());
    expect(runtime.translate).not.toHaveBeenCalled();
    finishRecognition({ text: "Привет" });
    await vi.waitFor(() => expect(messages.filter(message => message.type === "result")).toEqual([
      { id: 2, type: "result", text: "Привет" }, { id: 3, type: "result", text: "Привет." },
    ]));
  });

  it("loads the explicitly selected Small model instead of the legacy low-power preset", async () => {
    expect(await send({ id: 1, type: "init", recognize: true, sourceLanguage: "ru", targetLanguage: "ru", quality: "light", model: "small" }))
      .toEqual({ id: 1, type: "ready" });
    expect(runtime.pipeline).toHaveBeenCalledExactlyOnceWith("automatic-speech-recognition", "Xenova/whisper-small", expect.objectContaining({
      revision: "2d67713f236afa48a18992566e7647f6ca848e13", device: "wasm", dtype: "q8",
    }));
    await send({ id: 2, type: "recognize", audio: new Float32Array(16_000) });
    expect(runtime.recognize).toHaveBeenCalledWith(expect.any(Float32Array), expect.objectContaining({ task: "transcribe", language: "russian" }));
  });

  it("rejects an unknown model before downloading anything and can retry", async () => {
    expect((await send({ id: 1, type: "init", recognize: true, sourceLanguage: "en", targetLanguage: "en", model: "large" as "small" })).type).toBe("error");
    expect(runtime.pipeline).not.toHaveBeenCalled();
    expect(await send({ id: 2, type: "init", recognize: false, sourceLanguage: "en", targetLanguage: "en" }))
      .toEqual({ id: 2, type: "ready" });
  });

  it("bounds excessive or malformed audio, text and language metadata before inference", async () => {
    await send({ id: 1, type: "init", recognize: true, sourceLanguage: "en", targetLanguage: "en" });
    expect((await send({ id: 2, type: "recognize", audio: new Float32Array(128_001) })).type).toBe("error");
    const invalid = new Float32Array(16_000); invalid[0] = Number.NaN;
    expect((await send({ id: 3, type: "recognize", audio: invalid })).type).toBe("error");
    expect((await send({ id: 4, type: "translate", text: "a".repeat(1_001), sourceLanguage: "en" })).type).toBe("error");
    expect((await send({ id: 5, type: "translate", text: "Hello", sourceLanguage: "xx" as "en" })).type).toBe("error");
    expect(runtime.recognize).not.toHaveBeenCalled();
    expect(runtime.translate).not.toHaveBeenCalled();
  });

  it("permits an explicit source language per recognition job", async () => {
    await send({ id: 1, type: "init", recognize: true, sourceLanguage: "ru", targetLanguage: "ru" });
    await send({ id: 2, type: "recognize", audio: new Float32Array(16_000), sourceLanguage: "en" });
    expect(runtime.recognize).toHaveBeenCalledWith(expect.any(Float32Array), expect.objectContaining({ language: "english", task: "transcribe" }));
  });

  it("recovers from a failed initial model download without poisoning its command queue", async () => {
    runtime.pipeline.mockRejectedValueOnce(new Error("Download unavailable"));
    expect((await send({ id: 1, type: "init", recognize: true, sourceLanguage: "en", targetLanguage: "ru" })).type).toBe("error");
    expect(await send({ id: 2, type: "init", recognize: false, sourceLanguage: "ru", targetLanguage: "ru" }))
      .toEqual({ id: 2, type: "ready" });
    expect(await send({ id: 3, type: "translate", text: "Сохрани оригинал", sourceLanguage: "ru" }))
      .toEqual({ id: 3, type: "result", text: "Сохрани оригинал" });
  });
});
