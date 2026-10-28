import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { messageMenuPosition } from "../lib/messageMenuPosition";

export default function MessageActionsMenu({ messageId, children }: { messageId: string; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const bubble = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find(row => row.dataset.messageId === messageId)?.querySelector<HTMLElement>(".message-entry");
    if (!bubble || !menu.current) return;
    const place = () => {
      if (!menu.current) return;
      setPosition(messageMenuPosition(bubble.getBoundingClientRect(), menu.current.getBoundingClientRect(), {
        width: document.documentElement.clientWidth, height: window.innerHeight,
        topInset: document.documentElement.classList.contains("tauri-main-window") ? 36 : 0,
      }));
    };
    place();
    menu.current.querySelector<HTMLButtonElement>("button")?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(bubble); observer.observe(menu.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [messageId]);
  return createPortal(<div ref={menu} className="message-actions-menu message-actions-floating" style={position} role="group" aria-label="Действия с сообщением">{children}</div>, document.body);
}
