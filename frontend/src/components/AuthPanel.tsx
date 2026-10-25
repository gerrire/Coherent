import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Sparkles,
  UserRound,
  Mail,
} from "lucide-react";
import { api, type User } from "../lib/api";
import SecurityRecoveryCard from "./SecurityRecoveryCard";

interface AuthPanelProps {
  onAuthenticated: (user: User) => void;
}

export default function AuthPanel({ onAuthenticated }: AuthPanelProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [delivery, setDelivery] = useState<"pending" | "sent" | "failed">("pending");
  const [resendWait, setResendWait] = useState(0);
  const [createdUser, setCreatedUser] = useState<User | null>(null);
  useEffect(() => {
    if (!resendWait) return;
    const timer = window.setTimeout(() => setResendWait(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendWait]);
  useEffect(() => {
    if (!verificationId || createdUser) return;
    let active = true;
    let timer = 0;
    let attempts = 0;
    async function refresh() {
      try {
        const result = await api.registrationDelivery(verificationId!);
        if (!active) return;
        setDelivery(result.delivery);
        if (result.delivery === "failed") setError("Письмо не удалось отправить. Попробуй запросить новый код позже.");
        if (result.delivery === "pending" && ++attempts < 30) timer = window.setTimeout(() => void refresh(), 2000);
      } catch { if (active) setError("Не удалось проверить доставку письма. Можно повторно запросить код."); }
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [verificationId, createdUser]);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      if (mode === "register" && !verificationId) {
        const challenge = await api.registrationCode(email.trim());
        setDelivery("pending"); setVerificationId(challenge.verification_id); setResendWait(challenge.retry_after_seconds); setCode("");
        return;
      }
      const result = mode === "register"
        ? await api.register({ username, password, email: email.trim(), verification_id: verificationId!, code })
        : await api.login({ username, password });
      if (mode === "register") setCreatedUser(result.user);
      else { setPassword(""); onAuthenticated(result.user); }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Что-то пошло не так.",
      );
    } finally {
      setBusy(false);
    }
  }

  function toggleMode() {
    setMode((current) => current === "register" ? "login" : "register");
    setError("");
    setPassword(""); setCode(""); setVerificationId(null);
  }

  async function resendCode() {
    if (busy || resendWait) return;
    setBusy(true); setError("");
    try { const result = await api.registrationCode(email.trim()); setDelivery("pending"); setVerificationId(result.verification_id); setResendWait(result.retry_after_seconds); setCode(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось отправить код"); }
    finally { setBusy(false); }
  }

  return (
    <main className="auth-page">
      <div className="auth-glow auth-glow-one" />
      <div className="auth-glow auth-glow-two" />
      <div className="auth-grid" />

      <header className="auth-topbar">
        <a className="brand brand-large" href="#top" aria-label="Coherent">
          <span className="brand-mark"><span /><span /><span /></span>
          <span>coherent</span>
        </a>
        <div className="topbar-note">
          <span className="live-dot" />
          Пространство уже ждёт тебя
        </div>
      </header>

      <section className="auth-layout" id="top">
        <div className="auth-story">
          <div className="eyebrow">
            <Sparkles size={14} /> ОБЩЕНИЕ, КОТОРОЕ ЗВУЧИТ
          </div>
          <h1>Ближе, даже<br /><span>когда далеко.</span></h1>
          <p className="story-copy">
            Твои разговоры, друзья и совместные моменты — в одном уютном
            пространстве.
          </p>

          <div className="orbit-scene" aria-hidden="true">
            <div className="orbit orbit-outer" />
            <div className="orbit orbit-inner" />
            <div className="scene-core">
              <span className="brand-mark scene-logo"><span /><span /><span /></span>
            </div>
            <div className="orbit-person person-one">
              <span className="avatar avatar-pink">A</span><i />
            </div>
            <div className="orbit-person person-two">
              <span className="avatar avatar-blue">M</span><i />
            </div>
            <div className="orbit-person person-three">
              <span className="avatar avatar-gold">S</span><i />
            </div>
            <div className="scene-spark spark-one">✦</div>
            <div className="scene-spark spark-two">✧</div>
          </div>

          <div className="story-foot">
            <span className="mini-avatars"><i>A</i><i>M</i><i>+</i></span>
            <span>Твоя компания — в одном клике</span>
          </div>
        </div>

        <div className="auth-card-wrap">
          <div className="auth-card">
            {createdUser ? <SecurityRecoveryCard user={createdUser} initialPassword={password} onComplete={() => { setPassword(""); onAuthenticated(createdUser); }} /> : <><div className="card-heading">
              <div className="card-icon"><LockKeyhole size={20} /></div>
              <div className="card-overline">ТВОЁ ПРОСТРАНСТВО</div>
              <h2>{mode === "register" ? (verificationId ? "Подтверди почту" : "Создай аккаунт") : "С возвращением"}</h2>
              <p>
                {mode === "register"
                  ? "Начни общаться по-новому"
                  : "Войди, чтобы продолжить"}
              </p>
            </div>

            <form className="auth-form" onSubmit={submit}>
              {!verificationId && <><label className="field-label">
                Имя пользователя
                <span className="input-wrap">
                  <UserRound size={17} />
                  <input
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="например, alex_dev"
                    required
                    minLength={mode === "register" ? 3 : 1}
                    maxLength={32}
                    pattern={mode === "register" ? "[A-Za-z0-9_]{3,32}" : undefined}
                  />
                </span>
              </label>

              {mode === "register" && <label className="field-label">Электронная почта<span className="input-wrap"><Mail size={17} /><input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" maxLength={320} required /></span></label>}

              <label className="field-label">
                Пароль
                <span className="input-wrap">
                  <LockKeyhole size={17} />
                  <input
                    autoComplete={mode === "register" ? "new-password" : "current-password"}
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === "register" ? "Не менее 8 символов" : "Твой пароль"}
                    required
                    minLength={mode === "register" ? 8 : 1}
                    maxLength={128}
                  />
                  <button
                    className="visibility-toggle"
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </span>
              </label>
              </>}
              {verificationId && <><p className="auth-mail-note">{delivery === "pending" ? "Отправляем код на" : delivery === "failed" ? "Не удалось отправить код на" : "Код отправлен на"} <strong>{email}</strong>. Он действует 10 минут. Проверь также папку «Спам».</p><label className="field-label">Логин<span className="input-wrap"><UserRound size={17} /><input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" required /></span></label><label className="field-label">Код из письма<span className="input-wrap"><Mail size={17} /><input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" required /></span></label><div className="auth-code-actions"><button type="button" disabled={busy || resendWait > 0} onClick={() => void resendCode()}>{resendWait ? `Повторить через ${resendWait} с` : "Отправить ещё раз"}</button><button type="button" disabled={busy} onClick={() => { setVerificationId(null); setCode(""); setError(""); }}>Изменить адрес</button></div></>}

              {error && <div className="form-error" role="alert">{error}</div>}

              <button className="primary-button auth-submit" type="submit" disabled={busy}>
                <span>
                  {busy
                    ? "Секунду..."
                    : mode === "register"
                      ? (verificationId ? "Подтвердить и создать аккаунт" : "Получить код на почту")
                      : "Войти в Coherent"}
                </span>
                <ArrowRight size={17} />
              </button>
            </form>

            <div className="auth-switch">
              {mode === "register" ? "Уже есть аккаунт?" : "Впервые в Coherent?"}
              <button type="button" onClick={toggleMode}>
                {mode === "register" ? "Войти" : "Создать аккаунт"}
              </button>
            </div>

            <div className="card-legal">
              Условия использования и политика конфиденциальности<br />
              будут опубликованы до публичного запуска Coherent.
            </div>
            </>}
          </div>

          <div className="secure-note">
            <span className="secure-lock"><LockKeyhole size={13} /></span>
            Пароль хранится только в виде хеша
          </div>
        </div>
      </section>

      <footer className="auth-footer">
        <span>© 2026 Coherent</span>
        <span>Создано для хороших разговоров</span>
      </footer>
    </main>
  );
}
