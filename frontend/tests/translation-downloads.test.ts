import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelDownloadFetch, evictPinnedModelCache, fetchModelAsset, isPublicModelUrl, modelLoadError, ModelDownloadError } from "../src/lib/translation/downloads";

const URL = "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/onnx/encoder_model_quantized.onnx";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("public model downloads", () => {
  it("retries transient failures with a fresh HTTP request and leaves application requests untouched", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(new Response(Uint8Array.of(8, 1, 2)));
    const download = createModelDownloadFetch(fetcher, { retryDelayMs: 0 });
    expect(new Uint8Array(await (await download(URL)).arrayBuffer())).toEqual(Uint8Array.of(8, 1, 2));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "reload" });
    fetcher.mockResolvedValueOnce(new Response("api"));
    const init = { method: "POST", body: "hello" };
    await download("/api/v1/calls", init);
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/calls", init);
  });

  it("does not retry optional missing metadata, denied files, or cancellation", async () => {
    for (const status of [404, 403]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status }));
      expect((await createModelDownloadFetch(fetcher)(URL)).status).toBe(status);
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(createModelDownloadFetch(fetcher)(URL, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(isPublicModelUrl("https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json")).toBe(false);
  });

  it("bounds stalled requests and reports timeout after the configured attempts", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const task = createModelDownloadFetch(fetcher, { attempts: 2, timeoutMs: 10, retryDelayMs: 0 })(URL);
    const assertion = expect(task).rejects.toMatchObject({ code: "timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("turns a broken response stream into a retryable download error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("broken stream https://provider?secret=x")); },
    })));
    const response = await createModelDownloadFetch(fetcher)(URL);
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "network", retryable: true, file: "encoder_model_quantized.onnx" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("loads despite inaccessible cache, and rejects corrupted cached bytes before re-downloading", async () => {
    vi.stubGlobal("caches", { open: vi.fn().mockRejectedValue(new DOMException("denied", "SecurityError")) });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(Uint8Array.of(8, 1, 2)));
    vi.stubGlobal("fetch", fetcher);
    expect((await fetchModelAsset(URL, { expectedBytes: 3 })).byteLength).toBe(3);
    const cache = {
      match: vi.fn().mockResolvedValue(new Response("<html>not a model</html>")), delete: vi.fn().mockResolvedValue(true), put: vi.fn().mockRejectedValue(new DOMException("full", "QuotaExceededError")),
    };
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    fetcher.mockResolvedValue(new Response(Uint8Array.of(8, 1, 2)));
    expect((await fetchModelAsset(URL, { expectedBytes: 3 })).byteLength).toBe(3);
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(URL);
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("evicts only the failed pinned model, preserving unrelated app data and other models", async () => {
    const same = new Request(URL);
    const other = new Request("https://huggingface.co/Xenova/whisper-base/resolve/64da57285918e20ea79ea5c88eed7197933abaa8/config.json");
    const cache = { keys: vi.fn().mockResolvedValue([same, other]), delete: vi.fn().mockResolvedValue(true) };
    const open = vi.fn().mockResolvedValue(cache);
    vi.stubGlobal("caches", { open });
    await evictPinnedModelCache("Xenova/whisper-tiny", "5332fcc35e32a33b86612b9a57a89be7906102b1");
    expect(open.mock.calls.map(call => call[0])).toEqual(["transformers-cache", "coherent-model-assets-v1"]);
    expect(cache.delete.mock.calls).toEqual([[same], [same]]);
  });

  it("exposes bounded actionable errors, not raw provider bodies or signed URLs", () => {
    expect(modelLoadError(new Error("RuntimeError: memory access out of bounds"))).toMatchObject({ code: "memory", retryable: false });
    expect(modelLoadError(new SyntaxError("Unexpected token '<' https://provider?secret=value"))).toMatchObject({ code: "invalid-model", retryable: true });
    const info = modelLoadError(new ModelDownloadError("http", "Источник временно недоступен", true, "model.onnx", 503));
    expect(info).toMatchObject({ code: "http", status: 503, file: "model.onnx" });
    expect(JSON.stringify(modelLoadError(new Error("Failed to fetch https://provider?secret=value")))).not.toContain("secret");
  });
});
