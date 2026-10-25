import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, Check, Eye, EyeOff, KeyRound, Mail, ShieldCheck, UserRound, X } from "lucide-react";
import { api, displayName, type User } from "../lib/api";

interface ProfileSettingsDialogProps {
  user: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
}

export default function ProfileSettingsDialog({ user, onClose, onUpdated }: ProfileSettingsDialogProps) {
  const [name, setName] = useState(displayName(user));
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState("");
  const [nameSaved, setNameSaved] = useState(false);
  const [email, setEmail] = useState(user.email || "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailWait, setEmailWait] = useState(0);
  useEffect(() => {
    if (!emailWait) return;
    const timer = window.setTimeout(() => setEmailWait((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [emailWait]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
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
    if (busy || !currentPassword || newPassword.length < 8) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сменить пароль.");
    } finally {
      setBusy(false);
    }
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (nameBusy || !name.trim()) return;
    setNameBusy(true);
    setNameError("");
    setNameSaved(false);
    try {
      onUpdated(await api.updateProfile(name.trim()));
      setNameSaved(true);
    } catch (reason) {
      setNameError(reason instanceof Error ? reason.message : "Не удалось сохранить имя.");
    } finally { setNameBusy(false); }
  }

  async function sendEmailCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (emailBusy || emailWait || !emailPassword) return;
    setEmailBusy(true); setEmailError("");
    try {
      const result = await api.requestEmailCode(email.trim(), emailPassword);
      setEmailSent(true); setEmailWait(result.retry_after_seconds); setEmailCode(""); setEmailPassword("");
    } catch (reason) { setEmailError(reason instanceof Error ? reason.message : "Не удалось отправить код"); }
    finally { setEmailBusy(false); }
  }

  async function confirmEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (emailBusy || !/^\d{6}$/.test(emailCode)) return;
    setEmailBusy(true); setEmailError("");
    try { onUpdated(await api.confirmEmailCode(emailCode)); setEmailSent(false); setEmailCode(""); }
    catch (reason) { setEmailError(reason instanceof Error ? reason.message : "Не удалось подтвердить почту"); }
    finally { setEmailBusy(false); }
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
            <span className="avatar avatar-user">{displayName(user).slice(0, 1).toUpperCase()}</span>
            <strong>{displayName(user)}</strong>
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
              <div><span>Логин для входа</span><strong>@{user.username}</strong></div>
              <div><span>В Когеренте с</span><strong><CalendarDays size={15} /> {joined}</strong></div>
            </div>
            <form className="profile-password-form" onSubmit={(event) => void saveName(event)}>
              <label htmlFor="profile-display-name">Отображаемое имя</label>
              <div className="profile-password-field"><UserRound size={18} /><input id="profile-display-name" value={name} onChange={(event) => { setName(event.target.value); setNameSaved(false); }} maxLength={64} autoComplete="nickname" required /></div>
              <div className="profile-password-actions"><span>Это имя видно в чатах, звонках и списке друзей. Логин остаётся прежним.</span><button type="submit" disabled={nameBusy || !name.trim() || name.trim() === displayName(user)}>{nameBusy ? "Сохраняем…" : "Сохранить имя"}</button></div>
              {nameError && <p className="profile-settings-error" role="alert">{nameError}</p>}
              {nameSaved && <p className="profile-settings-success" role="status"><Check size={16} /> Имя сохранено.</p>}
            </form>
          </section>

          <section className="profile-settings-card" aria-label="Почта">
            <div className="profile-settings-section-heading"><Mail size={18} /><h3>Электронная почта</h3></div>
            <p>{user.email_verified ? `Подтверждённый адрес: ${user.email}` : "Привяжи и подтверди адрес кодом из письма."}</p>
            {!user.email_delivery_available && <p className="profile-mail-note">Отправка писем на сервере ещё настраивается.</p>}
            <form className="profile-password-form" onSubmit={(event) => void sendEmailCode(event)}>
              <label htmlFor="profile-email">Адрес почты</label><div className="profile-password-field"><Mail size={18} /><input id="profile-email" type="email" autoComplete="email" value={email} maxLength={320} onChange={(event) => { setEmail(event.target.value); setEmailSent(false); }} required /></div>
              <label htmlFor="profile-email-password">Текущий пароль для привязки адреса</label><div className="profile-password-field"><KeyRound size={18} /><input id="profile-email-password" type="password" autoComplete="current-password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} maxLength={128} required /></div>
              <div className="profile-password-actions"><span>Код действует 10 минут.</span><button type="submit" disabled={!user.email_delivery_available || emailBusy || emailWait > 0 || !emailPassword || !email.trim()}>{emailWait ? `Повторить через ${emailWait} с` : "Отправить код"}</button></div>
            </form>
            {emailSent && <form className="profile-password-form" onSubmit={(event) => void confirmEmail(event)}><label htmlFor="profile-email-code">Код из письма</label><div className="profile-password-field"><input id="profile-email-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={emailCode} onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" required /></div><div className="profile-password-actions"><span>Письмо отправлено на {email}.</span><button type="submit" disabled={emailBusy || emailCode.length !== 6}>Подтвердить адрес</button></div></form>}
            {emailError && <p className="profile-settings-error" role="alert">{emailError}</p>}
          </section>
          <section className="profile-settings-card" aria-label="Безопасность">
            <div className="profile-settings-section-heading"><ShieldCheck size={18} /><h3>Безопасность</h3></div>
            <p>Для смены пароля введи текущий и новый пароль.</p>
            <form className="profile-password-form" onSubmit={(event) => void savePassword(event)}>
              <label htmlFor="profile-current-password">Текущий пароль</label>
              <div className="profile-password-field">
                <KeyRound size={18} />
                <input
                  id="profile-current-password"
                  type={showPassword ? "text" : "password"}
                  value={currentPassword}
                  onChange={(event) => { setCurrentPassword(event.target.value); setSaved(false); }}
                  maxLength={128}
                  placeholder="Пароль от аккаунта"
                  autoComplete="current-password"
                  required
                />
              </div>
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
                <button type="submit" disabled={busy || !currentPassword || newPassword.length < 8}>{busy ? "Сохраняем..." : "Сохранить пароль"}</button>
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
