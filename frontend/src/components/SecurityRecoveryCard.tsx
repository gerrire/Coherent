import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Check, Copy, Download, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { apiRequest, api, type User } from "../lib/api";
import { CryptoClient } from "../lib/crypto/client";
import { closeMessaging } from "../lib/crypto/messaging";
import { enrollCurrentDevice, withDeviceState } from "../lib/crypto/access";
import type { DeviceBinding, Envelope } from "../lib/crypto/types";
import "./security-recovery.css";
import { NewDeviceLink } from "./DeviceLinkPanel";

interface Props { user: User; initialPassword?: string; onComplete?: () => void }
type Status = Awaited<ReturnType<typeof api.securityStatus>>;

export default function SecurityRecoveryCard({ user, initialPassword = "", onComplete }: Props) {
  const client = useRef<CryptoClient | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [device, setDevice] = useState<DeviceBinding | null>(null);
  const [password, setPassword] = useState(initialPassword);
  const [words, setWords] = useState<string[]>([]);
  const [indices, setIndices] = useState<[number, number]>([0, 1]);
  const [answers, setAnswers] = useState<[string, string]>(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const trusted = !!device && !!status?.devices.some(item => item.id === device.device_id);

  function hide() { setWords([]); setAnswers(["", ""]); setPassword(""); setRecoveryInput(""); }

  useEffect(() => {
    let active = true;
    let local: CryptoClient | null = null;
    void api.securityStatus().then(async result => {
      if (!active) return;
      setStatus(result);
      if (result.setup_available) {
        local = new CryptoClient(user.id); client.current = local;
        let identity = await local.execute({ operation: "identity" });
        let own = await local.execute({ operation: "own_fingerprint" }).catch(() => null);
        if (own && !result.devices.some(item => item.id === (identity.result.device as DeviceBinding).device_id)) {
          identity = await local.execute({operation:"replace_identity",device_id:crypto.randomUUID()});
          closeMessaging(user.id);
        } else if (own && result.configured) {
          await enrollCurrentDevice(local, "");
          own = await local.execute({operation:"own_fingerprint"});
        }
        if (active) setDevice(identity.result.device as DeviceBinding);
        if (active && own) setFingerprint(own.result.fingerprint as string);
      }
    }).catch(() => { if (active) setError("Не удалось открыть защищённое хранилище. Обнови клиент и попробуй снова."); });
    return () => { active = false; client.current = null; local?.close(); };
  }, [user.id]);

  useEffect(() => {
    const clear = () => { if (document.hidden) { setRecoveryInput(""); setPassword(""); } };
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);

  useEffect(() => {
    if (!words.length) return;
    const timer = window.setTimeout(hide, 120000);
    const onVisibility = () => { if (document.hidden) hide(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [words]);

  async function show(setup: boolean) {
    const local = client.current;
    if (!local || !password || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (setup) {
        const prepared = await local.execute({ operation: "recovery_backup" });
        const backup = prepared.result.backup as Envelope;
        const challenge = await api.deviceChallenge("bootstrap");
        const signed = await local.execute({ operation: "sign_device_proof", purpose: "bootstrap", nonce: challenge.nonce, backup });
        await api.bootstrapSecurity({ challenge_id: challenge.challenge_id, device: signed.result.device, proof: signed.result.proof, backup, recovery_public_key: prepared.result.recovery_public_key, current_password: password, label: isTauri() ? "Приложение Когерента" : "Браузер", platform: isTauri() ? "windows" : "browser" });
        await enrollCurrentDevice(local, password);
        setStatus(await api.securityStatus());
      }
      const own = await local.execute({ operation: "own_fingerprint" });
      setFingerprint(own.result.fingerprint as string);
      const result = await local.revealRecovery(password);
      const phrase = result.result.phrase;
      if (typeof phrase !== "string" || ![12, 24].includes(phrase.split(" ").length)) throw new Error("Ключ устройства недоступен");
      const next = phrase.split(" ");
      const random = crypto.getRandomValues(new Uint8Array(2));
      const first = random[0] % next.length;
      let second = random[1] % next.length;
      if (second === first) second = (first + 1) % next.length;
      setIndices([first, second]); setAnswers(["", ""]); setWords(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось открыть ключ. Проверь пароль и доверие к устройству.");
      setPassword("");
    } finally { setBusy(false); }
  }

  async function recoverDevice() {
    if (!client.current || busy || !password || !recoveryInput.trim()) return;
    setBusy(true); setError("");
    try {
      await enrollCurrentDevice(client.current, password, recoveryInput);
      const own = await client.current.execute({ operation: "own_fingerprint" });
      setFingerprint(own.result.fingerprint as string);
      setRecoveryInput(""); hide(); setStatus(await api.securityStatus());
      setNotice("Устройство подтверждено. Приватные ключи созданы заново; ключ истории восстановлен локально.");
      onComplete?.();
    } catch { setError("Не удалось подтвердить устройство. Проверь пароль и все слова ключа восстановления."); }
    finally { setBusy(false); }
  }

  async function confirmSaved() {
    const local = client.current;
    if (!local || !device || busy || !password) return;
    if (answers.some((answer, index) => answer.trim().toLowerCase() !== words[indices[index]])) { setError("Введи выбранные слова из сохранённой копии."); return; }
    setBusy(true); setError("");
    try {
      const challenge = await api.deviceChallenge("confirm_recovery");
      const signed = await local.execute({ operation: "sign_device_proof", purpose: "confirm_recovery", nonce: challenge.nonce, backup: null });
      await api.confirmRecoverySaved({ challenge_id: challenge.challenge_id, device_id: device.device_id, proof: signed.result.proof, current_password: password });
      setStatus(await api.securityStatus()); window.dispatchEvent(new Event("coherent-security-changed")); hide(); setNotice("Ключ сохранён. Письмо с подтверждением придёт без самих слов.");
      onComplete?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось подтвердить сохранение ключа"); }
    finally { setBusy(false); }
  }

  async function resetTrust() {
    const local = client.current;
    if (!local || !trusted || !device || !password || !resetConfirmed || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await withDeviceState(user.id,"exclusive",async () => {
      const pending = await local.pendingDeliveries();
      if (pending.some(item => ["send","add_members","remove_members"].includes(item.operation))) throw new Error("Сначала заверши или отмени неотправленные сообщения");
      const material = await api.recoveryMaterial();
      const prepared = await local.execute({operation:"prepare_rotation",previous:material.rosters.at(-1)!});
      const payload = JSON.stringify({operation:"rotate_recovery",public_key:prepared.result.public_key,backup:prepared.result.backup,roster:prepared.result.roster});
      const challenge = await api.deviceChallenge("action");
      const signed = await local.execute({operation:"sign_action",nonce:challenge.nonce,payload});
      await apiRequest("/api/v1/security/devices/reset-trust",{method:"POST",body:JSON.stringify({challenge_id:challenge.challenge_id,device:signed.result.device,proof:signed.result.proof,payload,current_password:password})});
      await local.execute({operation:"commit_rotation",public_key:prepared.result.public_key as string});
      closeMessaging(user.id);
      const nextStatus = await api.securityStatus(); setStatus(nextStatus);
      const own = await local.execute({operation:"own_fingerprint"}); setFingerprint(own.result.fingerprint as string);
      const shown = await local.revealRecovery(password);
      const nextWords = String(shown.result.phrase).split(" ");
      setWords(nextWords); setIndices([0, Math.min(7,nextWords.length-1)]); setAnswers(["",""]); setResetConfirmed(false);
      setNotice("Сохрани новые 12 слов. Прежний ключ больше не подходит. Остальные устройства нужно подтвердить заново; собеседникам — сверить новый код. Старая история сохранена.");
      window.dispatchEvent(new Event("coherent-security-changed"));
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сменить доверие к устройствам"); }
    finally { setBusy(false); }
  }

  function saveFile() {
    const text = `Когерент — ключ восстановления\nАккаунт: @${user.username}\n\n${words.join(" ")}\n\nХрани отдельно от пароля. Никому не передавай эти слова.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `coherent-recovery-${user.username}.txt`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Файл сохранён на твоём устройстве. Перенеси его в надёжное место.");
  }

  if (!status?.setup_available) return null;
  return <section className="profile-settings-card security-recovery-card" aria-label="Ключ восстановления">
    <div className="profile-settings-section-heading"><ShieldCheck size={18} /><h3>{status?.configured && !trusted ? "Подтверждение устройства" : "Ключ восстановления"}</h3></div>
    {(!status?.configured || trusted) && <p>12 случайных слов для доступа к защищённой истории при потере устройств. Храни их отдельно от пароля. Сервер и почта этих слов не получают.</p>}
    {status?.setup_available && <p className="recovery-rollout-note">{status.chat_encryption === "mls" ? "Новые личные и групповые сообщения используют сквозное шифрование. Каналы серверов остаются облачными." : "Подготавливаем защищённую переписку. Текущие чаты пока используют облачное шифрование."}</p>}
    {!isTauri() && <p className="recovery-private-note">В инкогнито ключи действуют до закрытия всех приватных окон. При следующем входе подтверди новое устройство с доверенного устройства или Recovery Key.</p>}
    {trusted && fingerprint && <div className="account-safety-code"><span>Сверочный код аккаунта</span><code>{fingerprint.match(/.{1,4}/g)?.join(" ")}</code><p>Этот код можно сравнить с собеседником. Он публичный и не заменяет секретные 12 слов.</p><button type="button" className="recovery-action" onClick={() => void navigator.clipboard.writeText(fingerprint)}>Скопировать код</button></div>}
    {!status && !error && <p role="status">Открываем хранилище…</p>}
    {status && !status.setup_available && <p>Настройка ключей появится в следующем этапе перехода.</p>}
    {status?.setup_available && !user.email_verified && <p>Сначала подтверди почту в настройках выше.</p>}
    {status?.configured && device && !trusted && <>
      {client.current && <NewDeviceLink client={client.current} onComplete={() => { void api.securityStatus().then(setStatus); window.dispatchEvent(new Event("coherent-security-changed")); onComplete?.(); }} />}
      <details className="recovery-fallback"><summary>Нет доступа к доверенным устройствам? Использовать Recovery Key</summary><div className="recovery-device-unlock"><p>Подтверди это устройство ключом восстановления, если нет доступа к другому устройству. Слова проверяются только здесь и не отправляются серверу.</p><label>Пароль аккаунта<input type="password" value={password} autoComplete="current-password" maxLength={128} onChange={event => setPassword(event.target.value)} /></label><label>12 слов ключа восстановления<textarea value={recoveryInput} onChange={event => setRecoveryInput(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={400} rows={3} placeholder="Введи слова в сохранённом порядке" /></label><button type="button" className="recovery-action" disabled={busy || !password || !recoveryInput.trim()} onClick={() => void recoverDevice()}>{busy ? "Подтверждаем…" : "Подтвердить по Recovery Key"}</button></div></details></>}
    {status?.setup_available && user.email_verified && device && (!status.configured || trusted) && <>
      {!words.length && <div className="profile-password-form"><label htmlFor={`recovery-password-${user.id}`}>Текущий пароль для подтверждения доступа</label><div className="profile-password-field"><input id={`recovery-password-${user.id}`} type="password" value={password} maxLength={128} autoComplete="current-password" onChange={event => setPassword(event.target.value)} placeholder="Твой пароль" /></div><button className="recovery-action" type="button" disabled={busy || !password} onClick={() => void show(!status.configured)}><Eye size={16} />{busy ? "Открываем…" : status.configured ? "Показать ключ" : "Создать и сохранить ключ"}</button></div>}
      {!!words.length && <div className="recovery-visible">
        <ol className="recovery-words" aria-label="Слова ключа восстановления">{words.map((word, index) => <li key={index}><span>{index + 1}</span><strong>{word}</strong></li>)}</ol>
        <p className="recovery-private-note">Слова автоматически скроются через 2 минуты или при переходе на другую вкладку.</p>
        <div className="recovery-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(words.join(" ")).then(() => setNotice("Ключ скопирован. Не отправляй его в переписку."), () => setNotice("Не удалось скопировать. Можно сохранить файл."))}><Copy size={16} /> Скопировать</button><button type="button" onClick={saveFile}><Download size={16} /> Сохранить файл</button><button type="button" onClick={hide}><EyeOff size={16} /> Скрыть</button></div>
        {!status.recovery_confirmed && <div className="recovery-confirm"><p>Сохрани слова, затем введи два слова из своей копии.</p><div>{indices.map((index, position) => <label key={position}>Слово №{index + 1}<input autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[position]} onChange={event => setAnswers(previous => position === 0 ? [event.target.value, previous[1]] : [previous[0], event.target.value])} /></label>)}</div><button className="recovery-action" type="button" disabled={busy || answers.some((answer, index) => answer.trim().toLowerCase() !== words[indices[index]])} onClick={() => void confirmSaved()}><Check size={16} /> Я сохранил ключ</button></div>}
      </div>}
    </>}
    {trusted && status && !words.length && <details className="recovery-fallback"><summary>Доверенные устройства · {status.devices.length} из 16</summary>
      {status.devices.map(item => <div className="management-row" key={item.id}><span>{item.label}<small>{item.platform}{item.id === device?.device_id ? " · Это устройство" : ""}</small></span></div>)}
      <p>Если устройство потеряно или ключ скомпрометирован, сбрось доверие. Текущее устройство сохранит историю. Остальные устройства выйдут из аккаунта и потребуют нового подтверждения; действующие звонки завершатся для твоего аккаунта.</p>
      <label className="recovery-reset-check"><input type="checkbox" checked={resetConfirmed} onChange={event => setResetConfirmed(event.target.checked)} /> Я сохраню новые 12 слов и заново подтвержу остальные устройства</label>
      <button className="recovery-action" disabled={busy || !password || !resetConfirmed} onClick={() => void resetTrust()}>Сменить ключ и отозвать остальные устройства</button>
    </details>}
    {notice && <p className="profile-settings-success" role="status">{notice}</p>}
    {error && <p className="profile-settings-error" role="alert">{error}</p>}
    {trusted && status?.recovery_confirmed && !words.length && <p className="profile-settings-success"><Check size={16} /> Сохранение ключа подтверждено.</p>}
    {onComplete && <button className="recovery-action recovery-continue" type="button" disabled={busy} onClick={() => { hide(); onComplete(); }}>{trusted ? "Начать общаться" : "Продолжить без личной переписки"}</button>}
  </section>;
}
