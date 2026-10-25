import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, initializeCsrf, type Call } from "../lib/api";
import IncomingCallCard from "./IncomingCallCard";
import "./desktop-windows.css";

export default function IncomingCallWindow() {
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const currentId = useRef<string | null>(null);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const theme = await invoke<string>("desktop_theme_get");
      document.documentElement.dataset.theme = theme;
      const nextId = await invoke<string | null>("desktop_current_call_overlay_id");
      if (nextId !== currentId.current) {
        currentId.current = nextId;
        setBusy(false);
        setError("");
      }
      if (!nextId) { setCall(null); return; }
      setCall((current) => current?.id === nextId ? current : null);
      const result = await api.currentCalls();
      if (await invoke<string | null>("desktop_current_call_overlay_id") !== nextId) return;
      const incoming = result.calls.find((item) => item.id === nextId
        && item.participants.some((participant) => participant.state === "invited"));
      if (!incoming) {
        await invoke("desktop_close_call_overlay", { callId: nextId });
        return;
      }
      setCall(incoming);
      setError("");
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    let active = true;
    let timer = 0;
    void initializeCsrf().then(() => refresh()).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось подключиться к звонку.");
    });
    timer = window.setInterval(() => {
      if (active) void refresh().catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Не удалось обновить состояние звонка.");
      });
    }, 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);

  async function finish(accept: boolean) {
    if (!call || busy) return;
    setBusy(true);
    setError("");
    try {
      if (accept) await api.acceptCall(call.id);
      else await api.endCall(call.id);
      await emit("desktop-call-updated", { callId: call.id });
      await invoke("desktop_close_call_overlay", { callId: call.id });
      if (accept) await invoke("desktop_show_main");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось обработать звонок.");
      setBusy(false);
    } finally {
      setBusy(false);
    }
  }

  return <main className="desktop-incoming-overlay" role="dialog" aria-modal="true" aria-label="Входящий звонок">
    <IncomingCallCard caller={call?.caller_username ?? (error ? "Звонок недоступен" : "Подключаемся…")}
      error={error} busy={!call || busy} onRetry={() => { void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось обновить звонок.")); }} onDecline={() => void finish(false)} onAccept={() => void finish(true)} />
  </main>;
}
