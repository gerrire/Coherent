import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Sparkles,
  UserRound,
} from "lucide-react";
import { api, type User } from "../lib/api";

interface AuthPanelProps {
  onAuthenticated: (user: User) => void;
}

export default function AuthPanel({ onAuthenticated }: AuthPanelProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const result = mode === "register"
        ? await api.register({ username, password })
        : await api.login({ username, password });
      onAuthenticated(result.user);
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
            <div className="card-heading">
              <div className="card-icon"><LockKeyhole size={20} /></div>
              <div className="card-overline">ТВОЁ ПРОСТРАНСТВО</div>
              <h2>{mode === "register" ? "Создай аккаунт" : "С возвращением"}</h2>
              <p>
                {mode === "register"
                  ? "Начни общаться по-новому"
                  : "Войди, чтобы продолжить"}
              </p>
            </div>

            <form className="auth-form" onSubmit={submit}>
              <label className="field-label">
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
                  />
                </span>
              </label>

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

              {error && <div className="form-error" role="alert">{error}</div>}

              <button className="primary-button auth-submit" type="submit" disabled={busy}>
                <span>
                  {busy
                    ? "Секунду..."
                    : mode === "register"
                      ? "Создать аккаунт"
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
