import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import AuthPanel from "./components/AuthPanel";
import ChatShell from "./components/ChatShell";
import IncomingCallWindow from "./components/IncomingCallWindow";
import DesktopTitleBar from "./components/DesktopTitleBar";
import DesktopMediaConsent from "./components/DesktopMediaConsent";
import ClientSettingsDialog, { type ClientSettingsSection } from "./components/ClientSettingsDialog";
import { loadMediaPreferences, saveMediaPreferences, type MediaPreferences } from "./lib/media";
import { api, ApiError, initializeCsrf, type User } from "./lib/api";
import { startUpdateWatcher } from "./lib/desktop";
import { DesktopUpdateNotice } from "./components/DesktopUpdates";

function MainApp() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [offlineSection, setOfflineSection] = useState<ClientSettingsSection | null>(null);
  const [offlineMedia, setOfflineMedia] = useState(loadMediaPreferences);

  async function changeOfflineMedia(patch: Partial<MediaPreferences>) {
    const next = { ...offlineMedia, ...patch };
    saveMediaPreferences(next);
    setOfflineMedia(next);
  }

  useEffect(() => {
    startUpdateWatcher();
    let active = true;
    const loadingTimeout = window.setTimeout(() => {
      if (!active) return;
      active = false;
      setConnectionError(true);
      setLoading(false);
    }, 20000);

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
        window.clearTimeout(loadingTimeout);
        if (active) setLoading(false);
      }
    }

    void restoreSession();
    return () => {
      active = false;
      window.clearTimeout(loadingTimeout);
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
      <><main className="connection-screen">
        <span className="brand-mark"><span /><span /><span /></span>
        <h1>Не удалось подключиться</h1>
        <p>{isTauri() ? "Проверь подключение к интернету и попробуй снова." : "Запусти API-сервер и обнови страницу."}</p>
        {!isTauri() && <code>uvicorn coherent_api.main:app --reload --app-dir backend/src</code>}
        <button className="primary-button" onClick={() => window.location.reload()}>
          Попробовать снова
        </button>
        {isTauri() && <button className="connection-settings-button" onClick={() => setOfflineSection("desktop")}>Настройки приложения</button>}
      </main>
      {offlineSection && <ClientSettingsDialog section={offlineSection} onSectionChange={setOfflineSection} media={offlineMedia}
        audioProcessingState={null} onMediaChange={changeOfflineMedia} onClose={() => setOfflineSection(null)} />}</>
    );
  }

  return <>{user
    ? <ChatShell user={user} onLogout={logout} onUserChange={setUser} />
    : <AuthPanel onAuthenticated={setUser} />}</>;
}

export default function App() {
  if (isTauri()) {
    const windowMode = new URLSearchParams(window.location.search).get("window");
    if (windowMode === "incoming-call") return <IncomingCallWindow />;
  }
  return <>{isTauri() && <><DesktopTitleBar /><DesktopUpdateNotice /></>}<MainApp />{isTauri() && <DesktopMediaConsent />}</>;
}
