import { useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Check, Download, LoaderCircle, RefreshCw, RotateCw, X } from "lucide-react";
import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate, subscribeUpdate } from "../lib/desktop";
import "./desktop-updates.css";

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

export function DesktopUpdateSettings() {
  const update = useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
  return <section className="desktop-update-card" aria-label="Обновления приложения">
    <header><strong><RefreshCw size={17} />Обновления приложения</strong><span>Версия {update.currentVersion || "…"}</span></header>
    {update.available && <h3>Доступна версия {update.version}</h3>}
    <p role="status" aria-live="polite">{update.status || "Проверяем новые версии автоматически при запуске и каждые шесть часов."}</p>
    {update.phase === "downloading" && <div className="desktop-update-progress">
      <progress aria-label="Загрузка обновления" max={100} value={update.progress ?? undefined} />
      <span>{update.progress !== null ? `${update.progress}% · ` : ""}{size(update.downloadedBytes)}{update.totalBytes ? ` из ${size(update.totalBytes)}` : ""}</span>
    </div>}
    {update.available && update.notes && <details className="desktop-update-notes"><summary>Что нового</summary><p>{update.notes.slice(0, 2000)}</p></details>}
    {update.available && update.callActive && <p className="desktop-update-hint">Скачивание доступно во время звонка. Для установки сначала заверши звонок.</p>}
    <div className="desktop-update-actions">
      {update.available && <button type="button" className="desktop-update-primary" disabled={update.busy || update.downloaded && update.callActive}
        onClick={() => void (update.downloaded ? installUpdate() : downloadUpdate())}>
        {update.busy ? <LoaderCircle size={16} className="desktop-update-spin" /> : update.downloaded ? <RotateCw size={16} /> : <Download size={16} />}
        {update.phase === "installing" ? "Устанавливаем…" : update.phase === "downloading" ? "Скачиваем…" : update.downloaded ? "Установить и перезапустить" : "Скачать обновление"}
      </button>}
      <button type="button" disabled={update.busy} onClick={() => void checkForUpdates()}>
        {update.phase === "checking" ? <LoaderCircle size={16} className="desktop-update-spin" /> : <RefreshCw size={16} />}
        {update.phase === "checking" ? "Проверяем…" : "Проверить обновления"}
      </button>
    </div>
    <small>{update.lastCheckedAt ? `Последняя проверка: ${new Date(update.lastCheckedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}. ` : ""}
      {update.downloaded ? <><Check size={12} /> Подпись обновления проверена.</> : "Обновления устанавливаются прямо в приложении и сохраняют вход и настройки."}</small>
  </section>;
}

export function DesktopUpdateNotice() {
  const update = useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  if (!isTauri() || !update.available || dismissedVersion === update.version) return null;
  return <aside className="desktop-update-notice" aria-label="Доступно обновление">
    <div><strong>Coherent {update.version}</strong><span>{update.status}</span></div>
    <button type="button" disabled={update.busy || update.downloaded && update.callActive}
      onClick={() => void (update.downloaded ? installUpdate() : downloadUpdate())}>
      {update.busy ? update.phase === "installing" ? "Устанавливаем…" : "Скачиваем…" : update.downloaded ? "Перезапустить" : "Скачать"}
    </button>
    <button type="button" className="desktop-update-dismiss" aria-label="Скрыть уведомление об обновлении" onClick={() => setDismissedVersion(update.version)}><X size={16} /></button>
  </aside>;
}
