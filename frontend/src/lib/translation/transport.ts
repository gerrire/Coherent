import { ConnectionState, Encryption_Type, RoomEvent, type RemoteParticipant, type Room } from "livekit-client";

export const CAPTION_TOPIC = "coherent.translation.v1";
export const MAX_CAPTION_CHARACTERS = 600;
export const MAX_CAPTION_BYTES = 4096;
export const CAPTION_RATE_WINDOW_MS = 10_000;
export const MAX_CAPTIONS_PER_WINDOW = 6;
export const MAX_CAPTION_REPLAY_ENTRIES = 256;
const REPLAY_RETENTION_MS = 120_000;
const MAX_RATE_ENTRIES = 64;
const SEGMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Caption {
  id: string;
  speakerId: string;
  text: string;
  receivedAt: number;
}

interface CaptionPacket {
  v: 1;
  callId: string;
  id: string;
  language: "en";
  text: string;
}

interface RateWindow { startedAt: number; count: number }

function isPacket(value: unknown, callId: string): value is CaptionPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Partial<CaptionPacket>;
  return packet.v === 1 && packet.callId === callId && packet.language === "en"
    && typeof packet.id === "string" && SEGMENT_ID.test(packet.id)
    && typeof packet.text === "string" && packet.text.length > 0
    && packet.text.length <= MAX_CAPTION_CHARACTERS && packet.text.trim() === packet.text
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(packet.text);
}

/** English pivot text only. LiveKit's `encryption` room option encrypts data
 * packets with the same MLS-backed key provider as the call. The deprecated
 * `e2ee` option alone does not encrypt data, so fail closed in that case. */
export function createCaptionTransport(room: Room, callId: string, onCaption: (caption: Caption) => void): {
  publish(text: string): Promise<void>;
  close(): void;
} {
  let closed = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const replay = new Map<string, number>();
  const rates = new Map<string, RateWindow>();
  let outgoing: RateWindow = { startedAt: 0, count: 0 };

  function encryptedAndConnected(): boolean {
    return !closed && !!room.options.encryption && room.isE2EEEnabled && room.state === ConnectionState.Connected;
  }

  function allowRate(identity: string, now: number): boolean {
    const previous = rates.get(identity);
    if (previous && now - previous.startedAt < CAPTION_RATE_WINDOW_MS) {
      if (previous.count >= MAX_CAPTIONS_PER_WINDOW) return false;
      previous.count++;
      return true;
    }
    if (rates.size >= MAX_RATE_ENTRIES) rates.delete(rates.keys().next().value!);
    rates.set(identity, { startedAt: now, count: 1 });
    return true;
  }

  const receive = (
    bytes: Uint8Array,
    participant?: RemoteParticipant,
    _kind?: unknown,
    topic?: string,
    encryptionType?: Encryption_Type,
  ) => {
    if (!encryptedAndConnected() || topic !== CAPTION_TOPIC || encryptionType !== Encryption_Type.GCM
      || !participant || room.remoteParticipants.get(participant.identity) !== participant
      || bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTION_BYTES) return;
    const now = Date.now();
    // Limit parsing and callbacks per authenticated sender, including malformed
    // messages. A busy or malicious participant cannot build an unbounded queue.
    if (!allowRate(participant.identity, now)) return;
    let packet: unknown;
    try { packet = JSON.parse(decoder.decode(bytes)); } catch { return; }
    if (!isPacket(packet, callId)) return;
    const replayId = `${participant.identity}:${packet.id}`;
    if (replay.has(replayId)) return;
    for (const [id, receivedAt] of replay) {
      if (now - receivedAt < REPLAY_RETENTION_MS) break;
      replay.delete(id);
    }
    if (replay.size >= MAX_CAPTION_REPLAY_ENTRIES) replay.delete(replay.keys().next().value!);
    replay.set(replayId, now);
    // Use the SDK's sender identity; payloads cannot choose another speaker.
    // Local receive time avoids dropping speech when device clocks differ.
    onCaption({ id: packet.id, speakerId: participant.identity, text: packet.text, receivedAt: now });
  };

  room.on(RoomEvent.DataReceived, receive);

  return {
    async publish(text: string): Promise<void> {
      if (!encryptedAndConnected()) throw new Error("Перевод ждёт защищённого соединения со звонком.");
      const packet: CaptionPacket = { v: 1, callId, id: crypto.randomUUID(), language: "en", text: text.trim() };
      if (!isPacket(packet, callId)) throw new Error("Недопустимый фрагмент субтитров.");
      const bytes = encoder.encode(JSON.stringify(packet));
      if (bytes.byteLength > MAX_CAPTION_BYTES) throw new Error("Фрагмент субтитров слишком большой.");
      const now = Date.now();
      if (now - outgoing.startedAt >= CAPTION_RATE_WINDOW_MS) outgoing = { startedAt: now, count: 0 };
      if (outgoing.count >= MAX_CAPTIONS_PER_WINDOW) throw new Error("Слишком много фрагментов перевода. Подожди немного.");
      outgoing.count++;
      await room.localParticipant.publishData(bytes, { reliable: true, topic: CAPTION_TOPIC });
    },
    close(): void {
      if (closed) return;
      closed = true;
      room.off(RoomEvent.DataReceived, receive);
      replay.clear();
      rates.clear();
    },
  };
}
