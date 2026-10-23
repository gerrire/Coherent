import { useEffect, useRef, useState } from "react";
import { Activity, Database, HardDrive, MessageSquare, RefreshCw, Users, X } from "lucide-react";
import { api, type AdminOverview } from "../lib/api";

interface AdminPanelProps {
  onClose: () => void;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
}

export default function AdminPanel({ onClose }: AdminPanelProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setOverview(await api.adminOverview());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить данные сервера.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    void refresh();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const storagePercent = overview
    ? Math.min(100, Math.round(overview.attachment_bytes / overview.attachment_limit_bytes * 100)) : 0;

  return <div className="admin-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="admin-panel" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="admin-title">
      <header className="admin-header">
        <div><span>УПРАВЛЕНИЕ СЕРВЕРОМ</span><h2 id="admin-title">Админ-панель</h2><p>Состояние сервиса и хранилища вложений.</p></div>
        <div className="admin-header-actions">
          <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Обновить данные"><RefreshCw size={18} /></button>
          <button type="button" onClick={onClose} aria-label="Закрыть панель"><X size={20} /></button>
        </div>
      </header>
      <div className="admin-body">
        {error && <p className="admin-error" role="alert">{error}</p>}
        {!overview && loading && <p className="admin-loading">Загружаем состояние сервера...</p>}
        {overview && <>
          <div className="admin-stats">
            <div><Users size={19} /><span>Пользователи</span><strong>{overview.users}</strong></div>
            <div><MessageSquare size={19} /><span>Беседы</span><strong>{overview.conversations}</strong></div>
            <div><Database size={19} /><span>Сообщения</span><strong>{overview.messages}</strong></div>
            <div><Activity size={19} /><span>Активные звонки</span><strong>{overview.active_calls}</strong></div>
          </div>
          <section className="admin-card">
            <div className="admin-card-title"><HardDrive size={18} /><h3>Файлы и место на диске</h3></div>
            <div className="admin-storage-line"><strong>{formatBytes(overview.attachment_bytes)} из {formatBytes(overview.attachment_limit_bytes)}</strong><span>{storagePercent}%</span></div>
            <div className="admin-storage-track"><i style={{ width: `${storagePercent}%` }} /></div>
            <p>{overview.attachment_count} вложений · лимит одного аккаунта {formatBytes(overview.attachment_user_limit_bytes)} · свободно на сервере {formatBytes(overview.disk_free_bytes)} из {formatBytes(overview.disk_total_bytes)}</p>
            <small>Файлы автоматически удаляются через 3 дня. Для загрузок сохраняется резерв свободного места.</small>
          </section>
          <section className="admin-card">
            <div className="admin-card-title"><Users size={18} /><h3>Новые аккаунты</h3></div>
            <div className="admin-users">{overview.recent_users.map((person) => <div key={person.username}><strong>{person.username}</strong><time dateTime={person.created_at}>{new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(person.created_at))}</time></div>)}</div>
          </section>
        </>}
      </div>
    </div>
  </div>;
}
