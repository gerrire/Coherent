import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Clock3, FilePlus2, MessageCircle, Pencil, Send, UserCheck, UserPlus, UsersRound, X } from "lucide-react";
import { api, conversationTitle, type Conversation, type Message, type UserSearchResult } from "../lib/api";

interface MessagesPanelProps {
  conversation: Conversation;
  currentUserId: string;
  version: number;
  onSent: () => void;
  onRead: (conversationId: string, messageId: string) => Promise<void>;
  callError: string;
  onRename: (conversationId: string, name: string) => Promise<void>;
  peerOnline?: boolean;
  incomingFiles?: { nonce: number; files: File[] } | null;
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

function filesFromClipboard(clipboard: DataTransfer): File[] {
  const items = Array.from(clipboard.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const files = items.length ? items : Array.from(clipboard.files);
  return files.map((file) => {
    if (!file.type.startsWith("image/")) {
      return file.name ? file : new File([file], "Файл", { type: file.type, lastModified: file.lastModified });
    }
    if (file.name && file.name !== "image.png") return file;
    const extension = file.type === "image/jpeg" ? "jpg"
      : file.type === "image/webp" ? "webp"
        : file.type === "image/gif" ? "gif"
          : file.type === "image/avif" ? "avif" : "png";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new File([file], `Скриншот-${timestamp}.${extension}`, {
      type: file.type || `image/${extension}`,
      lastModified: file.lastModified,
    });
  });
}

export default function MessagesPanel({
  conversation,
  currentUserId,
  version,
  onSent,
  onRead,
  callError,
  onRename,
  peerOnline,
  incomingFiles,
}: MessagesPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [friendError, setFriendError] = useState("");
  const [relationship, setRelationship] = useState<UserSearchResult | null>(null);
  const [friendBusy, setFriendBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<string | null>(null);
  const hasLoadedPage = useRef(false);
  const nearBottom = useRef(true);
  const relationshipTarget = useRef(conversation.other_user?.id);
  const lastReadRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  relationshipTarget.current = conversation.other_user?.id;
  const title = conversationTitle(conversation);
  const peer = conversation.other_user;

  useLayoutEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.min(140, Math.max(39, textarea.scrollHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 140 ? "auto" : "hidden";
  }, [draft, conversation.id]);

  function addFiles(next: File[]) {
    setFiles((current) => [...current, ...next].slice(0, 4));
    if (next.length + files.length > 4) setError("В одно сообщение можно добавить до 4 файлов");
  }

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      if (event.defaultPrevented || !event.clipboardData) return;
      const target = event.target;
      const insideChat = target instanceof Node && Boolean(panelRef.current?.contains(target));
      const editingElsewhere = !insideChat && target instanceof Element
        && Boolean(target.closest('input, textarea, [contenteditable="true"], [role="textbox"]'));
      const inOtherDialog = !insideChat && target instanceof Element
        && Boolean(target.closest('[role="dialog"], [aria-modal="true"]'));
      if (editingElsewhere || inOtherDialog || document.querySelector('[aria-modal="true"]')) return;
      const pastedFiles = filesFromClipboard(event.clipboardData);
      if (!pastedFiles.length) return;
      event.preventDefault();
      addFiles(pastedFiles);
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  });

  useEffect(() => {
    let active = true;
    setRelationship(null);
    setFriendError("");
    if (!peer) return;
    api.relationship(peer.id).then((result) => {
      if (active) setRelationship(result);
    }).catch((reason: unknown) => {
      if (active) setFriendError(reason instanceof Error ? reason.message : "Не удалось загрузить статус дружбы.");
    });
    return () => { active = false; };
  }, [peer?.id]);

  async function friendAction() {
    if (!relationship || !peer || friendBusy || relationship.relationship === "friends") return;
    const targetId = peer.id;
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

  async function saveGroupName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = groupName.trim();
    if (!name || renameBusy) return;
    setRenameBusy(true);
    setError("");
    try {
      await onRename(conversation.id, name);
      setRenaming(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось переименовать группу.");
    } finally {
      setRenameBusy(false);
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
      setFiles([]);
      setPreview(null);
      setLoading(true);
      setError("");
      setRenaming(false);
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!preview) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [preview]);

  useEffect(() => {
    if (incomingFiles?.files.length) addFiles(incomingFiles.files);
    // A new drop is identified by its nonce; local selections are handled separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingFiles?.nonce]);

  const latestId = messages.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list && nearBottom.current) list.scrollTop = list.scrollHeight;
  }, [latestId]);

  useEffect(() => {
    function markVisibleMessages() {
      if (document.hidden || !latestId || loading) return;
      const key = `${conversation.id}:${latestId}`;
      if (lastReadRef.current === key) return;
      lastReadRef.current = key;
      void onRead(conversation.id, latestId).catch(() => {
        if (lastReadRef.current === key) lastReadRef.current = "";
      });
    }
    markVisibleMessages();
    document.addEventListener("visibilitychange", markVisibleMessages);
    return () => document.removeEventListener("visibilitychange", markVisibleMessages);
  }, [conversation.id, latestId, loading, onRead]);

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
    if ((!body && files.length === 0) || sending) return;
    if (files.some((file) => file.size > 25 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      setError("До 25 МБ на файл и 50 МБ на сообщение");
      return;
    }
    setSending(true);
    setError("");
    try {
      const message = files.length
        ? await api.sendAttachments(conversation.id, body, files)
        : await api.sendMessage(conversation.id, body);
      if (conversationRef.current !== conversation.id) return;
      nearBottom.current = true;
      setMessages((current) => mergeMessages(current, [message]));
      setDraft("");
      setFiles([]);
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
    <div className="messages-panel" ref={panelRef}>
      <div className="messages-intro">
        <span className="avatar avatar-user">{conversation.kind === "group" ? <UsersRound size={25} /> : title[0]?.toUpperCase()}</span>
        <div className="messages-intro-copy">
          <div className="messages-intro-heading">
            <h1>{title}</h1>
            {conversation.kind === "group" && (
              <button className="chat-friend-button" onClick={() => { setGroupName(title); setRenaming(true); }} title="Изменить название группы" aria-label="Изменить название группы"><Pencil size={14} /> Изменить</button>
            )}
            {peer && relationship && (
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
          <p>{conversation.kind === "group"
            ? `Общий чат · ${conversation.members.map((member) => member.username).join(", ")} · Файлы хранятся только 3 дня.`
            : `${peerOnline ? "В сети" : "Не в сети"} · Личная беседа. Сообщения сохраняются в Coherent. Файлы хранятся только 3 дня.`}</p>
        </div>
      </div>
      {renaming && <form className="group-rename-form" onSubmit={(event) => void saveGroupName(event)}>
        <input value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={64} aria-label="Название группы" autoFocus />
        <button type="submit" disabled={renameBusy || !groupName.trim()}>Сохранить</button>
        <button type="button" onClick={() => setRenaming(false)}>Отмена</button>
      </form>}
      {friendError && <p className="call-inline-error" role="alert">{friendError}</p>}
      {callError && <p className="call-inline-error" role="alert">{callError}</p>}

      <div
        className="message-list"
        ref={listRef}
        aria-label={`Сообщения: ${title}`}
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
            <span>{conversation.kind === "group" ? "Напиши первое сообщение участникам группы." : `Напиши первое сообщение для ${title}.`}</span>
          </div>
        )}
        {messages.map((message) => {
          const own = message.sender_id === currentUserId;
          const author = own ? "Ты" : conversation.members.find((member) => member.id === message.sender_id)?.username ?? "Участник";
          const attachmentsExpired = message.attachments_expired || (message.attachment_count > 0 && now >= Date.parse(message.created_at) + 3 * 24 * 60 * 60 * 1000);
          return (
            <div className={`message-row ${own ? "message-own" : ""}`} key={message.id}>
              <span className="avatar avatar-user message-avatar">
                {own ? "Я" : author[0]?.toUpperCase()}
              </span>
              <div className="message-entry">
                <div className="message-meta">
                  <strong>{author}</strong>
                  <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
                </div>
                {message.body && (!attachmentsExpired || message.body !== "Вложение удалено") && <p>{message.body}</p>}
                {attachmentsExpired && <span className="message-attachment-expired">Вложение удалено</span>}
                {!attachmentsExpired && message.attachments?.map((attachment) => {
                  const url = `/api/v1/conversations/${conversation.id}/attachments/${attachment.id}`;
                  return <div className="message-attachment" key={attachment.id}>
                    {attachment.media_type.startsWith("image/") && <button type="button" className="message-image-preview" onClick={() => setPreview({ url, name: attachment.filename })} aria-label={`Открыть фото: ${attachment.filename}`}><img src={url} alt={attachment.filename} loading="lazy" /></button>}
                    {attachment.media_type.startsWith("video/") && <video src={url} controls preload="metadata" />}
                    {attachment.media_type.startsWith("audio/") && <audio src={url} controls preload="none" />}
                    <a href={url} target="_blank" rel="noreferrer">{attachment.filename} · {(attachment.byte_size / 1024 / 1024).toFixed(1)} МБ</a>
                  </div>;
                })}
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
        {files.length > 0 && <div className="composer-files">{files.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}<button type="button" onClick={() => setFiles((current) => current.filter((_, position) => position !== index))} aria-label={`Убрать ${file.name}`}><X size={13} /></button></span>)}</div>}
        <div className="composer-field">
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="composer-attach" onClick={() => fileInputRef.current?.click()} aria-label="Прикрепить файлы" title="Прикрепить файлы"><FilePlus2 size={19} /></button>
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={conversation.kind === "group" ? `Написать в ${title}...` : `Написать ${title}...`}
            aria-label="Текст сообщения"
            maxLength={4000}
            rows={1}
          />
          <button
            type="submit"
            aria-label="Отправить сообщение"
            title="Отправить сообщение"
            disabled={(!draft.trim() && files.length === 0) || sending}
          >
            <Send size={18} />
          </button>
        </div>
        <span className="composer-hint">Enter — отправить · Shift+Enter — новая строка · Ctrl+V — вставить файл или скриншот</span>
      </form>
      {preview && <div className="image-preview-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPreview(null);
      }}>
        <div className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={preview.name}>
          <div className="image-preview-header"><span>{preview.name}</span><a href={preview.url} download={preview.name}>Скачать</a><button type="button" onClick={() => setPreview(null)} aria-label="Закрыть фото"><X size={20} /></button></div>
          <img src={preview.url} alt={preview.name} />
        </div>
      </div>}
    </div>
  );
}
