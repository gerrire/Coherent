import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParticipantTracks, useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import { Activity, Languages, Volume2 } from "lucide-react";
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from "../lib/translation/protocol";
import { TRANSLATION_MODELS, getModelProfile, resolveModelChoice, type TranslationModelChoice } from "../lib/translation/models";
import { createTranslationMetrics, readBrowserResources } from "../lib/translation/metrics";
import { startTranslationSession } from "../lib/translation/session";
import { createLocalSpeech, type LocalSpeech } from "../lib/translation/speech";
import type { Caption, CaptionKey } from "../lib/translation/transport";
import CallTranslationMetrics from "./CallTranslationMetrics";
import "./call-translation.css";

interface CallTranslationPanelProps {
  callId: string;
  connected: boolean;
  microphoneEnabled: boolean;
  deafened: boolean;
  captionKeys: readonly CaptionKey[];
}

interface TranslationPeer {
  identity: string;
  name: string;
  version: string | undefined;
  ready: boolean;
}

const SOUND_TEST: Record<TranslationLanguage, string> = {
  ru: "Это проверка звука перевода.",
  en: "This is a translation audio test.",
  de: "Dies ist ein Audiotest für die Übersetzung.",
  fr: "Ceci est un test audio de traduction.",
  es: "Esta es una prueba de audio de traducción.",
};

