import type { Room } from "livekit-client";
import { captureMicrophone, type MicrophoneCapture } from "./capture";
import type { TranslationMetrics } from "./metrics";
import type { TranslationModelId } from "./models";
import type { TranslationLanguage, TranslationQuality, TranslationWorkerRequest, TranslationWorkerResponse } from "./protocol";
import { TranslationQueue, type TranslationJob } from "./queue";
import { createCaptionTransport, type Caption, type CaptionKey } from "./transport";

interface TranslationOptions {
  room: Room;
  callId: string;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  recognize: boolean;
  quality?: TranslationQuality;
  model?: TranslationModelId;
  metrics?: TranslationMetrics;
  getCaptionKeys(): readonly CaptionKey[];
  onStatus(status: string): void;
  onCaption(caption: Caption): void;
  onLocalCaption?(caption: Caption): void;
  onRecognitionReady?(ready: boolean): void;
  onError(message: string): void;
  onDropped(): void;
}

export interface TranslationSession {
  setMicrophoneTrack(track: MediaStreamTrack | null): void;
  close(): void;
}

export function startTranslationSession(options: TranslationOptions): TranslationSession {
  const { room, callId, recognize, targetLanguage, sourceLanguage, quality = "balanced", model, metrics, getCaptionKeys, onStatus, onCaption, onLocalCaption, onRecognitionReady, onError, onDropped } = options;
  let closed = false;
  let ready = false;
  let worker: Worker | undefined;
  let transport: ReturnType<typeof createCaptionTransport> | undefined;
  let capture: MicrophoneCapture | undefined;
  let microphone: MediaStreamTrack | null = null;
  let generation = 0;
  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: { id: number; job: TranslationJob; audioSeconds?: number; startedAt: number; stage: "loading" | "inference" } | undefined;
  function dropped(): void { if (!closed) { metrics?.drop(); onDropped(); } }
  const queue = new TranslationQueue(dropped);

  function close(): void {
    if (closed) return;
    closed = true;
    onRecognitionReady?.(false);
    generation++;
    clearTimeout(timer);
    capture?.close();
    capture = undefined;
    microphone = null;
    worker?.terminate();
    worker = undefined;
    metrics?.abort("recognition");
    metrics?.abort("translation");
    metrics?.setWorker("translation", false);
    transport?.close();
    queue.clear();
    current = undefined;
  }

  function fail(message: string): void {
    if (closed) return;
    close();
    onError(message);
  }

  async function attachMicrophone(track: MediaStreamTrack, expectedGeneration: number): Promise<void> {
    try {
      const next = await captureMicrophone(track, audio => {
        if (closed || expectedGeneration !== generation || !track.enabled || track.muted) return;
        queue.pushAudio(audio, expectedGeneration);
        pump();
      }, message => { if (!closed && expectedGeneration === generation) fail(message); });
      if (closed || expectedGeneration !== generation) next.close();
      else capture = next;
    } catch {
      if (!closed && expectedGeneration === generation) fail("Микрофон для перевода недоступен. Выключи передачу своей речи и используй субтитры собеседников.");
    }
  }

  function setMicrophoneTrack(track: MediaStreamTrack | null): void {
    if (closed || microphone === track) return;
    generation++;
    capture?.close();
    capture = undefined;
    queue.clearAudio();
    microphone = track;
    if (ready && recognize && track?.readyState === "live") void attachMicrophone(track, generation);
  }

  function markReady(): void {
    if (closed) return;
    clearTimeout(timer);
    if (worker) metrics?.finish(recognize ? "recognition" : "translation");
    ready = true;
    onRecognitionReady?.(recognize);
    onStatus(recognize ? "Перевод на устройстве включён" : "Принимаем субтитры · микрофон не обрабатывается");
    if (recognize && microphone?.readyState === "live") void attachMicrophone(microphone, generation);
    pump();
  }

  function post(request: TranslationWorkerRequest, timeout: number): void {
    clearTimeout(timer);
    timer = setTimeout(() => fail("Устройство не успевает выполнить перевод. Выключи передачу своей речи или выбери английские субтитры без модели перевода."), timeout);
    if (request.type === "recognize") worker!.postMessage(request, [request.audio.buffer]);
    else worker!.postMessage(request);
  }

  function receive(caption: Caption): void {
    if (closed) return;
    if (caption.speakerId === room.localParticipant.identity) return;
    if (caption.language === targetLanguage) { onCaption(caption); return; }
    queue.pushCaption(caption);
    if (!worker) initializeWorker();
    pump();
  }

  function pump(): void {
    if (closed || !ready || current || !worker) return;
    const job = queue.take();
    if (!job) return;
    const id = ++serial;
    current = { id, job, audioSeconds: job.type === "recognize" ? job.audio.length / 16_000 : undefined, startedAt: Date.now(), stage: job.type === "recognize" ? "inference" : "loading" };
    metrics?.begin(job.type === "recognize" ? "recognition" : "translation", current.stage);
    if (job.type === "recognize") post({ id, type: "recognize", audio: job.audio }, 30_000);
    else post({ id, type: "translate", text: job.caption.text, sourceLanguage: job.caption.language }, 300_000);
  }

  function result(data: TranslationWorkerResponse): void {
    if (closed) return;
    if (data.type === "progress") {
      if (data.id !== 0 && data.id !== current?.id) return;
      if (data.stage === "inference") {
        if (current) metrics?.transition(current.job.type === "recognize" ? "recognition" : "translation", "inference");
        if (current) current.stage = "inference";
        clearTimeout(timer);
        timer = setTimeout(() => fail("Локальный перевод не ответил вовремя. Попробуй экономичный режим."), 30_000);
        onStatus(current?.job.type === "recognize" ? "Распознаём твою речь на устройстве…" : "Переводим речь собеседника на устройстве…");
      } else {
        if (current) metrics?.transition(current.job.type === "recognize" ? "recognition" : "translation", "loading");
        if (current && current.stage !== "loading") {
          current.stage = "loading";
          clearTimeout(timer);
          timer = setTimeout(() => fail("Загрузка модели перевода заняла слишком много времени. Попробуй повторить позже."), 300_000);
        }
        onStatus(`Загружаем модели на устройство${data.progress === undefined ? "…" : ` · файл ${Math.round(data.progress)}%`}`);
      }
      return;
    }
    if (data.type === "error") { fail("Не удалось запустить локальную модель. Проверь свободную память и доступ к загрузке моделей, затем включи перевод снова."); return; }
    if (data.type === "ready" && data.id === 0) { markReady(); return; }
    if (data.type !== "result" || !current || data.id !== current.id) return;
    clearTimeout(timer);
    const { job, startedAt, audioSeconds } = current;
    metrics?.finish(job.type === "recognize" ? "recognition" : "translation", audioSeconds);
    current = undefined;
    const text = data.text?.trim().slice(0, 600);
    if (job.type === "translate") {
      if (text && Date.now() - job.createdAt <= 30_000) onCaption({ ...job.caption, text });
      else dropped();
    } else if (job.generation === generation && microphone?.enabled && !microphone.muted && microphone.readyState === "live") {
      // Transferring the PCM detaches its buffer; its age, not byte length, is
      // used here. Stale results never become delayed speech after unmuting.
      if (Date.now() - job.createdAt > 20_000) dropped();
      else if (text) {
        const caption: Caption = { id: crypto.randomUUID(), speakerId: room.localParticipant.identity, text, language: sourceLanguage, receivedAt: Date.now() };
        onLocalCaption?.(caption);
        void transport?.publish(text, sourceLanguage).catch(() => {
          if (!closed) onStatus("Не удалось передать субтитр. Проверяем соединение…");
        });
      }
      if (Date.now() - startedAt > 6_000) onStatus("Распознавание отстаёт · для меньшей нагрузки выключи передачу своей речи");
    }
    pump();
  }

  function initializeWorker(): void {
    if (closed) return;
    if (worker) return;
    try {
      ready = false;
      onStatus("Подготавливаем локальные модели… Первая загрузка может занять несколько минут.");
      metrics?.begin(recognize ? "recognition" : "translation", "loading");
      worker = new Worker(new URL("./model.worker.ts", import.meta.url), { type: "module" });
      metrics?.setWorker("translation", true);
      worker.onmessage = ({ data }: MessageEvent<TranslationWorkerResponse>) => result(data);
      worker.onerror = () => fail("Локальная модель недоступна в этом браузере. Обнови браузер или используй английские субтитры без распознавания своей речи.");
      worker.onmessageerror = () => fail("Не удалось получить результат локального перевода. Включи перевод повторно.");
      post({ id: 0, type: "init", recognize, sourceLanguage, targetLanguage, quality, ...(model ? { model } : {}) }, 300_000);
    } catch {
      fail("Не удалось включить локальный перевод. Проверь поддержку WebAssembly и сквозного шифрования.");
    }
  }

  queueMicrotask(() => {
    if (closed) return;
    transport = createCaptionTransport(room, callId, receive, getCaptionKeys);
    if (recognize) initializeWorker();
    else markReady();
  });

  return { setMicrophoneTrack, close };
}
