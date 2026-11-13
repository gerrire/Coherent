/** Browser-local timings. No audio, captions, device identifiers or network I/O. */
export type TranslationMetricKind = "recognition" | "translation" | "speech";
export type TranslationMetricPhase = "idle" | "loading" | "inference";

export interface TranslationMetricRecord {
  phase: TranslationMetricPhase;
  completed: number;
  lastInferenceMs: number | null;
  totalInferenceMs: number;
  lastLoadMs: number | null;
  totalLoadMs: number;
  lastAudioSeconds: number | null;
  /** Inference seconds / input audio seconds; below 1 means faster than real time. */
  lastRealtimeFactor: number | null;
  currentMs: number;
}

export interface TranslationMetricsSnapshot {
  recognition: TranslationMetricRecord;
  translation: TranslationMetricRecord;
  speech: TranslationMetricRecord;
  activeWorkers: number;
  dropped: number;
}

export interface TranslationMetrics {
  begin(kind: TranslationMetricKind, phase: Exclude<TranslationMetricPhase, "idle">): void;
  transition(kind: TranslationMetricKind, phase: Exclude<TranslationMetricPhase, "idle">): void;
  finish(kind: TranslationMetricKind, audioSeconds?: number): void;
  abort(kind: TranslationMetricKind): void;
  setWorker(worker: "translation" | "speech", active: boolean): void;
  drop(): void;
  getSnapshot(): TranslationMetricsSnapshot;
}

type TimedRecord = TranslationMetricRecord & { startedAt: number; inferenceMs: number; loadMs: number; inferred: boolean; loaded: boolean };

function emptyRecord(): TimedRecord {
  return { phase: "idle", completed: 0, lastInferenceMs: null, totalInferenceMs: 0, lastLoadMs: null,
    totalLoadMs: 0, lastAudioSeconds: null, lastRealtimeFactor: null, currentMs: 0,
    startedAt: 0, inferenceMs: 0, loadMs: 0, inferred: false, loaded: false };
}

/** One collector belongs to one call panel, shared by its ASR/MT and speech workers. */
export function createTranslationMetrics(now: () => number = () => performance.now()): TranslationMetrics {
  const records = { recognition: emptyRecord(), translation: emptyRecord(), speech: emptyRecord() };
  const workers = new Set<string>();
  let dropped = 0;

  function accrue(record: TimedRecord): void {
    const current = now();
    const elapsed = Math.max(0, current - record.startedAt);
    if (record.phase === "inference") record.inferenceMs += elapsed;
    if (record.phase === "loading") record.loadMs += elapsed;
    record.startedAt = current;
  }

  function settle(kind: TranslationMetricKind, success: boolean, audioSeconds?: number): void {
    const record = records[kind];
    if (record.phase === "idle") return;
    accrue(record);
    record.totalInferenceMs += record.inferenceMs;
    record.totalLoadMs += record.loadMs;
    if (success && record.loaded) record.lastLoadMs = record.loadMs;
    if (success && record.inferred) {
      record.completed++;
      record.lastInferenceMs = record.inferenceMs;
      record.lastAudioSeconds = audioSeconds !== undefined && Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : null;
      record.lastRealtimeFactor = record.lastAudioSeconds === null ? null : record.inferenceMs / 1000 / record.lastAudioSeconds;
    }
    record.phase = "idle";
    record.inferenceMs = record.loadMs = 0;
  }

  function snapshot(kind: TranslationMetricKind): TranslationMetricRecord {
    const record = records[kind];
    const elapsed = record.phase === "idle" ? 0 : Math.max(0, now() - record.startedAt);
    return {
      phase: record.phase, completed: record.completed, lastInferenceMs: record.lastInferenceMs,
      totalInferenceMs: record.totalInferenceMs + record.inferenceMs + (record.phase === "inference" ? elapsed : 0),
      lastLoadMs: record.lastLoadMs,
      totalLoadMs: record.totalLoadMs + record.loadMs + (record.phase === "loading" ? elapsed : 0),
      lastAudioSeconds: record.lastAudioSeconds, lastRealtimeFactor: record.lastRealtimeFactor, currentMs: elapsed,
    };
  }

  return {
    begin(kind, phase): void {
      settle(kind, false);
      const record = records[kind];
      record.phase = phase;
      record.startedAt = now();
      record.inferred = phase === "inference";
      record.loaded = phase === "loading";
    },
    transition(kind, phase): void {
      const record = records[kind];
      if (record.phase === "idle" || record.phase === phase) return;
      accrue(record);
      record.phase = phase;
      record.inferred ||= phase === "inference";
      record.loaded ||= phase === "loading";
    },
    finish(kind, audioSeconds): void { settle(kind, true, audioSeconds); },
    abort(kind): void { settle(kind, false); },
    setWorker(worker, active): void { if (active) workers.add(worker); else workers.delete(worker); },
    drop(): void { dropped++; },
    getSnapshot(): TranslationMetricsSnapshot {
      return { recognition: snapshot("recognition"), translation: snapshot("translation"), speech: snapshot("speech"), activeWorkers: workers.size, dropped };
    },
  };
}

export interface BrowserResources {
  logicalProcessors: number | null;
  /** Approximate device RAM capability exposed by some browsers. */
  deviceMemoryGB: number | null;
  /** Main-page JS heap only: excludes model weights in Workers/WASM and PC RAM. */
  jsHeapUsedBytes: number | null;
  jsHeapLimitBytes: number | null;
}

export function readBrowserResources(): BrowserResources {
  const capability = typeof navigator === "undefined" ? undefined : navigator as Navigator & { deviceMemory?: number };
  const memory = typeof performance === "undefined" ? undefined : (performance as Performance & { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
  const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  return {
    logicalProcessors: positive(capability?.hardwareConcurrency), deviceMemoryGB: positive(capability?.deviceMemory),
    jsHeapUsedBytes: positive(memory?.usedJSHeapSize), jsHeapLimitBytes: positive(memory?.jsHeapSizeLimit),
  };
}