export default function CallTranslationPanel({ callId, connected, microphoneEnabled, deafened, captionKeys }: CallTranslationPanelProps) {
  const room = useRoomContext();
  const microphoneTracks = useParticipantTracks([Track.Source.Microphone], room.localParticipant.identity);
  const publication = microphoneTracks[0]?.publication;
  const track = microphoneEnabled && !publication?.isMuted ? publication?.track?.mediaStreamTrack ?? null : null;
  const [enabled, setEnabled] = useState(false);
  const [recognize, setRecognize] = useState(true);
  const [spoken, setSpoken] = useState(true);
  const [downloadedVoice, setDownloadedVoice] = useState(false);
  const [showOwn, setShowOwn] = useState(false);
  const [modelChoice, setModelChoice] = useState<TranslationModelChoice>("auto");
  const [hardware] = useState(readBrowserResources);
  const autoModel = resolveModelChoice("auto", { deviceMemoryGB: hardware.deviceMemoryGB ?? undefined, logicalCores: hardware.logicalProcessors ?? undefined });
  const model = modelChoice === "auto" ? autoModel : modelChoice;
  const modelProfile = getModelProfile(model);
  const [metrics] = useState(createTranslationMetrics);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState<TranslationLanguage>("ru");
  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>("ru");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [recognitionReady, setRecognitionReady] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [receivedCount, setReceivedCount] = useState(0);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [localCaption, setLocalCaption] = useState<Caption | null>(null);
  const [peers, setPeers] = useState<TranslationPeer[]>([]);
  const sessionRef = useRef<ReturnType<typeof startTranslationSession> | null>(null);
  const voiceRef = useRef<{ language: TranslationLanguage; downloadedVoice: boolean; controller: LocalSpeech } | null>(null);
  const voicePlayingRef = useRef(false);
  const voiceRequestGeneration = useRef(0);
  const captionsRef = useRef<HTMLDivElement>(null);
  const followCaptions = useRef(true);
  const trackRef = useRef(track);
  trackRef.current = track;
  const keysRef = useRef(captionKeys);
  keysRef.current = captionKeys;
  const optionsRef = useRef({ enabled, connected, spoken, deafened, recognize, targetLanguage });
  optionsRef.current = { enabled, connected, spoken, deafened, recognize, targetLanguage };
  const settingsId = useId();
  const hintId = useId();
  const metricsId = useId();

  const syncRecognitionTrack = useCallback(() => {
    const options = optionsRef.current;
    sessionRef.current?.setMicrophoneTrack(options.enabled && options.connected && options.recognize && !voicePlayingRef.current
      ? trackRef.current : null);
  }, []);

  const cancelVoice = useCallback(() => {
    voiceRequestGeneration.current++;
    voiceRef.current?.controller.cancel();
    voicePlayingRef.current = false;
    setVoicePlaying(false);
    syncRecognitionTrack();
  }, [syncRecognitionTrack]);

  const closeVoice = useCallback(() => {
    voiceRequestGeneration.current++;
    const previous = voiceRef.current;
    voiceRef.current = null;
    previous?.controller.close();
    voicePlayingRef.current = false;
    setVoicePlaying(false);
    syncRecognitionTrack();
  }, [syncRecognitionTrack]);

  const ensureVoice = useCallback((language: TranslationLanguage, preferDownload: boolean): LocalSpeech => {
    const useDownload = language === "ru" && preferDownload;
    if (voiceRef.current?.language === language && voiceRef.current.downloadedVoice === useDownload) return voiceRef.current.controller;
    closeVoice();
    let controller: LocalSpeech;
    controller = createLocalSpeech({
      language,
      metrics,
      downloadedVoice: useDownload,
      onStatus: message => { if (voiceRef.current?.controller === controller) setVoiceStatus(message); },
      onError: message => { if (voiceRef.current?.controller === controller) setVoiceError(message); },
      onSpeakingChange: speaking => {
        if (voiceRef.current?.controller !== controller) return;
        voicePlayingRef.current = speaking;
        setVoicePlaying(speaking);
        syncRecognitionTrack();
      },
    });
    voiceRef.current = { language, downloadedVoice: useDownload, controller };
    return controller;
  }, [closeVoice, syncRecognitionTrack, metrics]);

  function toggleTranslation(): void {
    if (enabled) {
      optionsRef.current.enabled = false;
      setEnabled(false);
      closeVoice();
      return;
    }
    optionsRef.current.enabled = true;
    setEnabled(true);
    setVoiceError("");
    setVoiceStatus("");
    if (spoken) {
      const controller = ensureVoice(targetLanguage, downloadedVoice);
      // The initiating gesture unlocks audio before waiting for model downloads.
      void controller.prepare().catch(() => undefined);
    }
  }

  function changeSpoken(next: boolean): void {
    optionsRef.current.spoken = next;
    setSpoken(next);
    setVoiceError("");
    setVoiceStatus("");
    if (!next) { closeVoice(); return; }
    if (enabled) {
      const controller = ensureVoice(targetLanguage, downloadedVoice);
      void controller.prepare().catch(() => undefined);
    }
  }

  function changeTargetLanguage(language: TranslationLanguage): void {
    optionsRef.current.targetLanguage = language;
    closeVoice();
    setTargetLanguage(language);
    setVoiceError("");
    setVoiceStatus("");
    if (enabled && spoken) {
      const controller = ensureVoice(language, downloadedVoice);
      void controller.prepare().catch(() => undefined);
    }
  }

  function changeDownloadedVoice(next: boolean): void {
    closeVoice();
    setDownloadedVoice(next);
    setVoiceError("");
    setVoiceStatus("");
    if (enabled && spoken) {
      const controller = ensureVoice(targetLanguage, next);
      void controller.prepare().catch(() => undefined);
    }
  }

  function checkSound(): void {
    if (!enabled || !spoken || deafened || !connected) return;
    setVoiceError("");
    const controller = ensureVoice(targetLanguage, downloadedVoice);
    const generation = ++voiceRequestGeneration.current;
    void controller.prepare().then(() => {
      const options = optionsRef.current;
      if (generation === voiceRequestGeneration.current && voiceRef.current?.controller === controller
        && options.enabled && options.connected && options.spoken && !options.deafened) {
        controller.speak(SOUND_TEST[targetLanguage]);
      }
    }).catch(() => undefined);
  }

  function retryTranslation(): void {
    cancelVoice();
    setRetryAttempt(value => value + 1);
    if (enabled && spoken) {
      const controller = ensureVoice(targetLanguage, downloadedVoice);
      void controller.prepare().catch(() => undefined);
    }
  }

  useEffect(() => {
    if (!enabled || !spoken) closeVoice();
  }, [enabled, spoken, closeVoice]);

  useEffect(() => {
    if (deafened || !connected) cancelVoice();
  }, [deafened, connected, cancelVoice]);

  useEffect(() => () => closeVoice(), [closeVoice]);

  useEffect(() => {
    const update = () => setPeers([...room.remoteParticipants.values()].map(participant => ({
      identity: participant.identity,
      name: participant.name || "Участник",
      version: participant.attributes["coherent.translation.version"],
      ready: participant.attributes["coherent.translation.ready"] === "true",
    })));
    update();
    room.on(RoomEvent.ParticipantAttributesChanged, update);
    room.on(RoomEvent.ParticipantConnected, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    room.on(RoomEvent.Connected, update);
    room.on(RoomEvent.Disconnected, update);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, update);
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
      room.off(RoomEvent.Connected, update);
      room.off(RoomEvent.Disconnected, update);
    };
  }, [room]);

  useEffect(() => {
    const advertise = () => {
      void room.localParticipant.setAttributes({
        "coherent.translation.version": "2",
        "coherent.translation.ready": enabled && recognize && recognitionReady && connected ? "true" : "false",
      }).catch(() => undefined);
    };
    advertise();
    room.on(RoomEvent.Connected, advertise);
    return () => { room.off(RoomEvent.Connected, advertise); };
  }, [room, enabled, recognize, recognitionReady, connected]);

  useEffect(() => () => {
    void room.localParticipant.setAttributes({
      "coherent.translation.version": "2", "coherent.translation.ready": "false",
    }).catch(() => undefined);
  }, [room]);

  useEffect(() => {
    setCaptions([]);
    setLocalCaption(null);
    setReceivedCount(0);
    followCaptions.current = true;
    setError("");
    setDropped(0);
    setRecognitionReady(false);
    if (!enabled || !connected) {
      setStatus(enabled ? "Ожидаем соединения со звонком…" : "");
      return;
    }
    let active = true;
    setStatus("Подготавливаем локальные модели…");
    const session = startTranslationSession({
      room, callId, sourceLanguage, targetLanguage, recognize, model, metrics,
      getCaptionKeys: () => keysRef.current,
      onStatus: message => { if (active) setStatus(message); },
      onError: message => { if (active) { setError(message); setRecognitionReady(false); cancelVoice(); } },
      onRecognitionReady: ready => { if (active) setRecognitionReady(ready); },
      onDropped: () => { if (active) setDropped(count => count + 1); },
      onLocalCaption: caption => { if (active) setLocalCaption(caption); },
      onCaption: caption => {
        if (!active || caption.speakerId === room.localParticipant.identity) return;
        setCaptions(previous => [...previous, caption].slice(-8));
        setReceivedCount(count => count + 1);
        const options = optionsRef.current;
        if (options.enabled && options.connected && options.spoken && !options.deafened) {
          voiceRef.current?.controller.speak(caption.text);
        }
      },
    });
    sessionRef.current = session;
    syncRecognitionTrack();
    return () => {
      active = false;
      sessionRef.current = null;
      session.close();
      cancelVoice();
    };
    // Caption keys rotate without resetting models, audio, or caption history.
  }, [enabled, connected, room, callId, sourceLanguage, targetLanguage, recognize, model, metrics, retryAttempt, cancelVoice, syncRecognitionTrack]);

  useEffect(() => { syncRecognitionTrack(); }, [track, syncRecognitionTrack]);

  useEffect(() => {
    const element = captionsRef.current;
    if (element && followCaptions.current) element.scrollTop = element.scrollHeight;
  }, [captions]);

  const participantName = (identity: string) => room.remoteParticipants.get(identity)?.name || "Участник";
  const readyPeers = peers.filter(peer => peer.version === "2" && peer.ready);

  return <section className="call-translation" aria-label="Живой перевод">
    <div className="call-translation-heading">
      <span><Languages size={17} aria-hidden="true" /><strong>Живой перевод</strong><small>На устройстве</small></span>
      <div className="call-translation-heading-actions">
        <button type="button" className="call-translation-toggle call-translation-metrics-toggle" aria-expanded={metricsOpen} aria-controls={metricsId} onClick={() => setMetricsOpen(open => !open)}>
          <Activity size={14} aria-hidden="true" /> Метрики ПК
        </button>
        <button type="button" className="call-translation-toggle" aria-pressed={enabled} onClick={toggleTranslation}>
          {enabled ? "Выключить перевод" : "Включить перевод"}
        </button>
      </div>
    </div>
    {!enabled && <p className="call-translation-hint">{recognize
      ? "Включение распознаёт твой микрофон на этом устройстве и передаёт текст участникам звонка. Перевод и озвучивание тоже работают локально."
      : "Включится только приём перевода собеседников, без распознавания твоего микрофона."} Первая загрузка моделей может занять несколько минут.</p>}
    {metricsOpen && <CallTranslationMetrics id={metricsId} metrics={metrics} model={model} recognize={recognize} />}
    <details className="call-translation-settings">
      <summary>Языки, модели и озвучивание</summary>
      <div className="call-translation-language-fields">
        <label htmlFor={`${settingsId}-target`}>Переводить на
          <select id={`${settingsId}-target`} value={targetLanguage} onChange={event => changeTargetLanguage(event.target.value as TranslationLanguage)}>
            {TRANSLATION_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${settingsId}-source`}>Я говорю на
          <select id={`${settingsId}-source`} value={sourceLanguage} disabled={!recognize} onChange={event => setSourceLanguage(event.target.value as TranslationLanguage)}>
            {TRANSLATION_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${settingsId}-model`}>Модель распознавания
          <select id={`${settingsId}-model`} value={modelChoice} disabled={!recognize} onChange={event => setModelChoice(event.target.value as TranslationModelChoice)}>
            <option value="auto">Авто · {getModelProfile(autoModel).label}</option>
            {TRANSLATION_MODELS.map(profile => <option key={profile.id} value={profile.id}>{profile.label} · {Math.round(profile.weightBytes / 1_000_000)} МБ</option>)}
          </select>
        </label>
      </div>
      <p className="call-translation-hint">{modelProfile.description}. {modelProfile.hardwareHint}. Веса: около {Math.round(modelProfile.weightBytes / 1_000_000)} МБ; память при работе требуется дополнительно. {modelChoice === "auto" && "Автовыбор опирается на доступные браузеру характеристики и не выбирает Small."}</p>
      {modelChoice === "small" && <p className="call-translation-hint">Small требует больше времени и памяти. Если обработка не успевает за речью, выбери Base или Tiny. Смена модели перезапустит только перевод.</p>}
      <label className="call-translation-checkbox">
        <input type="checkbox" checked={recognize} onChange={event => {
          optionsRef.current.recognize = event.target.checked;
          setRecognize(event.target.checked);
          syncRecognitionTrack();
        }} aria-describedby={hintId} />
        Распознавать и передавать мою речь участникам
      </label>
      <p id={hintId} className="call-translation-hint">Для перевода в обе стороны каждому участнику нужно включить перевод. На слабом устройстве можно оставить только приём субтитров.</p>
      <label className="call-translation-checkbox">
        <input type="checkbox" checked={spoken} onChange={event => changeSpoken(event.target.checked)} />
        <Volume2 size={14} aria-hidden="true" /> Озвучивать перевод собеседников
      </label>
      {targetLanguage === "ru" && <label className="call-translation-checkbox">
        <input type="checkbox" checked={downloadedVoice} onChange={event => changeDownloadedVoice(event.target.checked)} />
        Нейросетевой русский голос · загрузка около 63 МБ
      </label>}
      <p className="call-translation-hint">Используется локальный голос системы. Если русского голоса нет, скачается голос для работы на устройстве — около 63 МБ. Для других языков нужен установленный локальный голос.</p>
      <div className="call-translation-voice-actions">
        <button type="button" className="call-translation-toggle" disabled={!enabled || !spoken || deafened || !connected} onClick={checkSound}>Проверить звук</button>
        {deafened && <span className="call-translation-hint">Включи звук звонка для проверки.</span>}
      </div>
      <label className="call-translation-checkbox">
        <input type="checkbox" checked={showOwn} onChange={event => setShowOwn(event.target.checked)} />
        Показывать мою исходную речь
      </label>
      <p className="call-translation-hint">Во время озвучивания распознавание микрофона приостанавливается, чтобы перевод не повторял сам себя. Возможны ошибки распознавания и перевода.</p>
    </details>
    {enabled && <>
      <div className="call-translation-status" role={error ? "alert" : "status"}>
        {error || status}
        {error && <button type="button" className="call-translation-toggle call-translation-retry" onClick={retryTranslation}>Повторить перевод</button>}
        {recognize && !track && <span>Микрофон выключен: твоя речь не распознаётся.</span>}
        {voicePlaying && recognize && <span>Распознавание своей речи приостановлено на время озвучивания.</span>}
        {!recognize && <span>Только приём: твоя речь не передаётся для перевода.</span>}
        {dropped > 0 && <span>Пропущено фрагментов — {dropped}. Если устройство не успевает, выбери экономное распознавание или только приём.</span>}
      </div>
      {spoken && <div className="call-translation-voice-status" role={voiceError ? "alert" : "status"}>
        {voiceError || voiceStatus}
        {voiceError && <button type="button" className="call-translation-toggle call-translation-retry" disabled={deafened || !connected} onClick={checkSound}>Проверить звук</button>}
        {deafened && <span>Озвучивание приостановлено вместе со звуком звонка.</span>}
      </div>}
      <div className="call-translation-peers" aria-label="Готовность собеседников">
        <p>Получено фраз от собеседников: {receivedCount}. {readyPeers.length > 0 && `Готовы: ${readyPeers.map(peer => peer.name).join(", ")}.`}</p>
        {peers.filter(peer => peer.version !== "2" || !peer.ready).map(peer => <p key={peer.identity}>
          <strong>{peer.name}:</strong> {peer.version !== "2"
            ? "нужно обновить страницу и включить перевод. После обновления клиента это нужно сделать обоим участникам."
            : "ожидаем включения перевода и загрузки распознавания на его устройстве."}
        </p>)}
        {peers.length === 0 && <p>Ожидаем собеседника с включённым переводом.</p>}
      </div>
      <div className="call-translation-captions" ref={captionsRef} onScroll={event => {
        const element = event.currentTarget;
        followCaptions.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }} role="log" aria-label="Перевод собеседников" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {captions.length ? captions.map(caption => <p key={`${caption.speakerId}:${caption.id}`}>
          <strong>{participantName(caption.speakerId)}</strong><span>{caption.text}</span>
        </p>) : <p className="call-translation-empty">Здесь появится перевод речи собеседников. Свою речь ты увидишь только при включении отдельной опции выше.</p>}
      </div>
      {showOwn && localCaption && <p className="call-translation-own"><strong>Ты · исходная речь</strong><span>{localCaption.text}</span></p>}
    </>}
  </section>;
}
