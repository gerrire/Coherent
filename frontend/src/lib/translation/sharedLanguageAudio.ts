import { ConnectionState, LocalAudioTrack, RoomEvent, Track, type RemoteAudioTrack, type RemoteParticipant, type Room } from "livekit-client";
import type { TranslationLanguage } from "./protocol";
import type { TranslationMetrics } from "./metrics";
import type { Caption, CaptionKey } from "./transport";
import { createLocalSpeech, type LocalSpeech } from "./speech";

const PREFIX = "coherent-translation-audio-v1-";
const TOPIC = "coherent.translation.audio-cue.v1";
const ATTRIBUTE = "coherent.translation.giga.audio.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const audibleRooms = new WeakMap<Room, { playing: boolean; listeners: Set<(playing: boolean) => void> }>();

function playbackState(room: Room) {
  let value = audibleRooms.get(room);
  if (!value) { value = { playing: false, listeners: new Set() }; audibleRooms.set(room, value); }
  return value;
}
function setLanguageAudioPlayback(room: Room, playing: boolean): void {
  const state = playbackState(room);
  if (state.playing === playing) return;
  state.playing = playing;
  for (const listener of state.listeners) listener(playing);
}
/** Local UI subscription; no participant attributes or network telemetry. */
export function watchLanguageAudioPlayback(room: Room, listener: (playing: boolean) => void): () => void {
  const state = playbackState(room);
  state.listeners.add(listener);
  listener(state.playing);
  return () => { state.listeners.delete(listener); };
}

interface Peer { identity: string; attributes: Readonly<Record<string, string>> }
export interface LanguageAudioCue {
  id: string;
  segmentId: string;
  language: TranslationLanguage;
  speakerId: string;
  state: "start" | "end";
  durationMs: number;
}

export function translationAudioTrackName(language: TranslationLanguage): string { return `${PREFIX}${language}`; }
export function isTranslationAudioTrack(name: string): boolean { return name.startsWith(PREFIX); }

/** Existing ready coordinators keep their role when a new listener joins. */
export function selectLanguageProducer(peers: readonly Peer[], language: TranslationLanguage): string | undefined {
  const candidates = peers.filter(peer => peer.attributes[`${ATTRIBUTE}enabled`] === "true"
    && peer.attributes[`${ATTRIBUTE}language`] === language && peer.attributes[`${ATTRIBUTE}producer`] === "true");
  const ready = candidates.filter(peer => peer.attributes[`${ATTRIBUTE}ready`] === "true");
  return (ready.length ? ready : candidates).map(peer => peer.identity).sort()[0];
}

function roster(room: Room): Peer[] { return [room.localParticipant, ...room.remoteParticipants.values()]; }
function connected(room: Room): boolean { return room.state === ConnectionState.Connected && !!room.options.encryption && room.isE2EEEnabled; }
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
function validCue(value: unknown, language: TranslationLanguage): value is LanguageAudioCue {
  if (!value || typeof value !== "object") return false;
  const cue = value as Partial<LanguageAudioCue>;
  return typeof cue.id === "string" && UUID.test(cue.id) && typeof cue.segmentId === "string" && UUID.test(cue.segmentId)
    && cue.language === language && typeof cue.speakerId === "string" && cue.speakerId.length > 0 && cue.speakerId.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(cue.speakerId) && (cue.state === "start" || cue.state === "end")
    && typeof cue.durationMs === "number" && Number.isFinite(cue.durationMs) && cue.durationMs >= 0 && cue.durationMs <= 45_000;
}
function aad(callId: string, sender: string, key: Pick<CaptionKey, "epoch" | "group">): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([TOPIC, callId, sender, key.group, key.epoch]));
}

/** Cues contain no text/audio and are still authenticated independently of the SDK data flag. */
export async function sealLanguageAudioCue(cue: LanguageAudioCue, callId: string, sender: string, key: CaptionKey): Promise<Uint8Array<ArrayBuffer>> {
  if (!validCue(cue, cue.language)) throw new Error("Invalid audio cue");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(callId, sender, key) }, key.key, encoder.encode(JSON.stringify(cue)));
  return encoder.encode(JSON.stringify({ v: 1, epoch: key.epoch, group: key.group, iv: base64(iv), data: base64(new Uint8Array(bytes)) }));
}

