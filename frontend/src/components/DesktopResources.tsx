import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Metrics = { processes: number; privateBytes: number; workingBytes: number; cpuMs: number; logicalProcessors: number };
export default function DesktopResources() {
  const [metrics, setMetrics] = useState<(Metrics & { cpu: number | null }) | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous: { metrics: Metrics; time: number } | null = null;
    const poll = async () => {
      try {
        const next = await invoke<Metrics>("desktop_process_metrics");
        const time = performance.now();
        if (!active) return;
        const cpu = previous ? Math.min(100, Math.max(0, (next.cpuMs - previous.metrics.cpuMs) / (time - previous.time) / next.logicalProcessors * 100)) : null;
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
    <p>Клиент и все его окна WebView2 вместе.</p>
    {error ? <p role="status">Не удалось получить показатели. Повторяем…</p> : <dl>
      <div><dt>Процессы</dt><dd>{metrics?.processes ?? "…"}</dd></div>
      <div><dt>Память</dt><dd>{metrics ? `${Math.round(metrics.privateBytes / 1048576)} МБ` : "…"}</dd></div>
      <div><dt>Процессор</dt><dd>{metrics?.cpu != null ? `${metrics.cpu.toFixed(1)}%` : "…"}</dd></div>
    </dl>}
    <small>Память — сумма частных выделений процессов. Показатели обновляются каждые 2 секунды; Windows может отображать WebView2 отдельной группой.</small>
  </section>;
}
