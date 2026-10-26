import { useState } from "react";
import { LockKeyhole, ShieldCheck, X } from "lucide-react";
import { displayName, type Conversation } from "../lib/api";
import { MessagingAccessError, messagingFor, type KeyReview } from "../lib/crypto/messaging";
import "./chat-security.css";

export default function ChatSecurityNotice({ conversation, accountId, ready, problem, busy, onVerify, onRetry }: {
  conversation: Conversation; accountId: string; ready: boolean; problem: MessagingAccessError | null; busy: boolean;
  onVerify: (keys: KeyReview[]) => Promise<void>; onRetry: () => void;
}) {
  const [open, setOpen] = useState(false); const [checked, setChecked] = useState(false);
  const [codes, setCodes] = useState<KeyReview[]>([]);
  const [reviewError, setReviewError] = useState("");
  const reviews = codes.length ? codes : problem?.reviews ?? [];
  async function showCodes() {
    setChecked(false); setReviewError("");
    try { setCodes(await messagingFor(accountId).verificationCodes(conversation)); setOpen(true); }
    catch (error) { setReviewError(error instanceof Error ? error.message : "Коды временно недоступны"); }
  }
  return <>
    <div className={`chat-security-notice ${ready ? "chat-security-ready" : ""}`}>
      <LockKeyhole size={15} /><span>{ready ? "Новые сообщения защищены сквозным шифрованием" : problem?.message || "Подготавливаем защищённую переписку…"}</span>
      {ready ? <button type="button" onClick={() => void showCodes()}>Сверочные коды</button> : problem?.kind === "verify" ? <button type="button" onClick={() => { setChecked(false); setOpen(true); }}>Сверить ключи</button>
        : problem?.kind === "device" || problem?.kind === "setup" ? <button type="button" onClick={() => window.dispatchEvent(new Event("coherent-open-profile"))}>Открыть профиль</button>
          : problem && <button type="button" disabled={busy} onClick={onRetry}>Повторить</button>}
    </div>
    {reviewError && <div className="chat-security-notice">{reviewError}</div>}
    {open && <div className="key-review-backdrop"><section className="key-review-dialog" role="dialog" aria-modal="true" aria-label="Проверка ключей участников">
      <header><ShieldCheck size={22} /><h2>Сверочные коды</h2><button type="button" onClick={() => setOpen(false)} aria-label="Закрыть"><X size={20} /></button></header>
      <p>Сравни код каждого участника с кодом в его профиле — например, голосом или при личной встрече. Ключ сохраняется при первом контакте; сверка помогает дополнительно проверить его подлинность.</p>
      <div className="key-review-accounts">{reviews.map(review => <div key={review.account_id}><strong>{displayName(conversation.members.find(member => member.id === review.account_id) ?? { username: "Участник" })}</strong><code>{review.fingerprint.match(/.{1,4}/g)?.join(" ")}</code><button type="button" onClick={() => void navigator.clipboard.writeText(review.fingerprint)}>Скопировать код</button></div>)}</div>
      <p className="key-review-help">Сверочные коды публичные. Секретные 12 слов никому не отправляй.</p>
      <label className="key-review-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /> Я сравнил коды с участниками</label>
      <button className="recovery-action" type="button" disabled={!checked || busy} onClick={() => void onVerify(reviews).then(() => setOpen(false)).catch(() => {})}>{busy ? "Подключаем…" : "Подтвердить ключи"}</button>
    </section></div>}
  </>;
}
