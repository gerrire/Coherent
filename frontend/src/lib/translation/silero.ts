import { env, InferenceSession, Tensor } from "coherent-recognition-ort";
import runtimeModuleUrl from "coherent-ort-runtime-module?url";
import runtimeWasmUrl from "coherent-ort-runtime-wasm?url";
import { evictModelAsset, fetchModelAsset } from "./downloads";

// Original Silero VAD v5.1.2 (MIT). Files are fetched only by the
// participant's worker. The checksum binds the exact unquantized ONNX graph.
export const SILERO_MODEL = {
  repository: "snakers4/silero-vad",
  revision: "6478567951ae5c9979ad7b234185b5515f4be7a1",
  sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f",
  bytes: 2_327_524,
} as const;
const MODEL_URL = `https://raw.githubusercontent.com/${SILERO_MODEL.repository}/${SILERO_MODEL.revision}/src/silero_vad/data/silero_vad.onnx`;

export interface SileroDetector {
  /** A positive short speech run permits ASR; noise-only fragments skip it. */
  containsSpeech(audio: Float32Array): Promise<boolean>;
  close(): Promise<void>;
}

export async function createSileroDetector(onProgress?: (progress: number) => void): Promise<SileroDetector> {
  env.wasm.numThreads = 1;
  env.wasm.proxy = false;
  env.wasm.wasmPaths = { mjs: runtimeModuleUrl, wasm: runtimeWasmUrl };
  const bytes = await fetchModelAsset(MODEL_URL, { onProgress, expectedBytes: SILERO_MODEL.bytes, sha256: SILERO_MODEL.sha256 });
  let session: InferenceSession;
  try { session = await InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }); }
  catch (error) { await evictModelAsset(MODEL_URL); throw error; }
  let closed = false;
  return {
    async containsSpeech(audio) {
      if (closed) return false;
      // Official Silero v5 ONNX framing: 512 samples at 16kHz, 64-sample
      // context and recurrent state [2, batch, 128]. Start fresh per fragment.
      let state: Tensor = new Tensor("float32", new Float32Array(256), [2, 1, 128]);
      const context = new Float32Array(64);
      let positiveFrames = 0;
      for (let offset = 0; offset < audio.length; offset += 512) {
        if (closed) return false;
        const frame = new Float32Array(576);
        frame.set(context);
        frame.set(audio.subarray(offset, Math.min(offset + 512, audio.length)), 64);
        const result = await session.run({
          input: new Tensor("float32", frame, [1, 576]), state,
          sr: new Tensor("int64", BigInt64Array.of(16_000n), []),
        });
        if (closed) return false;
        const probability = Number(result.output.data[0]);
        state = result.stateN;
        context.set(frame.subarray(512));
        positiveFrames = probability >= 0.5 ? positiveFrames + 1 : 0;
        // 96ms of confident activity avoids treating a single click as speech.
        // The capture worklet already requires a longer energetic segment.
        if (positiveFrames >= 3) return true;
      }
      return false;
    },
    async close() { if (closed) return; closed = true; await session.release(); },
  };
}
