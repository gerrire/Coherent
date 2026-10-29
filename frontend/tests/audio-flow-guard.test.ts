import { expect, it } from "vitest";
import { AudioFlowGuard } from "../src/lib/audioFlowGuard";
it("does not confuse silence or normal noise suppression with a stopped output", () => {
  const guard = new AudioFlowGuard();
  for (let n = 0; n < 20; n++) expect(guard.check(0, 0, n * 500)).toBe(false);
  for (let n = 20; n < 40; n++) expect(guard.check(0.03, 0.001, n * 500)).toBe(false);
});
it("detects sustained live input with a completely silent processor and resets after a pause", () => {
  const guard = new AudioFlowGuard();
  for (let n = 0; n < 5; n++) expect(guard.check(0.03, 0, n * 500)).toBe(false);
  expect(guard.check(0.03, 0, 2500)).toBe(true);
  expect(guard.check(0.03, 0, 7000)).toBe(false);
});
