import { useState } from "react";
import { LockKeyhole, ShieldCheck, X } from "lucide-react";
import { displayName, type Conversation } from "../lib/api";
import { MessagingAccessError, type KeyReview } from "../lib/crypto/messaging";
import "./chat-security.css";

export default function ChatSecurityNotice({ conversation, ready, problem, busy, onVerify, onRetry }: {
  conversation: Conversation; ready: boolean; problem: MessagingAccessError | null; busy: boolean;
  onVerify: (keys: KeyReview[]) => Promise<void>; onRetry: () => void;
}) {
  const [open, setOpen] = useState(false); const [checked, setChecked] = useState(false);
  const reviews = problem?.reviews ?? [];
  return <>
    <div className={`chat-security-notice ${ready ? "chat-security-ready" : ""}`}>
      <LockKeyhole size={15} /><span>{ready ? "Новые сообщения защищены сквозным шифрованием" : problem?.message || "Подготавливаем защищённую переписку…"}</span>
      {problem?.kind === "verify" ? <button type="button" onClick={() => { setChecked(false); setOpen(true); }}>Сверить ключи</button>
        : problem?.kind === "device" || problem?.kind === "setup" ? <button type="button" onClick={() => window.dispatchEvent(new Event("coherent-open-profile"))}>Открыть профиль</button>
          : problem && <button type="button" disabled={busy} onClick={onRetry}>Повторить</button>}
    </div>
    {open && <div className="key-review-backdrop"><section className="key-review-dialog" role="dialog" aria-modal="true" aria-label="Проверка ключей участников">
      <header><ShieldCheck size={22} /><h2>Сверочные коды</h2><button type="button" onClick={() => setOpen(false)} aria-label="Закрыть"><X size={20} /></button></header>
      <p>Сравни код каждого участника с кодом в его профиле — например, голосом или при личной встрече. Это подтверждает, кому принадлежат ключи устройств.</p>
      <div className="key-review-accounts">{reviews.map(review => <div key={review.account_id}><strong>{displayName(conversation.members.find(member => member.id === review.account_id) ?? { username: "Участник" })}</strong><code>{review.fingerprint.match(/.{1,4}/g)?.join(" ")}</code><button type="button" onClick={() => void navigator.clipboard.writeText(review.fingerprint)}>Скопировать код</button></div>)}</div>
      <p className="key-review-help">Сверочные коды публичные. Секретные 12 слов никому не отправляй.</p>
      <label className="key-review-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /> Я сравнил коды с участниками</label>
      <button className="recovery-action" type="button" disabled={!checked || busy} onClick={() => void onVerify(reviews).then(() => setOpen(false)).catch(() => {})}>{busy ? "Подключаем…" : "Подтвердить ключи"}</button>
    </section></div>}
  </>;
}
