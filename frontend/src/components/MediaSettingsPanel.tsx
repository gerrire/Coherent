import { useEffect, useMemo, useRef, useState } from "react";
import { useMaybeRoomContext } from "@livekit/components-react";
import { LocalVideoTrack, Track } from "livekit-client";
import { Settings2, X } from "lucide-react";
import { supportedAudioProcessing, supportedVideoCodec, type AudioProcessingState, type MediaPreferences, type VideoCodec } from "../lib/media";

interface MediaSettingsPanelProps {
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

export default function MediaSettingsPanel({ media, audioProcessingState, onChange, onClose, embedded = false }: MediaSettingsPanelProps) {
  const room = useMaybeRoomContext();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const naturalVoice = media.noiseProcessor === "browser" && !media.noiseSuppression && media.echoCancellation && !media.autoGainControl;
  const noisyVoice = media.noiseProcessor === "browser" && media.noiseSuppression && media.echoCancellation && !media.autoGainControl;

  function chooseVoiceProfile(profile: "natural" | "noisy") {
    const patch: Partial<MediaPreferences> = { noiseProcessor: "browser" };
    if (processingSupported.noiseSuppression) patch.noiseSuppression = profile === "noisy";
    if (processingSupported.echoCancellation) patch.echoCancellation = true;
    if (processingSupported.autoGainControl) patch.autoGainControl = false;
    void change(patch);
  }

  function processingCaption(key: keyof AudioProcessingState, enabled: boolean) {
    if (!processingSupported[key]) return "Браузер не поддерживает эту функцию.";
    if (!media.microphoneEnabled || !audioProcessingState) return "Применится при включении микрофона.";
    const actual = audioProcessingState[key];
    if (actual === null) return "Браузер не сообщает текущее состояние.";
    if (actual !== enabled) return "Браузер применил другое значение.";
    return enabled ? "Работает на микрофоне." : "Выключено на микрофоне.";
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
            {deviceOptions("audioinput")}
          </select>
        </label>
        <label className="media-volume-setting">
          <span>Громкость микрофона <strong>{media.microphoneVolume}%</strong></span>
          <input type="range" min="0" max="100" step="5" value={media.microphoneVolume} onChange={(event) => void change({ microphoneVolume: Number(event.target.value) })} />
          <small>100% — полный уровень. Голос усиливается и выравнивается автоматически, громкие пики ограничиваются.</small>
        </label>
        <label>
          Камера
          <select disabled={busy} value={media.cameraId} onChange={(event) => void change({ cameraId: event.target.value })}>
            <option value="">По умолчанию</option>
            {deviceOptions("videoinput")}
          </select>
        </label>
        <label>
          Вывод звука
          <select disabled={busy || !outputSupported} value={media.speakerId} onChange={(event) => void change({ speakerId: event.target.value })}>
            <option value="">По умолчанию</option>
            {deviceOptions("audiooutput")}
          </select>
          {!outputSupported && <small>Этот браузер не даёт выбрать динамики.</small>}
        </label>
        <div className="media-settings-divider" />
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
        <label>
          Разрешение
          <select disabled={busy} value={media.screenShareQuality} onChange={(event) => void change({ screenShareQuality: event.target.value as MediaPreferences["screenShareQuality"] })}>
            <option value="720p">1280×720</option>
            <option value="1080p">1920×1080</option>
            <option value="1440p">2560×1440</option>
            <option value="native">Исходное разрешение экрана</option>
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
            <option value={30}>30 кадров/с — сбалансированно</option>
            <option value={60}>60 кадров/с — для движения</option>
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
          {supportedVideoCodec(media.screenShareCodec) !== media.screenShareCodec && <small>Браузер не поддерживает {codecNames[media.screenShareCodec]}; используется VP8.</small>}
        </label>
        {screenDiagnostics && <div className="media-screen-diagnostics">
          <strong>Текущая трансляция</strong>
          <span>Захват: {screenDiagnostics.capture}</span>
          <span>Отправка: {screenDiagnostics.sent}</span>
          <span>Фактический битрейт: {screenDiagnostics.bitrate === null ? "считаем..." : `${screenDiagnostics.bitrate.toFixed(1)} Мбит/с`}</span>
          {screenDiagnostics.limitation && <span>Ограничение: {screenDiagnostics.limitation === "bandwidth" ? "скорость сети" : screenDiagnostics.limitation === "cpu" ? "нагрузка на процессор" : screenDiagnostics.limitation}</span>}
        </div>}
        <p className="media-settings-note">Разрешение, частота, режим и кодек применятся при следующем включении демонстрации. «Исходное разрешение» не уменьшает захват намеренно, но браузер и видеокодек могут обрезать несколько пикселей и менять цветовые оттенки. Сравни «Захват» и «Отправка» выше; для мелкого текста попробуй VP9 и более высокий битрейт. Для передачи звука без эха выбирай отдельную вкладку.</p>
        <div className="media-settings-divider" />
        <div className="media-settings-section-heading"><strong>Обработка голоса</strong></div>
        <label>
          Способ подавления шума
          <select disabled={busy} value={media.noiseProcessor} onChange={(event) => void change({ noiseProcessor: event.target.value as MediaPreferences["noiseProcessor"] })}>
            <option value="browser">Обработка браузера</option>
            <option value="rnnoise">RNNoise</option>
          </select>
          <small>RNNoise обрабатывает звук на твоём устройстве. Подавление эха браузера остаётся доступным.</small>
        </label>
        {media.noiseProcessor === "rnnoise" && <div className="media-voice-profiles">
          <div>
            <button type="button" className={media.rnnoisePreset === "natural" ? "active" : ""} disabled={busy} onClick={() => void change({ rnnoisePreset: "natural" })}>Естественный</button>
            <button type="button" className={media.rnnoisePreset === "balanced" ? "active" : ""} disabled={busy} onClick={() => void change({ rnnoisePreset: "balanced" })}>Сбалансированный</button>
            <button type="button" className={media.rnnoisePreset === "strong" ? "active" : ""} disabled={busy} onClick={() => void change({ rnnoisePreset: "strong" })}>Подавление</button>
          </div>
          <small>Все режимы передают один обработанный поток. Пресеты меняют приглушение фона в паузах, без смешивания с исходным голосом.</small>
        </div>}
        {media.noiseProcessor === "browser" && <>
        <div className="media-voice-profiles">
          <div>
            <button type="button" className={naturalVoice ? "active" : ""} disabled={busy} onClick={() => chooseVoiceProfile("natural")}>Естественный</button>
            <button type="button" className={noisyVoice ? "active" : ""} disabled={busy || !processingSupported.noiseSuppression} onClick={() => chooseVoiceProfile("noisy")}>Шумное место</button>
          </div>
          <small>В шумном месте браузер подавляет фон, а короткие щелчки мыши и клавиатуры в паузах дополнительно приглушаются без снижения уровня речи.</small>
        </div>
        <label className="media-setting-check">
          <input type="checkbox" disabled={busy || !processingSupported.noiseSuppression} checked={media.noiseSuppression && processingSupported.noiseSuppression} onChange={(event) => void change({ noiseSuppression: event.target.checked })} />
          <span className="media-setting-option">Подавление шума<small>{processingCaption("noiseSuppression", media.noiseSuppression)}</small></span>
        </label>
        </>}
        <label className="media-setting-check">
          <input type="checkbox" disabled={busy || !processingSupported.echoCancellation} checked={media.echoCancellation && processingSupported.echoCancellation} onChange={(event) => void change({ echoCancellation: event.target.checked })} />
          <span className="media-setting-option">Подавление эха<small>{processingCaption("echoCancellation", media.echoCancellation)}</small></span>
        </label>
        <label className="media-setting-check">
          <input type="checkbox" disabled={busy || !processingSupported.autoGainControl} checked={media.autoGainControl && processingSupported.autoGainControl} onChange={(event) => void change({ autoGainControl: event.target.checked })} />
          <span className="media-setting-option">Автоматическая громкость микрофона<small>{processingCaption("autoGainControl", media.autoGainControl)}</small></span>
        </label>
        <label className="media-setting-check">
          <input type="checkbox" disabled={busy} checked={media.deafened} onChange={(event) => void change({ deafened: event.target.checked })} />
          Не слышать собеседников
        </label>
        <p className="media-settings-note">Подавление эха выполняет браузер. При выборе RNNoise браузерное шумоподавление отключается, чтобы голос не обрабатывался дважды.</p>
      </div>
    </aside>
  );
}
