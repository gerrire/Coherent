import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

const source = readFileSync(new URL("../public/translation-capture.js", import.meta.url), "utf8");

function capture(sampleRate = 48_000) {
  const messages: Float32Array[] = [];
  const Capture = runInNewContext(`${source}\nTranslationCapture`, {
    AudioWorkletProcessor: class {
      port = { postMessage: (data: { audio: Float32Array }) => messages.push(data.audio), onmessage: () => {} };
    },
    registerProcessor: () => {}, sampleRate, Float32Array,
  });
  const worklet = new Capture();
  const feed = (seconds: number, amplitude: number) => {
    const count = Math.round(seconds * sampleRate);
    for (let i = 0; i < count; i += 128) worklet.process([[new Float32Array(Math.min(128, count - i)).fill(amplitude)]]);
  };
  return { worklet, messages, feed };
}

test("silence does not produce inference jobs or retain unbounded PCM", () => {
  const { feed, messages, worklet } = capture();
  feed(60, 0);
  expect(messages).toHaveLength(0);
  expect(worklet.preCount).toBe(3200);
  expect(worklet.length).toBe(0);
  expect(worklet.samples.length).toBe(96000);
});

test.each([16_000, 44_100, 48_000])("resamples %i Hz to 16 kHz across fractional frame boundaries", sampleRate => {
  const { feed, messages } = capture(sampleRate);
  feed(0.4, 0.1);
  feed(0.7, 0);
  expect(messages).toHaveLength(1);
  // 400 ms speech + 600 ms release, exactly 16,000 samples at any input rate.
  expect(messages[0]).toHaveLength(16000);
  expect(messages[0][4000]).toBeCloseTo(0.1, 5);
  expect(messages[0][12000]).toBe(0);
});

test("continuous speech is cut into six-second bounded jobs", () => {
  const { feed, messages } = capture();
  feed(18, 0.04);
  expect(messages).toHaveLength(3);
  expect(messages.every(audio => audio.length === 96000)).toBe(true);
});

test("a mute reset discards a partial utterance and pre-roll", () => {
  const { feed, messages, worklet } = capture();
  feed(0.4, 0.1);
  worklet.port.onmessage({ data: { type: "reset" } });
  feed(1, 0);
  expect(messages).toHaveLength(0);
});

test("short transients are excluded, and a short pre-roll preserves speech onset", () => {
  const { feed, messages } = capture();
  feed(0.1, 0.1);
  feed(1, 0);
  expect(messages).toHaveLength(0);
  feed(0.4, 0.1);
  feed(0.7, 0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toHaveLength(19200);
  expect(messages[0][0]).toBe(0);
  expect(messages[0][4000]).toBeCloseTo(0.1, 5);
});
