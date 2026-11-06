import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import { LocalVideoTrack, Track, type Room } from "livekit-client";
import MicrophoneCheck from "./MicrophoneCheck";
import { Settings2, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { supportedAudioProcessing, supportedVideoCodec, type AudioProcessingState, type MediaPreferences, type VideoCodec } from "../lib/media";

interface MediaSettingsPanelProps {
  room?: Room | null;
  media: MediaPreferences;
  audioProcessingState: AudioProcessingState | null;
  onChange: (patch: Partial<MediaPreferences>) => Promise<void>;
  onClose: () => void;
  embedded?: boolean;
}

const codecNames: Record<VideoCodec, string> = {
  vp8: "VP8",
  h264: "H.264",
  vp9: "VP9",
  av1: "AV1",
};

type VoiceProfile = "automatic" | "quiet" | "noisy";

const voiceProfileDescriptions: Record<VoiceProfile | "custom", string> = {
  automatic: "Доступная обработка браузера подавляет эхо и фон и выравнивает уровень голоса.",
  quiet: "Для тихой комнаты. Подавление эха включено, голос сохраняет естественную динамику.",
  noisy: "RNNoise выделяет речь на фоне шума, например вентилятора или клавиатуры.",
  custom: "Используются параметры из расширенных настроек.",
};

const rnnoiseProfiles = [
  ["natural", "Мягкий"],
  ["balanced", "Сбалансированный"],
  ["strong", "Сильный"],
] as const;

export default function MediaSettingsPanel({ media, audioProcessingState, onChange, onClose, embedded = false, room: providedRoom }: MediaSettingsPanelProps) {
  const contextRoom = useMaybeRoomContext();
  const room = contextRoom ?? providedRoom;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const profileHint = useId();
  const qualityHint = useId();
  const [screenDiagnostics, setScreenDiagnostics] = useState<{
    capture: string;
    sent: string;
    bitrate: number | null;
    limitation: string | null;
  } | null>(null);
  const previousScreenSample = useRef<{ trackId: string; bytes: number; timestamp: number } | null>(null);

  useEffect(() => {
    if (!room) return;
    let active = true;
    async function readScreenStats() {
      const track = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
      if (!(track instanceof LocalVideoTrack) || !track.sender) {
        if (active) setScreenDiagnostics(null);
        previousScreenSample.current = null;
        return;
      }
      const capture = track.mediaStreamTrack.getSettings();
      const report = await track.sender.getStats().catch(() => null);
      const outbound = (report ? Array.from(report.values()) : []).filter((entry) => {
        const stat = entry as RTCStats & { kind?: string; mediaType?: string; bytesSent?: number };
        return stat.type === "outbound-rtp" && (stat.kind === "video" || stat.mediaType === "video");
      }) as Array<{
        bytesSent?: number; timestamp?: number; frameWidth?: number; frameHeight?: number;
        framesPerSecond?: number; qualityLimitationReason?: string; active?: boolean;
      }>;
      const activeStreams = outbound.filter((stat) => stat.active !== false && (stat.framesPerSecond ?? 1) > 0);
      const sample = (activeStreams.length ? activeStreams : outbound)
        .sort((first, second) => (second.frameWidth ?? 0) * (second.frameHeight ?? 0) - (first.frameWidth ?? 0) * (first.frameHeight ?? 0))[0];
      const bytesSent = outbound.reduce((total, stat) => total + (stat.bytesSent ?? 0), 0);
      if (!active) return;
      const previous = previousScreenSample.current;
      const bitrate = sample?.timestamp !== undefined && previous?.trackId === track.mediaStreamTrack.id
        ? Math.max(0, (bytesSent - previous.bytes) * 8 / Math.max(1, sample.timestamp - previous.timestamp) / 1000)
        : null;
      if (sample?.timestamp !== undefined) {
        previousScreenSample.current = { trackId: track.mediaStreamTrack.id, bytes: bytesSent, timestamp: sample.timestamp };
      }
      setScreenDiagnostics({
        capture: `${capture.width ?? "?"}×${capture.height ?? "?"}${capture.frameRate ? ` · ${Math.round(capture.frameRate)} кадр/с` : ""}`,
        sent: sample?.frameWidth && sample?.frameHeight ? `${sample.frameWidth}×${sample.frameHeight}${sample.framesPerSecond ? ` · ${Math.round(sample.framesPerSecond)} кадр/с` : ""}` : "ожидание данных",
        bitrate,
        limitation: sample?.qualityLimitationReason && sample.qualityLimitationReason !== "none" ? sample.qualityLimitationReason : null,
      });
    }
    void readScreenStats().catch(() => undefined);
    const timer = window.setInterval(() => void readScreenStats().catch(() => undefined), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [room]);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const next = await navigator.mediaDevices.enumerateDevices();
        if (active) setDevices(next);
      } catch {
        if (active) setError("Браузер не дал список устройств. Проверь разрешения сайта.");
      }
    }
    if (navigator.mediaDevices) {
      void refresh();
      navigator.mediaDevices.addEventListener("devicechange", refresh);
    } else {
      setError("Для выбора устройств нужно защищённое соединение.");
    }
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, []);

  const codecs = useMemo(() => {
    const supported = typeof RTCRtpSender !== "undefined"
      ? RTCRtpSender.getCapabilities("video")?.codecs ?? []
      : [];
    const names = new Set(supported.map((codec) => codec.mimeType.toLowerCase()));
    return (Object.keys(codecNames) as VideoCodec[]).filter(
      (codec) => codec === media.videoCodec || codec === media.screenShareCodec || codec === "vp8" || names.has(`video/${codec}`),
    );
  }, [media.videoCodec, media.screenShareCodec]);

  async function change(patch: Partial<MediaPreferences>) {
    setBusy(true);
    setError("");
    try {
      await onChange(patch);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось применить настройку.");
    } finally {
      setBusy(false);
    }
  }

  function deviceOptions(kind: MediaDeviceKind) {
    return devices.filter((device) => device.kind === kind).map((device, index) => (
      <option key={device.deviceId || `${kind}-${index}`} value={device.deviceId}>
        {device.label || `${kind === "audioinput" ? "Микрофон" : kind === "videoinput" ? "Камера" : "Динамик"} ${index + 1}`}
      </option>
    ));
  }

  const outputSupported = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
  const processingSupported = supportedAudioProcessing();
  const rnnoiseSupported = typeof AudioContext !== "undefined" && "audioWorklet" in AudioContext.prototype
    && typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined";
  const microphoneUnavailable = Boolean(media.microphoneId && devices.length
    && !devices.some(device => device.kind === "audioinput" && device.deviceId === media.microphoneId));

  function voiceProfilePatch(profile: VoiceProfile): Partial<MediaPreferences> {
    const patch: Partial<MediaPreferences> = { noiseProcessor: profile === "noisy" ? "rnnoise" : "browser" };
    if (processingSupported.echoCancellation) patch.echoCancellation = true;
    if (profile === "noisy") {
      patch.rnnoisePreset = "balanced";
    } else {
      if (processingSupported.noiseSuppression) patch.noiseSuppression = profile === "automatic";
      if (processingSupported.autoGainControl) patch.autoGainControl = profile === "automatic";
    }
    return patch;
  }

  const voiceProfile = (["automatic", "quiet", "noisy"] as const).find(profile =>
    Object.entries(voiceProfilePatch(profile)).every(([key, value]) => media[key as keyof MediaPreferences] === value),
  ) ?? "custom";

  function processingCaption(key: keyof AudioProcessingState, enabled: boolean) {
    if (!processingSupported[key]) return "Браузер не поддерживает эту функцию.";
    if (!media.microphoneEnabled || !audioProcessingState) return "Применится при включении микрофона.";
    const actual = audioProcessingState[key];
    if (actual === null) return "Браузер не сообщает текущее состояние.";
    if (actual !== enabled) return "Браузер применил другое значение.";
    return enabled ? "Работает на микрофоне." : "Выключено на микрофоне.";
  }

  function processingToggle(key: keyof AudioProcessingState, name: string) {
    return (
      <label className="media-setting-check">
        <input type="checkbox" disabled={busy || !processingSupported[key]} checked={media[key] && processingSupported[key]} onChange={(event) => void change({ [key]: event.target.checked })} />
        <span className="media-setting-option">{name}<small>{processingCaption(key, media[key])}</small></span>
      </label>
    );
  }

  return (
    <aside className={`media-settings-panel ${embedded ? "media-settings-embedded" : ""}`} aria-label="Настройки звонка">
      {!embedded && <div className="media-settings-heading">
        <div><Settings2 size={18} /><strong>Звук и видео</strong></div>
        <button onClick={onClose} aria-label="Закрыть настройки"><X size={18} /></button>
      </div>}
      <div className="media-settings-scroll">
        {error && <p className="media-settings-error" role="alert">{error}</p>}
        <label>
          Микрофон
          <select disabled={busy} value={media.microphoneId} onChange={(event) => void change({ microphoneId: event.target.value })}>
            <option value="">По умолчанию</option>
            {microphoneUnavailable && <option value={media.microphoneId} disabled>Выбранный микрофон недоступен</option>}
            {deviceOptions("audioinput")}
          </select>
        </label>
        <label>
          Профиль микрофона
          <select aria-label="Профиль микрофона" aria-describedby={profileHint} disabled={busy} value={voiceProfile} onChange={(event) => void change(voiceProfilePatch(event.target.value as VoiceProfile))}>
            <option value="automatic">Автоматический</option>
            <option value="quiet" disabled={!processingSupported.noiseSuppression && !processingSupported.autoGainControl}>Тихая комната</option>
            <option value="noisy" disabled={!rnnoiseSupported}>Шумная комната · RNNoise</option>
            {voiceProfile === "custom" && <option value="custom" disabled>Свой профиль</option>}
          </select>
          <small id={profileHint}>{voiceProfileDescriptions[voiceProfile]} Настройки сохраняются для выбранного входа.</small>
        </label>
        <details className="media-voice-profiles">
          <summary>Расширенные настройки микрофона</summary>
          <section className="media-settings-scroll" style={{ padding: "8px 0 0", overflow: "visible" }} aria-label="Обработка микрофона">
            <label>
              Способ обработки
              <select disabled={busy} value={media.noiseProcessor} onChange={(event) => void change({ noiseProcessor: event.target.value as MediaPreferences["noiseProcessor"] })}>
                <option value="browser">Обработка браузера</option>
                <option value="rnnoise" disabled={!rnnoiseSupported}>RNNoise</option>
              </select>
            </label>
            {media.noiseProcessor === "rnnoise" ? <>
              <label>
                Степень подавления фона RNNoise
                <select disabled={busy} value={media.rnnoisePreset} onChange={(event) => void change({ rnnoisePreset: event.target.value as MediaPreferences["rnnoisePreset"] })}>
                  {rnnoiseProfiles.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                </select>
              </label>
              <small>RNNoise обрабатывает речь на устройстве. Браузер может отдельно подавлять эхо.</small>
            </> : <>
              {processingToggle("noiseSuppression", "Подавление шума")}
              {processingToggle("autoGainControl", "Автоматическое выравнивание голоса")}
            </>}
            {processingToggle("echoCancellation", "Подавление эха")}
          </section>
        </details>
        <MicrophoneCheck media={media} room={room} />
        <label>
          Качество передачи речи
          <select aria-label="Качество передачи речи" aria-describedby={qualityHint} disabled={busy} value={media.voiceQuality} onChange={(event) => void change({ voiceQuality: event.target.value as MediaPreferences["voiceQuality"] })}>
            <option value="efficient">Экономия · до 24 кбит/с</option>
            <option value="balanced">Сбалансированное · до 40 кбит/с</option>
            <option value="clear">Повышенное · до 56 кбит/с</option>
          </select>
          <small id={qualityHint}>Все режимы передают речь в моно через Opus. Для слабой сети подходит «Экономия».</small>
        </label>
        <label>
          Вывод звука
          <select disabled={busy || !outputSupported} value={media.speakerId} onChange={(event) => void change({ speakerId: event.target.value })}>
            <option value="">По умолчанию</option>
            {deviceOptions("audiooutput")}
          </select>
          {!outputSupported && <small>Этот браузер не даёт выбрать динамики.</small>}
        </label>
        <label className="media-setting-check">
          <input type="checkbox" disabled={busy} checked={media.deafened} onChange={(event) => void change({ deafened: event.target.checked })} />
          Не слышать собеседников
        </label>
        <div className="media-settings-divider" />
        <label>
          Камера
          <select disabled={busy} value={media.cameraId} onChange={(event) => void change({ cameraId: event.target.value })}>
            <option value="">По умолчанию</option>
            {deviceOptions("videoinput")}
          </select>
        </label>
        <label>
          Видеокодек
          <select disabled={busy} value={media.videoCodec} onChange={(event) => void change({ videoCodec: event.target.value as VideoCodec })}>
            {codecs.map((codec) => <option key={codec} value={codec}>{codecNames[codec]}</option>)}
          </select>
          {supportedVideoCodec(media.videoCodec) !== media.videoCodec && <small>Браузер не поддерживает {codecNames[media.videoCodec]}; используется VP8.</small>}
        </label>
        <label>
          Качество камеры
          <select disabled={busy} value={media.videoQuality} onChange={(event) => void change({ videoQuality: event.target.value as MediaPreferences["videoQuality"] })}>
            <option value="360p">Экономия · 360p</option>
            <option value="720p">Сбалансировано · 720p</option>
            <option value="1080p">Максимум · 1080p</option>
          </select>
        </label>
        <div className="media-settings-divider" />
        <div className="media-settings-section-heading">
          <strong>Демонстрация экрана</strong>
          <small>Для текста приоритет у чёткости. Для видео доступна более плавная передача.</small>
        </div>
        {isTauri() && <label className="media-setting-check">
          <input type="checkbox" disabled={busy} checked={media.systemAudioEnabled} onChange={(event) => void change({ systemAudioEnabled: event.target.checked })} />
          <span className="media-setting-option">Передавать звук компьютера<small>Звук Coherent исключается, чтобы собеседники не слышали себя повторно.</small></span>
        </label>}
        <label>
          Разрешение
          <select disabled={busy} value={media.screenShareQuality} onChange={(event) => void change({ screenShareQuality: event.target.value as MediaPreferences["screenShareQuality"] })}>
            <option value="720p">1280×720</option>
            <option value="1080p">1920×1080</option><option value="1440p">2560×1440</option><option value="2160p">3840×2160</option><option value="native">Исходное разрешение экрана</option>
          </select>
        </label>
        <label>
          Содержимое
          <select disabled={busy} value={media.screenShareContent} onChange={(event) => void change({ screenShareContent: event.target.value as MediaPreferences["screenShareContent"] })}>
            <option value="text">Текст и приложения — чёткость</option>
            <option value="motion">Видео и игры — плавность</option>
          </select>
          <small>Для текста отправляется один поток без уменьшенной копии; маленькая плитка больше не переключает трансляцию на низкое разрешение.</small>
        </label>
        <label>
          Частота кадров
          <select disabled={busy} value={media.screenShareFrameRate} onChange={(event) => void change({ screenShareFrameRate: Number(event.target.value) as MediaPreferences["screenShareFrameRate"] })}>
            <option value={15}>15 кадров/с — для текста</option>
            <option value={30}>30 кадров/с — сбалансированно</option><option value={60}>60 кадров/с — для движения</option>
          </select>
        </label>
        <label className="media-volume-setting">
          <span>Максимальный битрейт <strong>{media.screenShareBitrateMbps} Мбит/с</strong></span>
          <input type="range" min="1" max="50" step="1" value={media.screenShareBitrateMbps} onChange={(event) => void change({ screenShareBitrateMbps: Number(event.target.value) })} />
          <small>Предел передачи, а не гарантированная скорость. Во время показа меняется сразу; для высокого разрешения обычно нужно больше.</small>
        </label>
        <label>
          Кодек демонстрации
          <select disabled={busy} value={media.screenShareCodec} onChange={(event) => void change({ screenShareCodec: event.target.value as VideoCodec })}>
            {codecs.map((codec) => <option key={codec} value={codec}>{codecNames[codec]}</option>)}
          </select>
          {supportedVideoCodec(media.screenShareCodec) !== media.screenShareCodec && <small>На этом устройстве недоступен {codecNames[media.screenShareCodec]}; используется VP8.</small>}
        </label>
        {screenDiagnostics && <div className="media-screen-diagnostics">
          <strong>Текущая трансляция</strong>
          <span>Захват: {screenDiagnostics.capture}</span>
          <span>Отправка: {screenDiagnostics.sent}</span>
          <span>Фактический битрейт: {screenDiagnostics.bitrate === null ? "считаем..." : `${screenDiagnostics.bitrate.toFixed(1)} Мбит/с`}</span>
          {screenDiagnostics.limitation && <span>Ограничение: {screenDiagnostics.limitation === "bandwidth" ? "скорость сети" : screenDiagnostics.limitation === "cpu" ? "нагрузка на процессор" : screenDiagnostics.limitation}</span>}
        </div>}
        <p className="media-settings-note">{isTauri()
          ? "Разрешение, частота, режим и кодек применятся при следующем включении демонстрации. Доступные кодеки зависят от устройства; фактическое качество — от нагрузки и сети. Звук компьютера захватывается отдельно от звука звонка."
          : "Разрешение, частота, режим и кодек применятся при следующем включении демонстрации. «Исходное разрешение» не уменьшает захват намеренно, но кодек может менять цветовые оттенки. Сравни «Захват» и «Отправка» выше; для мелкого текста попробуй VP9 и более высокий битрейт. Для передачи звука без эха выбирай отдельную вкладку."}</p>
      </div>
    </aside>
  );
}
