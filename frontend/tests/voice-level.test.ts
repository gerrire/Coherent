import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const source = readFileSync(new URL("../public/voice-rnnoise.js", import.meta.url), "utf8");
const resolve = createRequire(import.meta.url).resolve;

function worklet(sampleRate = 48_000) {
  const messages: string[] = [];
  const types = runInNewContext(`${source}\n;({ CoherentSoftGate, VoiceLevel })`, {
    AudioWorkletProcessor: class {
      port = { postMessage: ({ type }: { type: string }) => { messages.push(type); } };
    },
    registerProcessor: () => {},
    sampleRate,
  }) as {
    CoherentSoftGate: new (options?: { processorOptions: { wasmBinary: Buffer; mode: string } }) => {
      port: { onmessage: (event: { data: unknown }) => void };
      process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
    };
    VoiceLevel: new () => { process(frame: Float32Array, probability: number, pauseGain: number): void };
  };
  return { ...types, messages };
}

function processedGain(level: InstanceType<ReturnType<typeof worklet>["VoiceLevel"]>, peak: number, probability: number, frames = 120) {
  const original = Float32Array.from({ length: 480 }, (_, i) => peak * 32768 * Math.sin(i * Math.PI / 16));
  const output = new Float32Array(480);
  for (let frame = 0; frame < frames; frame++) {
    output.set(original);
    level.process(output, probability, 0.7);
  }
  return Math.max(...output) / peak;
}

test("adapts to confirmed quiet speech while preserving consonants during its release hold", () => {
  const { VoiceLevel } = worklet();
  const level = new VoiceLevel();
  expect(processedGain(level, 0.0005, 0.04)).toBeLessThan(0.8);
  expect(processedGain(level, 0.008, 0.88)).toBeGreaterThan(3);
  expect(processedGain(level, 0.004, 0.12, 6)).toBeGreaterThan(2);
  expect(processedGain(level, 0.0005, 0.04)).toBeLessThan(0.8);
});

test("brings very quiet confirmed speech up while leaving a clean pause quiet", () => {
  const { VoiceLevel } = worklet();
  const level = new VoiceLevel();
  expect(processedGain(level, 0.0003, 0.05)).toBeLessThan(0.8);
  const gain = processedGain(level, 0.0025, 0.95);
  expect(gain).toBeGreaterThan(10);
  expect(gain).toBeLessThanOrEqual(12);
  expect(processedGain(level, 0.0003, 0.05)).toBeLessThan(0.8);
});

test("limits gain when the microphone already has an elevated noise floor", () => {
  const { VoiceLevel } = worklet();
  const level = new VoiceLevel();
  expect(processedGain(level, 0.007, 0.02)).toBeLessThan(0.8);
  expect(processedGain(level, 0.007, 0.78)).toBeLessThan(0.8);
  expect(processedGain(level, 0.018, 0.89)).toBeLessThan(1.1);
  expect(processedGain(level, 0.99, 0.92, 1) * 0.99).toBeLessThan(0.83);
});

test("does not raise a transient that the model briefly marks as voice", () => {
  const { VoiceLevel } = worklet();
  const level = new VoiceLevel();
  processedGain(level, 0.0008, 0.03);
  expect(processedGain(level, 0.04, 0.75, 1)).toBeLessThan(1);
  expect(processedGain(level, 0.0008, 0.03, 1)).toBeLessThan(0.95);
});

test("native browser mode leaves samples unchanged", () => {
  const { CoherentSoftGate } = worklet();
  const gate = new CoherentSoftGate();
  const input = Float32Array.of(-0.25, 0, 0.75);
  const output = new Float32Array(input.length);
  expect(gate.process([[input]], [[output]])).toBe(true);
  expect(output).toEqual(input);
});

test.each(["rnnoise.wasm", "rnnoise_simd.wasm"])("processes variable audio quanta with %s", async (filename) => {
  const { CoherentSoftGate, messages } = worklet();
  const wasmBinary = readFileSync(resolve(`@sapphi-red/web-noise-suppressor/${filename}`));
  const gate = new CoherentSoftGate({ processorOptions: { wasmBinary, mode: "rnnoise-balanced" } });
  await expect.poll(() => messages).toEqual(["ready"]);
  const output = new Float32Array(256);
  let peak = 0;
  let offset = 0;
  for (let block = 0; block < 100; block++) {
    const count = block % 2 ? 128 : 256;
    const input = Float32Array.from({ length: count }, (_, i) => 0.3 * Math.sin((i + offset) * Math.PI / 50));
    const chunk = output.subarray(0, count);
    expect(gate.process([[input]], [[chunk]])).toBe(true);
    if (block === 0) expect(chunk.every(sample => sample === 0)).toBe(true);
    peak = Math.max(peak, ...chunk.map(Math.abs));
    offset += count;
  }
  expect(peak).toBeGreaterThan(0.001);
  expect(peak).toBeLessThan(0.83);
  expect(messages).toEqual(["ready", "active"]);
  gate.port.onmessage({ data: { type: "stop" } });
  expect(gate.process([], [])).toBe(false);
});

test("reports an unsupported RNNoise sampling rate through the worklet port", () => {
  const { CoherentSoftGate, messages } = worklet(44_100);
  new CoherentSoftGate({ processorOptions: { wasmBinary: Buffer.from([]), mode: "rnnoise-balanced" } });
  expect(messages).toEqual(["error"]);
});
