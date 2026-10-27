import { useModalFocus } from "../lib/useModalFocus";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Bell, Check, Monitor, Settings2, SlidersHorizontal, X } from "lucide-react";
import MediaSettingsPanel from "./MediaSettingsPanel";
import { type AudioProcessingState, type MediaPreferences } from "../lib/media";
import { applyTheme, loadTheme, themes } from "../lib/theme";
import { defaultDesktopSettings, getAutostart, getDesktopSettings, requestDesktopNotifications, saveDesktopSettings, setAutostart, type DesktopSettings } from "../lib/desktop";
import { DesktopUpdateSettings } from "./DesktopUpdates";
import { getMediaAccess, setMediaAccess, type MediaAccess } from "../lib/desktopPermissions";

export type ClientSettingsSection = "appearance" | "media" | "desktop";

const DesktopDiagnostics = lazy(() => import("./DesktopDiagnostics"));

function DesktopSettingsPanel({ onMediaChange }: { onMediaChange: ClientSettingsDialogProps["onMediaChange"] }) {
  const [settings, setSettings] = useState<DesktopSettings>(defaultDesktopSettings);
  const [autostart, setAutostartState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnosticsOpened, setDiagnosticsOpened] = useState(false);
  const [access, setAccess] = useState<MediaAccess>({ microphone: false, camera: false });

  useEffect(() => {
    void getDesktopSettings().then(setSettings).catch(() => setError("Не удалось загрузить настройки приложения."));
    void getAutostart().then(setAutostartState).catch(() => undefined);
    void getMediaAccess().then(setAccess).catch(() => undefined);
  }, []);

  async function save(patch: Partial<DesktopSettings>) {
    setBusy(true); setError("");
    try {
      if (patch.showNotifications && !await requestDesktopNotifications()) throw new Error("Разреши уведомления в настройках Windows.");
      const next = { ...settings, ...patch };
      await saveDesktopSettings(next); setSettings(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить настройку."); }
    finally { setBusy(false); }
  }

  async function changeAutostart() {
    setBusy(true); setError("");
    try { await setAutostart(!autostart); setAutostartState(!autostart); }
    catch { setError("Не удалось изменить автозапуск."); }
    finally { setBusy(false); }
  }

  return <div className="client-settings-body desktop-settings-body">
    <DesktopUpdateSettings />
    {error && <p className="desktop-settings-error" role="alert">{error}</p>}
    <div className="desktop-settings-group">
      <strong>Окно и запуск</strong>
      <label className="desktop-settings-row"><span><b>Сворачивать в трей при закрытии</b><small>Звонки и уведомления продолжат работать.</small></span><input type="checkbox" checked={settings.closeToTray} disabled={busy} onChange={(event) => void save({ closeToTray: event.target.checked })} /></label>
      <label className="desktop-settings-row"><span><b>Запускать вместе с Windows</b><small>Приложение будет доступно после входа в систему.</small></span><input type="checkbox" checked={autostart} disabled={busy} onChange={() => void changeAutostart()} /></label>
    </div>
    <div className="desktop-settings-group">
      <strong>Звонки и уведомления</strong>
      <label className="desktop-settings-row"><span><b>Показывать входящий звонок</b><small>Окно появится поверх других приложений.</small></span><input type="checkbox" checked={settings.raiseOnCall} disabled={busy} onChange={(event) => void save({ raiseOnCall: event.target.checked })} /></label>
      <label className="desktop-settings-row"><span><b>Уведомления Windows</b><small>Сообщения и заявки. Входящий звонок появляется отдельным окном.</small></span><input type="checkbox" checked={settings.showNotifications} disabled={busy} onChange={(event) => void save({ showNotifications: event.target.checked })} /></label>
      <label className="desktop-settings-row"><span><b>Звук уведомлений</b><small>Сообщения и заявки. Звонки используют свою мелодию.</small></span><input type="checkbox" checked={settings.notificationSound} disabled={busy || !settings.showNotifications} onChange={(event) => void save({ notificationSound: event.target.checked })} /></label>
    </div>
    <div className="desktop-settings-group">
      <strong>Доступ к устройствам</strong>
      <p className="client-settings-intro">Coherent спрашивает разрешение при первом включении. Ограничения Windows продолжают действовать.</p>
      {(["microphone", "camera"] as const).map(kind => <div className="desktop-settings-row" key={kind}>
        <span><b>{kind === "microphone" ? "Микрофон" : "Камера"}</b><small>{access[kind] ? "Доступ разрешён" : "Запрос при включении"}</small></span>
        <button disabled={busy || !access[kind]} onClick={() => {
          setBusy(true);
          const next = { ...access, [kind]: false };
          void onMediaChange(kind === "microphone" ? { microphoneEnabled: false } : { cameraEnabled: false })
            .then(() => setMediaAccess(next)).then(() => setAccess(next))
            .catch(() => setError("Не удалось изменить доступ.")).finally(() => setBusy(false));
        }}>Отозвать</button>
      </div>)}
    </div>
    <details className="desktop-diagnostics" onToggle={event => { if (event.currentTarget.open) setDiagnosticsOpened(true); }}>
      <summary>Диагностика и проверки</summary>
      {diagnosticsOpened && <Suspense fallback={<p>Открываем инструменты диагностики…</p>}><DesktopDiagnostics /></Suspense>}
    </details>
  </div>;
}

interface ClientSettingsDialogProps {
  section: ClientSettingsSection;
  onSectionChange: (section: ClientSettingsSection) => void;
  onClose: () => void;
  media: MediaPreferences;
  audioProcessingState: AudioProcessingState | null;
  onMediaChange: (patch: Partial<MediaPreferences>) => Promise<void>;
}

export default function ClientSettingsDialog({
  section, onSectionChange, onClose, media, audioProcessingState, onMediaChange,
}: ClientSettingsDialogProps) {
  const [theme, setTheme] = useState(loadTheme);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalFocus(dialogRef, onClose);

  return <div className="client-settings-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="client-settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="client-settings-title" tabIndex={-1}>
      <aside className="client-settings-sidebar">
        <div className="client-settings-brand"><span className="brand-mark"><span /><span /><span /></span><strong>Когерент</strong></div>
        <span className="client-settings-nav-caption">НАСТРОЙКИ КЛИЕНТА</span>
        <nav className="client-settings-nav" aria-label="Разделы настроек">
          <button type="button" className={section === "appearance" ? "active" : ""} onClick={() => onSectionChange("appearance")}><Monitor size={18} /> Оформление</button>
          <button type="button" className={section === "media" ? "active" : ""} onClick={() => onSectionChange("media")}><SlidersHorizontal size={18} /> Звук и видео</button>
          {isTauri() && <button type="button" className={section === "desktop" ? "active" : ""} onClick={() => onSectionChange("desktop")}><Bell size={18} /> Приложение</button>}
        </nav>
        <p className="client-settings-sidebar-note"><Settings2 size={15} /> Настройки Coherent</p>
      </aside>
      <div className="client-settings-main">
        <header className="client-settings-header">
          <div><span>НАСТРОЙКИ КЛИЕНТА</span><h2 id="client-settings-title">{section === "appearance" ? "Оформление" : section === "media" ? "Звук и видео" : "Приложение"}</h2></div>
          <button type="button" onClick={onClose} aria-label="Закрыть настройки"><X size={20} /></button>
        </header>
        {section === "appearance" ? <div className="client-settings-body">
          <p className="client-settings-intro">Выбери оформление Когерента. Оно применяется сразу и сохраняется на этом устройстве.</p>
          <div className="client-theme-grid" role="group" aria-label="Цветовая тема">
            {themes.map((option) => <button
              key={option.id}
              type="button"
              className={`client-theme-card ${theme === option.id ? "active" : ""}`}
              data-preview-theme={option.id}
              aria-pressed={theme === option.id}
              onClick={() => { setTheme(option.id); applyTheme(option.id); }}
            >
              <span className="client-theme-preview" aria-hidden="true">
                <span className="client-theme-preview-rail"><i /><i /><i /></span>
                <span className="client-theme-preview-sidebar"><i /><i /><i /></span>
                <span className="client-theme-preview-content"><i /><i /><i /></span>
              </span>
              <span className="client-theme-name"><i style={{ background: option.color }} />{option.label}{theme === option.id && <Check size={16} />}</span>
            </button>)}
          </div>
        </div> : section === "desktop" ? <DesktopSettingsPanel onMediaChange={onMediaChange} /> : <div className="client-settings-media">
          <MediaSettingsPanel embedded media={media} audioProcessingState={audioProcessingState} onChange={onMediaChange} onClose={onClose} />
        </div>}
      </div>
    </div>
  </div>;
}
