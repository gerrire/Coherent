import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ONNX Runtime exposes its JS entry points, but not the supporting runtime
// assets. Resolve beside the installed entry point to keep their versions in
// sync with Transformers.js and let Vite emit same-origin, hashed URLs.
const onnxRuntimeDirectory = dirname(createRequire(import.meta.resolve("@huggingface/transformers")).resolve("onnxruntime-web/wasm"));
const speechRuntimeDirectory = dirname(createRequire(import.meta.url).resolve("onnxruntime-web/wasm"));
const piperPackageDirectory = dirname(fileURLToPath(import.meta.resolve("@mintplex-labs/piper-tts-web")));
const piperRuntimeDirectory = resolve(dirname(createRequire(import.meta.url).resolve("@diffusionstudio/piper-wasm/package.json")), "build");

let cryptoVersion = "unbuilt";
try {
  cryptoVersion = createHash("sha256").update(readFileSync(new URL("./public/crypto/v1/coherent_crypto.js", import.meta.url)))
    .update(readFileSync(new URL("./public/crypto/v1/coherent_crypto_bg.wasm", import.meta.url))).digest("hex").slice(0, 20);
} catch { /* Standalone TypeScript CI does not execute the WASM bridge. */ }

export default defineConfig({
  define: { __COHERENT_CRYPTO_VERSION__: JSON.stringify(cryptoVersion) },
  plugins: [react()],
  optimizeDeps: {
    exclude: [
      "coherent-ort-runtime-module?url", "coherent-ort-runtime-wasm?url",
      "coherent-speech-ort-module?url", "coherent-speech-ort-wasm?url",
      "coherent-piper-module", "coherent-piper-data?url", "coherent-piper-wasm?url",
    ],
  },
  resolve: {
    alias: [
      { find: /^coherent-ort-runtime-module(?=\?|$)/, replacement: resolve(onnxRuntimeDirectory, "ort-wasm-simd-threaded.jsep.mjs") },
      { find: /^coherent-ort-runtime-wasm(?=\?|$)/, replacement: resolve(onnxRuntimeDirectory, "ort-wasm-simd-threaded.jsep.wasm") },
      { find: /^coherent-speech-ort-module(?=\?|$)/, replacement: resolve(speechRuntimeDirectory, "ort-wasm-simd-threaded.mjs") },
      { find: /^coherent-speech-ort-wasm(?=\?|$)/, replacement: resolve(speechRuntimeDirectory, "ort-wasm-simd-threaded.wasm") },
      { find: /^coherent-piper-module(?=\?|$)/, replacement: resolve(piperPackageDirectory, "piper-o91UDS6e.js") },
      { find: /^coherent-piper-wasm(?=\?|$)/, replacement: resolve(piperRuntimeDirectory, "piper_phonemize.wasm") },
      { find: /^coherent-piper-data(?=\?|$)/, replacement: resolve(piperRuntimeDirectory, "piper_phonemize.data") },
    ],
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
