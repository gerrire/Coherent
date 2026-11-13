import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type TranslationPipeline,
} from "@huggingface/transformers";
import runtimeModuleUrl from "coherent-ort-runtime-module?url";
import runtimeWasmUrl from "coherent-ort-runtime-wasm?url";
import { getModelProfile, isTranslationModelId } from "./models";
import {
  isTranslationLanguage,
  type TranslationLanguage,
  type TranslationWorkerRequest,
  type TranslationWorkerResponse,
} from "./protocol";

// Fetch model files directly to the participant's browser cache. Never probe the
// application server for /models, use a server inference route, or upload audio.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.remoteHost = "https://huggingface.co/";
env.remotePathTemplate = "{model}/resolve/{revision}/";
// A single WASM thread leaves CPU time for the encrypted audio/video call and
// also works without SharedArrayBuffer or cross-origin isolation headers.
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
// Bundle runtime code on our origin, so script-src remains 'self'. These assets
// contain ONNX execution code only; neural-network weights stay on the Hub and
// are downloaded directly to the user's device after enabling translation.
env.backends.onnx.wasm!.wasmPaths = { mjs: runtimeModuleUrl, wasm: runtimeWasmUrl };

interface ModelReference { id: string; revision: string }
const FROM_ENGLISH: Record<Exclude<TranslationLanguage, "en">, ModelReference> = {
  ru: { id: "Xenova/opus-mt-en-ru", revision: "e050376e960175e8ddc5cff85025dc8436cddd68" },
  de: { id: "Xenova/opus-mt-en-de", revision: "1ca130c44c4c5441ef16d48aae521a424ab644f7" },
  fr: { id: "Xenova/opus-mt-en-fr", revision: "28726206f80896b90035bd99cccd5cc1e151f916" },
  es: { id: "Xenova/opus-mt-en-es", revision: "4b002a4c7edd54a7ced58877258b87f7efd3f892" },
};

const TO_ENGLISH: Record<Exclude<TranslationLanguage, "en">, ModelReference> = {
  ru: { id: "Xenova/opus-mt-ru-en", revision: "afe8c6c738ec81b6d033fd8f44f9678a639a7c67" },
  de: { id: "Xenova/opus-mt-de-en", revision: "399dfd68706739fffd503f876093e455ae268a06" },
  fr: { id: "Xenova/opus-mt-fr-en", revision: "6b166a182780e118c997879d0ad5be4b53671644" },
  es: { id: "Xenova/opus-mt-es-en", revision: "eadfd7c658a9d8929ac3b8e996b68a68e2c7d480" },
};

const WHISPER_LANGUAGES: Record<TranslationLanguage, string> = {
  en: "english", ru: "russian", de: "german", fr: "french", es: "spanish",
};

let recognizer: AutomaticSpeechRecognitionPipeline | null = null;
let translator: TranslationPipeline | null = null;
let translatorId: string | null = null;
let settings: Extract<TranslationWorkerRequest, { type: "init" }> | null = null;
let queue = Promise.resolve();

function reply(message: TranslationWorkerResponse): void {
  self.postMessage(message);
}

function progressFor(id: number) {
  return (info: { status: string; file?: string; progress?: number }) => reply({
    id, type: "progress", stage: "loading", message: info.file ? `Downloading ${info.file}` : "Preparing local models",
    progress: typeof info.progress === "number" ? Math.min(100, Math.max(0, info.progress)) : undefined,
  });
}

function sentences(text: string, language: TranslationLanguage): string[] {
  const parts = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(language, { granularity: "sentence" }).segment(text), item => item.segment.trim())
    : text.split(/(?<=[.!?…])\s+/u).map(part => part.trim());
  const present = parts.filter(Boolean);
  // Marian is trained on sentence pairs and can omit an earlier sentence in
  // a multi-sentence caption. Keep separate sentences, while bounding calls.
  return present.length <= 16 ? present : [...present.slice(0, 15), present.slice(15).join(" ")];
}

async function translateWith(model: ModelReference, text: string, id: number): Promise<string> {
  if (translatorId !== model.id) {
    // Mixed-language groups still allocate at most one Marian model. The
    // browser caches files, but an old inference session is freed before the
    // next one is constructed, including between two non-English passes.
    const previous = translator;
    translator = null;
    translatorId = null;
    if (previous) await previous.dispose();
    translator = await pipeline<"translation">("translation", model.id, {
      revision: model.revision, device: "wasm", dtype: "q8", progress_callback: progressFor(id),
    });
    translatorId = model.id;
  }
  const options = {
    max_new_tokens: 160,
    // Transformers.js 3.8 only follows the first beam in encoder-decoder
    // generation. Request one beam rather than claiming a quality benefit.
    num_beams: 1,
    do_sample: false,
  } as Parameters<TranslationPipeline>[1];
  reply({ id, type: "progress", stage: "inference", message: "Translating locally" });
  const output = await translator!(text, options);
  const first = output[0];
  return ((Array.isArray(first) ? first[0] : first)?.translation_text ?? "").trim().slice(0, 1_000);
}

