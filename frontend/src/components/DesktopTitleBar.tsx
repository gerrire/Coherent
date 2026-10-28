import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Minus, RefreshCw, Square, X } from "lucide-react";
import { checkForUpdates, getUpdateState, subscribeUpdate } from "../lib/desktop";
import { DesktopUpdateSettings } from "./DesktopUpdates";
import "./desktop-titlebar.css";

export default function DesktopTitleBar() {
  const window = useMemo(() => getCurrentWindow(), []);
  const [maximized, setMaximized] = useState(false);
  const [nativeHover, setNativeHover] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const update = useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
  const header = useRef<HTMLElement>(null);
  const updatePanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const listener = window.listen<boolean>("desktop-caption-hover", event => setNativeHover(event.payload));
    const observer = new ResizeObserver(() => {
      void invoke("desktop_window_frame_set_visible", { visible: Boolean(header.current?.getBoundingClientRect().height) }).catch(() => undefined);
    });
    if (header.current) observer.observe(header.current);
    return () => { observer.disconnect(); void listener.then(dispose => dispose()); };
  }, [window]);

  useEffect(() => {
    if (!updatesOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setUpdatesOpen(false); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".desktop-titlebar-update, .desktop-titlebar-updates")) setUpdatesOpen(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    updatePanel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [updatesOpen]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void window.isMaximized().then(setMaximized).catch(() => undefined);
    void window.onResized(() => { void window.isMaximized().then(setMaximized).catch(() => undefined); })
      .then((dispose) => { if (disposed) dispose(); else unlisten = dispose; })
      .catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [window]);

  return <header ref={header} className="desktop-titlebar" onMouseDown={(event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest("button, .desktop-titlebar-updates")) return;
    event.preventDefault();
    if (event.detail === 2) void window.toggleMaximize();
    else void window.startDragging();
  }}>
    <span className="desktop-titlebar-brand">
      <span className="desktop-titlebar-mark"><i /><i /><i /></span>
      <span>Coherent</span>
    </span>
    <span className="desktop-titlebar-caption">Сообщения и звонки</span>
    <div className="desktop-titlebar-controls">
      <button type="button" className={`desktop-titlebar-update ${update.available ? "has-update" : ""}`} aria-label="Проверить обновления" title={update.available ? "Доступно обновление" : "Проверить обновления"} aria-expanded={updatesOpen} aria-controls="titlebar-updates" onClick={() => { setUpdatesOpen(open => !open); if (!updatesOpen) void checkForUpdates(); }}><RefreshCw size={15} className={update.phase === "checking" ? "desktop-update-spin" : ""} />{update.available && <i />}</button>
      <button type="button" aria-label="Свернуть" title="Свернуть" onClick={() => void window.minimize()}><Minus size={15} /></button>
      <button type="button" className={nativeHover ? "native-hover" : ""} aria-label={maximized ? "Восстановить" : "Развернуть"} title={maximized ? "Восстановить" : "Развернуть"} onClick={() => void window.toggleMaximize()}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
      <button type="button" className="desktop-titlebar-close" aria-label="Закрыть" title="Закрыть" onClick={() => void window.close()}><X size={16} /></button>
    </div>
    {updatesOpen && <div ref={updatePanel} id="titlebar-updates" className="desktop-titlebar-updates" role="region" aria-label="Обновления Coherent">
      <button type="button" className="desktop-titlebar-updates-close" aria-label="Закрыть панель обновлений" onClick={() => setUpdatesOpen(false)}><X size={16} /></button>
      <DesktopUpdateSettings />
    </div>}
  </header>;
}
