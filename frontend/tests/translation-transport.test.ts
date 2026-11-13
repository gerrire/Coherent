import { EncryptedPacket } from "@livekit/protocol";
import { ConnectionState, Encryption_Type, RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTION_RATE_WINDOW_MS, CAPTION_TOPIC, createCaptionTransport, deriveCaptionKey,
  MAX_CAPTION_BYTES, MAX_CAPTION_CHARACTERS, MAX_CAPTIONS_PER_WINDOW, type CaptionKey,
} from "../src/lib/translation/transport";

const callId = "7f1c9ed9-5efe-4fb8-a1d5-2437816bfc96";
const rootKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(41)));
const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
let now = 1_000_000;

function roomFixture(identity: string, participant: RemoteParticipant) {
  let listener: (...args: any[]) => void = () => {};
  const room = {
    options: { encryption: {} }, isE2EEEnabled: true, state: ConnectionState.Connected,
    remoteParticipants: new Map([[participant.identity, participant]]),
    localParticipant: { identity, publishData: vi.fn().mockResolvedValue(undefined) },
    on: vi.fn((_event, callback) => { listener = callback; }), off: vi.fn(),
  };
  return {
    room,
    deliver: (bytes: Uint8Array, sender = participant, topic = CAPTION_TOPIC, encryptionType = Encryption_Type.NONE) =>
      listener(bytes, sender, undefined, topic, encryptionType),
  };
}

async function fixture() {
  const alice = { identity: "alice" } as RemoteParticipant;
  const bob = { identity: "bob" } as RemoteParticipant;
  const sender = roomFixture("alice", bob);
  const receiver = roomFixture("bob", alice);
  // Independently derive actual Web Crypto keys, as two browser clients do.
  const senderKeys = [await deriveCaptionKey(rootKey, callId, 7, "group-one")];
  let receiverKeys = [await deriveCaptionKey(rootKey, callId, 7, "group-one")];
  const received = vi.fn();
  const source = createCaptionTransport(sender.room as unknown as Room, callId, vi.fn(), () => senderKeys);
  const destination = createCaptionTransport(receiver.room as unknown as Room, callId, received, () => receiverKeys);
  const packet = async (text = "Hello there.", language: "en" | "ru" = "en") => {
    await source.publish(text, language);
    return sender.room.localParticipant.publishData.mock.calls.at(-1)![0] as Uint8Array;
  };
  return {
    alice, bob, sender, receiver, received, source, destination, packet, senderKeys,
    setReceiverKeys: (keys: CaptionKey[]) => { receiverKeys = keys; },
  };
}

