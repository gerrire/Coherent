import { invoke, isTauri } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export interface DesktopSettings {
  closeToTray: boolean;
  showNotifications: boolean;
  notificationSound: boolean;
  raiseOnCall: boolean;
  closeToTrayConfigured?: boolean;
  notificationsConfigured?: boolean;
}

export const defaultDesktopSettings: DesktopSettings = {
  closeToTray: true,
  showNotifications: true,
  notificationSound: true,
  raiseOnCall: true,
  closeToTrayConfigured: true,
  notificationsConfigured: true,
};

export async function getDesktopSettings(): Promise<DesktopSettings> {
  return isTauri() ? invoke<DesktopSettings>("desktop_settings_get") : defaultDesktopSettings;
}

export async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  if (isTauri()) await invoke("desktop_settings_set", { settings });
}

export async function getAutostart(): Promise<boolean> {
  return isTauri() && await isEnabled();
}

export async function setAutostart(value: boolean): Promise<void> {
  if (!isTauri()) return;
  if (value) await enable();
  else await disable();
}

export async function desktopNotify(title: string, body: string, kind: "message" | "friend" | "call"): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("desktop_notify", { title, body, kind });
  } catch {
    // The in-app notification stays visible if the OS blocks its toast.
  }
}

export async function requestDesktopNotifications(): Promise<boolean> {
  if (!isTauri()) return false;
  // Windows manages app notification access in system settings; no WebView permission prompt is needed.
  return true;
}

export async function sendDesktopTestNotification(): Promise<void> {
  if (!isTauri()) throw new Error("Системные уведомления доступны в приложении Windows.");
  await invoke("desktop_send_test_notification");
}

export async function desktopRaiseIncomingCall(callId: string): Promise<void> {
  if (!isTauri()) return;
  try {
    if ((await getDesktopSettings()).raiseOnCall) await invoke("desktop_show_call_overlay", { callId });
  } catch {
    // Incoming call remains visible in the client even if Windows rejects focus.
  }
}

type UpdateState = { available: boolean; status: string; busy: boolean };
let update: Update | null = null;
let updateState: UpdateState = { available: false, status: "", busy: false };
const updateListeners = new Set<() => void>();
let watcherStarted = false;
let mediaBusy = false;
let downloadedUpdate: Update | null = null;
export function setUpdateMediaBusy(value: boolean) { mediaBusy = value; }

function setUpdateState(patch: Partial<UpdateState>) {
  updateState = { ...updateState, ...patch };
  updateListeners.forEach((listener) => listener());
}

export function getUpdateState(): UpdateState { return updateState; }
export function subscribeUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function startUpdateWatcher(): void {
  if (!isTauri() || watcherStarted) return;
  watcherStarted = true;
  void checkForUpdates(true);
  window.setInterval(() => void checkForUpdates(true), 6 * 60 * 60 * 1000);
}

export async function checkForUpdates(silent = false): Promise<void> {
  if (!isTauri() || updateState.busy) return;
  setUpdateState({ busy: true, status: silent ? updateState.status : "Проверяем обновления…" });
  try {
    update = await check();
    setUpdateState({ available: Boolean(update), status: update ? "Доступно обновление Coherent." : "Обновлений пока нет." });
  } catch {
    setUpdateState({ status: "Не удалось проверить обновления. Попробуй позже." });
  } finally {
    setUpdateState({ busy: false });
  }
}

export async function installUpdate(): Promise<void> {
  if (!update || updateState.busy) return;
  if (mediaBusy) { setUpdateState({ status: "Заверши звонок перед установкой обновления." }); return; }
  setUpdateState({ busy: true, status: "Скачиваем обновление…" });
  try {
    const selected = update;
    if (downloadedUpdate !== selected) {
      await selected.download();
      downloadedUpdate = selected;
    }
    // A call may have started while the download was in progress.
    if (mediaBusy) { setUpdateState({ status: "Обновление скачано. Установи его после звонка." }); return; }
    setUpdateState({ status: "Устанавливаем обновление…" });
    await selected.install();
    await relaunch();
  } catch (reason) {
    setUpdateState({ status: reason instanceof Error ? reason.message : "Не удалось установить обновление." });
  } finally {
    setUpdateState({ busy: false });
  }
}
