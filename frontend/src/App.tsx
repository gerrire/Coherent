import { useEffect, useState } from "react";
import AuthPanel from "./components/AuthPanel";
import ChatShell from "./components/ChatShell";
import { api, ApiError, initializeCsrf, type User } from "./lib/api";
import { isTauri } from "@tauri-apps/api/core";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    let active = true;

    async function restoreSession() {
      try {
        await initializeCsrf();
        const currentUser = await api.me();
        if (active) setUser(currentUser);
      } catch (error) {
        if (active && !(error instanceof ApiError && error.status === 401)) {
          setConnectionError(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    await api.logout().catch(() => undefined);
    setUser(null);
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <span className="loading-mark"><i /><i /><i /></span>
        <span>Открываем Coherent</span>
      </main>
    );
  }

  if (connectionError) {
    return (
      <main className="connection-screen">
        <span className="brand-mark"><span /><span /><span /></span>
        <h1>Не удалось подключиться</h1>
        {isTauri() ? (
          <p>Проверь подключение к интернету и попробуй снова.</p>
        ) : (
          <>
            <p>Запусти API-сервер и обнови страницу.</p>
            <code>uvicorn coherent_api.main:app --reload --app-dir backend/src</code>
          </>
        )}
        <button className="primary-button" onClick={() => window.location.reload()}>
          Попробовать снова
        </button>
      </main>
    );
  }

  return user
    ? <ChatShell user={user} onLogout={logout} />
    : <AuthPanel onAuthenticated={setUser} />;
}
