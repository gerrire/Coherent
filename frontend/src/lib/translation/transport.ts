import { ConnectionState, RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { isTranslationLanguage, type TranslationLanguage } from "./protocol";

export const CAPTION_TOPIC = "coherent.translation.v2";
export const MAX_CAPTION_CHARACTERS = 600;
export const MAX_CAPTION_BYTES = 4096;
export const CAPTION_RATE_WINDOW_MS = 10_000;
export const MAX_CAPTIONS_PER_WINDOW = 6;
export const MAX_CAPTION_REPLAY_ENTRIES = 256;
const REPLAY_RETENTION_MS = 120_000;
const MAX_RATE_ENTRIES = 64;
const SEGMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface Caption {
  id: string;
  speakerId: string;
  text: string;
  language: TranslationLanguage;
  receivedAt: number;
}

export interface CaptionKey { epoch: number; group: string; key: CryptoKey }
interface CaptionPayload { text: string; language: TranslationLanguage }
interface CaptionEnvelope {
  v: 2; callId: string; epoch: number; group: string; sender: string; id: string;
  iv: string; ciphertext: string;
}
interface RateWindow { startedAt: number; count: number }

function validGroup(group: unknown): group is string {
  return typeof group === "string" && group.length > 0 && group.length <= 256 && !CONTROL.test(group);
}
function validEpoch(epoch: unknown): epoch is number {
  return Number.isSafeInteger(epoch) && Number(epoch) >= 0;
}
function toBase64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid encoding");
  const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
  if (toBase64(bytes) !== value) throw new Error("Invalid encoding");
  return bytes;
}

/** Domain-separated, non-exportable caption key derived from the MLS media key. */
export async function deriveCaptionKey(
  mediaKeyBase64: string, callId: string, epoch: number, group: string,
): Promise<CaptionKey> {
  if (!callId || callId.length > 128 || !validEpoch(epoch) || !validGroup(group)) {
    throw new Error("Недопустимый контекст ключа субтитров.");
  }
  const material = fromBase64(mediaKeyBase64);
  if (material.byteLength !== 32) throw new Error("Недопустимый ключ звонка.");
  const root = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode("coherent/call-caption-key/v2"),
    info: encoder.encode(JSON.stringify([callId, group, epoch])),
  }, root, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  material.fill(0);
  return { epoch, group, key };
}

function isPayload(value: unknown): value is CaptionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<CaptionPayload>;
  return isTranslationLanguage(payload.language) && typeof payload.text === "string"
    && payload.text.length > 0 && payload.text.length <= MAX_CAPTION_CHARACTERS
    && payload.text.trim() === payload.text && !CONTROL.test(payload.text);
}
function isEnvelope(value: unknown, callId: string, sender: string): value is CaptionEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<CaptionEnvelope>;
  return envelope.v === 2 && envelope.callId === callId && envelope.sender === sender
    && validEpoch(envelope.epoch) && validGroup(envelope.group)
    && typeof envelope.id === "string" && SEGMENT_ID.test(envelope.id)
    && typeof envelope.iv === "string" && envelope.iv.length === 16
    && typeof envelope.ciphertext === "string" && envelope.ciphertext.length >= 24
    && envelope.ciphertext.length <= MAX_CAPTION_BYTES;
}
function associatedData(envelope: Pick<CaptionEnvelope, "callId" | "group" | "epoch" | "sender" | "id">): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([
    CAPTION_TOPIC, envelope.callId, envelope.group, envelope.epoch, envelope.sender, envelope.id,
  ]));
}

/** Native LiveKit encryption remains enabled. An application AEAD envelope
 * authenticates captions independently of the SDK's encryptionType callback:
 * livekit-client 2.17.2 reports NONE for some successfully decrypted packets. */
