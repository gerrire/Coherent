import { useEffect, useMemo, useState } from "react";
import { Settings2, X } from "lucide-react";
import { supportedAudioProcessing, supportedVideoCodec, type AudioProcessingState, type MediaPreferences, type VideoCodec } from "../lib/media";

interface MediaSettingsPanelProps {
  media: MediaPreferences;
  audioProcessingState: AudioProcessingState | null;
  onChange: (patch: Partial<MediaPreferences>) => Promise<void>;
  onClose: () => void;
}

const codecNames: Record<VideoCodec, string> = {
  vp8: "VP8",
  h264: "H.264",
  vp9: "VP9",
  av1: "AV1",
};

export default function MediaSettingsPanel({ media, audioProcessingState, onChange, onClose }: MediaSettingsPanelProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      (codec) => codec === media.videoCodec || codec === "vp8" || names.has(`video/${codec}`),
    );
  }, [media.videoCodec]);

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

  const outputSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const processingSupported = supportedAudioProcessing();

  function processingCaption(key: keyof AudioProcessingState, enabled: boolean) {
    if (!processingSupported[key]) return "Браузер не поддерживает эту функцию.";
    if (!media.microphoneEnabled || !audioProcessingState) return "Применится при включении микрофона.";
    const actual = audioProcessingState[key];
    if (actual === null) return "Браузер не сообщает текущее состояние.";
    if (actual !== enabled) return "Браузер применил другое значение.";
    return enabled ? "Работает на микрофоне." : "Выключено на микрофоне.";
  }

  return (
    <aside className="media-settings-panel" aria-label="Настройки звонка">
      <div className="media-settings-heading">
        <div><Settings2 size={18} /><strong>Звук и видео</strong></div>
        <button onClick={onClose} aria-label="Закрыть настройки"><X size={18} /></button>
      </div>
      <div className="media-settings-scroll">
        {error && <p className="media-settings-error" role="alert">{error}</p>}
        <label>
          Микрофон
          <select disabled={busy} value={media.microphoneId} onChange={(event) => void change({ microphoneId: event.target.value })}>
            <option value="">По умолчанию</option>
            {deviceOptions("audioinput")}
          </select>
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
        <label>
          Качество демонстрации экрана
          <select disabled={busy} value={media.screenShareQuality} onChange={(event) => void change({ screenShareQuality: event.target.value as MediaPreferences["screenShareQuality"] })}>
            <option value="720p">Устойчивая связь · 720p, 15 кадров/с</option>
            <option value="1080p">Чёткое · 1080p, 30 кадров/с</option>
            <option value="native">Оригинал · до 4K, 30 кадров/с</option>
          </select>
          <small>Оригинал требует больше ресурсов. Параметры демонстрации применятся при следующем включении показа экрана.</small>
        </label>
        <label>
          Тип демонстрации
          <select disabled={busy} value={media.screenShareContent} onChange={(event) => void change({ screenShareContent: event.target.value as MediaPreferences["screenShareContent"] })}>
            <option value="text">Текст и приложения · чёткость</option>
            <option value="motion">Видео и игры · плавность</option>
          </select>
        </label>
        <label className="media-setting-check">
          <input type="checkbox" disabled={busy || !processingSupported.noiseSuppression} checked={media.noiseSuppression && processingSupported.noiseSuppression} onChange={(event) => void change({ noiseSuppression: event.target.checked })} />
          <span className="media-setting-option">Подавление шума<small>{processingCaption("noiseSuppression", media.noiseSuppression)}</small></span>
        </label>
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
        <p className="media-settings-note">Подавление шума и эха выполняет браузер на твоём микрофоне. Доступность и результат зависят от браузера и устройства.</p>
      </div>
    </aside>
  );
}