export async function openLanguageAudioCue(bytes: Uint8Array, callId: string, sender: string, language: TranslationLanguage, keys: readonly CaptionKey[], keyAllowed?: (key: CaptionKey) => boolean): Promise<LanguageAudioCue | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > 2_048) return null;
  try {
    const envelope = JSON.parse(decoder.decode(bytes)) as { v?: unknown; epoch?: unknown; group?: unknown; iv?: unknown; data?: unknown };
    if (envelope.v !== 1) return null;
    const key = keys.slice(0, 2).find(candidate => candidate.epoch === envelope.epoch && candidate.group === envelope.group);
    if (!key) return null;
    const iv = unbase64(envelope.iv);
    if (iv.length !== 12) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(callId, sender, key) }, key.key, unbase64(envelope.data));
    const cue: unknown = JSON.parse(decoder.decode(plain));
    return validCue(cue, language) && (!keyAllowed || keyAllowed(key)) ? cue : null;
  } catch { return null; }
}

/** Install for every call, including local-only listeners: unrelated language
 * tracks must not consume bandwidth merely because Room auto-subscribe is on. */
export function guardTranslationAudioSubscriptions(room: Room): () => void {
  const update = () => {
    const attrs = room.localParticipant.attributes;
    const language = attrs[`${ATTRIBUTE}language`] as TranslationLanguage;
    const enabled = attrs[`${ATTRIBUTE}enabled`] === "true" && connected(room);
    const leader = enabled ? selectLanguageProducer(roster(room), language) : undefined;
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (!isTranslationAudioTrack(publication.trackName)) continue;
        const wanted = enabled && participant.identity === leader && publication.trackName === translationAudioTrackName(language);
        if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
      }
    }
  };
  room.on(RoomEvent.TrackPublished, update);
  room.on(RoomEvent.ParticipantAttributesChanged, update);
  room.on(RoomEvent.LocalTrackPublished, update);
  room.on(RoomEvent.ParticipantDisconnected, update);
  room.on(RoomEvent.Connected, update);
  room.on(RoomEvent.ConnectionStateChanged, update);
  room.on(RoomEvent.Reconnected, update);
  update();
  return () => {
    room.off(RoomEvent.TrackPublished, update);
    room.off(RoomEvent.ParticipantAttributesChanged, update);
    room.off(RoomEvent.LocalTrackPublished, update);
    room.off(RoomEvent.ParticipantDisconnected, update);
    room.off(RoomEvent.Connected, update);
    room.off(RoomEvent.ConnectionStateChanged, update);
    room.off(RoomEvent.Reconnected, update);
  };
}

interface SharedLanguageAudioOptions {
  room: Room;
  callId: string;
  language: TranslationLanguage;
  producer: boolean;
  deafened?: boolean;
  metrics?: TranslationMetrics;
  getCaptionKeys(): readonly CaptionKey[];
  onStatus(message: string): void;
  onError(message: string): void;
  onSpeakingChange(speaking: boolean): void;
  onProducerChange?(producer: boolean): void;
}
export interface SharedLanguageAudio {
  prepareFromGesture(): Promise<void>;
  offer(caption: Caption, playback?: { playLocally?: boolean }): void;
  isProducer(): boolean;
  setDeafened(value: boolean): void;
  checkSound(text: string): Promise<void>;
  retry(): void;
  close(): void;
}

