import * as ort from "onnxruntime-web/wasm";
import { createPiperPhonemize } from "coherent-piper-module";
import phonemizerWasmUrl from "coherent-piper-wasm?url";
import phonemizerDataUrl from "coherent-piper-data?url";
import runtimeModuleUrl from "coherent-speech-ort-module?url";
import runtimeWasmUrl from "coherent-speech-ort-wasm?url";
import type { SpeechWorkerRequest, SpeechWorkerResponse } from "./speechProtocol";

// Runtime code is served by the app; model weights go directly to the browser.
// The original inference mapping follows Mintplex-Labs/piper-tts-web (MIT).
// The Denis voice and its rdh training base are CC0, unlike other RU voices
// whose dataset licences are unknown or non-commercial. See voice model card.
const MODEL_ROOT = "https://huggingface.co/rhasspy/piper-voices/resolve/2f358b6a560e3a913ebf509b2f3344f20b367f94/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx";
const CACHE = "coherent-local-speech-v1";
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { mjs: runtimeModuleUrl, wasm: runtimeWasmUrl };

interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
}
let session: ort.InferenceSession | undefined;
let config: VoiceConfig | undefined;
let phonemizerData: ArrayBuffer | undefined;
let queue = Promise.resolve();

function reply(message: SpeechWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

async function download(url: string, id: number): Promise<ArrayBuffer> {
  let cache: Cache | undefined;
  try { cache = await caches.open(CACHE); } catch { /* Private browsing may lack cache storage. */ }
  const stored = await cache?.match(url);
  if (stored) return stored.arrayBuffer();
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("Не удалось скачать локальный голос.");
  const length = Number(response.headers.get("Content-Length")) || 63_221_984;
  const reader = response.body?.getReader();
  if (!reader) return response.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    // Bound an unexpected or replaced response before allocating inference memory.
    if (received > 80_000_000) throw new Error("Размер локального голоса превышает лимит.");
    chunks.push(value);
    if (url.endsWith(".onnx")) reply({ id, type: "progress", progress: Math.min(100, received / length * 100) });
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { await cache?.put(url, new Response(data, { headers: { "Content-Type": "application/octet-stream" } })); } catch { /* Caching is optional. */ }
  return data.buffer;
}

async function initialize(id: number): Promise<void> {
  const configBytes = await download(`${MODEL_ROOT}.json`, id);
  config = JSON.parse(new TextDecoder().decode(configBytes)) as VoiceConfig;
  if (config.espeak.voice !== "ru" || config.audio.sample_rate !== 22_050) throw new Error("Неподдерживаемый формат локального голоса.");
  phonemizerData = await download(phonemizerDataUrl, id);
  const weights = await download(MODEL_ROOT, id);
  session = await ort.InferenceSession.create(weights, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  reply({ id, type: "ready" });
}

async function synthesize(text: string): Promise<Float32Array<ArrayBuffer>> {
  if (!session || !config || !phonemizerData) throw new Error("Локальный голос ещё не готов.");
  const phonemes = await new Promise<number[]>(async (resolve, reject) => {
    try {
      const module = await createPiperPhonemize({
        print(data) {
          try {
            const ids = (JSON.parse(data) as { phoneme_ids: unknown }).phoneme_ids;
            if (!Array.isArray(ids) || ids.length > 2_000 || !ids.every(Number.isInteger)) throw new Error("Некорректные звуки речи.");
            resolve(ids);
          } catch (error) { reject(error); }
        },
        printErr() { /* eSpeak pronunciation warnings must not expose translated text to logs. */ },
        locateFile(path) { return path.endsWith(".wasm") ? phonemizerWasmUrl : phonemizerDataUrl; },
        getPreloadedPackage() { return phonemizerData!; },
      });
      module.callMain(["-l", config!.espeak.voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
    } catch (error) { reject(error); }
  });
  const ids = BigInt64Array.from(phonemes, value => BigInt(value));
  const result = await session.run({
    input: new ort.Tensor("int64", ids, [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.of(BigInt(ids.length)), [1]),
    scales: new ort.Tensor("float32", Float32Array.of(config.inference.noise_scale, config.inference.length_scale, config.inference.noise_w), [3]),
  });
  const pcm = result.output?.data;
  if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > 22_050 * 45) throw new Error("Локальный голос вернул некорректный звук.");
  return new Float32Array(pcm);
}

self.addEventListener("message", ({ data }: MessageEvent<SpeechWorkerRequest>) => {
  queue = queue.then(async () => {
    try {
      if (data.type === "init") { await initialize(data.id); return; }
      const text = data.text?.trim();
      if (!text || text.length > 600) throw new Error("Фраза для озвучивания слишком длинная.");
      const pcm = await synthesize(text);
      reply({ id: data.id, type: "audio", pcm: pcm.buffer, sampleRate: 22_050 }, [pcm.buffer]);
    } catch (error) {
      reply({ id: data.id, type: "error", message: error instanceof Error ? error.message : "Не удалось озвучить перевод." });
    }
  });
});
