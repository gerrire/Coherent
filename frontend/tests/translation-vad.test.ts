import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ env: { wasm: {} }, create: vi.fn(), run: vi.fn(), release: vi.fn(), download: vi.fn(), evict: vi.fn() }));
vi.mock("coherent-recognition-ort", () => ({
  env: mock.env,
  Tensor: class { constructor(public type: string, public data: unknown, public dims: readonly number[]) {} },
  InferenceSession: { create: mock.create },
}));
vi.mock("../src/lib/translation/downloads", () => ({ fetchModelAsset: mock.download, evictModelAsset: mock.evict }));
import { createSileroDetector, SILERO_MODEL } from "../src/lib/translation/silero";

beforeEach(() => {
  mock.download.mockReset().mockResolvedValue(new ArrayBuffer(8));
  mock.run.mockReset();
  mock.release.mockReset().mockResolvedValue(undefined);
  mock.create.mockReset().mockResolvedValue({ run: mock.run, release: mock.release });
  mock.evict.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("local Silero speech gate", () => {
  it("uses immutable direct weights and a checksum, and rejects noise without ASR", async () => {
    mock.run.mockResolvedValue({ output: { data: Float32Array.of(0.05) }, stateN: { data: new Float32Array(256) } });
    const detector = await createSileroDetector();
    expect(mock.download).toHaveBeenCalledWith(expect.stringContaining(`/${SILERO_MODEL.revision}/src/silero_vad/data/silero_vad.onnx`), expect.objectContaining({ sha256: SILERO_MODEL.sha256, expectedBytes: 2_327_524 }));
    expect(mock.env.wasm).toMatchObject({ numThreads: 1, proxy: false });
    expect(await detector.containsSpeech(new Float32Array(4_000))).toBe(false);
    const first = mock.run.mock.calls[0][0];
    expect(first.input).toMatchObject({ type: "float32", dims: [1, 576] });
    expect(first.state).toMatchObject({ dims: [2, 1, 128] });
    expect(first.sr.data).toEqual(BigInt64Array.of(16_000n));
    await detector.close(); await detector.close();
    expect(mock.release).toHaveBeenCalledOnce();
  });

  it("requires a short consecutive speech run and returns before processing an entire long fragment", async () => {
    for (const value of [0.8, 0.1, 0.9, 0.7, 0.8]) mock.run.mockResolvedValueOnce({ output: { data: Float32Array.of(value) }, stateN: { data: new Float32Array(256) } });
    const detector = await createSileroDetector();
    expect(await detector.containsSpeech(new Float32Array(96_000))).toBe(true);
    expect(mock.run).toHaveBeenCalledTimes(5);
    await detector.close();
    expect(await detector.containsSpeech(new Float32Array(16_000))).toBe(false);
    expect(mock.run).toHaveBeenCalledTimes(5);
  });

  it("does not return speech from a detector closed while a frame was running", async () => {
    let resolveFrame!: (value: unknown) => void;
    mock.run.mockImplementation(() => new Promise(resolve => { resolveFrame = resolve; }));
    const detector = await createSileroDetector();
    const pending = detector.containsSpeech(new Float32Array(16_000));
    await detector.close();
    resolveFrame({ output: { data: Float32Array.of(0.99) }, stateN: { data: new Float32Array(256) } });
    expect(await pending).toBe(false);
    expect(mock.run).toHaveBeenCalledOnce();
  });
});