export function createCaptionTransport(
  room: Room, callId: string, onCaption: (caption: Caption) => void,
  getKeys: () => readonly CaptionKey[],
): { publish(text: string, language: TranslationLanguage): Promise<void>; close(): void } {
  let closed = false;
  const replay = new Map<string, number>();
  const pending = new Set<string>();
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

  async function open(bytes: Uint8Array, participant: RemoteParticipant): Promise<void> {
    let decoded: unknown;
    try { decoded = JSON.parse(decoder.decode(bytes)); } catch { return; }
    if (!isEnvelope(decoded, callId, participant.identity)) return;
    const envelope = decoded;
    const captionKey = getKeys().slice(0, 2).find(key => key.epoch === envelope.epoch && key.group === envelope.group);
    if (!captionKey) return;
    const replayId = `${participant.identity}:${envelope.id}`;
    if (replay.has(replayId) || pending.has(replayId)) return;
    pending.add(replayId);
    try {
      const iv = fromBase64(envelope.iv);
      const ciphertext = fromBase64(envelope.ciphertext);
      if (iv.byteLength !== 12 || ciphertext.byteLength < 17) return;
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM", iv, additionalData: associatedData(envelope), tagLength: 128,
      }, captionKey.key, ciphertext);
      if (!encryptedAndConnected() || room.remoteParticipants.get(participant.identity) !== participant
        || !getKeys().slice(0, 2).some(key => key.key === captionKey.key)) return;
      let payload: unknown;
      try { payload = JSON.parse(decoder.decode(plaintext)); } catch { return; }
      if (!isPayload(payload)) return;
      const now = Date.now();
      for (const [id, receivedAt] of replay) {
        if (now - receivedAt < REPLAY_RETENTION_MS) break;
        replay.delete(id);
      }
      if (replay.size >= MAX_CAPTION_REPLAY_ENTRIES) replay.delete(replay.keys().next().value!);
      replay.set(replayId, now);
      onCaption({ id: envelope.id, speakerId: participant.identity, text: payload.text, language: payload.language, receivedAt: now });
    } catch {
      // Failed encoding, key lookup or GCM authentication never becomes text.
    } finally {
      pending.delete(replayId);
    }
  }

  const receive = (bytes: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (!encryptedAndConnected() || topic !== CAPTION_TOPIC || !participant
      || room.remoteParticipants.get(participant.identity) !== participant
      || bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTION_BYTES
      || !allowRate(participant.identity, Date.now())) return;
    void open(bytes, participant).catch(() => undefined);
  };
  room.on(RoomEvent.DataReceived, receive);

  return {
    async publish(text: string, language: TranslationLanguage): Promise<void> {
      if (!encryptedAndConnected()) throw new Error("Перевод ждёт защищённого соединения со звонком.");
      const captionKey = getKeys()[0];
      if (!captionKey) throw new Error("Согласуем ключ субтитров звонка.");
      const payload = { text: text.trim(), language };
      if (!isPayload(payload)) throw new Error("Недопустимый фрагмент субтитров.");
      const now = Date.now();
      if (now - outgoing.startedAt >= CAPTION_RATE_WINDOW_MS) outgoing = { startedAt: now, count: 0 };
      if (outgoing.count >= MAX_CAPTIONS_PER_WINDOW) throw new Error("Слишком много фрагментов перевода. Подожди немного.");
      outgoing.count++;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const envelope: CaptionEnvelope = {
        v: 2, callId, epoch: captionKey.epoch, group: captionKey.group,
        sender: room.localParticipant.identity, id: crypto.randomUUID(), iv: toBase64(iv), ciphertext: "",
      };
      const ciphertext = await crypto.subtle.encrypt({
        name: "AES-GCM", iv, additionalData: associatedData(envelope), tagLength: 128,
      }, captionKey.key, encoder.encode(JSON.stringify(payload)));
      if (!encryptedAndConnected()) throw new Error("Перевод ждёт защищённого соединения со звонком.");
      envelope.ciphertext = toBase64(new Uint8Array(ciphertext));
      const bytes = encoder.encode(JSON.stringify(envelope));
      if (bytes.byteLength > MAX_CAPTION_BYTES) throw new Error("Фрагмент субтитров слишком большой.");
      await room.localParticipant.publishData(bytes, { reliable: true, topic: CAPTION_TOPIC });
    },
    close(): void {
      if (closed) return;
      closed = true;
      room.off(RoomEvent.DataReceived, receive);
      replay.clear(); pending.clear(); rates.clear();
    },
  };
}
