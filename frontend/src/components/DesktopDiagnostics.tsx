import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sendDesktopTestNotification } from "../lib/desktop";
import { checkScreenBridgeOnly, checkScreenEncoder } from "../lib/nativeScreenShare";
import { checkCallAudioIsolation } from "../lib/checkCallAudioIsolation";

export default function DesktopDiagnostics() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  async function run(check: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setResult(""); setError("");
    try { setResult(await check()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Проверка не завершилась."); }
    finally { setBusy(false); }
  }
  const checks = [
    { title: "Проверить уведомления", description: "Отправить пробное системное уведомление.", run: async () => { await sendDesktopTestNotification(); return "Проверочное уведомление отправлено в Windows."; } },
    { title: "Проверить исключение звука звонка", description: "Тихий сигнал через локальный звонок. Перед проверкой остановите демонстрацию и другой звук.", run: checkCallAudioIsolation },
    { title: "Проверить захват Windows", description: "Один кадр без звонка, сохранения и передачи.", run: () => invoke<string>("desktop_screen_self_check") },
    { title: "Проверить видеопоток клиента", description: "Локальная проверка кадров без отправки собеседникам.", run: checkScreenBridgeOnly },
    { title: "Проверить кодирование видео", description: "Соединение внутри ПК, без микрофона и сервера.", run: checkScreenEncoder },
  ];
  return <div className="desktop-settings-group">
    <p className="client-settings-intro">Инструменты для разбора неполадок. Каждая проверка запускается отдельно по нажатию.</p>
    {checks.map(check => <div className="desktop-settings-row" key={check.title}><span><b>{check.title}</b><small>{check.description}</small></span><button type="button" disabled={busy} onClick={() => void run(check.run)}>Проверить</button></div>)}
    {busy && <p role="status">Выполняем проверку…</p>}
    {result && <p className="desktop-settings-success" role="status">{result}</p>}
    {error && <p className="desktop-settings-error" role="alert">{error}</p>}
  </div>;
}
