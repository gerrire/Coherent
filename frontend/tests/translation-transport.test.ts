import { ConnectionState, Encryption_Type, RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTION_RATE_WINDOW_MS, CAPTION_TOPIC, createCaptionTransport, MAX_CAPTION_BYTES,
  MAX_CAPTION_CHARACTERS, MAX_CAPTIONS_PER_WINDOW,
} from "../src/lib/translation/transport";

const callId = "7f1c9ed9-5efe-4fb8-a1d5-2437816bfc96";
const encoder = new TextEncoder();
const packet = (patch = {}) => encoder.encode(JSON.stringify({
  v: 1, callId, id: crypto.randomUUID(), language: "en", text: "Hello there.", ...patch,
}));

function fixture() {
  let listener: (...args: any[]) => void = () => {};
  const alice = { identity: "alice" } as RemoteParticipant;
  const publishData = vi.fn().mockResolvedValue(undefined);
  const room = {
    options: { encryption: {} }, isE2EEEnabled: true, state: ConnectionState.Connected,
    remoteParticipants: new Map([[alice.identity, alice]]),
    localParticipant: { identity: "self", publishData },
    on: vi.fn((_event, callback) => { listener = callback; }), off: vi.fn(),
  };
  const receive = vi.fn();
  const transport = createCaptionTransport(room as unknown as Room, callId, receive);
  const deliver = (bytes = packet(), participant: RemoteParticipant | undefined = alice,
    topic = CAPTION_TOPIC, encryptionType: Encryption_Type | undefined = Encryption_Type.GCM) =>
    listener(bytes, participant, undefined, topic, encryptionType);
  return { room, receive, transport, publishData, alice, deliver };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe("encrypted ephemeral caption transport", () => {
  it("publishes a bounded English pivot packet through the encrypted room", async () => {
    const { room, transport, publishData } = fixture();
    await transport.publish("  Hello.  ");
    const [bytes, options] = publishData.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      v: 1, callId, id: expect.any(String), language: "en", text: "Hello.",
    });
    expect(options).toEqual({ reliable: true, topic: CAPTION_TOPIC });
    expect(room.on).toHaveBeenCalledWith(RoomEvent.DataReceived, expect.any(Function));
  });

  it("fails closed when encryption is disabled, legacy-only, disconnected or closed", async () => {
    const { room, transport, publishData } = fixture();
    room.isE2EEEnabled = false;
    await expect(transport.publish("Hello")).rejects.toThrow("защищённого");
    room.isE2EEEnabled = true;
    room.options.encryption = undefined as any;
    await expect(transport.publish("Hello")).rejects.toThrow("защищённого");
    room.options.encryption = {};
    room.state = ConnectionState.Reconnecting;
    await expect(transport.publish("Hello")).rejects.toThrow("защищённого");
    room.state = ConnectionState.Connected;
    transport.close();
    await expect(transport.publish("Hello")).rejects.toThrow("защищённого");
    expect(publishData).not.toHaveBeenCalled();
  });

  it("rejects plaintext and unknown senders even inside an encrypted room", () => {
    const { deliver, receive, alice } = fixture();
    deliver(packet(), alice, CAPTION_TOPIC, Encryption_Type.NONE);
    deliver(packet(), { identity: "alice" } as RemoteParticipant);
    deliver(packet(), { identity: "mallory" } as RemoteParticipant);
    deliver(packet(), alice, "another-topic");
    expect(receive).not.toHaveBeenCalled();
  });

  it("uses the authenticated sender and local receive time, and ignores repeated segments", () => {
    const { deliver, receive } = fixture();
    const bytes = packet({ speakerId: "victim", timestamp: -100_000 });
    deliver(bytes); deliver(bytes);
    expect(receive).toHaveBeenCalledExactlyOnceWith({
      id: JSON.parse(new TextDecoder().decode(bytes)).id, speakerId: "alice", text: "Hello there.", receivedAt: 1_000_000,
    });
  });

  it.each([
    { v: 2 }, { callId: "other-call" }, { language: "ru" }, { id: "" }, { text: "" },
    { text: "x".repeat(MAX_CAPTION_CHARACTERS + 1) }, { text: "\u0000hello" }, { text: " untrimmed " },
  ])("rejects malformed packet fields %j", (patch) => {
    const { deliver, receive } = fixture();
    deliver(packet(patch));
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects oversized, invalid UTF-8 and invalid JSON without throwing", () => {
    const { deliver, receive } = fixture();
    expect(() => {
      deliver(new Uint8Array(MAX_CAPTION_BYTES + 1));
      deliver(Uint8Array.of(0xff));
      deliver(encoder.encode("{nope"));
    }).not.toThrow();
    expect(receive).not.toHaveBeenCalled();
  });

  it("bounds each sender's work while allowing another participant and a later window", () => {
    const { room, deliver, receive } = fixture();
    for (let index = 0; index < MAX_CAPTIONS_PER_WINDOW + 10; index++) deliver(packet());
    expect(receive).toHaveBeenCalledTimes(MAX_CAPTIONS_PER_WINDOW);
    const bob = { identity: "bob" } as RemoteParticipant;
    room.remoteParticipants.set("bob", bob);
    deliver(packet(), bob);
    expect(receive).toHaveBeenCalledTimes(MAX_CAPTIONS_PER_WINDOW + 1);
    vi.advanceTimersByTime(CAPTION_RATE_WINDOW_MS);
    deliver(packet());
    expect(receive).toHaveBeenCalledTimes(MAX_CAPTIONS_PER_WINDOW + 2);
  });

  it("bounds outgoing traffic and rejects invalid text before sending", async () => {
    const { transport, publishData } = fixture();
    await expect(transport.publish("x".repeat(MAX_CAPTION_CHARACTERS + 1))).rejects.toThrow("Недопустимый");
    for (let index = 0; index < MAX_CAPTIONS_PER_WINDOW; index++) await transport.publish("Hello");
    await expect(transport.publish("Hello")).rejects.toThrow("Слишком много");
    expect(publishData).toHaveBeenCalledTimes(MAX_CAPTIONS_PER_WINDOW);
    vi.advanceTimersByTime(CAPTION_RATE_WINDOW_MS);
    await transport.publish("Hello again");
    expect(publishData).toHaveBeenCalledTimes(MAX_CAPTIONS_PER_WINDOW + 1);
  });

  it("detaches exactly once and ignores already queued deliveries after closing", () => {
    const { transport, room, deliver, receive } = fixture();
    transport.close(); transport.close(); deliver(packet());
    expect(room.off).toHaveBeenCalledExactlyOnceWith(RoomEvent.DataReceived, expect.any(Function));
    expect(receive).not.toHaveBeenCalled();
  });
});
