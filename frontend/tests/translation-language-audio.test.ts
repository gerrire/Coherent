import { EventEmitter } from "node:events";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import { deriveCaptionKey, type Caption, type CaptionKey } from "../src/lib/translation/transport";
import {
  createSharedLanguageAudio, guardTranslationAudioSubscriptions, openLanguageAudioCue,
  sealLanguageAudioCue, selectLanguageProducer, translationAudioTrackName, watchLanguageAudioPlayback, type LanguageAudioCue,
} from "../src/lib/translation/sharedLanguageAudio";

const doubles = vi.hoisted(() => ({ voices: [] as Array<{
  options: Record<string, unknown>; prepare: ReturnType<typeof vi.fn>; speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
}> }));
vi.mock("../src/lib/translation/speech", () => ({ createLocalSpeech: vi.fn((options: Record<string, unknown>) => {
  const voice = { options, prepare: vi.fn(async () => {}), speak: vi.fn(), cancel: vi.fn(), close: vi.fn() };
  doubles.voices.push(voice);
  return voice;
}) }));
vi.mock("livekit-client", async importOriginal => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return { ...actual, LocalAudioTrack: class {
    constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
    stop() { this.mediaStreamTrack.stop(); }
  } };
});

const PREFIX = "coherent.translation.giga.audio.";
const TOPIC = "coherent.translation.audio-cue.v1";
const attributes = (language: string, producer = true, ready = false) => ({
  [`${PREFIX}enabled`]: "true", [`${PREFIX}language`]: language,
  [`${PREFIX}producer`]: String(producer), [`${PREFIX}ready`]: String(ready),
});
const caption = (speakerId = "other"): Caption => ({
  id: "11111111-1111-4111-8111-111111111111", speakerId, language: "ru", text: "Проверка перевода", receivedAt: Date.now(),
});
const cue = (state: "start" | "end" = "start"): LanguageAudioCue => ({
  id: crypto.randomUUID(), segmentId: caption().id, language: "ru", speakerId: "local", state, durationMs: state === "start" ? 1_000 : 0,
});
async function key(epoch = 1): Promise<CaptionKey> { return deriveCaptionKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(epoch))), "call", epoch, "group"); }

