import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Settings2, SlidersHorizontal, X } from "lucide-react";
import MediaSettingsPanel from "./MediaSettingsPanel";
import { type AudioProcessingState, type MediaPreferences } from "../lib/media";
import { applyTheme, loadTheme, themes } from "../lib/theme";

export type ClientSettingsSection = "appearance" | "media";

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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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
        </nav>
        <p className="client-settings-sidebar-note"><Settings2 size={15} /> Настройки будут дополняться</p>
      </aside>
      <div className="client-settings-main">
        <header className="client-settings-header">
          <div><span>НАСТРОЙКИ КЛИЕНТА</span><h2 id="client-settings-title">{section === "appearance" ? "Оформление" : "Звук и видео"}</h2></div>
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
        </div> : <div className="client-settings-media">
          <MediaSettingsPanel embedded media={media} audioProcessingState={audioProcessingState} onChange={onMediaChange} onClose={onClose} />
        </div>}
      </div>
    </div>
  </div>;
}
