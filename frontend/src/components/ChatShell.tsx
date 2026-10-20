import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  CircleHelp,
  Compass,
  Headphones,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Settings,
  Users,
  UsersRound,
  Video,
  VideoOff,
  VolumeX,
} from "lucide-react";
import { ConnectionState, type Room } from "livekit-client";
import { api, type Call, type Conversation, type User } from "../lib/api";
import {
  cameraCapture,
  loadMediaPreferences,
  microphoneCapture,
  saveMediaPreferences,
  type MediaPreferences,
} from "../lib/media";
import FriendsPanel from "./FriendsPanel";
import MediaSettingsPanel from "./MediaSettingsPanel";
import MessagesPanel from "./MessagesPanel";
import ParticipantPicker from "./ParticipantPicker";

interface ChatShellProps {
  user: User;
  onLogout: () => void;
}

type Section = "messages" | "friends";
const CallPanel = lazy(() => import("./CallPanel"));

export default function ChatShell({ user, onLogout }: ChatShellProps) {
  const [section, setSection] = useState<Section>("messages");
  const [showProfile, setShowProfile] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [messageVersion, setMessageVersion] = useState(0);
  const [currentCall, setCurrentCall] = useState<Call | null>(null);
  const [callPending, setCallPending] = useState(false);
  const [callError, setCallError] = useState("");
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlError, setControlError] = useState("");
  const [media, setMedia] = useState(loadMediaPreferences);
  const mediaRef = useRef(media);
  const roomRef = useRef<Room | null>(null);
  const mediaQueue = useRef<Promise<void>>(Promise.resolve());
  const initial = user.username.slice(0, 1).toUpperCase();
  const selectedConversation = conversations.find((item) => item.id === activeConversationId);
  const callCompact = Boolean(currentCall && (section !== "messages" || activeConversationId !== currentCall.conversation_id));
  const callPanelReady = Boolean(currentCall?.status === "active"
    && currentCall.participants.some((participant) => participant.user_id === user.id && participant.state === "joined")
    && !callCompact);
  const visibleConversations = conversations.filter((item) =>
    item.other_user.username.toLowerCase().includes(conversationQuery.trim().toLowerCase()),
  );

  const refreshConversations = useCallback(async () => {
    const result = await api.conversations();
    setConversations(result.conversations);
    setActiveConversationId((current) => current ?? result.conversations[0]?.id ?? null);
    setConversationError("");
  }, []);

  const refreshCalls = useCallback(async () => {
    const result = await api.currentCalls();
    setCurrentCall(result.calls[0] ?? null);
  }, []);

  useEffect(() => {
    void refreshConversations().catch((error: unknown) => {
      setConversationError(error instanceof Error ? error.message : "Не удалось загрузить беседы.");
    });
  }, [refreshConversations]);

  useEffect(() => {
    void refreshCalls().catch(() => undefined);
    const timer = window.setInterval(() => void refreshCalls().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [refreshCalls]);

  useEffect(() => {
    if (!currentCall || (currentCall.status === "ringing" && currentCall.callee_id === user.id)) {
      return;
    }
    const callId = currentCall.id;
    const handlePageHide = () => api.endCallOnPageHide(callId);
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [currentCall, user.id]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let reconnectDelay = 1000;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/conversations/events`);
      socket.onopen = () => {
        reconnectDelay = 1000;
        void refreshConversations().catch(() => undefined);
        setMessageVersion((current) => current + 1);
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string };
          if (payload.type === "call") {
            void refreshCalls().catch(() => undefined);
            void refreshConversations().catch(() => undefined);
            return;
          }
          if (payload.type !== "message") return;
          void refreshConversations().catch(() => undefined);
          setMessageVersion((current) => current + 1);
        } catch {
          // Ignore an event with an unknown payload.
        }
      };
      socket.onclose = (event) => {
        if (stopped || event.code === 1008) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };
      socket.onerror = () => socket?.close();
    }

    connect();
    const pollTimer = window.setInterval(() => {
      void refreshConversations().catch(() => undefined);
      setMessageVersion((current) => current + 1);
    }, 15000);
    return () => {
      stopped = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [refreshConversations, refreshCalls]);

  const setActiveRoom = useCallback((room: Room | null) => {
    roomRef.current = room;
  }, []);

  const updateMedia = useCallback((patch: Partial<MediaPreferences>): Promise<void> => {
    const operation = mediaQueue.current.then(async () => {
      const current = mediaRef.current;
      const next = { ...current, ...patch };
      const room = roomRef.current;
      if (room?.state === ConnectionState.Connected) {
        const participant = room.localParticipant;
        const microphoneCaptureChanged = patch.noiseSuppression !== undefined
          || patch.echoCancellation !== undefined;
        const cameraCaptureChanged = patch.videoCodec !== undefined
          || patch.videoQuality !== undefined;

        if (patch.microphoneEnabled !== undefined || microphoneCaptureChanged) {
          if (microphoneCaptureChanged && current.microphoneEnabled) {
            await participant.setMicrophoneEnabled(false);
          }
          try {
            await participant.setMicrophoneEnabled(next.microphoneEnabled, microphoneCapture(next));
          } catch (reason) {
            if (microphoneCaptureChanged && current.microphoneEnabled) {
              await participant.setMicrophoneEnabled(true, microphoneCapture(current)).catch(() => undefined);
            }
            throw reason;
          }
        }
        if (patch.cameraEnabled !== undefined || cameraCaptureChanged) {
          if (cameraCaptureChanged && current.cameraEnabled) {
            await participant.setCameraEnabled(false);
          }
          try {
            await participant.setCameraEnabled(
              next.cameraEnabled,
              cameraCapture(next),
              { videoCodec: next.videoCodec },
            );
          } catch (reason) {
            if (cameraCaptureChanged && current.cameraEnabled) {
              await participant.setCameraEnabled(
                true,
                cameraCapture(current),
                { videoCodec: current.videoCodec },
              ).catch(() => undefined);
            }
            throw reason;
          }
        }
        if (patch.microphoneId !== undefined && next.microphoneEnabled) {
          if (!await room.switchActiveDevice("audioinput", next.microphoneId || "default")) {
            throw new Error("Не удалось выбрать микрофон.");
          }
        }
        if (patch.cameraId !== undefined && next.cameraEnabled) {
          if (!await room.switchActiveDevice("videoinput", next.cameraId || "default")) {
            throw new Error("Не удалось выбрать камеру.");
          }
        }
        if (patch.speakerId !== undefined) {
          if (!await room.switchActiveDevice("audiooutput", next.speakerId || "default")) {
            throw new Error("Браузер не смог переключить вывод звука.");
          }
        }
      }
      mediaRef.current = next;
      setMedia(next);
      saveMediaPreferences(next);
      setControlError("");
    });
    mediaQueue.current = operation.catch(() => undefined);
    return operation;
  }, []);

  function changeMedia(patch: Partial<MediaPreferences>) {
    return updateMedia(patch).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : "Не удалось изменить настройку.";
      setControlError(message);
      throw reason;
    });
  }

  async function startCall(inviteeIds: string[] = []) {
    if (!activeConversationId || currentCall || callPending) return;
    setCallPending(true);
    setCallError("");
    try {
      setCurrentCall(await api.startCall(activeConversationId, inviteeIds));
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : "Не удалось начать звонок.");
      throw reason;
    } finally {
      setCallPending(false);
    }
  }

  async function inviteToCall(userIds: string[]) {
    if (!currentCall) return;
    const call = await api.inviteCall(currentCall.id, userIds);
    setCurrentCall(call);
  }

  async function acceptCall() {
    if (!currentCall || callPending) return;
    setCallPending(true);
    setCallError("");
    try {
      const call = await api.acceptCall(currentCall.id);
      setCurrentCall(call);
      setActiveConversationId(call.conversation_id);
      setSection("messages");
      void refreshConversations().catch(() => undefined);
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : "Не удалось принять звонок.");
      void refreshCalls().catch(() => undefined);
    } finally {
      setCallPending(false);
    }
  }

  async function endCall() {
    if (!currentCall || callPending) return;
    setCallPending(true);
    setCallError("");
    try {
      await api.endCall(currentCall.id);
      setCurrentCall(null);
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : "Не удалось завершить звонок.");
    } finally {
      setCallPending(false);
    }
  }

  async function startConversation(userId: string) {
    const conversation = await api.openConversation(userId);
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
    setActiveConversationId(conversation.id);
    setSection("messages");
    setMessageVersion((current) => current + 1);
    void refreshConversations().catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <aside className="server-rail">
        <button className="rail-home active" aria-label="Coherent" disabled>
          <span className="brand-mark"><span /><span /><span /></span>
        </button>
        <div className="rail-separator" />
        <button
          className={`rail-item ${section === "messages" ? "selected" : ""}`}
          aria-label="Сообщения"
          onClick={() => setSection("messages")}
        >
          <MessageCircle size={21} />
        </button>
        <button
          className={`rail-item ${section === "friends" ? "selected" : ""}`}
          aria-label="Друзья"
          onClick={() => setSection("friends")}
        >
          <Users size={21} />
        </button>
        <button
          className="rail-item"
          aria-label="Поиск пользователей"
          onClick={() => setSection("friends")}
        >
          <Compass size={21} />
        </button>
        <div className="rail-spacer" />
        <button
          className="rail-item rail-voice"
          aria-label="Открыть настройки звука и видео"
          title="Настройки звука и видео"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Headphones size={20} />
        </button>
        <button
          className="rail-profile"
          onClick={() => setShowProfile((visible) => !visible)}
          aria-label="Профиль"
        >
          <span className="avatar avatar-user">{initial}</span>
          <i />
        </button>
      </aside>

      <aside className="channel-sidebar">
        <button className="workspace-picker" disabled>
          <span className="workspace-symbol">
            <span className="brand-mark"><span /><span /><span /></span>
          </span>
          <span className="workspace-name">Coherent</span>
          <ChevronDown size={16} />
        </button>

        <label className="sidebar-search">
          <Search size={15} />
          <input
            value={conversationQuery}
            onChange={(event) => setConversationQuery(event.target.value)}
            placeholder="Найти беседу"
            aria-label="Найти беседу"
          />
        </label>

        <div className="sidebar-nav">
          <button
            className={`sidebar-nav-item ${section === "messages" ? "active" : ""}`}
            onClick={() => setSection("messages")}
          >
            <MessageCircle size={18} /> Личные сообщения
          </button>
          <button
            className={`sidebar-nav-item ${section === "friends" ? "active" : ""}`}
            onClick={() => setSection("friends")}
          >
            <Users size={18} /> Друзья
            <span className="nav-add"><Plus size={15} /></span>
          </button>
        </div>

        <div className="sidebar-section-title">
          <span>ЛИЧНЫЕ СООБЩЕНИЯ</span>
          <button aria-label="Начать беседу" title="Найти собеседника" onClick={() => setSection("friends")}>
            <Plus size={16} />
          </button>
        </div>
        {conversationError && <p className="conversation-error" role="alert">{conversationError}</p>}
        {visibleConversations.length > 0 ? (
          <div className="conversation-list">
            {visibleConversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${section === "messages" && activeConversationId === conversation.id ? "active" : ""}`}
                onClick={() => {
                  setActiveConversationId(conversation.id);
                  setSection("messages");
                }}
              >
                <span className="avatar avatar-user">{conversation.other_user.username[0]?.toUpperCase()}</span>
                <span className="conversation-item-copy">
                  <strong>{conversation.other_user.username}</strong>
                  <small>{conversation.last_message?.body ?? "Беседа начата"}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-conversations">
            <div className="empty-bubble"><MessageCircle size={18} /></div>
            <span>{conversationQuery ? "Беседа не найдена" : "Пока здесь тихо"}</span>
            <p>{conversationQuery ? "Попробуй другое имя." : "Найди пользователя и начни разговор."}</p>
          </div>
        )}

        <div className="sidebar-bottom-note">
          <span className="sidebar-note-icon"><SparkleGlyph /></span>
          <div>
            <strong>Coherent в разработке</strong>
            <small>Мы создаём место для общения</small>
          </div>
        </div>
      </aside>

      <section className="content-area">
        <header className="content-header">
          <div className="header-location">
            <MessageCircle size={19} />
            <span>{section === "messages" ? selectedConversation?.other_user.username ?? (currentCall?.status === "active" ? "Групповой звонок" : "Сообщения") : "Друзья"}</span>
            <span className="header-divider" />
            <span className="header-subtle">Личное пространство</span>
          </div>
          <div className="mobile-nav" aria-label="Разделы">
            <button className={section === "messages" ? "active" : ""} onClick={() => setSection("messages")} aria-label="Сообщения"><MessageCircle size={18} /></button>
            <button className={section === "friends" ? "active" : ""} onClick={() => setSection("friends")} aria-label="Друзья"><Users size={18} /></button>
          </div>
          <div className="header-actions">
            {section === "messages" && selectedConversation && (
              <button
                className="header-icon header-call-button"
                onClick={() => void startCall().catch(() => undefined)}
                disabled={Boolean(currentCall) || callPending}
                aria-label={`Позвонить ${selectedConversation.other_user.username}`}
                title="Начать голосовой звонок"
              >
                <Phone size={19} />
              </button>
            )}
            {section === "messages" && selectedConversation && (
              <button
                className="header-icon header-call-button"
                onClick={() => setShowGroupPicker(true)}
                disabled={Boolean(currentCall) || callPending}
                aria-label="Начать групповой звонок"
                title="Начать групповой звонок"
              >
                <UsersRound size={19} />
              </button>
            )}
            <button className="header-icon" aria-label="Уведомления появятся позже" disabled>
              <Bell size={18} />
            </button>
            <button className="header-icon" aria-label="Помощь появится позже" disabled>
              <CircleHelp size={18} />
            </button>
            <span className="header-user">{user.username}</span>
          </div>
        </header>

        {section === "messages" && conversations.length > 0 && (
          <div className="mobile-conversations" aria-label="Беседы">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={activeConversationId === conversation.id ? "active" : ""}
                onClick={() => setActiveConversationId(conversation.id)}
              >
                {conversation.other_user.username}
              </button>
            ))}
          </div>
        )}

        {currentCall && (
          <Suspense fallback={<div className="call-connect-note">Подготавливаем звонок...</div>}>
            <CallPanel
              call={currentCall}
              currentUserId={user.id}
              compact={callCompact}
              error={callError}
              pending={callPending}
              media={media}
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((open) => !open)}
              onMediaChange={changeMedia}
              onRoomReady={setActiveRoom}
              onInvite={inviteToCall}
              onAccept={() => void acceptCall()}
              onEnd={() => void endCall()}
              onFocus={() => {
                setActiveConversationId(currentCall.conversation_id);
                setSection("messages");
              }}
            />
          </Suspense>
        )}

        {section === "messages" && selectedConversation ? (
          <MessagesPanel
            conversation={selectedConversation}
            currentUserId={user.id}
            version={messageVersion}
            onSent={() => { void refreshConversations().catch(() => undefined); }}
            callError={currentCall ? "" : callError}
          />
        ) : (
        <div className={`welcome-content ${section === "friends" ? "friends-content" : ""}`}>
          {section === "messages" ? (
            <>
              {currentCall?.status === "active" ? (
                <div className="welcome-copy">
                  <h1>Групповой звонок<br /><span>уже идёт.</span></h1>
                  <p>Управление участниками, звуком и видео находится в панели звонка выше.</p>
                </div>
              ) : (
                <>
                  <div className="welcome-eyebrow">
                    <span className="welcome-pulse" /> ПЕРВОЕ ПРОСТРАНСТВО COHERENT
                  </div>
                  <WelcomeArt />
                  <div className="welcome-copy">
                    <h1>Хорошие разговоры<br /><span>начинаются здесь.</span></h1>
                    <p>Найди своих людей — и оставайся рядом, где бы вы ни были.</p>
                    <button className="primary-button welcome-button" onClick={() => setSection("friends")}>
                      <Users size={17} /> Найти собеседника <span className="button-arrow">↗</span>
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <FriendsPanel onStartConversation={startConversation} />
          )}
        </div>
        )}

        <footer className="app-statusbar">
          <span><i className="status-dot" /> Сессия активна</span>
          <span>Coherent <b>·</b> ранняя версия</span>
          <button aria-label="Настройки звука и видео" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings size={15} />
          </button>
        </footer>
      </section>

      {showProfile && (
        <div className="profile-menu">
          <div className="profile-menu-user">
            <span className="avatar avatar-user">{initial}</span>
            <div><strong>{user.username}</strong><span>В сети</span></div>
            <MoreHorizontal size={18} />
          </div>
          <button onClick={onLogout}><LogOut size={16} /> Выйти из аккаунта</button>
        </div>
      )}

      <div className="account-bar">
        <div className="account-profile">
          <button
            className="avatar avatar-user"
            onClick={() => setShowProfile((visible) => !visible)}
            aria-label="Открыть профиль"
          >
            {initial}
          </button>
          <span className="account-name">
            <strong>{user.username}</strong>
            <small>В сети</small>
          </span>
          <button
            className="account-settings"
            aria-label="Настройки звука и видео"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings size={16} />
          </button>
        </div>
        <div className="account-controls">
          <button className={media.microphoneEnabled ? "is-on" : "is-off"} aria-label={media.microphoneEnabled ? "Выключить микрофон" : "Включить микрофон"} title={media.microphoneEnabled ? "Выключить микрофон" : "Включить микрофон"} onClick={() => void changeMedia({ microphoneEnabled: !media.microphoneEnabled }).catch(() => undefined)}>
            {media.microphoneEnabled ? <Mic size={16} /> : <MicOff size={16} />}
          </button>
          <button className={media.deafened ? "is-off" : "is-on"} aria-label={media.deafened ? "Включить звук собеседников" : "Не слышать собеседников"} title={media.deafened ? "Включить звук" : "Не слышать собеседников"} onClick={() => void changeMedia({ deafened: !media.deafened }).catch(() => undefined)}>
            {media.deafened ? <VolumeX size={16} /> : <Headphones size={16} />}
          </button>
          <button className={media.cameraEnabled ? "is-on" : "is-off"} aria-label={media.cameraEnabled ? "Выключить камеру" : "Включить камеру"} title={media.cameraEnabled ? "Выключить камеру" : "Включить камеру"} onClick={() => void changeMedia({ cameraEnabled: !media.cameraEnabled }).catch(() => undefined)}>
            {media.cameraEnabled ? <Video size={16} /> : <VideoOff size={16} />}
          </button>
        </div>
      </div>
      {controlError && <div className="media-control-error" role="alert">{controlError}</div>}
      {settingsOpen && !callPanelReady && (
        <MediaSettingsPanel media={media} onChange={changeMedia} onClose={() => setSettingsOpen(false)} />
      )}
      {showGroupPicker && selectedConversation && (
        <ParticipantPicker
          title="Новый групповой звонок"
          submitLabel="Позвонить"
          excludedIds={[user.id, selectedConversation.other_user.id]}
          maxSelect={8}
          onSubmit={(ids) => startCall(ids)}
          onClose={() => setShowGroupPicker(false)}
        />
      )}
    </main>
  );
}

function WelcomeArt() {
  return (
    <div className="welcome-art" aria-hidden="true">
      <div className="art-orbit art-orbit-a" />
      <div className="art-orbit art-orbit-b" />
      <div className="art-glow" />
      <div className="art-chat-card chat-card-left">
        <span className="art-avatar art-avatar-purple">A</span>
        <div><i /><i /></div>
        <span className="chat-spark">✦</span>
      </div>
      <div className="art-chat-card chat-card-right">
        <span className="art-avatar art-avatar-orange">M</span>
        <div><i /><i /><i /></div>
      </div>
      <div className="art-main-icon">
        <span className="brand-mark"><span /><span /><span /></span>
        <span className="art-signal signal-one" />
        <span className="art-signal signal-two" />
      </div>
      <div className="art-micro-dot dot-a" />
      <div className="art-micro-dot dot-b" />
      <div className="art-micro-dot dot-c" />
    </div>
  );
}

function SparkleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 1.5 11.7 8l6.8 2-6.8 2L10 18.5 8.3 12l-6.8-2 6.8-2L10 1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