class TestAudioContext {
  currentTime = 0;
  destination = {};
  track = { stop: vi.fn() };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  createOscillator() { return { frequency: { value: 0 }, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; }
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [this.track], getTracks: () => [this.track] } }; }
}
function fixture(producer = true, keys: CaptionKey[] = []) {
  const emitter = new EventEmitter();
  const local = {
    identity: "local", attributes: {} as Record<string, string>,
    setAttributes: vi.fn(async (values: Record<string, string>) => { Object.assign(local.attributes, values); emitter.emit(RoomEvent.ParticipantAttributesChanged); }),
    publishTrack: vi.fn(async () => ({})), unpublishTrack: vi.fn(async () => undefined), publishData: vi.fn(async () => undefined),
  };
  const peers = new Map<string, { identity: string; attributes: Record<string, string>; audioTrackPublications: Map<string, any> }>();
  const room = Object.assign(emitter, { localParticipant: local, remoteParticipants: peers,
    state: ConnectionState.Connected, options: { encryption: {} }, isE2EEEnabled: true, startAudio: vi.fn(async () => {}) });
  const callbacks = { onStatus: vi.fn(), onError: vi.fn(), onSpeakingChange: vi.fn(), onProducerChange: vi.fn() };
  const controller = createSharedLanguageAudio({ room: room as unknown as Room, callId: "call", language: "ru", producer, getCaptionKeys: () => keys, ...callbacks });
  return { room, local, peers, controller, ...callbacks };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("document", { createElement: vi.fn(() => ({ autoplay: false, muted: false, srcObject: null, play: vi.fn(async () => {}), pause: vi.fn() })) });
  doubles.voices.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("authenticated shared-language audio cues", () => {
  it("authenticates the call, actual SDK sender, language and key without exposing the speaker identifier", async () => {
    const current = await key();
    const message = cue();
    const bytes = await sealLanguageAudioCue(message, "call", "coordinator", current);
    expect(new TextDecoder().decode(bytes)).not.toContain('"speakerId"');
    expect(await openLanguageAudioCue(bytes, "call", "coordinator", "ru", [current])).toEqual(message);
    expect(await openLanguageAudioCue(bytes, "other-call", "coordinator", "ru", [current])).toBeNull();
    expect(await openLanguageAudioCue(bytes, "call", "spoofed", "ru", [current])).toBeNull();
    expect(await openLanguageAudioCue(bytes, "call", "coordinator", "en", [current])).toBeNull();
    expect(await openLanguageAudioCue(bytes, "call", "coordinator", "ru", [await key(2)])).toBeNull();
    expect(await openLanguageAudioCue(new TextEncoder().encode(JSON.stringify(message)), "call", "coordinator", "ru", [current])).toBeNull();
  });

  it("accepts the preceding epoch but bounds key history and rejects tampering", async () => {
    const previous = await key(1), current = await key(2), newer = await key(3);
    const bytes = await sealLanguageAudioCue(cue(), "call", "coordinator", previous);
    expect(await openLanguageAudioCue(bytes, "call", "coordinator", "ru", [current, previous])).not.toBeNull();
    expect(await openLanguageAudioCue(bytes, "call", "coordinator", "ru", [newer, current, previous])).toBeNull();
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    envelope.data = envelope.data.slice(0, 4) + (envelope.data[4] === "a" ? "b" : "a") + envelope.data.slice(5);
    expect(await openLanguageAudioCue(new TextEncoder().encode(JSON.stringify(envelope)), "call", "coordinator", "ru", [previous])).toBeNull();
    expect(await openLanguageAudioCue(new Uint8Array(2_049), "call", "coordinator", "ru", [previous])).toBeNull();
  });
});

describe("one coordinator per requested language", () => {
  it("elects deterministically and retains a ready coordinator when a new listener joins", () => {
    const peers = [{ identity: "z", attributes: attributes("ru", true, true) }, { identity: "a", attributes: attributes("ru") },
      { identity: "b", attributes: attributes("en", true, true) }, { identity: "c", attributes: attributes("ru", false) }];
    expect(selectLanguageProducer(peers, "ru")).toBe("z");
    expect(selectLanguageProducer(peers.slice(1), "ru")).toBe("a");
    expect(selectLanguageProducer(peers, "en")).toBe("b");
    expect(selectLanguageProducer(peers, "fr")).toBeUndefined();
  });

  it("starts no voice before a gesture, publishes one separate track, suppresses own playback and deduplicates phrases", async () => {
    const { controller, local } = fixture();
    expect(doubles.voices).toHaveLength(0);
    expect(local.publishTrack).not.toHaveBeenCalled();
    await controller.prepareFromGesture(); await flush();
    expect(controller.isProducer()).toBe(true);
    expect(doubles.voices).toHaveLength(1);
    expect(local.publishTrack).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ name: translationAudioTrackName("ru"), source: "unknown" }));
    controller.offer(caption("local"), { playLocally: false });
    controller.offer(caption("local"), { playLocally: false });
    expect(doubles.voices[0].speak).toHaveBeenCalledExactlyOnceWith("Проверка перевода", expect.objectContaining({ playLocally: false }));
    controller.close();
    expect(local.unpublishTrack).toHaveBeenCalledOnce();
    expect(doubles.voices[0].close).toHaveBeenCalledOnce();
  });

  it("stops its old synthesis and publication after another ready coordinator wins", async () => {
    const { controller, room, peers, local, onProducerChange } = fixture();
    await controller.prepareFromGesture(); await flush();
    peers.set("a", { identity: "a", attributes: attributes("ru", true, true), audioTrackPublications: new Map() });
    room.emit(RoomEvent.ParticipantConnected); await flush();
    expect(controller.isProducer()).toBe(false);
    expect(onProducerChange).toHaveBeenLastCalledWith(false);
    expect(local.unpublishTrack).toHaveBeenCalledOnce();
    expect(doubles.voices[0].close).toHaveBeenCalledOnce();
    controller.offer(caption());
    expect(doubles.voices[0].speak).not.toHaveBeenCalled();
    controller.close();
    expect(room.listenerCount(RoomEvent.DataReceived)).toBe(0);
  });

  it("does not publish a late-created track after being closed during model preparation", async () => {
    let finish: (() => void) | undefined;
    const { controller, local } = fixture();
    const preparing = controller.prepareFromGesture();
    doubles.voices[0].prepare.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    // Closing before pending publication settles is enough to invalidate its generation.
    controller.close();
    finish?.(); await preparing; await flush();
    expect(local.publishTrack).not.toHaveBeenCalled();
    expect(controller.isProducer()).toBe(false);
  });

  it("attaches only the selected encrypted language, preserves an early own cue and never loads a listener voice", async () => {
    const current = await key();
    const { controller, room, peers, onSpeakingChange } = fixture(false, [current]);
    const publication = { trackName: translationAudioTrackName("ru"), isDesired: true, isEncrypted: true,
      setSubscribed: vi.fn(), audioTrack: undefined as any };
    const wrongLanguage = { trackName: translationAudioTrackName("en"), isDesired: true, isEncrypted: true, setSubscribed: vi.fn() };
    const peer = { identity: "producer", attributes: attributes("ru", true, true), audioTrackPublications: new Map([['ru', publication], ['en', wrongLanguage]]) };
    peers.set(peer.identity, peer);
    await controller.prepareFromGesture(); await flush();
    expect(doubles.voices).toHaveLength(0);
    expect(wrongLanguage.setSubscribed).toHaveBeenCalledWith(false);
    const start = await sealLanguageAudioCue(cue(), "call", peer.identity, current);
    room.emit(RoomEvent.DataReceived, start, peer, undefined, TOPIC, 0);
    // crypto.subtle resolves outside the JS microtask-only loop.
    await new Promise(resolve => setTimeout(resolve, 20));
    publication.audioTrack = { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { enabled: true } };
    room.emit(RoomEvent.TrackSubscribed);
    const element = publication.audioTrack.attach.mock.calls[0][0];
    expect(element.muted).toBe(true);
    expect(publication.audioTrack.mediaStreamTrack.enabled).toBe(false);
    expect(onSpeakingChange).toHaveBeenLastCalledWith(false);
    const end = await sealLanguageAudioCue(cue("end"), "call", peer.identity, current);
    room.emit(RoomEvent.DataReceived, end, peer, undefined, TOPIC, 0);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(element.muted).toBe(true); // Idle media stays fail-closed after the RTP tail.
    const otherStart = await sealLanguageAudioCue({ ...cue(), speakerId: "other" }, "call", peer.identity, current);
    room.emit(RoomEvent.DataReceived, otherStart, peer, undefined, TOPIC, 0);
    await vi.waitFor(() => expect(element.muted).toBe(false));
    expect(publication.audioTrack.mediaStreamTrack.enabled).toBe(true);
    controller.setDeafened(true);
    expect(element.muted).toBe(true);
    expect(publication.audioTrack.mediaStreamTrack.enabled).toBe(false);
    element.muted = false; // Room.startAudio can do this even with webAudioMix.
    room.emit(RoomEvent.AudioPlaybackStatusChanged, true);
    expect(element.muted).toBe(true);
    expect(publication.audioTrack.mediaStreamTrack.enabled).toBe(false);
    controller.close();
    expect(publication.audioTrack.detach).toHaveBeenCalledWith(element);
  });

  it("unsubscribes all translation tracks for ordinary local-mode call participants", () => {
    const { controller, room, peers } = fixture(false);
    const publication = { trackName: translationAudioTrackName("ru"), isDesired: true, setSubscribed: vi.fn() };
    peers.set("producer", { identity: "producer", attributes: attributes("ru", true, true), audioTrackPublications: new Map([['track', publication]]) });
    const stop = guardTranslationAudioSubscriptions(room as unknown as Room);
    expect(publication.setSubscribed).toHaveBeenCalledWith(false);
    stop(); controller.close();
  });

  it("tests a nonproducer listener with a local beep instead of downloading a voice", async () => {
    const { controller, local } = fixture(false);
    await controller.prepareFromGesture();
    await controller.checkSound("Тест");
    expect(doubles.voices).toHaveLength(0);
    expect(local.publishTrack).not.toHaveBeenCalled();
    controller.close();
  });

  it("declares a gesture-prepared channel after connecting and updates only local playback observers", async () => {
    const { controller, room, local } = fixture();
    room.state = ConnectionState.Disconnected;
    const playback = vi.fn();
    const stop = watchLanguageAudioPlayback(room as unknown as Room, playback);
    await controller.prepareFromGesture();
    expect(local.publishTrack).not.toHaveBeenCalled();
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Connected);
    await flush();
    expect(local.publishTrack).toHaveBeenCalledOnce();
    expect(playback).toHaveBeenCalledWith(false);
    (doubles.voices[0].options.onSpeakingChange as (value: boolean) => void)(true);
    expect(playback).toHaveBeenLastCalledWith(true);
    controller.setDeafened(true);
    expect(playback).toHaveBeenLastCalledWith(false);
    controller.close(); stop();
  });

  it("invalidates the old coordinator on reconnecting and creates one fresh publication after reconnection", async () => {
    const { controller, room, local } = fixture();
    await controller.prepareFromGesture(); await flush();
    room.state = ConnectionState.Reconnecting;
    room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
    expect(controller.isProducer()).toBe(false);
    expect(local.unpublishTrack).toHaveBeenCalledOnce();
    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    room.emit(RoomEvent.Reconnected);
    await flush();
    expect(controller.isProducer()).toBe(true);
    expect(local.publishTrack).toHaveBeenCalledTimes(2);
    controller.close();
  });
});
