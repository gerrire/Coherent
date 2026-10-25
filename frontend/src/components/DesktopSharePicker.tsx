import { useEffect, useMemo, useState } from "react";
import { AppWindow, ArrowLeft, Chrome, Layers3, Monitor, Search, X } from "lucide-react";
import { screenPreview, screenSources, type ScreenSource } from "../lib/nativeScreenShare";
import { invoke } from "@tauri-apps/api/core";
import "./desktop-share-picker.css";

type Category = "monitor" | "window" | "application" | "tab";
const categories: { id: Category; title: string; description: string; icon: typeof Monitor }[] = [
  { id: "monitor", title: "Экран", description: "Всё, что видно на мониторе", icon: Monitor },
  { id: "window", title: "Окно", description: "Только выбранное окно", icon: AppWindow },
  { id: "application", title: "Приложение", description: "Выбрать программу и её окно", icon: Layers3 },
  { id: "tab", title: "Вкладка", description: "Отдельная вкладка браузера", icon: Chrome },
];
const applicationName = (source: ScreenSource) => source.appName?.replace(/\.exe$/i, "") || "Другое приложение";

export default function DesktopSharePicker({ onChoose, onClose, busy }: {
  onChoose: (source: ScreenSource) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  const [application, setApplication] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [borderBusy, setBorderBusy] = useState(false);
  const [borderless, setBorderless] = useState(false);
  const [borderStatus, setBorderStatus] = useState("");

  async function changeBorder(enabled: boolean) {
    setBorderBusy(true);
    setBorderStatus("");
    try {
      const allowed = await invoke<boolean>("desktop_screen_borderless", { enabled });
      setBorderless(allowed);
      setBorderStatus(enabled && !allowed ? "Windows оставила рамку. Разрешение можно изменить в настройках захвата Windows." : allowed ? "Рамка отключена с разрешения Windows." : "");
    } catch (reason) {
      setBorderless(false);
      setBorderStatus(reason instanceof Error ? reason.message : String(reason));
    } finally { setBorderBusy(false); }
  }

  useEffect(() => {
    void invoke<boolean>("desktop_screen_borderless_status").then(setBorderless).catch(() => undefined);
    let alive = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const list = await screenSources();
        if (!alive) return;
        setSources(list);
        setError(list.length === 0 ? "Нет доступных экранов и окон." : "");
        setSelected(previous => previous && list.some(source => source.id === previous) ? previous : null);
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : "Не удалось получить список экранов.");
      } finally { refreshing = false; if (alive) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    window.addEventListener("focus", refresh);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);

  const chosen = sources.find((source) => source.id === selected);
  const minimized = chosen?.minimized ?? false;
  useEffect(() => {
    setPreview(null);
    if (!selected || minimized) { setLoadingPreview(false); return; }
    let alive = true;
    setLoadingPreview(true);
    const request = screenPreview(selected);
    void request.result.then((jpeg) => {
      if (alive) setPreview(`data:image/jpeg;base64,${jpeg}`);
    }).catch(() => { if (alive) setPreview(null); })
      .finally(() => { if (alive) setLoadingPreview(false); });
    return () => { alive = false; request.cancel(); };
  }, [selected, minimized]);

  const windows = useMemo(() => sources.filter((source) => source.kind === "window"), [sources]);
  const applications = useMemo(() => [...new Set(windows.map(applicationName))].sort((a, b) => a.localeCompare(b, "ru")), [windows]);
  const visibleSources = sources.filter((source) => {
    if (category === "monitor") return source.kind === "monitor";
    if (category === "window") return source.kind === "window";
    if (category === "application") return source.kind === "window" && applicationName(source) === application;
    return false;
  }).filter((source) => source.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visibleApps = applications.filter((name) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  function chooseCategory(next: Category) {
    setCategory(next); setApplication(null); setSelected(null); setPreview(null); setSearch("");
  }
  function back() {
    if (category === "application" && application) setApplication(null);
    else setCategory(null);
    setSelected(null); setPreview(null); setSearch("");
  }

  const choosingSources = category === "monitor" || category === "window" || (category === "application" && application !== null);
  const heading = category === "application" && application ? application : category ? categories.find((item) => item.id === category)?.title : "Что показать участникам?";

  return <div className="desktop-share-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="desktop-share-picker" role="dialog" aria-modal="true" aria-label="Выбор источника демонстрации">
      <header className="desktop-share-header">
        <div className="desktop-share-heading">
          {category && <button onClick={back} disabled={busy} aria-label="Назад"><ArrowLeft size={18} /></button>}
          <div><span>Демонстрация экрана</span><h2>{heading}</h2></div>
        </div>
        <button onClick={onClose} disabled={busy} aria-label="Закрыть"><X size={19} /></button>
      </header>
      {!category ? <div className="desktop-share-categories">
        {categories.map(({ id, title, description, icon: Icon }) => <button key={id} onClick={() => chooseCategory(id)}>
          <span className="desktop-share-category-icon"><Icon size={23} /></span>
          <strong>{title}</strong><small>{description}</small>
        </button>)}
      </div> : category === "tab" ? <div className="desktop-share-tab-note">
        <Chrome size={32} /><h3>Вкладки пока недоступны отдельно</h3>
        <p>Windows захватывает окно браузера целиком. Чтобы показать сайт, выберите «Окно» и нужное окно браузера.</p>
        <button onClick={() => chooseCategory("window")}>Выбрать окно</button>
      </div> : <>
        <div className="desktop-share-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={category === "application" && !application ? "Найти приложение" : "Найти окно или экран"} aria-label="Поиск источника" /></div>
        <div className="desktop-share-body">
          <div className="desktop-share-sources">
            {category === "application" && !application
              ? visibleApps.map((name) => <button key={name} onClick={() => { setApplication(name); setSearch(""); }}><Layers3 size={19} /><span>{name}</span><small>{windows.filter((source) => applicationName(source) === name).length} окон</small></button>)
              : visibleSources.map((source) => <button key={source.id} className={selected === source.id ? "selected" : ""} onClick={() => setSelected(source.id)}>
                {source.kind === "monitor" ? <Monitor size={19} /> : <AppWindow size={19} />}
                <span>{source.name}</span><small>{source.minimized ? "Свёрнуто · " : ""}{source.width} × {source.height}</small>
              </button>)}
            {!loading && (choosingSources ? visibleSources.length === 0 : visibleApps.length === 0) && <p className="desktop-share-empty">Ничего не найдено</p>}
            {loading && <p className="desktop-share-empty">Ищем доступные источники…</p>}
          </div>
          <div className="desktop-share-preview">
            {preview ? <img src={preview} alt={`Предпросмотр: ${chosen?.name ?? "экран"}`} /> : <div className="desktop-share-placeholder">{minimized ? "Окно свёрнуто. После нажатия «Показать» оно будет восстановлено для захвата." : loadingPreview ? "Получаем изображение…" : choosingSources ? "Выберите источник для предпросмотра" : "Выберите приложение"}</div>}
            {chosen && <p title={chosen.name}>{chosen.name}</p>}
          </div>
        </div>
      </>}
      {error && <p className="desktop-share-error" role="alert">{error}</p>}
      <div className="desktop-share-border-option"><label><input type="checkbox" checked={borderless} disabled={busy || borderBusy} onChange={event => void changeBorder(event.target.checked)} />Убрать жёлтую рамку захвата</label><small>{borderBusy ? "Ожидаем разрешение Windows…" : borderStatus || "Windows может запросить подтверждение."}</small></div>
      <footer><span>Захват выполняет Windows. Звук компьютера настраивается отдельно.</span><button className="desktop-share-cancel" onClick={onClose} disabled={busy || borderBusy}>Отмена</button><button className="desktop-share-confirm" onClick={() => { if (chosen) onChoose(chosen); }} disabled={!chosen || busy || borderBusy}>{busy ? "Подключаем…" : "Показать"}</button></footer>
    </section>
  </div>;
}
