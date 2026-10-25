import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Hash, Plus, UsersRound, X } from "lucide-react";
import { api, type CommunityServer } from "../lib/api";

export default function ServerDialog({ server, currentUserId, onSaved, onClose }: { server?: CommunityServer; currentUserId: string; onSaved: (server: CommunityServer) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [category, setCategory] = useState("Текстовые каналы");
  const [invite, setInvite] = useState<{ code: string; expires_at: string; max_uses: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  async function submit(event: FormEvent, action: "create" | "join" | "channel") {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const saved = action === "join" ? await api.joinServer(code.trim()) : action === "channel" && server ? await api.createServerChannel(server.id, name.trim(), category.trim()) : await api.createServer(name.trim());
      onSaved(saved); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось выполнить действие"); }
    finally { setBusy(false); }
  }
  async function makeInvite() {
    if (!server || busy) return;
    setBusy(true); setError(""); setCopied(false);
    try { setInvite(await api.createServerInvite(server.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать приглашение"); }
    finally { setBusy(false); }
  }
  return <div className="server-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialog} className="server-dialog" role="dialog" aria-modal="true" aria-labelledby="server-dialog-title" tabIndex={-1}>
    <header><div><UsersRound size={24} /><h2 id="server-dialog-title">{server?.name || "Место для своих"}</h2><p>{server ? `${server.member_count} участников · ${server.channels.length} текстовых каналов` : "Создай сервер или присоединись по приглашению."}</p></div><button onClick={onClose} aria-label="Закрыть"><X size={20} /></button></header>
    {!server && <><form onSubmit={(event) => void submit(event, "create")}><h3>Создать сервер</h3><label>Название<input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="Например, Наши вечера" required /></label><button type="submit" disabled={busy || !name.trim()}><Plus size={16} /> Создать</button></form><form onSubmit={(event) => void submit(event, "join")}><h3>Есть приглашение?</h3><label>Код приглашения<input value={code} onChange={(event) => setCode(event.target.value)} maxLength={128} placeholder="Вставь код от владельца" required autoComplete="off" /></label><button type="submit" disabled={busy || !code.trim()}>Присоединиться</button></form></>}
    {server && server.owner_id === currentUserId && <><form onSubmit={(event) => void submit(event, "channel")}><h3>Новый текстовый канал</h3><label>Название<input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="общение" required /></label><label>Категория<input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={64} required /></label><button type="submit" disabled={busy || !name.trim() || !category.trim()}><Hash size={16} /> Добавить канал</button></form><section><h3>Пригласить участников</h3><p>Код действует 7 дней, до 25 вступлений. Новый код отменяет предыдущий.</p><button disabled={busy} onClick={() => void makeInvite()}>Создать новый код</button>{invite && <div className="server-invite"><input value={invite.code} readOnly aria-label="Код приглашения" /><button onClick={() => void navigator.clipboard.writeText(invite.code).then(() => setCopied(true)).catch(() => setError("Скопируй код вручную из поля"))} aria-label="Скопировать код">{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>}</section></>}
    {server && server.owner_id !== currentUserId && <p>Каналами и приглашениями управляет владелец сервера.</p>}
    {error && <p role="alert" className="server-error">{error}</p>}
  </div></div>;
}
