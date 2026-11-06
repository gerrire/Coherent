import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

type Gate = {
  port: { onmessage: (event: { data: { mode: string } }) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
const worklet = readFileSync(new URL("../public/mic-soft-gate.js", import.meta.url), "utf8");

function voiceGate(mode: string) {
  let GateProcessor: (new () => Gate) | undefined;
  runInNewContext(worklet, {
    AudioWorkletProcessor: class { port = {}; },
    registerProcessor: (_name: string, processor: new () => Gate) => { GateProcessor = processor; },
    sampleRate: 48_000,
  });
  if (!GateProcessor) throw new Error("Voice worklet was not registered");
  const gate = new GateProcessor();
  gate.port.onmessage({ data: { mode } });
  return gate;
}

function sustainedGain(gate: Gate, peak: number) {
  const input = Float32Array.from({ length: 128 }, (_, i) => peak * Math.sin(i * Math.PI / 16));
  const output = new Float32Array(128);
  for (let block = 0; block < 375; block++) gate.process([[input]], [[output]]);
  return Math.max(...output) / peak;
}

test("RNNoise strengthens quiet speech without boosting steady low-level noise", () => {
  const gate = voiceGate("rnnoise-balanced");
  expect(sustainedGain(gate, 0.0005)).toBeLessThan(0.5);
  expect(sustainedGain(gate, 0.008)).toBeGreaterThan(3);
  expect(sustainedGain(gate, 0.15)).toBeLessThan(1.2);
  expect(sustainedGain(gate, 0.0005)).toBeLessThan(0.5);
});

test("browser noise mode reduces the floor without lowering voiced blocks", () => {
  const gate = voiceGate("noisy");
  expect(sustainedGain(gate, 0.001)).toBeLessThan(0.5);
  expect(sustainedGain(gate, 0.02)).toBeCloseTo(1, 2);
});
