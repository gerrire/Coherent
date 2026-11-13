import { expect, test } from "vitest";
import { TranslationQueue } from "../src/lib/translation/queue";

const caption = (id: string, receivedAt = 1000) => ({ id, speakerId: "speaker", text: id, language: "en" as const, receivedAt });

test("keeps only newest waiting audio and six recent group captions", () => {
  let dropped = 0;
  const queue = new TranslationQueue(() => dropped++);
  queue.pushAudio(Float32Array.of(1), 0, 1000);
  queue.pushAudio(Float32Array.of(2), 1, 1000);
  for (let i = 0; i < 8; i++) queue.pushCaption(caption(String(i)));
  expect(dropped).toBe(3);
  expect(queue.take(1000)).toMatchObject({ type: "recognize", generation: 1, audio: Float32Array.of(2) });
  expect(queue.take(1000)).toMatchObject({ type: "translate", caption: { id: "2" } });
});

test("alternates recognition and translation so neither starves", () => {
  const queue = new TranslationQueue(() => {});
  queue.pushCaption(caption("remote"));
  queue.pushAudio(Float32Array.of(1), 0, 1000);
  expect(queue.take(1000)?.type).toBe("recognize");
  queue.pushAudio(Float32Array.of(2), 0, 1000);
  expect(queue.take(1000)?.type).toBe("translate");
  expect(queue.take(1000)?.type).toBe("recognize");
});

test("drops expired queued work instead of playing a delayed conversation", () => {
  let dropped = 0;
  const queue = new TranslationQueue(() => dropped++);
  queue.pushAudio(Float32Array.of(1), 0, 1000);
  queue.pushCaption(caption("expired"));
  expect(queue.take(17000)).toBeUndefined();
  expect(dropped).toBe(2);
});

test("mute clears captured PCM while retaining incoming captions; close clears both", () => {
  const queue = new TranslationQueue(() => {});
  queue.pushAudio(Float32Array.of(1), 0, 1000);
  queue.pushCaption(caption("still audible"));
  queue.clearAudio();
  expect(queue.take(1000)?.type).toBe("translate");
  queue.pushCaption(caption("clear"));
  queue.clear();
  expect(queue.take(1000)).toBeUndefined();
});
