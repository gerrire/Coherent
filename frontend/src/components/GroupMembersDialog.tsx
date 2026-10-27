import { useRef, useState } from "react";
import { X } from "lucide-react";
import { api, displayName, type Conversation } from "../lib/api";
import { useModalFocus } from "../lib/useModalFocus";
import ParticipantPicker from "./ParticipantPicker";

export default function GroupMembersDialog({ conversation, account, onUpdated, onLeft, onClose }: {
  conversation: Conversation; account: string; onUpdated: (value: Conversation) => void;
  onLeft: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [add, setAdd] = useState(false), [target, setTarget] = useState<string | null>(null);
  useModalFocus(dialog, onClose);
  async function remove() {
    if (!target || busy) return; setBusy(true); setError("");
    try { await api.removeGroupMember(conversation.id, target); if (target === account) onLeft(); else onUpdated({ ...conversation, members: conversation.members.filter(person => person.id !== target) }); setTarget(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось изменить группу"); }
    finally { setBusy(false); }
  }
  return <div className="server-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="server-dialog" role="dialog" aria-modal="true" aria-labelledby="group-members-title" tabIndex={-1} ref={dialog}>
    <header><div><h2 id="group-members-title">Участники группы</h2><p>После изменения состава ключи дальнейшей переписки обновляются.</p></div><button onClick={onClose} aria-label="Закрыть"><X size={20} /></button></header>
    {conversation.members.map(person => <div className="management-row" key={person.id}><span>{displayName(person)}{conversation.owner_id === person.id && <small>Владелец группы</small>}</span>{(account === person.id || conversation.owner_id === account) && <button disabled={busy} onClick={() => setTarget(person.id)}>{person.id === account ? "Покинуть" : "Удалить"}</button>}</div>)}
    <section><button disabled={busy || conversation.members.length >= 10} onClick={() => setAdd(true)}>Добавить друзей</button></section>
    {target && <section className="management-confirm"><p>{target === account ? "Покинуть группу? Доступ к новым сообщениям прекратится." : "Удалить участника из группы?"}</p><button disabled={busy} onClick={() => void remove()}>Подтвердить</button><button disabled={busy} onClick={() => setTarget(null)}>Отмена</button></section>}
    {error && <p role="alert" className="server-error">{error}</p>}
    {add && <ParticipantPicker title="Добавить друзей в группу" submitLabel="Добавить" excludedIds={conversation.members.map(person => person.id)} minSelect={1} maxSelect={10 - conversation.members.length} onClose={() => setAdd(false)} onSubmit={async ids => { onUpdated(await api.addGroupMembers(conversation.id, ids)); setAdd(false); }} />}
  </div></div>;
}
