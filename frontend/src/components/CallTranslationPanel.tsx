import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParticipantTracks, useRoomContext } from "@livekit/components-react";
import { Track } from "livekit-client";
import { Languages, Volume2 } from "lucide-react";
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from "../lib/translation/protocol";
import { startTranslationSession } from "../lib/translation/session";
import "./call-translation.css";

interface TranslationCaption {
  id: string;
  speakerId: string;
  text: string;
  receivedAt: number;
}

interface CallTranslationPanelProps {
  callId: string;
  connected: boolean;
  microphoneEnabled: boolean;
  deafened: boolean;
}

export default function CallTranslationPanel({ callId, connected, microphoneEnabled, deafened }: CallTranslationPanelProps) {
  const room = useRoomContext();
  const microphoneTracks = useParticipantTracks([Track.Source.Microphone], room.localParticipant.identity);
  const publication = microphoneTracks[0]?.publication;
  const track = microphoneEnabled && !publication?.isMuted ? publication?.track?.mediaStreamTrack ?? null : null;
  const [enabled, setEnabled] = useState(false);
  const [recognize, setRecognize] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState<TranslationLanguage>("ru");
  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>("ru");
  const [spoken, setSpoken] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [captions, setCaptions] = useState<TranslationCaption[]>([]);
  const sessionRef = useRef<ReturnType<typeof startTranslationSession> | null>(null);
  const captionsRef = useRef<HTMLDivElement>(null);
  const followCaptions = useRef(true);
  const trackRef = useRef(track);
  trackRef.current = track;
  const settingsId = useId();
  const hintId = useId();
  const speech = useRef<{ current: SpeechSynthesisUtterance | null; pending: string | null; timer?: ReturnType<typeof setTimeout> }>({ current: null, pending: null });
  const localVoice = voices.find(voice => voice.localService && voice.lang.toLowerCase().split(/[-_]/)[0] === targetLanguage);
  const speechOptionsRef = useRef({ enabled, connected, spoken, deafened, localVoice, targetLanguage });
  speechOptionsRef.current = { enabled, connected, spoken, deafened, localVoice, targetLanguage };

  const syncRecognitionTrack = useCallback(() => {
    const options = speechOptionsRef.current;
    sessionRef.current?.setMicrophoneTrack(options.enabled && options.connected && !speech.current.current ? trackRef.current : null);
  }, []);

  const cancelSpeech = useCallback(() => {
    const current = speech.current.current;
    if (current) {
      current.onend = null;
      current.onerror = null;
    }
    clearTimeout(speech.current.timer);
    speech.current = { current: null, pending: null };
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    syncRecognitionTrack();
  }, [syncRecognitionTrack]);

  const speak = useCallback(function speakNext(text: string) {
    const options = speechOptionsRef.current;
    if (!options.enabled || !options.connected || !options.spoken || options.deafened || !options.localVoice || !("speechSynthesis" in window)) return;
    if (speech.current.current) {
      // Keep only the newest waiting phrase if synthesis cannot keep up.
      speech.current.pending = text;
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = options.localVoice;
    utterance.lang = options.localVoice.lang;
    speech.current.current = utterance;
    // Capturing only the local microphone still hears loudspeaker playback.
    // Pause recognition so translated speech cannot be sent around the call.
    syncRecognitionTrack();
    const finish = () => {
      if (speech.current.current !== utterance) return;
      clearTimeout(speech.current.timer);
      utterance.onend = null;
      utterance.onerror = null;
      const next = speech.current.pending;
      speech.current = { current: null, pending: null };
      if (next) speakNext(next);
      syncRecognitionTrack();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // Some platform voices omit completion callbacks. Never let an old phrase
    // block newer captions indefinitely.
    speech.current.timer = setTimeout(() => {
      if (speech.current.current !== utterance) return;
      utterance.onend = null;
      utterance.onerror = null;
      window.speechSynthesis.cancel();
      finish();
    }, 15_000);
    try { window.speechSynthesis.speak(utterance); }
    catch { finish(); }
  }, [syncRecognitionTrack]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);

  useEffect(() => {
    cancelSpeech();
    return cancelSpeech;
  }, [enabled, spoken, deafened, targetLanguage, callId, connected, cancelSpeech]);

  useEffect(() => {
    setCaptions([]);
    followCaptions.current = true;
    setError("");
    setDropped(0);
    if (!enabled || !connected) {
      setStatus(enabled ? "Ожидаем соединения со звонком…" : "");
      return;
    }
    let active = true;
    setStatus("Подготавливаем локальные модели…");
    const session = startTranslationSession({
      room,
      callId,
      sourceLanguage,
      targetLanguage,
      recognize,
      onStatus: (message: string) => { if (active) setStatus(message); },
      onError: (message: string) => { if (active) { setError(message); cancelSpeech(); } },
      onDropped: () => { if (active) setDropped(count => count + 1); },
      onCaption: (caption: TranslationCaption) => {
        if (!active) return;
        setCaptions(previous => [...previous, caption].slice(-8));
        if (caption.speakerId !== room.localParticipant.identity) speak(caption.text);
      },
    });
    sessionRef.current = session;
    syncRecognitionTrack();
    return () => {
      active = false;
      sessionRef.current = null;
      session.close();
      cancelSpeech();
    };
  }, [enabled, connected, room, callId, sourceLanguage, targetLanguage, recognize, retryAttempt, speak, cancelSpeech, syncRecognitionTrack]);

  useEffect(() => {
    syncRecognitionTrack();
  }, [track, syncRecognitionTrack]);

  useEffect(() => {
    const element = captionsRef.current;
    if (element && followCaptions.current) element.scrollTop = element.scrollHeight;
  }, [captions]);

  const participantName = (identity: string) => identity === room.localParticipant.identity
    ? "Ты"
    : room.remoteParticipants.get(identity)?.name || "Участник";

  return <section className="call-translation" aria-label="Живой перевод">
    <div className="call-translation-heading">
      <span><Languages size={17} aria-hidden="true" /><strong>Живой перевод</strong><small>На устройстве</small></span>
      <button type="button" className="call-translation-toggle" aria-pressed={enabled} onClick={() => setEnabled(value => !value)}>
        {enabled ? "Выключить перевод" : "Включить перевод"}
      </button>
    </div>
    {!enabled && <p className="call-translation-hint">{targetLanguage === "en" && !recognize
      ? "Английские субтитры принимаются без загрузки моделей."
      : "Первое включение скачает модели на это устройство. Перевод работает локально."}</p>}
      <details className="call-translation-settings">
        <summary>Языки, моя речь и озвучивание</summary>
        <div className="call-translation-language-fields">
          <label htmlFor={`${settingsId}-target`}>Переводить на
            <select id={`${settingsId}-target`} value={targetLanguage} onChange={event => setTargetLanguage(event.target.value as TranslationLanguage)}>
              {TRANSLATION_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
            </select>
          </label>
          <label htmlFor={`${settingsId}-source`}>Я говорю на
            <select id={`${settingsId}-source`} value={sourceLanguage} disabled={!recognize} onChange={event => setSourceLanguage(event.target.value as TranslationLanguage)}>
              {TRANSLATION_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
            </select>
          </label>
        </div>
        <label className="call-translation-checkbox">
          <input type="checkbox" checked={recognize} onChange={event => setRecognize(event.target.checked)} aria-describedby={hintId} />
          Распознавать и передавать мою речь участникам
        </label>
        <p id={hintId} className="call-translation-hint">Без этой опции устройство только принимает перевод — это легче для слабых устройств. Для перевода собеседника он должен включить распознавание у себя.</p>
        <label className="call-translation-checkbox">
          <input type="checkbox" checked={spoken} disabled={!localVoice} onChange={event => setSpoken(event.target.checked)} />
          <Volume2 size={14} aria-hidden="true" /> Озвучивать перевод локальным голосом
        </label>
        {localVoice && <p className="call-translation-hint">Во время озвучивания распознавание микрофона приостанавливается, чтобы перевод не повторял сам себя.</p>}
        {!localVoice && <p className="call-translation-hint">На устройстве нет локального голоса для выбранного языка. Доступны субтитры.</p>}
        <p className="call-translation-hint">Модели скачиваются при первом использовании языка. На слабом устройстве перевод может отставать от речи.</p>
      </details>
    {enabled && <>
      {!recognize && <p className="call-translation-hint">Только приём субтитров. Чтобы собеседники получали перевод твоей речи, включи её распознавание в настройках.</p>}
      <div className="call-translation-status" role={error ? "alert" : "status"}>
        {error || status}
        {error && <button type="button" className="call-translation-toggle call-translation-retry" onClick={() => setRetryAttempt(value => value + 1)}>Повторить</button>}
        {recognize && !track && <span>Микрофон выключен: твоя речь не распознаётся.</span>}
        {deafened && spoken && <span>Озвучивание приостановлено вместе со звуком звонка.</span>}
        {dropped > 0 && <span>Устройство не успевает: пропущено фрагментов — {dropped}. Можно выключить распознавание своей речи.</span>}
      </div>
      <div className="call-translation-captions" ref={captionsRef} onScroll={event => {
        const element = event.currentTarget;
        followCaptions.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }} role="log" aria-label="Переведённые субтитры" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {captions.length ? captions.map(caption => <p key={`${caption.speakerId}:${caption.id}`}>
          <strong>{participantName(caption.speakerId)}</strong><span>{caption.text}</span>
        </p>) : <p className="call-translation-empty">Субтитры появятся, когда участник с включённым распознаванием начнёт говорить. Речь переводится через английский; возможны ошибки.</p>}
      </div>
    </>}
  </section>;
}
