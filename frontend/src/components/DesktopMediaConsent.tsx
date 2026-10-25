import { useEffect, useRef, useSyncExternalStore } from "react";
import { Camera, Mic } from "lucide-react";
import { answerMediaAccess, getMediaAccessRequest, subscribeMediaAccess } from "../lib/desktopPermissions";
import "./desktop-media-consent.css";

export default function DesktopMediaConsent() {
  const request = useSyncExternalStore(subscribeMediaAccess, getMediaAccessRequest);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [request]);
  if (!request) return null;
  const name = request.camera && request.microphone ? "камере и микрофону" : request.camera ? "камере" : "микрофону";
  return <div className="desktop-consent-backdrop" onKeyDown={event => {
    if (event.key === "Escape") answerMediaAccess(false);
    if (event.key === "Tab") {
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons[1]) { event.preventDefault(); buttons[0]?.focus(); }
    }
  }}>
    <section className="desktop-consent" role="dialog" aria-modal="true" aria-labelledby="media-consent-title" aria-describedby="media-consent-description">
      <span className="desktop-consent-icon">{request.camera ? <Camera size={26} /> : <Mic size={26} />}</span>
      <h2 id="media-consent-title">Разрешить доступ к {name}?</h2>
      <p id="media-consent-description">Coherent использует устройства для звонков, когда ты их включаешь. Доступ можно отозвать в настройках приложения.</p>
      <div><button ref={cancel} onClick={() => answerMediaAccess(false)}>Не сейчас</button><button className="primary-button" onClick={() => answerMediaAccess(true)}>Разрешить</button></div>
    </section>
  </div>;
}
