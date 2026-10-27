import { useModalFocus } from "../lib/useModalFocus";
import { displayName } from "../lib/api";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Hash, Plus, UsersRound, X } from "lucide-react";
import { api, type CommunityServer } from "../lib/api";

export default function ServerDialog({ server, currentUserId, onSaved, onRemoved, onClose }: { server?: CommunityServer; currentUserId: string; onSaved: (server: CommunityServer) => void; onRemoved: (id:string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [category, setCategory] = useState("Текстовые каналы");
  const [invite, setInvite] = useState<{ code: string; expires_at: string; max_uses: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.serverMembers>>["members"]>([]);
  const [serverName, setServerName] = useState(server?.name || "");
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { label: string; action: () => Promise<void> }>(null);
  const owner = server?.owner_id === currentUserId;
  const manager = owner || members.find(person => person.id === currentUserId)?.role === "moderator";
  useModalFocus(dialog, onClose);
  useEffect(() => { if (server) void api.serverMembers(server.id).then(result => setMembers(result.members)).catch(reason => setError(reason instanceof Error ? reason.message : "Участники недоступны")); }, [server?.id]);
  async function change(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError("");
    try { await action(); setConfirm(null); if (server) setMembers((await api.serverMembers(server.id)).members); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось выполнить действие"); }
    finally { setBusy(false); }
  }
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
    {server && manager && <><form onSubmit={(event) => void submit(event, "channel")}><h3>Новый текстовый канал</h3><label>Название<input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="общение" required /></label><label>Категория<input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={64} required /></label><button type="submit" disabled={busy || !name.trim() || !category.trim()}><Hash size={16} /> Добавить канал</button></form><section><h3>Пригласить участников</h3><p>Код действует 7 дней, до 25 вступлений. Новый код отменяет предыдущий.</p><button disabled={busy} onClick={() => void makeInvite()}>Создать новый код</button>{invite && <div className="server-invite"><input value={invite.code} readOnly aria-label="Код приглашения" /><button onClick={() => void navigator.clipboard.writeText(invite.code).then(() => setCopied(true)).catch(() => setError("Скопируй код вручную из поля"))} aria-label="Скопировать код">{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>}</section></>}
    {server && !manager && <p>Каналами управляют владелец и модераторы сервера.</p>}
    {server && <>
      {owner && <form onSubmit={event => { event.preventDefault(); void change(async () => onSaved(await api.editServer(server.id, serverName.trim()))); }}><h3>Название сервера</h3><input aria-label="Название сервера" value={serverName} maxLength={64} onChange={event => setServerName(event.target.value)} /><button disabled={busy || !serverName.trim()}>Сохранить название</button></form>}
      {manager && <section><h3>Текстовые каналы</h3>{server.channels.map(channel => <div key={channel.id} className="management-row"><span>#{channel.name}</span><button disabled={busy} onClick={() => { setEditingChannel(channel.id); setName(channel.name); setCategory(channel.category); }}>Изменить</button><button disabled={busy || server.channels.length <= 1} onClick={() => setConfirm({label:`Удалить канал «${channel.name}» вместе с историей?`, action:async () => onSaved(await api.deleteServerChannel(server.id, channel.id))})}>Удалить</button></div>)}
      {editingChannel && <form onSubmit={event => { event.preventDefault(); void change(async () => { onSaved(await api.editServerChannel(server.id, editingChannel, name.trim(), category.trim())); setEditingChannel(null); setName(""); }); }}><h3>Изменить канал</h3><input aria-label="Новое название канала" value={name} maxLength={64} onChange={event => setName(event.target.value)} /><input aria-label="Категория канала" value={category} maxLength={64} onChange={event => setCategory(event.target.value)} /><button disabled={busy || !name.trim() || !category.trim()}>Сохранить</button><button type="button" onClick={() => { setEditingChannel(null); setName(""); }}>Отмена</button></form>}</section>}
      <section><h3>Участники</h3>{members.map(person => <div className="management-row" key={person.id}><span>{displayName(person)}<small>{person.role === "owner" ? "Владелец" : person.role === "moderator" ? "Модератор" : "Участник"}</small></span>{owner && person.role !== "owner" && <><button disabled={busy} onClick={() => void change(() => api.setServerRole(server.id, person.id, person.role === "member" ? "moderator" : "member"))}>{person.role === "member" ? "Назначить модератором" : "Убрать роль"}</button><button disabled={busy} onClick={() => setConfirm({label:`Передать владение ${displayName(person)}?`, action:async () => onSaved(await api.transferServer(server.id, person.id))})}>Передать сервер</button></>}{manager && person.id !== currentUserId && person.role !== "owner" && (owner || person.role !== "moderator") && <button disabled={busy} onClick={() => setConfirm({label:`Исключить ${displayName(person)} с сервера?`,action:() => api.removeServerMember(server.id, person.id)})}>Исключить</button>}</div>)}</section>
      <section>{owner ? <button disabled={busy} onClick={() => setConfirm({label:"Удалить сервер и всю историю его каналов?",action:async () => { await api.deleteServer(server.id); onRemoved(server.id); onClose(); }})}>Удалить сервер</button> : <button disabled={busy} onClick={() => setConfirm({label:"Покинуть сервер?",action:async () => { await api.removeServerMember(server.id,currentUserId); onRemoved(server.id); onClose(); }})}>Покинуть сервер</button>}</section>
      {confirm && <section className="management-confirm" role="alert"><strong>{confirm.label}</strong><div><button disabled={busy} onClick={() => void change(confirm.action)}>Подтвердить</button><button disabled={busy} onClick={() => setConfirm(null)}>Отмена</button></div></section>}
    </>}
    {error && <p role="alert" className="server-error">{error}</p>}
  </div></div>;
}
