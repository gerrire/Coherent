import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearUpdateConversation, readUpdateConversation, rememberUpdateConversation } from "../src/lib/updateLocation";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("restores the conversation only for the account being updated and consumes it explicitly", () => {
  rememberUpdateConversation("alice", "conversation-1");
  expect(readUpdateConversation("alice")).toBe("conversation-1");
  expect(readUpdateConversation("bob")).toBeNull();
  // React StrictMode may initialize a component twice before effects run.
  expect(readUpdateConversation("alice")).toBe("conversation-1");
  clearUpdateConversation("alice");
  expect(readUpdateConversation("alice")).toBeNull();
});

it("discards stale or corrupt checkpoints instead of reopening old conversations", () => {
  rememberUpdateConversation("alice", "conversation-1");
  vi.advanceTimersByTime(15 * 60 * 1000);
  expect(readUpdateConversation("alice")).toBeNull();
  localStorage.setItem("coherent.update-location.alice", "broken JSON");
  expect(readUpdateConversation("alice")).toBeNull();
});
