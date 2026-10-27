import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import SecurityRecoveryCard from "./components/SecurityRecoveryCard";
import { CryptoClient } from "./lib/crypto/client";
import { closeMessaging } from "./lib/crypto/messaging";
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
  const [unlockUser, setUnlockUser] = useState<User | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
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

  useEffect(() => {
    if (!user) return;
    let active = true;
    let client:CryptoClient|null = null;
    void api.securityStatus().then(async status => {
      if (!status.configured || !status.setup_available || status.chat_encryption!=="mls") { if (active) setUnlockPassword(""); return; }
      client = new CryptoClient(user.id);
      const identity = await client.execute({ operation: "identity" });
      const device = identity.result.device as { device_id: string };
      if (active && !status.devices.some(item => item.id === device.device_id)) setUnlockUser(user);
      else if (active) setUnlockPassword("");
    }).catch(() => { if (active) setUnlockPassword(""); }).finally(() => client?.close());
    return () => { active = false; client?.close(); };
  }, [user?.id]);

  function authenticated(next: User, password = "") { setUnlockPassword(password); setUser(next); }

  useEffect(() => {
    if (!user) return;
    const ended = () => {
      closeMessaging(user.id);
      setUnlockUser(null); setUnlockPassword(""); setUser(null);
    };
    window.addEventListener("coherent-session-ended", ended);
    return () => window.removeEventListener("coherent-session-ended", ended);
  }, [user?.id]);

  async function logout() {
    await api.logout().catch(() => undefined);
    if (user) closeMessaging(user.id);
    setUnlockUser(null); setUnlockPassword(""); setUser(null);
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
    : <AuthPanel onAuthenticated={authenticated} />}
    {unlockUser && <div className="device-unlock-backdrop"><div className="device-unlock-dialog" role="dialog" aria-modal="true" aria-label="Подтверждение устройства"><h2>Новое устройство</h2><p>Вход в аккаунт выполнен. Для доступа к личной переписке подтверди это устройство.</p><SecurityRecoveryCard user={unlockUser} initialPassword={unlockPassword} onComplete={() => { setUnlockUser(null); setUnlockPassword(""); window.dispatchEvent(new Event("coherent-security-changed")); }} /></div></div>}
  </>;
}

export default function App() {
  if (isTauri()) {
    const windowMode = new URLSearchParams(window.location.search).get("window");
    if (windowMode === "incoming-call") return <IncomingCallWindow />;
  }
  return <>{isTauri() && <><DesktopTitleBar /><DesktopUpdateNotice /></>}<MainApp />{isTauri() && <DesktopMediaConsent />}</>;
}