async function handle(request: TranslationWorkerRequest): Promise<void> {
  if (request.type === "init") {
    if (settings) throw new Error("Translation is already initialized. Restart it to change languages.");
    if (!isTranslationLanguage(request.sourceLanguage) || !isTranslationLanguage(request.targetLanguage)) {
      throw new Error("Unsupported translation language.");
    }
    if (request.quality !== undefined && request.quality !== "light" && request.quality !== "balanced") {
      throw new Error("Unsupported recognition quality.");
    }
    if (request.model !== undefined && !isTranslationModelId(request.model)) {
      throw new Error("Unsupported recognition model.");
    }
    // Translators are selected lazily using the actual incoming language.
    // Same-language captions never download or invoke a translation model.
    try {
      if (request.recognize) {
        const model = getModelProfile(request.model ?? (request.quality === "light" ? "tiny" : "base"));
        recognizer = await pipeline<"automatic-speech-recognition">("automatic-speech-recognition", model.repository, {
          revision: model.revision, device: "wasm", dtype: "q8", progress_callback: progressFor(request.id),
        });
      }
      settings = request;
      reply({ id: request.id, type: "ready" });
    } catch (error) {
      await recognizer?.dispose().catch(() => undefined);
      await translator?.dispose().catch(() => undefined);
      recognizer = null;
      translator = null;
      translatorId = null;
      throw error;
    }
    return;
  }

  if (!settings) throw new Error("Local translation is not initialized.");

  if (request.type === "recognize") {
    if (!recognizer || !settings.recognize) throw new Error("Microphone translation is disabled.");
    // The capture worklet must supply mono, 16 kHz PCM. Raw arrays are NOT
    // resampled by Transformers.js. Bound input even if the caller misbehaves.
    const audio = request.audio;
    if (!(audio instanceof Float32Array) || audio.length < 4_000 || audio.length > 128_000
      || !audio.every(Number.isFinite)) {
      throw new Error("Expected between 0.25 and 8 seconds of mono 16 kHz audio.");
    }
    const sourceLanguage = request.sourceLanguage ?? settings.sourceLanguage;
    if (!isTranslationLanguage(sourceLanguage)) throw new Error("Unsupported speech language.");
    reply({ id: request.id, type: "progress", stage: "inference", message: "Recognizing locally" });
    const output = await recognizer(audio, {
      language: WHISPER_LANGUAGES[sourceLanguage],
      task: "transcribe",
      return_timestamps: false,
      max_new_tokens: 128,
      num_beams: 1,
      do_sample: false,
    });
    const result = Array.isArray(output) ? output[0] : output;
    reply({ id: request.id, type: "result", text: (result?.text ?? "").trim().slice(0, 1_000) });
    return;
  }

  if (request.type === "translate") {
    if (typeof request.text !== "string" || request.text.length > 1_000) {
      throw new Error("Caption is too long.");
    }
    if (!isTranslationLanguage(request.sourceLanguage)) throw new Error("Unsupported caption language.");
    const text = request.text.trim();
    if (!text || request.sourceLanguage === settings.targetLanguage) {
      reply({ id: request.id, type: "result", text });
      return;
    }
    // Direct EN↔target paths avoid needless round trips. Other pairs use an
    // English pivot only when source and target actually differ.
    let parts = sentences(text, request.sourceLanguage);
    if (request.sourceLanguage !== "en") {
      const translated: string[] = [];
      for (const part of parts) translated.push(await translateWith(TO_ENGLISH[request.sourceLanguage], part, request.id));
      parts = translated;
    }
    if (settings.targetLanguage !== "en") {
      const translated: string[] = [];
      for (const part of parts) if (part) translated.push(await translateWith(FROM_ENGLISH[settings.targetLanguage], part, request.id));
      parts = translated;
    }
    reply({ id: request.id, type: "result", text: parts.filter(Boolean).join(" ").slice(0, 1_000) });
    return;
  }

  throw new Error("Unknown translation request.");
}

self.addEventListener("message", (event: MessageEvent<TranslationWorkerRequest>) => {
  const request = event.data;
  // ASR and MT share one worker and never infer concurrently. The client owns
  // the bounded real-time queue and terminates this worker on stop or timeout.
  queue = queue.then(async () => {
    try {
      await handle(request);
    } catch (error) {
      reply({
        id: request.id,
        type: "error",
        message: error instanceof Error ? error.message : "Local translation failed.",
      });
    }
  });
});
