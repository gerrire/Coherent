import { useModalFocus } from "../lib/useModalFocus";
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

  useModalFocus(dialogRef, onClose);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
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
            {latest?.memory_total_bytes != null && <small>RAM: {formatBytes(latest.memory_used_bytes ?? 0)} из {formatBytes(latest.memory_total_bytes)}. История сохраняется после перезапуска. Показаны последние сутки; срок хранения — 7 дней.</small>}
          </section>
          <section className="admin-card">
            <div className="admin-card-title"><HardDrive size={18} /><h3>Файлы и место на диске</h3></div>
            <div className="admin-storage-line"><strong>{formatBytes(overview.attachment_bytes)} из {formatBytes(overview.attachment_limit_bytes)}</strong><span>{storagePercent}%</span></div>
            <div className="admin-storage-track"><i style={{ width: `${storagePercent}%` }} /></div>
            <p>{overview.attachment_count} вложений · свободно на сервере {formatBytes(overview.disk_free_bytes)} из {formatBytes(overview.disk_total_bytes)}</p>
            <small>Общий лимит для всех пользователей — {formatBytes(overview.attachment_limit_bytes)}. После его достижения загрузки приостанавливаются до освобождения места. Файлы автоматически удаляются через 3 дня; для загрузок сохраняется резерв свободного места.</small>
          </section>
          <section className="admin-card"><h3>Защищённая переписка</h3><p>{formatBytes(overview.e2ee_storage_bytes)} из {formatBytes(overview.e2ee_storage_limit_bytes)}</p><div className="admin-storage-track"><i style={{width:`${Math.min(100,overview.e2ee_storage_bytes / overview.e2ee_storage_limit_bytes * 100)}%`}} /></div>{overview.e2ee_storage_bytes > overview.e2ee_storage_limit_bytes * .8 && <p role="alert">Хранилище E2EE близко к пределу. Проверь рост данных заранее.</p>}<small>Старых личных сообщений в облачном формате: {overview.pending_private_migration}. Их переносят устройства авторов. Просроченные служебные пакеты очищаются автоматически.</small></section>
          <section className="admin-card"><h3>Работа API и сеть</h3><div className="admin-runtime-details"><span>Запросов за минуту <strong>{latest?.api_requests_minute ?? "—"}</strong></span><span>Ошибок сервера <strong>{latest?.api_errors_minute ?? "—"}</strong></span><span>95% запросов быстрее <strong>{latest?.api_p95_ms != null ? `${latest.api_p95_ms.toFixed(0)} мс` : "—"}</strong></span><span>Приём <strong>{latest?.network_receive_bps != null ? `${formatBytes(latest.network_receive_bps)}/с` : "—"}</strong></span><span>Передача <strong>{latest?.network_send_bps != null ? `${formatBytes(latest.network_send_bps)}/с` : "—"}</strong></span></div><small>Сетевой счётчик относится к сетевому пространству API. Он не измеряет отдельно медиатрафик LiveKit.</small></section>
          <section className="admin-card"><h3>Резервное копирование</h3>{overview.backup?.last_success_at ? <p>Последняя копия БД: {new Date(overview.backup.last_success_at).toLocaleString("ru-RU")} · {formatBytes(overview.backup.bytes ?? 0)}</p> : <p>Нет подтверждённого отчёта о последней копии.</p>}{overview.backup?.offsite_last_success_at ? <p>Зашифрованная копия вне VPS: {new Date(overview.backup.offsite_last_success_at).toLocaleString("ru-RU")} · {formatBytes(overview.backup.offsite_bytes ?? 0)}</p> : <p>Внешняя копия ещё не подтверждена.</p>}{overview.backup?.restore_checked_at && <p>Восстановление проверено: {new Date(overview.backup.restore_checked_at).toLocaleString("ru-RU")}</p>}<small>Время внешней копии обновляется только после успешного сохранения на другом компьютере.</small></section>
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
