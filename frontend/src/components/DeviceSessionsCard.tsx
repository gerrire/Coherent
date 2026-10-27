import { useEffect, useState } from "react";
import { LogOut, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { api, type DeviceSession } from "../lib/api";

function deviceName(agent: string): string {
  if (agent.includes("CoherentDesktop/")) return "Windows · Когерент";
  const os = /iPhone/.test(agent) ? "iPhone" : /iPad/.test(agent) ? "iPad"
    : /Android/.test(agent) ? "Android" : /Windows/.test(agent) ? "Windows"
      : /Macintosh/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "Устройство";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox"
    : /Chrome\/|CriOS\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Когерент";
  return `${os} · ${browser}`;
}

export default function DeviceSessionsCard() {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    setError("");
    try { setSessions((await api.sessions()).sessions); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось загрузить сессии"); }
    finally { setLoaded(true); }
  }
  useEffect(() => { void refresh(); }, []);

  async function terminate(item: DeviceSession) {
    setBusy(item.id); setError("");
    try {
      await api.terminateSession(item.id);
      setSessions(current => current.filter(row => row.id !== item.id));
      if (item.current) window.dispatchEvent(new Event("coherent-session-ended"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось завершить сессию"); }
    finally { setBusy(null); }
  }

  return <section className="profile-settings-card" aria-label="Сессии устройств">
    <div className="profile-settings-section-heading"><Monitor size={18} /><h3>Устройства и сессии</h3><button className="session-refresh" type="button" onClick={() => void refresh()} aria-label="Обновить сессии"><RefreshCw size={16} /></button></div>
    <p>Заверши отдельную сессию, чтобы потребовать повторный вход на этом устройстве. Доверие к ключам устройства управляется отдельно. Сессии, открытые до этого обновления, появятся после следующего обращения к серверу.</p>
    {!loaded && <p role="status">Загружаем сессии…</p>}
    <div className="device-sessions">{sessions.map(item => <div className="device-session" key={item.id}>
      {/iPhone|iPad|Android/.test(item.agent) ? <Smartphone size={21} /> : <Monitor size={21} />}
      <div className="device-session-info"><strong>{deviceName(item.agent)}{item.current && <span>Текущая</span>}</strong><small>Последняя активность: {new Date(item.last_seen_at).toLocaleString("ru-RU")}</small><small>Вход: {new Date(item.created_at).toLocaleString("ru-RU")}</small></div>
      <button type="button" disabled={busy !== null} onClick={() => void terminate(item)} aria-label={`Завершить сессию: ${deviceName(item.agent)}${item.current ? " (текущая)" : ""}`}><LogOut size={16} /><span>{busy === item.id ? "Завершаем…" : "Завершить"}</span></button>
    </div>)}</div>
    {error && <p className="profile-settings-error" role="alert">{error}</p>}
  </section>;
}
