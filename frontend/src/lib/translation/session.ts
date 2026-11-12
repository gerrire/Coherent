import type { Room } from "livekit-client";
import { captureMicrophone, type MicrophoneCapture } from "./capture";
import type { TranslationLanguage, TranslationWorkerRequest, TranslationWorkerResponse } from "./protocol";
import { TranslationQueue, type TranslationJob } from "./queue";
import { createCaptionTransport, type Caption } from "./transport";

interface TranslationOptions {
  room: Room;
  callId: string;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  recognize: boolean;
  onStatus(status: string): void;
  onCaption(caption: Caption): void;
  onError(message: string): void;
  onDropped(): void;
}

export interface TranslationSession {
  setMicrophoneTrack(track: MediaStreamTrack | null): void;
  close(): void;
}

export function startTranslationSession(options: TranslationOptions): TranslationSession {
  const { room, callId, recognize, targetLanguage, sourceLanguage, onStatus, onCaption, onError, onDropped } = options;
  let closed = false;
  let ready = false;
  let worker: Worker | undefined;
  let transport: ReturnType<typeof createCaptionTransport> | undefined;
  let capture: MicrophoneCapture | undefined;
  let microphone: MediaStreamTrack | null = null;
  let generation = 0;
  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: { id: number; job: TranslationJob; startedAt: number } | undefined;
  const queue = new TranslationQueue(() => { if (!closed) onDropped(); });

  function close(): void {
    if (closed) return;
    closed = true;
    generation++;
    clearTimeout(timer);
    capture?.close();
    capture = undefined;
    microphone = null;
    worker?.terminate();
    worker = undefined;
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
    ready = true;
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
    if (targetLanguage === "en") { onCaption(caption); return; }
    queue.pushCaption(caption);
    pump();
  }

  function pump(): void {
    if (closed || !ready || current || !worker) return;
    const job = queue.take();
    if (!job) return;
    const id = ++serial;
    current = { id, job, startedAt: Date.now() };
    if (job.type === "recognize") post({ id, type: "recognize", audio: job.audio }, 30_000);
    else post({ id, type: "translate", text: job.caption.text }, 30_000);
  }

  function result(data: TranslationWorkerResponse): void {
    if (closed) return;
    if (data.type === "progress") {
      onStatus(`Загружаем модели на устройство${data.progress === undefined ? "…" : ` · файл ${Math.round(data.progress)}%`}`);
      return;
    }
    if (data.type === "error") { fail("Не удалось запустить локальную модель. Проверь свободную память и доступ к загрузке моделей, затем включи перевод снова."); return; }
    if (data.type === "ready" && data.id === 0) { markReady(); return; }
    if (data.type !== "result" || !current || data.id !== current.id) return;
    clearTimeout(timer);
    const { job, startedAt } = current;
    current = undefined;
    const text = data.text?.trim().slice(0, 600);
    if (job.type === "translate") {
      if (text && Date.now() - job.createdAt <= 30_000) onCaption({ ...job.caption, text });
      else onDropped();
    } else if (job.generation === generation && microphone?.enabled && !microphone.muted && microphone.readyState === "live") {
      // Transferring the PCM detaches its buffer; its age, not byte length, is
      // used here. Stale results never become delayed speech after unmuting.
      if (Date.now() - job.createdAt > 20_000) onDropped();
      else if (text) {
        const caption: Caption = { id: crypto.randomUUID(), speakerId: room.localParticipant.identity, text, receivedAt: Date.now() };
        receive(caption);
        void transport?.publish(text).catch(() => {
          if (!closed) onStatus("Не удалось передать субтитр. Проверяем соединение…");
        });
      }
      if (Date.now() - startedAt > 6_000) onStatus("Распознавание отстаёт · для меньшей нагрузки выключи передачу своей речи");
    }
    pump();
  }

  // Defer initialization so the caller can safely retain/close the session even
  // if constructing a Worker fails synchronously in an unsupported browser.
  queueMicrotask(() => {
    if (closed) return;
    try {
      transport = createCaptionTransport(room, callId, receive);
      if (!recognize && targetLanguage === "en") { markReady(); return; }
      onStatus("Подготавливаем локальные модели… Первая загрузка может занять несколько минут.");
      worker = new Worker(new URL("./model.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<TranslationWorkerResponse>) => result(data);
      worker.onerror = () => fail("Локальная модель недоступна в этом браузере. Обнови браузер или используй английские субтитры без распознавания своей речи.");
      worker.onmessageerror = () => fail("Не удалось получить результат локального перевода. Включи перевод повторно.");
      post({ id: 0, type: "init", recognize, sourceLanguage, targetLanguage }, 300_000);
    } catch {
      fail("Не удалось включить локальный перевод. Проверь поддержку WebAssembly и сквозного шифрования.");
    }
  });

  return { setMicrophoneTrack, close };
}
