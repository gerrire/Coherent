import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
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
    // The call remains in the client even when a separate window cannot be shown.
  }
}

export type UpdateState = {
  available: boolean; status: string; busy: boolean;
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string; version: string | null; notes: string;
  downloaded: boolean; downloadedBytes: number; totalBytes: number | null;
  progress: number | null; lastCheckedAt: number | null; callActive: boolean;
};
let update: Update | null = null;
let updateState: UpdateState = { available: false, status: "", busy: false, phase: "idle",
  currentVersion: "", version: null, notes: "", downloaded: false, downloadedBytes: 0,
  totalBytes: null, progress: null, lastCheckedAt: null, callActive: false };
const updateListeners = new Set<() => void>();
let watcherStarted = false;
let mediaBusy = false;
let downloadedUpdate: Update | null = null;
let versionRequest: Promise<void> | null = null;
export function setUpdateMediaBusy(value: boolean) {
  mediaBusy = value;
  setUpdateState({ callActive: value,
    ...(updateState.downloaded && !updateState.busy ? { status: value
      ? "Обновление скачано. Установка доступна после звонка."
      : "Обновление скачано и проверено. Можно установить и перезапустить приложение." } : {}),
  });
}

export function setDesktopMediaActive(active: boolean) {
  if (isTauri()) void invoke("desktop_set_media_active", { active }).catch(() => undefined);
}

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
  setUpdateState({ busy: true, phase: "checking", status: silent && updateState.available ? updateState.status : "Проверяем обновления…" });
  try {
    versionRequest ??= getVersion().then(currentVersion => { setUpdateState({ currentVersion }); }).catch(() => undefined);
    await versionRequest;
    const candidate = await check({ timeout: 20000 });
    if (candidate && update && candidate.version === update.version && downloadedUpdate === update) {
      if (candidate !== update) await candidate.close().catch(() => undefined);
    } else {
      const previous = update;
      update = candidate;
      downloadedUpdate = null;
      if (previous && previous !== candidate) await previous.close().catch(() => undefined);
      setUpdateState({ downloaded: false, downloadedBytes: 0, totalBytes: null, progress: null });
    }
    setUpdateState({ available: Boolean(update), version: update?.version ?? null, notes: update?.body ?? "",
      phase: downloadedUpdate ? "ready" : update ? "available" : "idle", lastCheckedAt: Date.now(),
      status: downloadedUpdate ? "Обновление скачано и проверено. Можно установить и перезапустить приложение."
        : update ? "Новая версия готова к скачиванию." : "Установлена последняя версия Coherent.",
    });
  } catch {
    setUpdateState({ phase: "error", status: "Не удалось проверить обновления. Проверь подключение и попробуй снова." });
  } finally {
    setUpdateState({ busy: false });
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!isTauri() || !update || updateState.busy || downloadedUpdate === update) return;
  const selected = update;
  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  let acceptingProgress = true;
  setUpdateState({ busy: true, phase: "downloading", status: "Скачиваем обновление…", downloaded: false,
    downloadedBytes: 0, totalBytes: null, progress: null });
  try {
    await selected.download(event => {
      if (!acceptingProgress || selected !== update) return;
      if (event.event === "Started") totalBytes = event.data.contentLength || null;
      if (event.event === "Progress") downloadedBytes += event.data.chunkLength;
      setUpdateState({ downloadedBytes, totalBytes,
        progress: totalBytes ? Math.min(99, Math.round(downloadedBytes / totalBytes * 100)) : null,
        status: event.event === "Finished" ? "Проверяем подпись обновления…" : "Скачиваем обновление…",
      });
    }, { timeout: 120000 });
    downloadedUpdate = selected;
    setUpdateState({ phase: "ready", downloaded: true, progress: 100,
      status: mediaBusy ? "Обновление скачано. Установка доступна после звонка."
        : "Обновление скачано и проверено. Можно установить и перезапустить приложение." });
  } catch {
    downloadedUpdate = null;
    setUpdateState({ phase: "error", downloaded: false, progress: null,
      status: "Не удалось скачать или проверить обновление. Повтори скачивание." });
  } finally { acceptingProgress = false; setUpdateState({ busy: false }); }
}

export async function installUpdate(): Promise<void> {
  if (!isTauri() || !update || updateState.busy) return;
  if (mediaBusy) { setUpdateState({ status: "Заверши звонок перед установкой обновления." }); return; }
  const selected = update;
  if (downloadedUpdate !== selected) await downloadUpdate();
  if (downloadedUpdate !== selected || update !== selected || updateState.busy) return;
  if (mediaBusy) { setUpdateState({ status: "Обновление скачано. Установка доступна после звонка." }); return; }
  setUpdateState({ busy: true, phase: "installing", status: "Устанавливаем обновление. Приложение перезапустится…" });
  try {
    // On Windows the verified installer closes this process and restarts the
    // installed client. A separate relaunch races with the installer replacing it.
    await selected.install({ restartAfterInstall: true });
  } catch {
    // The native installer may have consumed its bytes before failing to launch.
    // A retry must download/verify again instead of trusting an invalid resource.
    downloadedUpdate = null;
    setUpdateState({ phase: "error", downloaded: false, busy: false, progress: null,
      status: "Не удалось установить обновление. Приложение продолжает работать; попробуй скачать его снова." });
  }
}
