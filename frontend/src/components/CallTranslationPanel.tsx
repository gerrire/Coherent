import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParticipantTracks, useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import { Activity, Languages, Volume2 } from "lucide-react";
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from "../lib/translation/protocol";
import { TRANSLATION_MODELS, getModelProfile, resolveModelChoice, type TranslationModelChoice } from "../lib/translation/models";
import { createTranslationMetrics, readBrowserResources } from "../lib/translation/metrics";
import { getGigaChatConfiguration, type GigaChatConfiguration, type TranslationMethod } from "../lib/translation/cloudTranslation";
import { createSharedLanguageAudio } from "../lib/translation/sharedLanguageAudio";
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
  const [method, setMethod] = useState<TranslationMethod>("local");
  const [cloudConsent, setCloudConsent] = useState(false);
  const [channelProducer, setChannelProducer] = useState(() => (hardware.deviceMemoryGB ?? 0) >= 8 && (hardware.logicalProcessors ?? 0) > 4);
  const [cloudConfiguration, setCloudConfiguration] = useState<GigaChatConfiguration | null>(null);
  const [cloudConfigurationError, setCloudConfigurationError] = useState("");
  const autoModel = resolveModelChoice("auto", { deviceMemoryGB: hardware.deviceMemoryGB ?? undefined, logicalCores: hardware.logicalProcessors ?? undefined });
  const model = modelChoice === "auto" ? autoModel : modelChoice;
  const modelProfile = getModelProfile(model);
  const [metrics] = useState(createTranslationMetrics);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState<TranslationLanguage>("ru");
  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>("ru");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [providerError, setProviderError] = useState("");
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
  const sharedAudioRef = useRef<ReturnType<typeof createSharedLanguageAudio> | null>(null);
  const voicePlayingRef = useRef(false);
  const voiceRequestGeneration = useRef(0);
  const captionsRef = useRef<HTMLDivElement>(null);
  const followCaptions = useRef(true);
  const trackRef = useRef(track);
  trackRef.current = track;
  const keysRef = useRef(captionKeys);
  keysRef.current = captionKeys;
  const optionsRef = useRef({ enabled, connected, spoken, deafened, recognize, targetLanguage, method });
  optionsRef.current = { enabled, connected, spoken, deafened, recognize, targetLanguage, method };
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
    sharedAudioRef.current?.setDeafened(true);
    voicePlayingRef.current = false;
    setVoicePlaying(false);
    syncRecognitionTrack();
  }, [syncRecognitionTrack]);

  const closeSharedAudio = useCallback(() => {
    const previous = sharedAudioRef.current;
    sharedAudioRef.current = null;
    previous?.close();
    voicePlayingRef.current = false;
    setVoicePlaying(false);
    syncRecognitionTrack();
  }, [syncRecognitionTrack]);

  const ensureSharedAudio = useCallback((language = targetLanguage, producer = channelProducer) => {
    if (sharedAudioRef.current) return sharedAudioRef.current;
    let controller: ReturnType<typeof createSharedLanguageAudio>;
    controller = createSharedLanguageAudio({
      room, callId, language, producer, deafened,
      getCaptionKeys: () => keysRef.current, metrics,
      onStatus: message => { if (sharedAudioRef.current === controller) setVoiceStatus(message); },
      onError: message => { if (sharedAudioRef.current === controller) setVoiceError(message); },
      onSpeakingChange: speaking => {
        if (sharedAudioRef.current !== controller) return;
        voicePlayingRef.current = speaking;
        setVoicePlaying(speaking);
        syncRecognitionTrack();
      },
    });
    sharedAudioRef.current = controller;
    return controller;
  }, [room, callId, targetLanguage, channelProducer, deafened, metrics, syncRecognitionTrack]);

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
      sessionRef.current?.close();
      setEnabled(false);
      closeVoice();
      closeSharedAudio();
      return;
    }
    if (method === "gigachat" && (!cloudConfiguration?.configured || !cloudConfiguration.enabled || (recognize && !cloudConsent))) return;
    optionsRef.current.enabled = true;
    setEnabled(true);
    setVoiceError("");
    setVoiceStatus("");
    if (spoken && method === "gigachat") {
      void ensureSharedAudio().prepareFromGesture().catch(() => undefined);
    } else if (spoken) {
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
    if (!next) { closeVoice(); closeSharedAudio(); return; }
    if (enabled && method === "gigachat") {
      void ensureSharedAudio().prepareFromGesture().catch(() => undefined);
      return;
    }
    if (enabled) {
      const controller = ensureVoice(targetLanguage, downloadedVoice);
      void controller.prepare().catch(() => undefined);
    }
  }

  function changeTargetLanguage(language: TranslationLanguage): void {
    optionsRef.current.targetLanguage = language;
    closeVoice();
    closeSharedAudio();
    setTargetLanguage(language);
    setVoiceError("");
    setVoiceStatus("");
    if (enabled && spoken && method === "gigachat") {
      void ensureSharedAudio(language).prepareFromGesture().catch(() => undefined);
      return;
    }
    if (enabled && spoken && method === "local") {
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
    if (method === "gigachat") {
      const controller = ensureSharedAudio();
      void controller.prepareFromGesture().then(() => controller.checkSound(SOUND_TEST[targetLanguage])).catch(() => undefined);
      return;
    }
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
    if (enabled && spoken && method === "gigachat") {
      const controller = ensureSharedAudio();
      controller.setDeafened(deafened);
      controller.retry();
      void controller.prepareFromGesture().catch(() => undefined);
      return;
    }
    if (enabled && spoken) {
      const controller = ensureVoice(targetLanguage, downloadedVoice);
      void controller.prepare().catch(() => undefined);
    }
  }

  useEffect(() => {
    if (!enabled || !spoken || method !== "local") closeVoice();
    if (!enabled || !spoken || method !== "gigachat") closeSharedAudio();
  }, [enabled, spoken, method, closeVoice, closeSharedAudio]);

  useEffect(() => {
    if (enabled && connected && spoken && method === "gigachat") {
      const controller = ensureSharedAudio();
      controller.setDeafened(deafened);
    }
  }, [enabled, connected, spoken, method, ensureSharedAudio, deafened]);

  useEffect(() => {
    if (deafened || !connected) cancelVoice();
    sharedAudioRef.current?.setDeafened(deafened || !connected);
  }, [deafened, connected, cancelVoice]);

  useEffect(() => () => { closeVoice(); closeSharedAudio(); }, [closeVoice, closeSharedAudio]);

  useEffect(() => {
    setCloudConfiguration(null);
    setCloudConfigurationError("");
    if (method !== "gigachat" || !connected) return;
    let active = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    void getGigaChatConfiguration(callId, abort.signal).then(configuration => {
      if (active) setCloudConfiguration(configuration);
    }).catch(() => {
      if (active) setCloudConfigurationError("Не удалось проверить GigaChat. Серверу требуется актуальная версия и настройка доступа к API.");
    }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); abort.abort(); };
  }, [method, connected, callId, retryAttempt]);

  function changeMethod(next: TranslationMethod): void {
    optionsRef.current.enabled = false;
    sessionRef.current?.close();
    setEnabled(false);
    closeVoice();
    closeSharedAudio();
    setCloudConsent(false);
    setVoiceStatus("");
    setVoiceError("");
    setMethod(next);
  }

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
    setProviderError("");
    setDropped(0);
    setRecognitionReady(false);
    if (!enabled || !connected || (method === "gigachat" && (!cloudConfiguration?.configured || !cloudConfiguration.enabled))) {
      setStatus(enabled ? "Ожидаем соединения со звонком…" : "");
      return;
    }
    let active = true;
    setStatus(method === "gigachat" ? "Подготавливаем Silero и распознавание на устройстве…" : "Подготавливаем локальные модели…");
    const session = startTranslationSession({
      room, callId, sourceLanguage, targetLanguage, recognize, model, metrics, method, cloudConsent,
      getCaptionKeys: () => keysRef.current,
      onStatus: message => { if (active) setStatus(message); },
      onError: message => { if (active) { setError(message); setRecognitionReady(false); if (method === "local") cancelVoice(); } },
      onRecognitionReady: ready => { if (active) setRecognitionReady(ready); },
      onDropped: () => { if (active) setDropped(count => count + 1); },
      onProviderError: message => { if (active) setProviderError(message); },
      shouldTranslateLocalCaption: () => sharedAudioRef.current?.isProducer() === true,
      onTranslatedLocalCaption: caption => {
        if (active && optionsRef.current.enabled && optionsRef.current.spoken && caption.sourceLanguage && caption.sourceLanguage !== targetLanguage) {
          sharedAudioRef.current?.offer(caption, { playLocally: false });
        }
      },
      onLocalCaption: caption => { if (active) setLocalCaption(caption); },
      onCaption: caption => {
        if (!active || caption.speakerId === room.localParticipant.identity) return;
        if (caption.language === targetLanguage) setProviderError("");
        setCaptions(previous => [...previous, caption].slice(-8));
        setReceivedCount(count => count + 1);
        const options = optionsRef.current;
        if (!options.enabled || !options.connected || !options.spoken || caption.language !== options.targetLanguage) return;
        if (options.method === "gigachat") {
          if (caption.sourceLanguage && caption.sourceLanguage !== options.targetLanguage) {
            sharedAudioRef.current?.offer(caption, { playLocally: !options.deafened });
          }
        } else if (!options.deafened) {
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
      if (method === "local") cancelVoice();
    };
    // Caption keys rotate without resetting models, audio, or caption history.
  }, [enabled, connected, room, callId, sourceLanguage, targetLanguage, recognize, model, metrics, method, cloudConsent, cloudConfiguration, retryAttempt, cancelVoice, syncRecognitionTrack]);

  useEffect(() => { syncRecognitionTrack(); }, [track, syncRecognitionTrack]);

  useEffect(() => {
    const element = captionsRef.current;
    if (element && followCaptions.current) element.scrollTop = element.scrollHeight;
  }, [captions]);

  const participantName = (identity: string) => room.remoteParticipants.get(identity)?.name || "Участник";
  const readyPeers = peers.filter(peer => peer.version === "2" && peer.ready);
  const cloudBlocked = method === "gigachat" && (!cloudConfiguration?.configured || !cloudConfiguration.enabled || (recognize && !cloudConsent));

  return <section className="call-translation" aria-label="Живой перевод">
    <div className="call-translation-heading">
      <span><Languages size={17} aria-hidden="true" /><strong>Живой перевод</strong><small>{method === "local" ? "На устройстве" : "GigaChat · языковой канал"}</small></span>
      <div className="call-translation-heading-actions">
        <button type="button" className="call-translation-toggle call-translation-metrics-toggle" aria-expanded={metricsOpen} aria-controls={metricsId} onClick={() => setMetricsOpen(open => !open)}>
          <Activity size={14} aria-hidden="true" /> Метрики ПК
        </button>
        <button type="button" className="call-translation-toggle" disabled={!enabled && cloudBlocked} aria-pressed={enabled} onClick={toggleTranslation}>
          {enabled ? "Выключить перевод" : "Включить перевод"}
        </button>
      </div>
    </div>
    {!enabled && method === "local" && <p className="call-translation-hint">{recognize
      ? "Включение распознаёт твой микрофон на этом устройстве и передаёт текст участникам звонка. Перевод и озвучивание тоже работают локально."
      : "Включится только приём перевода собеседников, без распознавания твоего микрофона."} Первая загрузка моделей может занять несколько минут.</p>}
    {metricsOpen && <CallTranslationMetrics id={metricsId} metrics={metrics} model={model} recognize={recognize} method={method} />}
    <details className="call-translation-settings">
      <summary>Способ перевода, языки и озвучивание</summary>
      <label className="call-translation-method" htmlFor={`${settingsId}-method`}>Способ перевода
        <select id={`${settingsId}-method`} value={method} onChange={event => changeMethod(event.target.value as TranslationMethod)}>
          <option value="local">Локальные модели · без отправки текста</option>
          <option value="gigachat">GigaChat API + Silero + языковые аудиоканалы</option>
        </select>
      </label>
      {method === "gigachat" && <div className="call-translation-cloud-notice">
        <p>Распознанный текст разрешённых фраз передаётся серверу Coherent и GigaChat. Аудио микрофона и ключи звонка туда не отправляются. Silero, распознавание и Piper работают на устройствах участников.</p>
        <p>Для каждого языка выбирается одно устройство озвучивания. Остальные слушатели получают его зашифрованный аудиоканал.</p>
        {!connected && <p>Подключись к звонку, чтобы проверить доступность GigaChat.</p>}
        {connected && !cloudConfiguration && !cloudConfigurationError && <p>Проверяем настройку GigaChat…</p>}
        {cloudConfigurationError && <p role="alert">{cloudConfigurationError}</p>}
        {cloudConfiguration && (!cloudConfiguration.enabled || !cloudConfiguration.configured) && <p role="status">GigaChat пока не настроен администратором: нужны ключ доступа, доверенный сертификат и доступ сервера к API. Модели на VPS устанавливать не требуется.</p>}
        {cloudConfiguration?.configured && cloudConfiguration.enabled && <p>Настройки GigaChat заданы · {cloudConfiguration.model}. Подключение проверяется при переводе фразы.</p>}
        {(cloudConfigurationError || (cloudConfiguration && !cloudConfiguration.configured)) && <button type="button" className="call-translation-toggle" onClick={() => setRetryAttempt(value => value + 1)}>Проверить доступность снова</button>}
        <label className="call-translation-checkbox">
          <input type="checkbox" checked={cloudConsent} onChange={event => {
            setCloudConsent(event.target.checked);
            if (!event.target.checked && enabled && recognize) {
              optionsRef.current.enabled = false;
              sessionRef.current?.close();
              setEnabled(false);
              closeVoice(); closeSharedAudio();
            }
          }} />
          Разрешаю передавать текст моих фраз в GigaChat для перевода
        </label>
        {recognize && !cloudConsent && <p>Для передачи своей речи в этом режиме сначала нужно согласие выше.</p>}
        <label className="call-translation-checkbox">
          <input type="checkbox" checked={channelProducer} onChange={event => {
            closeSharedAudio();
            setChannelProducer(event.target.checked);
            if (enabled && spoken) void ensureSharedAudio(targetLanguage, event.target.checked).prepareFromGesture().catch(() => undefined);
          }} />
          Разрешить моему устройству озвучивать языковой канал
        </label>
        <p>На слабом устройстве эту опцию можно отключить. Хотя бы один слушатель каждого языка должен разрешить озвучивание.</p>
      </div>}
      <div className="call-translation-language-fields">
        <label htmlFor={`${settingsId}-source`}>Я говорю на
          <select id={`${settingsId}-source`} value={sourceLanguage} disabled={!recognize} onChange={event => setSourceLanguage(event.target.value as TranslationLanguage)}>
            {TRANSLATION_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select>
        </label>
        <label htmlFor={`${settingsId}-target`}>Слушаю перевод на
          <select id={`${settingsId}-target`} value={targetLanguage} onChange={event => changeTargetLanguage(event.target.value as TranslationLanguage)}>
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
      <p className="call-translation-hint">«Я говорю на» задаёт язык твоего микрофона. «Слушаю перевод на» — язык речи собеседников для тебя. Каждый говорящий выбирает собственный язык у себя.</p>
      <p className="call-translation-hint">{modelProfile.description}. {modelProfile.hardwareHint}. Веса: около {Math.round(modelProfile.weightBytes / 1_000_000)} МБ; память при работе требуется дополнительно. {modelChoice === "auto" && "Автовыбор опирается на доступные браузеру характеристики и не выбирает Small."}</p>
      {modelChoice === "small" && <p className="call-translation-hint">Small требует больше времени и памяти. Если обработка не успевает за речью, выбери Base или Tiny. Смена модели перезапустит только перевод.</p>}
      <label className="call-translation-checkbox">
        <input type="checkbox" checked={recognize} onChange={event => {
          optionsRef.current.recognize = event.target.checked;
          setRecognize(event.target.checked);
          if (event.target.checked && method === "gigachat" && !cloudConsent) {
            optionsRef.current.enabled = false;
            sessionRef.current?.close();
            setEnabled(false);
            closeSharedAudio();
          }
          syncRecognitionTrack();
        }} aria-describedby={hintId} />
        Распознавать и передавать мою речь участникам
      </label>
      <p id={hintId} className="call-translation-hint">Для перевода в обе стороны каждому участнику нужно включить перевод. На слабом устройстве можно оставить только приём субтитров.</p>
      <label className="call-translation-checkbox">
        <input type="checkbox" checked={spoken} onChange={event => changeSpoken(event.target.checked)} />
        <Volume2 size={14} aria-hidden="true" /> Озвучивать перевод собеседников
      </label>
      {method === "local" && targetLanguage === "ru" && <label className="call-translation-checkbox">
        <input type="checkbox" checked={downloadedVoice} onChange={event => changeDownloadedVoice(event.target.checked)} />
        Нейросетевой русский голос · загрузка около 63 МБ
      </label>}
      <p className="call-translation-hint">{method === "local" ? "Используется локальный голос системы. Если русского голоса нет, скачается голос для работы на устройстве — около 63 МБ. Для других языков нужен установленный локальный голос."
        : "В режиме языковых каналов Piper скачивается на выбранное устройство озвучивания. Файлы голоса могут занимать около 63 МБ; слушателям модель голоса не требуется."}</p>
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
      <div className="call-translation-status" role={error || providerError ? "alert" : "status"}>
        {error || providerError || status}
        {(error || providerError) && <button type="button" className="call-translation-toggle call-translation-retry" onClick={retryTranslation}>Повторить перевод</button>}
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
          <strong>{participantName(caption.speakerId)}{caption.language !== targetLanguage ? " · исходная речь" : ""}</strong><span>{caption.text}</span>
        </p>) : <p className="call-translation-empty">Здесь появится перевод речи собеседников. Свою речь ты увидишь только при включении отдельной опции выше.</p>}
      </div>
      {showOwn && localCaption && <p className="call-translation-own"><strong>Ты · исходная речь</strong><span>{localCaption.text}</span></p>}
    </>}
  </section>;
}
