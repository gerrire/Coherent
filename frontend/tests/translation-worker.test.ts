import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationWorkerRequest, TranslationWorkerResponse } from "../src/lib/translation/protocol";

const runtime = vi.hoisted(() => ({
  env: { backends: { onnx: { wasm: {} } } } as Record<string, any>,
  pipeline: vi.fn(),
  recognize: vi.fn(),
  translate: vi.fn(),
  disposeRecognizer: vi.fn(),
  disposeTranslator: vi.fn(),
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
  runtime.recognize.mockReset().mockResolvedValue({ text: " Hello there. " });
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
  it("receives English captions without downloading or allocating any model", async () => {
    expect(await send({ id: 1, type: "init", recognize: false, sourceLanguage: "ru", targetLanguage: "en" }))
      .toEqual({ id: 1, type: "ready" });
    expect(await send({ id: 2, type: "translate", text: " Hello " })).toEqual({ id: 2, type: "result", text: "Hello" });
    expect(runtime.pipeline).not.toHaveBeenCalled();
    expect(runtime.env.allowLocalModels).toBe(false);
    expect(runtime.env.backends.onnx.wasm).toMatchObject({ numThreads: 1, proxy: false });
    expect(runtime.env.backends.onnx.wasm.wasmPaths.mjs).toContain("ort-wasm-simd-threaded.jsep.mjs");
    expect(runtime.env.backends.onnx.wasm.wasmPaths.wasm).toContain("ort-wasm-simd-threaded.jsep.wasm");
  });

  it("receive-only Russian loads just its one pinned quantized translator", async () => {
    await send({ id: 1, type: "init", recognize: false, sourceLanguage: "en", targetLanguage: "ru" });
    expect(runtime.pipeline).toHaveBeenCalledExactlyOnceWith("translation", "Xenova/opus-mt-en-ru", expect.objectContaining({
      revision: "e050376e960175e8ddc5cff85025dc8436cddd68", device: "wasm", dtype: "q8",
    }));
    expect((await send({ id: 2, type: "recognize", audio: new Float32Array(16_000) })).type).toBe("error");
    expect(runtime.recognize).not.toHaveBeenCalled();
    expect(await send({ id: 3, type: "translate", text: "Hello" })).toEqual({ id: 3, type: "result", text: "Привет." });
  });

  it("serializes speech and text inference, translating Russian speech to the shared English representation", async () => {
    await send({ id: 1, type: "init", recognize: true, sourceLanguage: "ru", targetLanguage: "ru" });
    let finishRecognition!: (value: { text: string }) => void;
    runtime.recognize.mockImplementation(() => new Promise(resolve => { finishRecognition = resolve; }));
    receive({ data: { id: 2, type: "recognize", audio: new Float32Array(16_000) } });
    receive({ data: { id: 3, type: "translate", text: "Hello" } });
    await vi.waitFor(() => expect(runtime.recognize).toHaveBeenCalledOnce());
    expect(runtime.translate).not.toHaveBeenCalled();
    expect(runtime.recognize).toHaveBeenCalledWith(expect.any(Float32Array), expect.objectContaining({
      language: "russian", task: "translate", num_beams: 1, max_new_tokens: 96,
    }));
    finishRecognition({ text: "Hello" });
    await vi.waitFor(() => expect(messages.filter(message => message.type === "result")).toEqual([
      { id: 2, type: "result", text: "Hello" }, { id: 3, type: "result", text: "Привет." },
    ]));
  });

  it("bounds malformed or excessive audio and text before invoking models", async () => {
    await send({ id: 1, type: "init", recognize: true, sourceLanguage: "en", targetLanguage: "en" });
    expect((await send({ id: 2, type: "recognize", audio: new Float32Array(128_001) })).type).toBe("error");
    const invalid = new Float32Array(16_000);
    invalid[0] = Number.NaN;
    expect((await send({ id: 3, type: "recognize", audio: invalid })).type).toBe("error");
    expect((await send({ id: 4, type: "translate", text: "a".repeat(1_001) })).type).toBe("error");
    expect(runtime.recognize).not.toHaveBeenCalled();
    expect(runtime.translate).not.toHaveBeenCalled();
  });

  it("releases an initialized recognizer if the target model fails to load and permits a retry", async () => {
    runtime.pipeline.mockRejectedValueOnce(new Error("Download unavailable"));
    expect((await send({ id: 1, type: "init", recognize: false, sourceLanguage: "en", targetLanguage: "ru" })).type).toBe("error");
    runtime.pipeline.mockImplementation(async task => {
      if (task === "translation") throw new Error("Download unavailable");
      return Object.assign(runtime.recognize, { dispose: runtime.disposeRecognizer });
    });
    expect((await send({ id: 2, type: "init", recognize: true, sourceLanguage: "en", targetLanguage: "ru" })).type).toBe("error");
    expect(runtime.disposeRecognizer).toHaveBeenCalledOnce();
    expect(await send({ id: 3, type: "init", recognize: false, sourceLanguage: "en", targetLanguage: "en" }))
      .toEqual({ id: 3, type: "ready" });
  });
});
