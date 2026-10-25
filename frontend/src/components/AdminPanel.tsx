import { useEffect, useRef, useState } from "react";
import { Activity, Database, HardDrive, MessageSquare, RefreshCw, Users, X } from "lucide-react";
import { api, type AdminOverview, type ServerMetricSample } from "../lib/api";

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
  const [samples, setSamples] = useState<ServerMetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshing = useRef(false);

  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    setError("");
    try {
      const [next, metrics] = await Promise.all([api.adminOverview(), api.adminMetrics()]);
      setOverview(next);
      setSamples(metrics.samples);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить данные сервера.");
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(timer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const storagePercent = overview
    ? Math.min(100, Math.round(overview.attachment_bytes / overview.attachment_limit_bytes * 100)) : 0;
  const latest = samples.at(-1);

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
            <div className="admin-card-title"><Activity size={18} /><h3>Нагрузка VPS</h3><span className="metric-live-label">Каждые 10 сек.</span></div>
            <div className="admin-metrics-grid">
              <MetricGraph title="Процессор" value={latest?.cpu_percent} points={samples.map((point) => point.cpu_percent)} />
              <MetricGraph title="Оперативная память" value={latest?.memory_percent} points={samples.map((point) => point.memory_percent)} />
            </div>
            <div className="admin-runtime-details">
              <span>В сети <strong>{overview.online_users}</strong></span>
              <span>Нагрузка <strong>{latest?.load_average?.map((value) => value.toFixed(2)).join(" / ") ?? "—"}</strong></span>
              <span>CPU <strong>{latest?.cpu_count ?? "—"}</strong></span>
              <span>VPS работает <strong>{latest?.host_uptime_seconds != null ? `${Math.floor(latest.host_uptime_seconds / 3600)} ч` : "—"}</strong></span>
            </div>
            {latest?.memory_total_bytes != null && <small>RAM: {formatBytes(latest.memory_used_bytes ?? 0)} из {formatBytes(latest.memory_total_bytes)}. Графики показывают последние 20 минут с момента запуска API.</small>}
          </section>
          <section className="admin-card">
            <div className="admin-card-title"><HardDrive size={18} /><h3>Файлы и место на диске</h3></div>
            <div className="admin-storage-line"><strong>{formatBytes(overview.attachment_bytes)} из {formatBytes(overview.attachment_limit_bytes)}</strong><span>{storagePercent}%</span></div>
            <div className="admin-storage-track"><i style={{ width: `${storagePercent}%` }} /></div>
            <p>{overview.attachment_count} вложений · свободно на сервере {formatBytes(overview.disk_free_bytes)} из {formatBytes(overview.disk_total_bytes)}</p>
            <small>Общий лимит для всех пользователей — {formatBytes(overview.attachment_limit_bytes)}. После его достижения загрузки приостанавливаются до освобождения места. Файлы автоматически удаляются через 3 дня; для загрузок сохраняется резерв свободного места.</small>
          </section>
          <section className="admin-card"><h3>Облачное шифрование</h3><p>{overview.cloud_encryption_enabled ? "Новые сообщения и вложения шифруются ключом вне базы данных." : "Ключ ещё не подключён. Новое шифрование пока выключено."}</p><small>Осталось перенести старых сообщений: {overview.legacy_plaintext_messages}. Старых незашифрованных вложений: {overview.legacy_plaintext_attachments}; они удаляются по сроку хранения. Сервер имеет доступ к облачной истории — это не E2EE.</small></section>
          <section className="admin-card">
            <div className="admin-card-title"><Users size={18} /><h3>Новые аккаунты</h3></div>
            <div className="admin-users">{overview.recent_users.map((person) => <div key={person.username}><strong>{person.username}</strong><time dateTime={person.created_at}>{new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(person.created_at))}</time></div>)}</div>
          </section>
        </>}
      </div>
    </div>
  </div>;
}

function MetricGraph({ title, value, points }: { title: string; value?: number | null; points: Array<number | null> }) {
  const values = points.map((point, index) => point == null ? null : `${index / Math.max(1, points.length - 1) * 280},${76 - point * .68}`);
  const lines: string[] = [];
  let current: string[] = [];
  values.forEach((point) => { if (point == null) { if (current.length) lines.push(current.join(" ")); current = []; } else current.push(point); });
  if (current.length) lines.push(current.join(" "));
  return <div className="admin-metric"><div><span>{title}</span><strong>{value == null ? "—" : `${value.toFixed(1)}%`}</strong></div><svg viewBox="0 0 280 84" role="img" aria-label={`${title}: ${value == null ? "собираем данные" : `${value}%`}`}><path d="M0 8H280 M0 42H280 M0 76H280" className="metric-guides" />{lines.map((line, index) => <polyline key={index} points={line} className="metric-line" />)}</svg></div>;
}
