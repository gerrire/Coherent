import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Clock3, MessageCircle, Send, UserCheck, UserPlus } from "lucide-react";
import { api, type Conversation, type Message, type UserSearchResult } from "../lib/api";

interface MessagesPanelProps {
  conversation: Conversation;
  currentUserId: string;
  version: number;
  onSent: () => void;
  callError: string;
}

function mergeMessages(first: Message[], second: Message[]): Message[] {
  const unique = new Map([...first, ...second].map((message) => [message.id, message]));
  return [...unique.values()].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" })
    .format(new Date(value));
}

export default function MessagesPanel({
  conversation,
  currentUserId,
  version,
  onSent,
  callError,
}: MessagesPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [friendError, setFriendError] = useState("");
  const [relationship, setRelationship] = useState<UserSearchResult | null>(null);
  const [friendBusy, setFriendBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<string | null>(null);
  const hasLoadedPage = useRef(false);
  const nearBottom = useRef(true);
  const relationshipTarget = useRef(conversation.other_user.id);
  relationshipTarget.current = conversation.other_user.id;

  useEffect(() => {
    let active = true;
    setRelationship(null);
    setFriendError("");
    api.relationship(conversation.other_user.id).then((result) => {
      if (active) setRelationship(result);
    }).catch((reason: unknown) => {
      if (active) setFriendError(reason instanceof Error ? reason.message : "Не удалось загрузить статус дружбы.");
    });
    return () => { active = false; };
  }, [conversation.other_user.id]);

  async function friendAction() {
    if (!relationship || friendBusy || relationship.relationship === "friends") return;
    const targetId = conversation.other_user.id;
    setFriendBusy(true);
    setFriendError("");
    try {
      if (relationship.relationship === "incoming_pending" && relationship.request_id) {
        await api.acceptFriendRequest(relationship.request_id);
      } else if (relationship.relationship === "outgoing_pending" && relationship.request_id) {
        await api.removeFriendRequest(relationship.request_id);
      } else {
        await api.sendFriendRequest(targetId);
      }
      const updated = await api.relationship(targetId);
      if (relationshipTarget.current === targetId) setRelationship(updated);
    } catch (reason) {
      if (relationshipTarget.current === targetId) {
        setFriendError(reason instanceof Error ? reason.message : "Не удалось обновить заявку.");
        setRelationship(await api.relationship(targetId).catch(() => relationship));
      }
    } finally {
      setFriendBusy(false);
    }
  }

  useEffect(() => {
    const changed = conversationRef.current !== conversation.id;
    if (changed) {
      conversationRef.current = conversation.id;
      hasLoadedPage.current = false;
      nearBottom.current = true;
      setMessages([]);
      setHasMore(false);
      setDraft("");
      setLoading(true);
      setError("");
    }

    let active = true;
    api.messages(conversation.id).then((page) => {
      if (!active) return;
      setMessages((current) => changed ? page.messages : mergeMessages(current, page.messages));
      if (!hasLoadedPage.current) {
        setHasMore(page.has_more);
        hasLoadedPage.current = true;
      }
      setLoading(false);
      setError("");
    }).catch((requestError: unknown) => {
      if (!active) return;
      setLoading(false);
      setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить сообщения.");
    });
    return () => { active = false; };
  }, [conversation.id, version, retry]);

  const latestId = messages.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list && nearBottom.current) list.scrollTop = list.scrollHeight;
  }, [latestId]);

  async function loadOlder() {
    const first = messages[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    setError("");
    const list = listRef.current;
    const oldHeight = list?.scrollHeight ?? 0;
    const oldTop = list?.scrollTop ?? 0;
    try {
      const page = await api.messages(conversation.id, first.id);
      if (conversationRef.current !== conversation.id) return;
      nearBottom.current = false;
      setMessages((current) => mergeMessages(page.messages, current));
      setHasMore(page.has_more);
      requestAnimationFrame(() => {
        if (list) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить историю.");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      const message = await api.sendMessage(conversation.id, body);
      if (conversationRef.current !== conversation.id) return;
      nearBottom.current = true;
      setMessages((current) => mergeMessages(current, [message]));
      setDraft("");
      onSent();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось отправить сообщение.");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className="messages-panel">
      <div className="messages-intro">
        <span className="avatar avatar-user">{conversation.other_user.username[0]?.toUpperCase()}</span>
        <div className="messages-intro-copy">
          <div className="messages-intro-heading">
            <h1>{conversation.other_user.username}</h1>
            {relationship && (
              <button
                className={`chat-friend-button chat-friend-${relationship.relationship}`}
                onClick={() => void friendAction()}
                disabled={friendBusy || relationship.relationship === "friends"}
                title={relationship.relationship === "outgoing_pending" ? "Отменить заявку" : undefined}
              >
                {relationship.relationship === "friends" ? <UserCheck size={14} />
                  : relationship.relationship === "incoming_pending" ? <Check size={14} />
                    : relationship.relationship === "outgoing_pending" ? <Clock3 size={14} />
                      : <UserPlus size={14} />}
                {relationship.relationship === "friends" ? "Ваш друг"
                  : relationship.relationship === "incoming_pending" ? "Принять заявку"
                    : relationship.relationship === "outgoing_pending" ? "Заявка отправлена"
                      : "В друзья"}
              </button>
            )}
          </div>
          <p>Личная беседа. Сообщения сохраняются в Coherent.</p>
        </div>
      </div>
      {friendError && <p className="call-inline-error" role="alert">{friendError}</p>}
      {callError && <p className="call-inline-error" role="alert">{callError}</p>}

      <div
        className="message-list"
        ref={listRef}
        aria-label={`Сообщения с ${conversation.other_user.username}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        }}
      >
        {hasMore && (
          <button className="load-messages" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? "Загружаем..." : "Показать ранние сообщения"}
          </button>
        )}
        {loading && <p className="message-list-note">Загружаем беседу...</p>}
        {!loading && messages.length === 0 && (
          <div className="message-empty">
            <MessageCircle size={27} />
            <strong>Начни разговор</strong>
            <span>Напиши первое сообщение для {conversation.other_user.username}.</span>
          </div>
        )}
        {messages.map((message) => {
          const own = message.sender_id === currentUserId;
          return (
            <div className={`message-row ${own ? "message-own" : ""}`} key={message.id}>
              <span className="avatar avatar-user message-avatar">
                {(own ? "Я" : conversation.other_user.username[0]?.toUpperCase())}
              </span>
              <div className="message-entry">
                <div className="message-meta">
                  <strong>{own ? "Ты" : conversation.other_user.username}</strong>
                  <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
                </div>
                <p>{message.body}</p>
              </div>
            </div>
          );
        })}
      </div>

      <form className="message-composer" onSubmit={(event) => void sendMessage(event)}>
        {error && (
          <div className="message-error" role="alert">
            {error} {messages.length === 0 && <button type="button" onClick={() => setRetry((n) => n + 1)}>Повторить</button>}
          </div>
        )}
        <div className="composer-field">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Написать ${conversation.other_user.username}...`}
            aria-label="Текст сообщения"
            maxLength={4000}
            rows={2}
          />
          <button
            type="submit"
            aria-label="Отправить сообщение"
            title="Отправить сообщение"
            disabled={!draft.trim() || sending}
          >
            <Send size={18} />
          </button>
        </div>
        <span className="composer-hint">Enter — отправить · Shift+Enter — новая строка</span>
      </form>
    </div>
  );
}
