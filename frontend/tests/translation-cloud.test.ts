import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateWithGigaChat } from "../src/lib/translation/cloudTranslation";
import type { Caption } from "../src/lib/translation/transport";

const request = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/api", () => ({ apiRequest: request }));
const caption: Caption = { id: "8b9971d8-e568-46cf-a854-6d5f3f2382c0", speakerId: "other", text: "Hello", language: "en", receivedAt: 0 };
beforeEach(() => { request.mockReset().mockResolvedValue({ text: "Привет" }); });
afterEach(() => vi.restoreAllMocks());

describe("explicit cloud translation consent", () => {
  it("keeps a same-language caption local even without cloud permission", async () => {
    expect(await translateWithGigaChat("call", caption, "en", new AbortController().signal)).toBe("Hello");
    expect(request).not.toHaveBeenCalled();
  });
  it("never sends a caption from an old or non-consenting source to the API", async () => {
    await expect(translateWithGigaChat("call", caption, "ru", new AbortController().signal)).rejects.toThrow("не разрешил");
    expect(request).not.toHaveBeenCalled();
  });
  it("sends the source language and stable speaker/segment identity in the correct direction", async () => {
    const signal = new AbortController().signal;
    expect(await translateWithGigaChat("call", { ...caption, cloudAllowed: true }, "ru", signal)).toBe("Привет");
    expect(request).toHaveBeenCalledWith("/api/v1/calls/call/translation", expect.objectContaining({ method: "POST", signal }));
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      text: "Hello", source_language: "en", target_language: "ru", segment_id: caption.id, speaker_id: "other",
    });
  });
  it("discards a late reply after cancellation", async () => {
    let complete!: (value: { text: string }) => void;
    request.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const abort = new AbortController();
    const result = translateWithGigaChat("call", { ...caption, cloudAllowed: true }, "ru", abort.signal);
    abort.abort(); complete({ text: "Привет" });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each(["", " ", "x".repeat(601), "broken\u0000text", undefined])("rejects unusable provider output", async text => {
    request.mockResolvedValue({ text });
    await expect(translateWithGigaChat("call", { ...caption, cloudAllowed: true }, "ru", new AbortController().signal)).rejects.toThrow("некорректную");
  });
});
