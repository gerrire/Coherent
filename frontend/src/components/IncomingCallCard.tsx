import { Phone } from "lucide-react";

interface IncomingCallCardProps {
  caller: string;
  error?: string;
  busy: boolean;
  onDecline: () => void;
  onAccept: () => void;
  onRetry?: () => void;
}

export default function IncomingCallCard({ caller, error, busy, onDecline, onAccept, onRetry }: IncomingCallCardProps) {
  return <div className="incoming-call-card">
    <div className="incoming-call-avatar">{caller.slice(0, 1).toUpperCase() || "…"}</div>
    <span>ВХОДЯЩИЙ ЗВОНОК</span>
    <h2>{caller}</h2>
    <p className={error ? "incoming-call-error" : undefined}>{error || "звонит тебе в Coherent"}</p>
    <div className="incoming-call-actions">
      {error && busy && onRetry ? <button type="button" className="incoming-call-accept" onClick={onRetry}>Повторить</button> : <>
      <button type="button" className="incoming-call-decline" onClick={onDecline} disabled={busy}><Phone size={21} /> Отклонить</button>
      <button type="button" className="incoming-call-accept" onClick={onAccept} disabled={busy}><Phone size={21} /> Ответить</button>
      </>}
    </div>
  </div>;
}
