import GroupMembersDialog from "./GroupMembersDialog";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, Clock3, FilePlus2, MessageCircle, Pencil, Send, UserCheck, UserPlus, UsersRound, X } from "lucide-react";
import ChatSecurityNotice from "./ChatSecurityNotice";
import { messagingFor, MessagingAccessError, type KeyReview } from "../lib/crypto/messaging";
import { apiRequest, api, displayName, attachmentObjectUrl, conversationTitle, type Conversation, type Message, type UserSearchResult } from "../lib/api";

interface MessagesPanelProps {
  conversation: Conversation;
  currentUserId: string;
  version: number;
  onSent: () => void;
  onRead: (conversationId: string, messageId: string) => Promise<void>;
  callError: string;
  inCall?: boolean;
  onRename: (conversationId: string, name: string) => Promise<void>;
  peerOnline?: boolean;
  incomingFiles?: { nonce: number; conversationId: string; files: File[] } | null;
  onFilesConsumed: (nonce: number) => void;
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

function dayKey(value: string | number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value: string, now: number): string {
  if (dayKey(value) === dayKey(now)) return "Сегодня";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(value) === dayKey(yesterday.getTime())) return "Вчера";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value));
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
  inCall = false,
  onRename,
  peerOnline,
  incomingFiles,
  onFilesConsumed,
}: MessagesPanelProps) {
  const consumedDrop = useRef<number | null>(null);
  const secure = conversation.encryption === "mls";
  const [securityReady, setSecurityReady] = useState(false);
  const [securityProblem, setSecurityProblem] = useState<MessagingAccessError | null>(null);
  const [migration, setMigration] = useState<{ done: number; total: number } | null>(null);
  const [migrationInfo, setMigrationInfo] = useState<{remaining:number; own_remaining:number; other_remaining:number} | null>(null);
  const [migrationError, setMigrationError] = useState("");
  const [securityBusy, setSecurityBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);

  async function decodePage(page: Message[]): Promise<Message[]> {
    if (!secure) return page;
    const result: Message[] = [];
    for (const message of page) {
      try { result.push(await messagingFor(currentUserId).decrypt(message)); }
      catch { result.push({ ...message, body: "Подтверди ключи, чтобы прочитать защищённое сообщение", attachments: [], locked: true }); }
    }
    return result;
  }

  useEffect(() => {
    if (!secure) { setMigrationInfo(null); return; }
    let active = true;
    void apiRequest<{remaining:number;own_remaining:number;other_remaining:number}>(`/api/v1/conversations/${conversation.id}/migration`).then(info => { if (active) setMigrationInfo(info); }).catch(() => {});
    return () => { active = false; };
  }, [conversation.id, secure, migration?.done, version]);

  async function verifyKeys(keys: KeyReview[]) {
    setSecurityBusy(true);
    try { await messagingFor(currentUserId).synchronize(conversation, keys); setSecurityReady(true); setSecurityProblem(null); setRetry(n => n + 1); }
    catch (reason) { setSecurityProblem(reason instanceof MessagingAccessError ? reason : new MessagingAccessError("waiting", reason instanceof Error ? reason.message : "Не удалось подключить защищённую беседу")); throw reason; }
    finally { setSecurityBusy(false); }
  }

  async function cancelPending() {
    const id = pendingRef.current; if (!id) return;
    setSending(true);
    try {
      await messagingFor(currentUserId).cancelPending(conversation);
      try { const message = await messagingFor(currentUserId).decrypt(await apiRequest<Message>(`/api/v1/conversations/${conversation.id}/messages/${id}`)); setMessages(current => mergeMessages(current, [message])); setDraft(""); setFiles([]); onSent(); }
      catch { /* An unaccepted message stays in the composer for editing. */ }
      pendingRef.current = null; setPendingId(null); setError(""); setRetry(n => n + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось отменить отправку"); }
    finally { setSending(false); }
  }
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [friendError, setFriendError] = useState("");
  const [relationship, setRelationship] = useState<UserSearchResult | null>(null);
  const [friendBusy, setFriendBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [membersOpen, setMembersOpen] = useState(false);
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
    if (sending || pendingRef.current) { setError("Сначала заверши или отмени текущую отправку"); return; }
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
      setMessages([]); setSecurityReady(false); setSecurityProblem(null); setMigration(null); setMigrationError(""); pendingRef.current = null; setPendingId(null);
      setHasMore(false);
      setDraft("");
      setFiles([]);
      setPreview(null);
      setLoading(true);
      setError("");
      setLoadError("");
      setRenaming(false);
    }

    let active = true;
    api.messages(conversation.id).then(async (page) => {
      if (secure) {
        try { await messagingFor(currentUserId).synchronize(conversation); if (active) { setSecurityReady(true); setSecurityProblem(null); } }
        catch (reason) { if (active) { setSecurityReady(false); setSecurityProblem(reason instanceof MessagingAccessError ? reason : new MessagingAccessError("waiting", reason instanceof Error ? reason.message : "Не удалось синхронизировать ключи")); } }
      }
      const decoded = await decodePage(page.messages);
      if (!active) return;
      setMessages((current) => changed ? decoded : mergeMessages(current, decoded));
      if (!hasLoadedPage.current) {
        setHasMore(page.has_more);
        hasLoadedPage.current = true;
      }
      setLoading(false);
      setLoadError("");
    }).catch((requestError: unknown) => {
      if (!active) return;
      setLoading(false);
      setLoadError(requestError instanceof Error ? requestError.message : "Не удалось загрузить сообщения.");
    });
    return () => { active = false; };
  }, [conversation.id, conversation.encryption, version, retry]);

  useEffect(() => {
    if (!secure || securityReady || securityProblem?.kind !== "waiting") return;
    const timer = window.setInterval(() => { if (!document.hidden) setRetry(value => value + 1); }, 4500);
    return () => window.clearInterval(timer);
  }, [secure, securityReady, securityProblem?.kind]);

  useEffect(() => {
    if (!secure || !securityReady) return;
    let active = true;
    setMigrationError("");
    void messagingFor(currentUserId).migrateOwnHistory(conversation, (done, total) => { if (active) setMigration(total ? { done, total } : null); }).then(() => { if (active) { setMigration(null); setRetry(n => n + 1); } }).catch(reason => { if (active) { setMigration(null); setMigrationError(reason instanceof Error ? reason.message : "Перенос истории будет продолжен позже"); } });
    return () => { active = false; };
  }, [conversation.id, secure, securityReady]);

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
    if (incomingFiles?.files.length && incomingFiles.conversationId === conversation.id
      && consumedDrop.current !== incomingFiles.nonce) {
      consumedDrop.current = incomingFiles.nonce;
      addFiles(incomingFiles.files);
      onFilesConsumed(incomingFiles.nonce);
    }
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
      if (document.hidden || !document.hasFocus() || !nearBottom.current || !latestId || loading || messages.at(-1)?.locked) return;
      const key = `${conversation.id}:${latestId}`;
      if (lastReadRef.current === key) return;
      lastReadRef.current = key;
      void onRead(conversation.id, latestId).catch(() => {
        if (lastReadRef.current === key) lastReadRef.current = "";
      });
    }
    markVisibleMessages();
    const list = listRef.current;
    const onScroll = () => {
      if (list) nearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
      markVisibleMessages();
    };
    document.addEventListener("visibilitychange", markVisibleMessages);
    window.addEventListener("focus", markVisibleMessages);
    list?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("visibilitychange", markVisibleMessages);
      window.removeEventListener("focus", markVisibleMessages);
      list?.removeEventListener("scroll", onScroll);
    };
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
      const decoded = await decodePage(page.messages);
      setMessages((current) => mergeMessages(decoded, current));
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
      if (secure && !pendingRef.current) { pendingRef.current = crypto.randomUUID(); setPendingId(pendingRef.current); }
      const message = secure
        ? await messagingFor(currentUserId).send(conversation, body, files, pendingRef.current!)
        : files.length ? await api.sendAttachments(conversation.id, body, files) : await api.sendMessage(conversation.id, body);
      pendingRef.current = null; setPendingId(null);
      if (conversationRef.current !== conversation.id) return;
      nearBottom.current = true;
      setMessages((current) => mergeMessages(current, [message]));
      setDraft("");
      setFiles([]);
      onSent();
    } catch (requestError) {
      if (secure && pendingRef.current && !await messagingFor(currentUserId).hasPending(pendingRef.current).catch(() => true)) { pendingRef.current = null; setPendingId(null); }
      if (requestError instanceof MessagingAccessError) { setSecurityProblem(requestError); setSecurityReady(false); }
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
      <div className="messages-intro" hidden={inCall}>
        <span className="avatar avatar-user">{conversation.kind === "group" ? <UsersRound size={25} /> : title[0]?.toUpperCase()}</span>
        <div className="messages-intro-copy">
          <div className="messages-intro-heading">
            <h1>{title}</h1>
            {conversation.kind === "group" && !conversation.server_id && (
              <button className="chat-friend-button" title="Участники группы" onClick={() => setMembersOpen(true)}><UsersRound size={16} /> Участники</button>
            )}
            {conversation.kind === "group" && !conversation.server_id && (
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
          <p>{conversation.server_id ? `Текстовый канал · ${conversation.members.length} участников · Файлы хранятся 3 дня.` : conversation.kind === "group"
            ? `Общий чат · ${conversation.members.map(displayName).join(", ")} · Файлы хранятся только 3 дня.`
            : `${peerOnline ? "В сети" : "Не в сети"} · Личная беседа. Сообщения сохраняются в Coherent. Файлы хранятся только 3 дня.`}</p>
        </div>
      </div>
      {membersOpen && <GroupMembersDialog conversation={conversation} account={currentUserId} onClose={() => setMembersOpen(false)} onUpdated={() => { setMembersOpen(false); onSent(); }} onLeft={() => { setMembersOpen(false); onSent(); }} />}
      {secure && !!migrationInfo?.remaining && <p className="migration-status">Старая облачная история: {migrationInfo.remaining} сообщений. {migrationInfo.own_remaining ? `Твоих осталось перенести: ${migrationInfo.own_remaining}.` : "Твои сообщения перенесены."} {migrationInfo.other_remaining ? "Остальные перенесутся, когда авторы откроют беседу." : ""}</p>}
      {renaming && <form className="group-rename-form" onSubmit={(event) => void saveGroupName(event)}>
        <input value={groupName} onChange={(event) => setGroupName(event.target.value)} maxLength={64} aria-label="Название группы" autoFocus />
        <button type="submit" disabled={renameBusy || !groupName.trim()}>Сохранить</button>
        <button type="button" onClick={() => setRenaming(false)}>Отмена</button>
      </form>}
      {secure && (!inCall || !!securityProblem) && <ChatSecurityNotice accountId={currentUserId} conversation={conversation} ready={securityReady} problem={securityProblem} busy={securityBusy} onVerify={verifyKeys} onRetry={() => setRetry(n => n + 1)} />}
      {migration && <div className="chat-security-notice">Переводим твою старую историю в E2EE: {migration.done} из {migration.total}. Сообщения остаются на месте.</div>}
      {migrationError && <div className="chat-security-notice">{migrationError} Облачная копия сохранена.</div>}
      {friendError && <p className="call-inline-error" role="alert">{friendError}</p>}
      {callError && <p className="call-inline-error" role="alert">{callError}</p>}

      <div
        className="message-list"
        ref={listRef}
        aria-label={`Сообщения: ${title}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 30;
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
        {messages.map((message, index) => {
          const own = message.sender_id === currentUserId;
          const author = own ? "Ты" : (conversation.members.find((member) => member.id === message.sender_id) ? displayName(conversation.members.find((member) => member.id === message.sender_id)!) : "Участник");
          const attachmentsExpired = message.attachments_expired || (message.attachment_count > 0 && now >= Date.parse(message.created_at) + 3 * 24 * 60 * 60 * 1000);
          return (
            <Fragment key={message.id}>
            {(index === 0 || dayKey(messages[index - 1].created_at) !== dayKey(message.created_at)) && <div className="message-date-divider"><time dateTime={message.created_at}>{dayLabel(message.created_at, now)}</time></div>}
            <div className={`message-row ${own ? "message-own" : ""}`} key={message.id}>
              <span className="avatar avatar-user message-avatar">
                {own ? "Я" : author[0]?.toUpperCase()}
              </span>
              <div className="message-entry">
                <div className="message-meta">
                  <strong>{author}</strong>
                  <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
                  {secure && <span className="message-encryption-label">{message.crypto ? "E2EE" : "Облачная история"}</span>}
                </div>
                {message.body && (!attachmentsExpired || message.body !== "Вложение удалено") && <p>{message.body}</p>}
                {attachmentsExpired && <span className="message-attachment-expired">Вложение удалено</span>}
                {!attachmentsExpired && message.attachments?.map((attachment) => <AttachmentView
                  key={attachment.id}
                  path={`/api/v1/conversations/${conversation.id}/attachments/${attachment.id}`}
                  attachment={attachment}
                  accountId={currentUserId}
                  onPreview={(url) => setPreview({ url, name: attachment.filename })}
                />)}
              </div>
            </div>
            </Fragment>
          );
        })}
      </div>

      {pendingId && !sending && <div className="pending-secure-message">Сообщение сохранено в защищённой очереди. Повторная отправка не создаст копию.<button type="button" onClick={() => void sendMessage()}>Повторить</button><button type="button" onClick={() => void cancelPending()}>Отменить отправку</button></div>}
      <form className="message-composer" onSubmit={(event) => void sendMessage(event)}>
        {(error || loadError) && (
          <div className="message-error" role="alert">
            {error || loadError} {messages.length === 0 && <button type="button" onClick={() => setRetry((n) => n + 1)}>Повторить</button>}
          </div>
        )}
        {files.length > 0 && <div className="composer-files">{files.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}<button type="button" onClick={() => setFiles((current) => current.filter((_, position) => position !== index))} aria-label={`Убрать ${file.name}`}><X size={13} /></button></span>)}</div>}
        <div className="composer-field">
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="composer-attach" disabled={sending || !!pendingId} onClick={() => fileInputRef.current?.click()} aria-label="Прикрепить файлы" title="Прикрепить файлы"><FilePlus2 size={19} /></button>
          <textarea
            ref={draftRef}
            readOnly={sending || !!pendingId}
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
            disabled={(!draft.trim() && files.length === 0) || sending || (secure && !securityReady && !pendingId)}
          >
            <Send size={18} />
          </button>
        </div>
        <div className="composer-footer">
          <span className="composer-hint">Enter — отправить · Shift+Enter — новая строка · Ctrl+V — вставить файл или скриншот</span>
          {!secure && !inCall && <small className="composer-security-note" title="TLS защищает передачу, сообщения шифруются при хранении на сервере. Сервер расшифровывает историю для участников беседы; это не сквозное шифрование.">Защита при передаче и хранении на сервере</small>}
        </div>
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

function AttachmentView({ path, attachment, accountId, onPreview }: {
  path: string;
  accountId: string;
  attachment: Message["attachments"][number];
  onPreview: (url: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [requestNumber, setRequestNumber] = useState(0);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!attachment.media_type.startsWith("image/")) return;
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRequestNumber(1);
        observer.disconnect();
      }
    }, { rootMargin: "250px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [attachment.media_type]);

  useEffect(() => {
    if (!requestNumber) return;
    setError("");
    let active = true;
    let loadedUrl = "";
    void (attachment.secure ? messagingFor(accountId).openAttachment(path, attachment.secure) : attachmentObjectUrl(path)).then((value) => {
      loadedUrl = value;
      if (active) setUrl(value);
      else if (value.startsWith("blob:")) URL.revokeObjectURL(value);
    }).catch(() => { if (active) setError("Не удалось загрузить вложение"); });
    return () => {
      active = false;
      if (loadedUrl.startsWith("blob:")) URL.revokeObjectURL(loadedUrl);
    };
  }, [path, requestNumber]);

  return <div className="message-attachment" ref={container}>
    {url && attachment.media_type.startsWith("image/") && <button type="button" className="message-image-preview" onClick={() => onPreview(url)} aria-label={`Открыть фото: ${attachment.filename}`}><img src={url} alt={attachment.filename} loading="lazy" /></button>}
    {url && attachment.media_type.startsWith("video/") && <video src={url} controls preload="metadata" />}
    {url && attachment.media_type.startsWith("audio/") && <audio src={url} controls preload="none" />}
    {url ? <a href={url} download={attachment.filename}>{attachment.filename} · {(attachment.byte_size / 1024 / 1024).toFixed(1)} МБ</a>
      : <button type="button" onClick={() => setRequestNumber((value) => value + 1)} disabled={requestNumber > 0 && !error}>
        {error || (requestNumber ? `Загружаем ${attachment.filename}…` : `Открыть ${attachment.filename} · ${(attachment.byte_size / 1024 / 1024).toFixed(1)} МБ`)}
      </button>}
  </div>;
}
