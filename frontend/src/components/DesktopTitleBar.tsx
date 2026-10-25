import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Minus, Square, X } from "lucide-react";
import "./desktop-titlebar.css";

export default function DesktopTitleBar() {
  const window = useMemo(() => getCurrentWindow(), []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void window.isMaximized().then(setMaximized).catch(() => undefined);
    void window.onResized(() => { void window.isMaximized().then(setMaximized).catch(() => undefined); })
      .then((dispose) => { if (disposed) dispose(); else unlisten = dispose; })
      .catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [window]);

  return <header className="desktop-titlebar" onMouseDown={(event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    if (event.detail === 2) void window.toggleMaximize();
    else void invoke("desktop_window_drag", { x: event.clientX, y: event.clientY });
  }}>
    <span className="desktop-titlebar-brand">
      <span className="desktop-titlebar-mark"><i /><i /><i /></span>
      <span>Coherent</span>
    </span>
    <span className="desktop-titlebar-caption">Сообщения и звонки</span>
    <div className="desktop-titlebar-controls">
      <button type="button" aria-label="Свернуть" title="Свернуть" onClick={() => void window.minimize()}><Minus size={15} /></button>
      <button type="button" aria-label={maximized ? "Восстановить" : "Развернуть"} title={maximized ? "Восстановить" : "Развернуть"} onClick={() => void window.toggleMaximize()}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
      <button type="button" className="desktop-titlebar-close" aria-label="Закрыть" title="Закрыть" onClick={() => void window.close()}><X size={16} /></button>
    </div>
  </header>;
}