beforeEach(() => { now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());

describe("authenticated ephemeral caption transport", () => {
  it("accepts a real encrypted caption when the pinned SDK reports its default NONE", async () => {
    const f = await fixture();
    // RTCEngine 2.17.2 omits encryptionType while constructing EncryptedPacket.
    const sdkEncryptionType = new EncryptedPacket().encryptionType;
    expect(sdkEncryptionType).toBe(Encryption_Type.NONE);
    const bytes = await f.packet("Привет, собеседник!", "ru");
    expect(new TextDecoder().decode(bytes)).not.toContain("Привет");
    f.receiver.deliver(bytes, f.alice, CAPTION_TOPIC, sdkEncryptionType);
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledExactlyOnceWith({
      id: decode(bytes).id, speakerId: "alice", text: "Привет, собеседник!", language: "ru", receivedAt: now,
    }));
    expect(f.sender.room.localParticipant.publishData.mock.calls[0][1]).toEqual({ reliable: true, topic: CAPTION_TOPIC });
    expect(f.receiver.room.on).toHaveBeenCalledWith(RoomEvent.DataReceived, expect.any(Function));
  });

  it.each([Encryption_Type.NONE, Encryption_Type.GCM])("rejects unsealed text regardless of SDK encryption enum %s", async encryptionType => {
    const f = await fixture();
    f.receiver.deliver(encode({ v: 2, callId, id: crypto.randomUUID(), sender: "alice", language: "en", text: "plaintext" }), f.alice, CAPTION_TOPIC, encryptionType);
    f.receiver.deliver(encode({ v: 1, callId, id: crypto.randomUUID(), language: "en", text: "legacy plaintext" }), f.alice, CAPTION_TOPIC, encryptionType);
    await settle();
    expect(f.received).not.toHaveBeenCalled();
  });

  it("rejects unknown SDK senders and unrelated topics", async () => {
    const f = await fixture();
    const bytes = await f.packet();
    f.receiver.deliver(bytes, { identity: "alice" } as RemoteParticipant);
    f.receiver.deliver(bytes, { identity: "mallory" } as RemoteParticipant);
    f.receiver.deliver(bytes, f.alice, "another-topic");
    await settle();
    expect(f.received).not.toHaveBeenCalled();
  });

  it.each([
    { callId: "other-call" }, { group: "other-group" }, { epoch: 8 },
    { sender: "bob" }, { id: "11111111-1111-4111-8111-111111111111" },
  ])("authenticates envelope context %j", async patch => {
    const f = await fixture();
    f.receiver.deliver(encode({ ...decode(await f.packet()), ...patch }));
    await settle();
    expect(f.received).not.toHaveBeenCalled();
  });

  it("rejects a modified ciphertext or authentication tag", async () => {
    const f = await fixture();
    const envelope = decode(await f.packet());
    const ciphertext = Uint8Array.from(atob(envelope.ciphertext), c => c.charCodeAt(0));
    ciphertext[0] ^= 1;
    envelope.ciphertext = btoa(String.fromCharCode(...ciphertext));
    f.receiver.deliver(encode(envelope));
    await settle();
    expect(f.received).not.toHaveBeenCalled();
  });

  it("rejects a wrong key even if its group and epoch metadata match", async () => {
    const f = await fixture();
    const wrong = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
    f.setReceiverKeys([await deriveCaptionKey(wrong, callId, 7, "group-one")]);
    f.receiver.deliver(await f.packet());
    await settle();
    expect(f.received).not.toHaveBeenCalled();
  });

  it("tolerates the previous epoch during rotation but rejects older retired keys", async () => {
    const f = await fixture();
    const previous = await deriveCaptionKey(rootKey, callId, 7, "group-one");
    const latest = await deriveCaptionKey(rootKey, callId, 8, "group-one");
    f.setReceiverKeys([latest, previous]);
    f.receiver.deliver(await f.packet("In-flight old epoch"));
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledOnce());
    f.setReceiverKeys([await deriveCaptionKey(rootKey, callId, 9, "group-one"), latest]);
    f.receiver.deliver(await f.packet("Retired epoch"));
    await settle();
    expect(f.received).toHaveBeenCalledOnce();
  });

  it("deduplicates simultaneous encrypted deliveries before decryption finishes", async () => {
    const f = await fixture();
    const bytes = await f.packet();
    f.receiver.deliver(bytes); f.receiver.deliver(bytes); f.receiver.deliver(bytes);
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledOnce());
    f.receiver.deliver(bytes);
    await settle();
    expect(f.received).toHaveBeenCalledOnce();
  });

  it("does not deliver an in-flight decryption after close or participant removal", async () => {
    const f = await fixture();
    f.receiver.deliver(await f.packet());
    f.destination.close(); f.destination.close();
    await settle();
    expect(f.received).not.toHaveBeenCalled();
    expect(f.receiver.room.off).toHaveBeenCalledExactlyOnceWith(RoomEvent.DataReceived, expect.any(Function));
    const g = await fixture();
    g.receiver.deliver(await g.packet());
    g.receiver.room.remoteParticipants.delete("alice");
    await settle();
    expect(g.received).not.toHaveBeenCalled();
  });

  it("bounds outgoing traffic and permits another window", async () => {
    const f = await fixture();
    await expect(f.source.publish("x".repeat(MAX_CAPTION_CHARACTERS + 1), "en")).rejects.toThrow("Недопустимый");
    await expect(f.source.publish("\u0000bad", "en")).rejects.toThrow("Недопустимый");
    for (let index = 0; index < MAX_CAPTIONS_PER_WINDOW; index++) await f.packet();
    await expect(f.packet()).rejects.toThrow("Слишком много");
    now += CAPTION_RATE_WINDOW_MS;
    await expect(f.packet()).resolves.toBeInstanceOf(Uint8Array);
  });

  it("rate limits invalid authenticated senders before expensive cryptography", async () => {
    const f = await fixture();
    const bytes = await f.packet();
    for (let i = 0; i < MAX_CAPTIONS_PER_WINDOW; i++) f.receiver.deliver(encoder.encode("{invalid"));
    f.receiver.deliver(bytes);
    await settle();
    expect(f.received).not.toHaveBeenCalled();
    now += CAPTION_RATE_WINDOW_MS;
    f.receiver.deliver(bytes);
    await vi.waitFor(() => expect(f.received).toHaveBeenCalledOnce());
  });

  it("rejects oversized, malformed UTF-8 and invalid JSON without throwing", async () => {
    const f = await fixture();
    expect(() => {
      f.receiver.deliver(new Uint8Array(MAX_CAPTION_BYTES + 1));
      f.receiver.deliver(Uint8Array.of(0xff));
      f.receiver.deliver(encoder.encode("{invalid"));
    }).not.toThrow();
    await settle();
    expect(f.received).not.toHaveBeenCalled();
  });

  it("keeps maximum-sized Russian speech within its bounded encrypted packet", async () => {
    const f = await fixture();
    const text = "Я".repeat(MAX_CAPTION_CHARACTERS);
    const bytes = await f.packet(text, "ru");
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_CAPTION_BYTES);
    f.receiver.deliver(bytes);
    await vi.waitFor(() => expect(f.received.mock.calls[0]?.[0].text).toBe(text));
  });

  it("fails closed when room encryption, connection or caption keys are absent", async () => {
    const f = await fixture();
    f.sender.room.isE2EEEnabled = false;
    await expect(f.packet()).rejects.toThrow("защищённого");
    f.sender.room.isE2EEEnabled = true;
    f.sender.room.options.encryption = undefined as any;
    await expect(f.packet()).rejects.toThrow("защищённого");
    f.sender.room.options.encryption = {};
    f.sender.room.state = ConnectionState.Reconnecting;
    await expect(f.packet()).rejects.toThrow("защищённого");
    f.sender.room.state = ConnectionState.Connected;
    f.senderKeys.length = 0;
    await expect(f.packet()).rejects.toThrow("ключ");
  });

  it("derives non-exportable keys separated by call, group and epoch", async () => {
    const key = await deriveCaptionKey(rootKey, callId, 7, "group-one");
    expect(key.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key.key)).rejects.toThrow();
    for (const args of [["other-call", 7, "group-one"], [callId, 8, "group-one"], [callId, 7, "other-group"]] as const) {
      const other = await deriveCaptionKey(rootKey, ...args);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key.key, encoder.encode("secret"));
      await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, other.key, ciphertext)).rejects.toThrow();
    }
    await expect(deriveCaptionKey("invalid", callId, 1, "group-one")).rejects.toThrow();
    await expect(deriveCaptionKey(btoa("too short"), callId, 1, "group-one")).rejects.toThrow();
  });
});
