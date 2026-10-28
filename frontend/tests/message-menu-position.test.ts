import { expect, it } from "vitest";
import { messageMenuPosition } from "../src/lib/messageMenuPosition";
const menu = { width: 180, height: 90 };
const viewport = { width: 1200, height: 800, topInset: 0 };
it("centres actions on the left side of the message", () => {
  expect(messageMenuPosition({ left: 700, right: 1100, top: 200, bottom: 400 }, menu, viewport))
    .toEqual({ left: 512, top: 255 });
});
it("uses the lower left corner if the side has no room", () => {
  expect(messageMenuPosition({ left: 30, right: 200, top: 200, bottom: 300 }, menu, viewport))
    .toEqual({ left: 30, top: 308 });
});
it("flips above a message near the bottom", () => {
  expect(messageMenuPosition({ left: 30, right: 200, top: 700, bottom: 780 }, menu, viewport))
    .toEqual({ left: 30, top: 602 });
});
it("keeps actions inside narrow windows and below the desktop caption", () => {
  expect(messageMenuPosition({ left: 300, right: 470, top: -40, bottom: 20 }, menu, { width: 480, height: 420, topInset: 36 }))
    .toEqual({ left: 112, top: 44 });
});