export function createSharedLanguageAudio(options: SharedLanguageAudioOptions): SharedLanguageAudio {
  const { room, language } = options;
  let closed = false;
  let prepared = false;
  let failed = false;
  let deafened = options.deafened ?? false;
  let producer = false;
  let producerGeneration = 0;
  let context: AudioContext | undefined;
  let localGain: GainNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let localTrack: LocalAudioTrack | undefined;
  let publishing: Promise<void> | undefined;
  let speech: LocalSpeech | undefined;
  let selected: RemoteAudioTrack | undefined;
  let listeningLeader: string | undefined;
  let remoteSegment: string | undefined;
  let element: HTMLAudioElement | undefined;
  let remoteSpeaking = false;
  let localSpeaking = false;
  let ownCue = false;
  let cueTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { caption: Caption; playLocally: boolean } | undefined;
  const seen = new Set<string>();
  const cues = new Set<string>();
  let rate = { startedAt: 0, count: 0 };

  function speaking(): void {
    const audible = !closed && !deafened && (localSpeaking || remoteSpeaking && !ownCue);
    setLanguageAudioPlayback(room, audible);
    options.onSpeakingChange(audible);
  }
  function applyRemoteGate(): void {
    const allowed = prepared && !closed && !deafened && remoteSpeaking && !ownCue;
    // CallRoom uses webAudioMix. Its SDK AudioContext bypasses element.muted,
    // and Room.startAudio() may unmute elements. Disable this separate remote
    // media track itself so every playback path is gated, never the call mic.
    if (selected) selected.mediaStreamTrack.enabled = allowed;
    if (element) element.muted = !allowed;
  }
  function isProducer(): boolean { return !closed && prepared && producer && !failed && connected(room); }
  function advertise(ready = !!localTrack): void {
    if (!connected(room)) return;
    void room.localParticipant.setAttributes({
      [`${ATTRIBUTE}enabled`]: !closed && prepared ? "true" : "false",
      [`${ATTRIBUTE}language`]: language,
      [`${ATTRIBUTE}producer`]: !closed && prepared && options.producer && !failed ? "true" : "false",
      [`${ATTRIBUTE}ready`]: !closed && producer && ready ? "true" : "false",
    }).catch(() => { if (!closed) options.onStatus("Не удалось объявить языковой канал. Проверяем соединение…"); });
  }
  function detach(clearCue = true): void {
    if (clearCue) {
      clearTimeout(cueTimer);
      remoteSpeaking = false; ownCue = false; remoteSegment = undefined;
    }
    if (selected) selected.mediaStreamTrack.enabled = false;
    if (selected && element) selected.detach(element);
    if (element) { element.pause(); element.srcObject = null; }
    selected = undefined; element = undefined;
    speaking();
  }
  function closeSpeech(): void {
    speech?.close(); speech = undefined;
    localSpeaking = false;
    pending = undefined;
    speaking();
  }
  function unpublish(): void {
    producerGeneration++;
    closeSpeech();
    const previous = localTrack;
    localTrack = undefined;
    if (previous) {
      previous.stop();
      void room.localParticipant.unpublishTrack(previous, true).catch(() => undefined);
    }
    destination?.stream.getTracks().forEach(track => track.stop());
    destination = undefined;
    publishing = undefined;
  }
  function fail(message: string): void {
    if (closed) return;
    failed = true;
    unpublish();
    producer = false;
    options.onProducerChange?.(false);
    advertise(false);
    options.onError(message);
    update();
  }
  function ensureSpeech(): LocalSpeech {
    if (speech) return speech;
    if (!context) throw new Error("Нажми «Проверить звук», чтобы включить воспроизведение.");
    destination ??= context.createMediaStreamDestination();
    speech = createLocalSpeech({
      language, downloadedVoice: true, audioContext: context, output: destination, localOutput: localGain,
      metrics: options.metrics,
      onStatus: options.onStatus,
      onError: message => { if (producer) fail(message); else options.onError(message); },
      onSpeakingChange: value => { localSpeaking = value; speaking(); },
    });
    return speech;
  }
  async function sendCue(caption: Caption, state: "start" | "end", durationMs: number): Promise<void> {
    if (!isProducer()) return;
    const key = options.getCaptionKeys()[0];
    if (!key) throw new Error("Ожидаем ключ языкового канала.");
    const packet = await sealLanguageAudioCue({ id: crypto.randomUUID(), segmentId: caption.id, language,
      speakerId: caption.speakerId, state, durationMs }, options.callId, room.localParticipant.identity, key);
    if (!isProducer() || !options.getCaptionKeys().some(candidate => candidate.key === key.key)) return;
    await room.localParticipant.publishData(packet, { topic: TOPIC, reliable: true });
  }
  function speakPending(): void {
    if (!isProducer() || !localTrack || !pending) return;
    const next = pending;
    pending = undefined;
    if (Date.now() - next.caption.receivedAt > 15_000) { options.metrics?.drop(); return; }
    const generation = producerGeneration;
    ensureSpeech().speak(next.caption.text, {
      playLocally: next.playLocally,
      beforePlayback: async durationMs => {
        if (!isProducer() || generation !== producerGeneration) throw new Error("Языковой канал изменился.");
        await sendCue(next.caption, "start", durationMs);
        // Give the authenticated cue a head start. Receivers remain muted until
        // a valid cue; media and data transport have no shared ordering guarantee.
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!isProducer() || generation !== producerGeneration) throw new Error("Языковой канал изменился.");
      },
      afterPlayback: () => { void sendCue(next.caption, "end", 0).catch(() => undefined); },
    });
  }
  function publish(): void {
    if (publishing || localTrack || !isProducer()) return;
    const generation = producerGeneration;
    publishing = (async () => {
      const voice = ensureSpeech();
      await voice.prepare();
      if (!isProducer() || generation !== producerGeneration || !destination) return;
      const track = new LocalAudioTrack(destination.stream.getAudioTracks()[0], undefined, true);
      try {
        await room.localParticipant.publishTrack(track, {
          name: translationAudioTrackName(language), source: Track.Source.Unknown, dtx: true, red: false,
        });
        if (!isProducer() || generation !== producerGeneration) {
          track.stop();
          await room.localParticipant.unpublishTrack(track, true).catch(() => undefined);
          return;
        }
        localTrack = track;
        advertise(true);
        options.onStatus("Ты озвучиваешь общий языковой канал · один синтез для слушателей этого языка");
        speakPending();
      } catch (error) { track.stop(); throw error; }
    })().catch(() => { if (!closed && generation === producerGeneration) fail("Не удалось подготовить языковой аудиоканал. Можно повторить или выбрать локальный перевод."); })
      .finally(() => { if (generation === producerGeneration) publishing = undefined; });
  }
  function subscribe(leader: string | undefined): void {
    if (listeningLeader !== leader) { detach(); listeningLeader = leader; }
    let next: RemoteAudioTrack | undefined;
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (!isTranslationAudioTrack(publication.trackName)) continue;
        const wanted = prepared && connected(room) && participant.identity === leader && publication.trackName === translationAudioTrackName(language);
        if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
        if (wanted && publication.audioTrack && publication.isEncrypted) next = publication.audioTrack as RemoteAudioTrack;
      }
    }
    if (selected === next) return;
    // A cue can arrive before TrackSubscribed. Keep it when attaching the
    // same producer's track, otherwise a speaker briefly hears their own voice.
    detach(false);
    if (!next || closed) return;
    selected = next;
    applyRemoteGate();
    element = document.createElement("audio");
    element.autoplay = true;
    element.muted = deafened || ownCue || !remoteSpeaking;
    selected.attach(element);
    applyRemoteGate();
    void element.play().catch(() => { if (!closed) options.onError("Браузер остановил звук канала. Нажми «Проверить звук»."); });
    options.onStatus("Слушаем общий языковой аудиоканал");
  }
  function update(): void {
    if (closed) return;
    const leader = connected(room) && prepared ? selectLanguageProducer(roster(room), language) : undefined;
    const elected = leader === room.localParticipant.identity && options.producer && !failed;
    if (producer !== elected) {
      producer = elected;
      if (!elected) { unpublish(); advertise(false); }
      options.onProducerChange?.(elected);
    }
    if (elected) publish();
    else if (prepared && !leader) options.onStatus("Для общего голоса нужен участник, включивший озвучивание канала на этом языке.");
    subscribe(leader);
  }
  function reconnected(): void {
    if (closed || !prepared) return;
    advertise(false);
    update();
  }
  const receive = (bytes: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (closed || !prepared || !connected(room) || topic !== TOPIC || !participant || bytes.length > 2_048
      || room.remoteParticipants.get(participant.identity) !== participant || selectLanguageProducer(roster(room), language) !== participant.identity) return;
    const now = Date.now();
    if (now - rate.startedAt > 10_000) rate = { startedAt: now, count: 0 };
    if (++rate.count > 24) return;
    void openLanguageAudioCue(bytes, options.callId, participant.identity, language, options.getCaptionKeys(),
      key => options.getCaptionKeys().slice(0, 2).some(candidate => candidate.key === key.key)).then(cue => {
      if (!cue || closed || !connected(room) || room.remoteParticipants.get(participant.identity) !== participant
        || selectLanguageProducer(roster(room), language) !== participant.identity || cues.has(cue.id)) return;
      if (cues.size >= 256) cues.delete(cues.values().next().value!);
      cues.add(cue.id);
      if (cue.state === "end" && cue.segmentId !== remoteSegment) return;
      clearTimeout(cueTimer);
      if (cue.state === "start") {
        remoteSegment = cue.segmentId;
        ownCue = cue.speakerId === room.localParticipant.identity;
        remoteSpeaking = true;
      }
      applyRemoteGate();
      speaking();
      cueTimer = setTimeout(() => {
        ownCue = false; remoteSpeaking = false; remoteSegment = undefined;
        applyRemoteGate();
        speaking();
      }, cue.state === "start" ? cue.durationMs + 1_000 : 250);
    }).catch(() => undefined);
  };
  room.on(RoomEvent.DataReceived, receive);
  room.on(RoomEvent.ParticipantAttributesChanged, update);
  room.on(RoomEvent.ParticipantConnected, update);
  room.on(RoomEvent.ParticipantDisconnected, update);
  room.on(RoomEvent.TrackSubscribed, update);
  room.on(RoomEvent.TrackUnsubscribed, update);
  room.on(RoomEvent.TrackPublished, update);
  room.on(RoomEvent.TrackUnpublished, update);
  room.on(RoomEvent.TrackMuted, applyRemoteGate);
  room.on(RoomEvent.TrackUnmuted, applyRemoteGate);
  room.on(RoomEvent.AudioPlaybackStatusChanged, applyRemoteGate);
  room.on(RoomEvent.Connected, reconnected);
  room.on(RoomEvent.Disconnected, update);
  room.on(RoomEvent.ConnectionStateChanged, update);
  room.on(RoomEvent.Reconnected, reconnected);

  return {
    async prepareFromGesture(): Promise<void> {
      if (closed) throw new Error("Языковой канал выключен.");
      if (!context) {
        context = new AudioContext({ latencyHint: "playback" });
        localGain = context.createGain();
        localGain.gain.value = deafened ? 0 : 1;
        localGain.connect(context.destination);
      }
      const unlocking = context.resume();
      void room.startAudio().catch(() => undefined);
      prepared = true;
      advertise(false);
      update();
      await unlocking;
    },
    offer(caption, playback = {}): void {
      const segmentKey = `${caption.speakerId}:${caption.id}`;
      if (!isProducer() || caption.language !== language || !UUID.test(caption.id) || seen.has(segmentKey)
        || !caption.text.trim() || caption.text.length > 600 || Date.now() - caption.receivedAt > 15_000) return;
      if (seen.size >= 256) seen.delete(seen.values().next().value!);
      seen.add(segmentKey);
      if (pending) options.metrics?.drop();
      pending = { caption, playLocally: playback.playLocally ?? caption.speakerId !== room.localParticipant.identity };
      speakPending();
    },
    isProducer,
    setDeafened(value): void {
      deafened = value;
      if (localGain) localGain.gain.value = value ? 0 : 1;
      applyRemoteGate();
      speaking();
    },
    async checkSound(text): Promise<void> {
      if (closed || deafened) return;
      if (context) await context.resume();
      if (!isProducer()) {
        // A weak listener tests playback without downloading its own TTS model.
        if (!context || !localGain) return;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 660;
        gain.gain.value = 0.06;
        oscillator.connect(gain); gain.connect(localGain);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); localSpeaking = false; speaking(); };
        localSpeaking = true; speaking();
        oscillator.start(); oscillator.stop(context.currentTime + 0.15);
        if (element) void element.play().catch(() => undefined);
        options.onStatus("Звук включён · пробный сигнал воспроизведён на этом устройстве");
        return;
      }
      const voice = ensureSpeech();
      await voice.prepare();
      if (closed || deafened) return;
      // An explicit sound check is local, never broadcast into the shared call.
      voice.speak(text, { playLocally: true, output: null });
      if (element) void element.play().catch(() => undefined);
    },
    retry(): void { if (!closed) { failed = false; advertise(false); update(); } },
    close(): void {
      if (closed) return;
      closed = true;
      producer = false;
      unpublish(); detach();
      advertise(false);
      room.off(RoomEvent.DataReceived, receive);
      room.off(RoomEvent.ParticipantAttributesChanged, update);
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
      room.off(RoomEvent.TrackSubscribed, update);
      room.off(RoomEvent.TrackUnsubscribed, update);
      room.off(RoomEvent.TrackPublished, update);
      room.off(RoomEvent.TrackUnpublished, update);
      room.off(RoomEvent.TrackMuted, applyRemoteGate);
      room.off(RoomEvent.TrackUnmuted, applyRemoteGate);
      room.off(RoomEvent.AudioPlaybackStatusChanged, applyRemoteGate);
      room.off(RoomEvent.Connected, reconnected);
      room.off(RoomEvent.Disconnected, update);
      room.off(RoomEvent.ConnectionStateChanged, update);
      room.off(RoomEvent.Reconnected, reconnected);
      options.onProducerChange?.(false);
      options.onSpeakingChange(false);
      seen.clear(); cues.clear();
      localGain?.disconnect();
      void context?.close().catch(() => undefined);
      context = undefined;
    },
  };
}
