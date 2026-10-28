import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function connectAppEvents(
  onOpen: () => void,
  onMessage: (data: string) => void,
  onClose: (code: number) => void,
  userId?: string,
): Promise<() => void> {
  if (!isTauri()) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/conversations/events`);
    let active = true;
    socket.onopen = onOpen;
    socket.onmessage = (event) => onMessage(event.data);
    socket.onclose = (event) => { if (active) { active = false; onClose(event.code); } };
    socket.onerror = () => socket.close();
    return () => { active = false; socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); };
  }

  // Each connection owns its listeners. A stale close/cleanup must never stop
  // its replacement, or reconnects multiply listeners and requests indefinitely.
  const connectionId = crypto.randomUUID();
  const unlisten: UnlistenFn[] = [];
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    unlisten.splice(0).forEach((remove) => remove());
    void invoke("events_disconnect", { connectionId }).catch(() => undefined);
  };
  try {
    unlisten.push(await listen(`coherent:event-open-${connectionId}`, () => { if (active) onOpen(); }));
    unlisten.push(await listen<string>(`coherent:event-${connectionId}`, (event) => {
      if (active) onMessage(event.payload);
    }));
    unlisten.push(await listen(`coherent:event-close-${connectionId}`, () => {
      if (!active) return;
      cleanup();
      onClose(0);
    }));
    await invoke("events_connect", { userId: userId ?? "", connectionId });
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
