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
    socket.onopen = onOpen;
    socket.onmessage = (event) => onMessage(event.data);
    socket.onclose = (event) => onClose(event.code);
    socket.onerror = () => socket.close();
    return () => socket.close();
  }

  const unlisten: UnlistenFn[] = [];
  let active = true;
  try {
    unlisten.push(await listen("coherent:event-open", () => { if (active) onOpen(); }));
    unlisten.push(await listen<string>("coherent:event", (event) => {
      if (active) onMessage(event.payload);
    }));
    unlisten.push(await listen("coherent:event-close", () => {
      if (active) onClose(0);
    }));
    await invoke("events_connect", { userId: userId ?? "" });
  } catch (error) {
    unlisten.forEach((remove) => remove());
    throw error;
  }
  return () => {
    active = false;
    unlisten.forEach((remove) => remove());
    void invoke("events_disconnect");
  };
}
