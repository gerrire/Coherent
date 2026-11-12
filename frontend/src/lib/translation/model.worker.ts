import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type TranslationPipeline,
} from "@huggingface/transformers";
import runtimeModuleUrl from "coherent-ort-runtime-module?url";
import runtimeWasmUrl from "coherent-ort-runtime-wasm?url";
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

const WHISPER = {
  id: "Xenova/whisper-tiny",
  revision: "5332fcc35e32a33b86612b9a57a89be7906102b1",
};

const TRANSLATORS: Record<Exclude<TranslationLanguage, "en">, { id: string; revision: string }> = {
  ru: { id: "Xenova/opus-mt-en-ru", revision: "e050376e960175e8ddc5cff85025dc8436cddd68" },
  de: { id: "Xenova/opus-mt-en-de", revision: "1ca130c44c4c5441ef16d48aae521a424ab644f7" },
  fr: { id: "Xenova/opus-mt-en-fr", revision: "28726206f80896b90035bd99cccd5cc1e151f916" },
  es: { id: "Xenova/opus-mt-en-es", revision: "4b002a4c7edd54a7ced58877258b87f7efd3f892" },
};

const WHISPER_LANGUAGES: Record<TranslationLanguage, string> = {
  en: "english", ru: "russian", de: "german", fr: "french", es: "spanish",
};

let recognizer: AutomaticSpeechRecognitionPipeline | null = null;
let translator: TranslationPipeline | null = null;
let settings: Extract<TranslationWorkerRequest, { type: "init" }> | null = null;
let queue = Promise.resolve();

function reply(message: TranslationWorkerResponse): void {
  self.postMessage(message);
}

async function handle(request: TranslationWorkerRequest): Promise<void> {
  if (request.type === "init") {
    if (settings) throw new Error("Translation is already initialized. Restart it to change languages.");
    if (!isTranslationLanguage(request.sourceLanguage) || !isTranslationLanguage(request.targetLanguage)) {
      throw new Error("Unsupported translation language.");
    }
    const progress_callback = (info: { status: string; file?: string; progress?: number }) => {
      reply({
        id: request.id,
        type: "progress",
        message: info.file ? `Downloading ${info.file}` : "Preparing local models",
        progress: typeof info.progress === "number" ? Math.min(100, Math.max(0, info.progress)) : undefined,
      });
    };
    // Initialize sequentially to avoid competing downloads and transient memory
    // peaks. Receive-only mode deliberately never allocates Whisper.
    try {
      if (request.recognize) {
        recognizer = await pipeline<"automatic-speech-recognition">("automatic-speech-recognition", WHISPER.id, {
          revision: WHISPER.revision, device: "wasm", dtype: "q8", progress_callback,
        });
      }
      if (request.targetLanguage !== "en") {
        const model = TRANSLATORS[request.targetLanguage];
        translator = await pipeline<"translation">("translation", model.id, {
          revision: model.revision, device: "wasm", dtype: "q8", progress_callback,
        });
      }
      settings = request;
      reply({ id: request.id, type: "ready" });
    } catch (error) {
      await recognizer?.dispose().catch(() => undefined);
      await translator?.dispose().catch(() => undefined);
      recognizer = null;
      translator = null;
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
    const output = await recognizer(audio, {
      language: WHISPER_LANGUAGES[settings.sourceLanguage],
      task: settings.sourceLanguage === "en" ? "transcribe" : "translate",
      return_timestamps: false,
      max_new_tokens: 96,
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
    const text = request.text.trim();
    if (!text || !translator) {
      reply({ id: request.id, type: "result", text });
      return;
    }
    // v3 declares a full GenerationConfig here although the implementation
    // merges partial generation options with the model's defaults.
    const options = { max_new_tokens: 128, num_beams: 1, do_sample: false } as Parameters<TranslationPipeline>[1];
    const output = await translator(text, options);
    const first = output[0];
    const result = Array.isArray(first) ? first[0] : first;
    reply({ id: request.id, type: "result", text: (result?.translation_text ?? "").trim().slice(0, 1_000) });
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
