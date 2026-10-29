import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { processCpu, processReport, processRole, type ProcessMetrics } from "../lib/processMetrics";

const megabytes = (bytes: number | null) => bytes === null ? "—" : `${(bytes / 1048576).toFixed(1)} МБ`;
export default function DesktopResources() {
  const [metrics, setMetrics] = useState<(ProcessMetrics & { cpu: number | null }) | null>(null);
  const [error, setError] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous: { metrics: ProcessMetrics; time: number } | null = null;
    const poll = async () => {
      try {
        const next = await invoke<ProcessMetrics>("desktop_process_metrics");
        const time = performance.now();
        if (!active) return;
        const cpu = previous ? processCpu(previous.metrics, next, time - previous.time) : null;
        setMetrics({ ...next, cpu }); setError(false);
        previous = { metrics: next, time };
      } catch { if (active) setError(true); }
      finally { if (active) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return <section className="desktop-settings-group desktop-resources" aria-label="Ресурсы Coherent">
    <strong>Ресурсы Coherent</strong>
    <p>Общий расход клиента и принадлежащих ему процессов WebView2.</p>
    {error ? <p role="status">Не удалось получить показатели. Повторяем…</p> : <dl>
      <div><dt>Процессы</dt><dd>{metrics?.processes ?? "…"}</dd></div>
      <div><dt>В ОЗУ</dt><dd>{metrics ? megabytes(metrics.residentPrivateBytes) : "…"}</dd></div>
      <div><dt>Выделено</dt><dd>{metrics ? megabytes(metrics.privateBytes) : "…"}</dd></div>
      <div><dt>Процессор</dt><dd>{metrics?.cpu != null ? `${metrics.cpu.toFixed(1)}%` : "…"}</dd></div>
    </dl>}
    {metrics && !metrics.complete && <p role="status">Часть данных недоступна: измерено {metrics.measuredProcesses} из {metrics.processes} процессов. Суммы могут быть неполными.</p>}
    {metrics && <details className="desktop-process-details"><summary>Процессы Coherent · {metrics.processes}</summary>
      <div className="desktop-process-table"><table><thead><tr><th>Процесс</th><th>PID</th><th>В ОЗУ</th><th>Выделено</th></tr></thead>
        <tbody>{metrics.entries.map(entry => <tr key={`${entry.pid}-${entry.createdAt}`}>
          <td>{processRole(entry.kind)}<small>{entry.image}</small></td><td>{entry.pid}</td>
          <td>{megabytes(entry.residentPrivateBytes)}</td><td>{megabytes(entry.privateBytes)}</td>
        </tr>)}</tbody></table></div>
      <p>PID совпадает с идентификатором на вкладке «Подробности» диспетчера задач Windows. Node.js в состав установленного Coherent не входит.</p>
      <button type="button" onClick={() => { void navigator.clipboard.writeText(processReport(metrics)).then(() => setActionStatus("Список скопирован.")).catch(() => setActionStatus("Не удалось скопировать список.")); }}>Скопировать список</button>
    </details>}
    <button type="button" onClick={() => { void invoke("desktop_open_runtime_tasks").then(() => setActionStatus("")).catch(() => setActionStatus("Не удалось открыть диагностику интерфейса.")); }}>Открыть диагностику WebView2</button>
    {actionStatus && <p role="status">{actionStatus}</p>}
    <small>В ОЗУ — частная память в оперативной памяти; «Выделено» включает и выгруженные Windows страницы. Обновление каждые 2 секунды. Windows 11 может показывать WebView2 отдельной группой; здесь учитываются только процессы Coherent.</small>
  </section>;
}
