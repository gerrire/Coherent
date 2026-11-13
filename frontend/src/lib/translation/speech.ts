import type { TranslationLanguage } from "./protocol";
import type { TranslationMetrics } from "./metrics";
import type { SpeechWorkerRequest, SpeechWorkerResponse } from "./speechProtocol";

export interface LocalSpeechOptions {
  language: TranslationLanguage;
  /** Choose the downloadable Russian voice even if the OS advertises one. */
  downloadedVoice?: boolean;
  metrics?: TranslationMetrics;
  onStatus(message: string): void;
  onError(message: string): void;
  onSpeakingChange(speaking: boolean): void;
}

export interface LocalSpeech {
  /** Call directly from a user click to unlock audio before awaiting downloads. */
  prepare(): Promise<void>;
  speak(text: string): void;
  cancel(): void;
  close(): void;
}

export function localVoiceFor(language: TranslationLanguage): SpeechSynthesisVoice | undefined {
  if (!("speechSynthesis" in window)) return undefined;
  return window.speechSynthesis.getVoices().find(voice => voice.localService
    && voice.lang.toLowerCase().split(/[-_]/)[0] === language);
}

/** Local system voice, or a downloadable Russian voice synthesized on-device. */
export function createLocalSpeech(options: LocalSpeechOptions): LocalSpeech {
  let closed = false;
  let ready = false;
  let preparing: Promise<void> | undefined;
  let context: AudioContext | undefined;
  let worker: Worker | undefined;
  let nativeVoice: SpeechSynthesisVoice | undefined;
  let utterance: SpeechSynthesisUtterance | undefined;
  let source: AudioBufferSourceNode | undefined;
  let pending: { text: string; receivedAt: number } | undefined;
  let generation = 0;
  let serial = 0;
  let inference: { id: number; generation: number } | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let playbackDeadline: ReturnType<typeof setTimeout> | undefined;
  let initResolve: (() => void) | undefined;
  let initReject: ((error: Error) => void) | undefined;
  let speaking = false;
  let reportedError = false;
  let nativeFailed = options.downloadedVoice === true;

  function setSpeaking(next: boolean): void {
    if (speaking === next) return;
    speaking = next;
    if (!closed) options.onSpeakingChange(next);
  }

  function finishPlayback(): void {
    clearTimeout(playbackDeadline);
    if (source) { source.onended = null; source.disconnect(); source = undefined; }
    if (utterance) { utterance.onend = null; utterance.onerror = null; utterance = undefined; }
    setSpeaking(false);
    pump();
  }

  function cancel(): void {
    generation++;
    pending = undefined;
    clearTimeout(playbackDeadline);
    if (source) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); source = undefined; }
    if (utterance) {
      utterance.onend = null;
      utterance.onerror = null;
      utterance = undefined;
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
    // An in-flight local calculation finishes in the worker. Its generation is
    // invalid now, and retaining its slot prevents a queue of cancelled jobs.
  }

  function fail(message: string): void {
    if (closed) return;
    cancel();
    clearTimeout(deadline);
    inference = undefined;
    ready = false;
    preparing = undefined;
    worker?.terminate();
    worker = undefined;
    options.metrics?.abort("speech");
    options.metrics?.setWorker("speech", false);
    initReject?.(new Error(message));
    initResolve = initReject = undefined;
    reportedError = true;
    options.onError(message);
  }

  function onMessage(data: SpeechWorkerResponse): void {
    if (closed) return;
    if (data.type === "progress") { options.onStatus(`Загружаем русский голос на устройство · ${Math.round(data.progress)}%`); return; }
    if (data.type === "ready" && data.id === 0) {
      clearTimeout(deadline);
      options.metrics?.finish("speech");
      ready = true;
      options.onStatus("Русский голос готов · озвучивание на устройстве");
      initResolve?.();
      initResolve = initReject = undefined;
      pump();
      return;
    }
    if (data.type === "error") { fail(data.message); return; }
    if (data.type !== "audio" || !inference || data.id !== inference.id) return;
    clearTimeout(deadline);
    options.metrics?.finish("speech");
    const currentGeneration = inference.generation;
    inference = undefined;
    if (currentGeneration !== generation) { pump(); return; }
    if (!context || data.sampleRate !== 22_050 || data.pcm.byteLength === 0 || data.pcm.byteLength > 22_050 * 45 * 4) { fail("Не удалось воспроизвести локальный голос."); return; }
    try {
      const pcm = new Float32Array(data.pcm);
      const buffer = context.createBuffer(1, pcm.length, data.sampleRate);
      buffer.copyToChannel(pcm, 0);
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = finishPlayback;
      setSpeaking(true);
      source.start();
      playbackDeadline = setTimeout(() => { cancel(); options.onError("Озвучивание остановлено: браузер не завершил воспроизведение."); }, 46_000);
    } catch { fail("Браузер не воспроизводит перевод. Нажми «Проверить звук» и проверь звук вкладки."); }
  }

  function pump(): void {
    if (closed || !ready || inference || source || utterance || !pending) return;
    if (Date.now() - pending.receivedAt > 15_000) { pending = undefined; options.metrics?.drop(); return; }
    const { text } = pending;
    pending = undefined;
    if (nativeVoice) {
      const nextUtterance = new SpeechSynthesisUtterance(text);
      utterance = nextUtterance;
      nextUtterance.voice = nativeVoice;
      nextUtterance.lang = nativeVoice.lang;
      nextUtterance.onend = () => { if (!closed && utterance === nextUtterance) finishPlayback(); };
      nextUtterance.onerror = () => {
        if (closed || utterance !== nextUtterance) return;
        const latest = pending;
        cancel();
        if (options.language === "ru") {
          nativeFailed = true;
          nativeVoice = undefined;
          ready = false;
          preparing = undefined;
          pending = latest ?? { text, receivedAt: Date.now() };
          options.onStatus("Системный голос недоступен · загружаем русский голос на устройство");
          void prepare().catch(() => { /* Reported through onError. */ });
        } else options.onError("Системный голос не смог озвучить перевод. Проверь звук вкладки и нажми «Проверить звук».");
      };
      setSpeaking(true);
      playbackDeadline = setTimeout(() => { cancel(); options.onError("Системный голос не завершил озвучивание вовремя. Проверь звук вкладки."); }, 46_000);
      try { window.speechSynthesis.speak(utterance); }
      catch { cancel(); options.onError("Браузер запретил озвучивание. Нажми «Проверить звук»."); }
      return;
    }
    if (!worker) return;
    const id = ++serial;
    inference = { id, generation };
    options.metrics?.begin("speech", "inference");
    deadline = setTimeout(() => fail("Устройство не успевает озвучить перевод. Отключи озвучивание или выбери системный голос."), 30_000);
    const request: SpeechWorkerRequest = { id, type: "speak", text };
    worker.postMessage(request);
  }

  async function prepareVoice(): Promise<void> {
    // AudioContext.resume() settles asynchronously; the controller may have
    // been closed before its continuation starts, including forced download.
    if (closed) return;
    nativeVoice = nativeFailed ? undefined : localVoiceFor(options.language);
    if (!nativeVoice && !nativeFailed && "speechSynthesis" in window) {
      // Chromium can populate local voices after the first event loop turn.
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); window.speechSynthesis.removeEventListener("voiceschanged", finish); resolve(); };
        const timer = setTimeout(finish, 300);
        window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
      });
      if (closed) return;
      nativeVoice = nativeFailed ? undefined : localVoiceFor(options.language);
    }
    if (nativeVoice) {
      ready = true;
      options.onStatus("Озвучивание локальным системным голосом готово");
      pump();
      return;
    }
    if (options.language !== "ru") throw new Error("Для этого языка нужен установленный локальный голос. Доступны субтитры; русский голос можно скачать в приложении.");
    options.onStatus("Подготавливаем русский голос · первая загрузка около 63 МБ");
    options.metrics?.begin("speech", "loading");
    const nextWorker = new Worker(new URL("./speech.worker.ts", import.meta.url), { type: "module" });
    worker = nextWorker;
    options.metrics?.setWorker("speech", true);
    nextWorker.onmessage = ({ data }: MessageEvent<SpeechWorkerResponse>) => { if (worker === nextWorker) onMessage(data); };
    nextWorker.onerror = () => { if (worker === nextWorker) fail("Не удалось запустить локальный русский голос. Проверь доступ к загрузке и свободную память."); };
    nextWorker.onmessageerror = () => { if (worker === nextWorker) fail("Не удалось получить звук локального голоса."); };
    return new Promise<void>((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
      deadline = setTimeout(() => fail("Загрузка русского голоса заняла слишком много времени. Попробуй включить озвучивание снова."), 300_000);
      const request: SpeechWorkerRequest = { id: 0, type: "init" };
      worker!.postMessage(request);
    });
  }

  function prepare(): Promise<void> {
    if (closed) return Promise.reject(new Error("Озвучивание уже выключено."));
    // Resume synchronously from the initiating click, before any model download.
    try { context ??= new AudioContext({ latencyHint: "playback" }); } catch { /* Native speech can still work. */ }
    const unlocked = context?.resume() ?? Promise.resolve();
    if (ready) return unlocked;
    if (preparing) return preparing;
    reportedError = false;
    preparing = unlocked.then(prepareVoice).catch(error => {
      preparing = undefined;
      if (!closed) options.metrics?.abort("speech");
      if (!closed && !reportedError) options.onError(error instanceof Error ? error.message : "Не удалось включить озвучивание.");
      throw error;
    });
    return preparing;
  }

  return {
    prepare,
    speak(text: string): void {
      if (closed) return;
      const next = text.trim();
      if (!next) return;
      if (next.length > 600) { options.onError("Фраза для озвучивания слишком длинная."); return; }
      if (pending) options.metrics?.drop();
      pending = { text: next, receivedAt: Date.now() };
      pump();
    },
    cancel,
    close(): void {
      if (closed) return;
      cancel();
      closed = true;
      clearTimeout(deadline);
      worker?.terminate();
      worker = undefined;
      options.metrics?.abort("speech");
      options.metrics?.setWorker("speech", false);
      initReject?.(new Error("Озвучивание выключено."));
      initResolve = initReject = undefined;
      void context?.close().catch(() => undefined);
      context = undefined;
    },
  };
}
