import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, Check, Eye, EyeOff, KeyRound, ShieldCheck, UserRound, X } from "lucide-react";
import { api, type User } from "../lib/api";
import { applyTheme, loadTheme, themes } from "../lib/theme";

interface ProfileSettingsDialogProps {
  user: User;
  onClose: () => void;
}

export default function ProfileSettingsDialog({ user, onClose }: ProfileSettingsDialogProps) {
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
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

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || newPassword.length < 8) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api.changePassword(newPassword);
      setNewPassword("");
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сменить пароль.");
    } finally {
      setBusy(false);
    }
  }

  const joined = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  }).format(new Date(user.created_at));

  return (
    <div className="profile-settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className="profile-settings-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-settings-title"
      >
        <aside className="profile-settings-sidebar">
          <div className="profile-settings-brand"><span className="brand-mark"><span /><span /><span /></span> Когерент</div>
          <div className="profile-settings-person">
            <span className="avatar avatar-user">{user.username.slice(0, 1).toUpperCase()}</span>
            <strong>{user.username}</strong>
            <span><i className="status-dot" /> В сети</span>
          </div>
          <div className="profile-settings-nav"><UserRound size={17} /> Мой профиль</div>
          <p className="profile-settings-sidebar-note">Настройки аккаунта</p>
        </aside>

        <div className="profile-settings-content">
          <header className="profile-settings-header">
            <div>
              <span className="profile-settings-eyebrow">АККАУНТ</span>
              <h2 id="profile-settings-title">Настройки профиля</h2>
              <p>Основные сведения и безопасность твоего аккаунта.</p>
            </div>
            <button type="button" className="profile-settings-close" onClick={onClose} aria-label="Закрыть настройки"><X size={20} /></button>
          </header>

          <section className="profile-settings-card" aria-label="Профиль">
            <div className="profile-settings-section-heading"><UserRound size={18} /><h3>Профиль</h3></div>
            <div className="profile-settings-details">
              <div><span>Имя пользователя</span><strong>{user.username}</strong></div>
              <div><span>В Когеренте с</span><strong><CalendarDays size={15} /> {joined}</strong></div>
            </div>
          </section>

          <section className="profile-settings-card" aria-label="Оформление">
            <div className="profile-settings-section-heading"><Eye size={18} /><h3>Оформление</h3></div>
            <p>Тема применяется сразу и сохраняется в этом браузере.</p>
            <div className="profile-theme-grid">
              {themes.map((option) => <button key={option.id} type="button" className={theme === option.id ? "active" : ""} onClick={() => { setTheme(option.id); applyTheme(option.id); }} aria-pressed={theme === option.id}>
                <i style={{ background: option.color }} aria-hidden="true" />{option.label}
              </button>)}
            </div>
          </section>

          <section className="profile-settings-card" aria-label="Безопасность">
            <div className="profile-settings-section-heading"><ShieldCheck size={18} /><h3>Безопасность</h3></div>
            <p>Сменить пароль можно прямо здесь. Текущий пароль вводить не нужно.</p>
            <form className="profile-password-form" onSubmit={(event) => void savePassword(event)}>
              <label htmlFor="profile-new-password">Новый пароль</label>
              <div className="profile-password-field">
                <KeyRound size={18} />
                <input
                  id="profile-new-password"
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(event) => { setNewPassword(event.target.value); setSaved(false); }}
                  minLength={8}
                  maxLength={128}
                  placeholder="Не менее 8 символов"
                  autoComplete="new-password"
                  required
                />
                <button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <div className="profile-password-actions">
                <span>После смены пароля другие сеансы завершатся.</span>
                <button type="submit" disabled={busy || newPassword.length < 8}>{busy ? "Сохраняем..." : "Сохранить пароль"}</button>
              </div>
              {error && <p className="profile-settings-error" role="alert">{error}</p>}
              {saved && <p className="profile-settings-success" role="status"><Check size={16} /> Пароль изменён.</p>}
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
