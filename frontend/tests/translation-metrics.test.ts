import { afterEach, expect, test, vi } from "vitest";
import { createTranslationMetrics, readBrowserResources } from "../src/lib/translation/metrics";

afterEach(() => vi.unstubAllGlobals());

test("measures inference separately from both model downloads in a pivot translation", () => {
  let time = 0;
  const metrics = createTranslationMetrics(() => time);
  metrics.begin("translation", "loading");
  time = 90_000;
  metrics.transition("translation", "inference");
  time += 200;
  metrics.transition("translation", "loading");
  time += 60_000;
  metrics.transition("translation", "inference");
  time += 300;
  metrics.finish("translation");
  expect(metrics.getSnapshot().translation).toMatchObject({ phase: "idle", completed: 1,
    lastInferenceMs: 500, totalInferenceMs: 500, lastLoadMs: 150_000, totalLoadMs: 150_000,
    lastRealtimeFactor: null });
});

test("tracks real-time ratio, ongoing work, aborted work and unique live workers independently", () => {
  let time = 0;
  const metrics = createTranslationMetrics(() => time);
  metrics.setWorker("translation", true);
  metrics.setWorker("translation", true);
  metrics.setWorker("speech", true);
  metrics.begin("recognition", "inference");
  time += 2_000;
  metrics.finish("recognition", 4);
  expect(metrics.getSnapshot().recognition).toMatchObject({ completed: 1, lastAudioSeconds: 4, lastRealtimeFactor: 0.5 });
  metrics.begin("recognition", "inference");
  time += 300;
  expect(metrics.getSnapshot()).toMatchObject({ activeWorkers: 2, recognition: { phase: "inference", currentMs: 300, totalInferenceMs: 2_300 } });
  metrics.abort("recognition");
  metrics.setWorker("translation", false);
  metrics.setWorker("speech", false);
  metrics.drop();
  const snapshot = metrics.getSnapshot();
  expect(snapshot).toMatchObject({ activeWorkers: 0, dropped: 1, recognition: { phase: "idle", completed: 1, totalInferenceMs: 2_300, lastInferenceMs: 2_000 } });
  snapshot.recognition.completed = 999;
  expect(metrics.getSnapshot().recognition.completed).toBe(1);
});

test("marks unavailable browser resource APIs as unknown instead of estimating PC usage", () => {
  vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
  vi.stubGlobal("performance", {});
  expect(readBrowserResources()).toEqual({ logicalProcessors: 4, deviceMemoryGB: null, jsHeapUsedBytes: null, jsHeapLimitBytes: null });
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, deviceMemory: 4 });
  vi.stubGlobal("performance", { memory: { usedJSHeapSize: 20_000_000, jsHeapSizeLimit: 2_000_000_000 } });
  expect(readBrowserResources()).toEqual({ logicalProcessors: 8, deviceMemoryGB: 4, jsHeapUsedBytes: 20_000_000, jsHeapLimitBytes: 2_000_000_000 });
});
