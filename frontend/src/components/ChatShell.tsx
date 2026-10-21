import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  UserPlus,
  Video,
  VideoOff,
  VolumeX,
} from "lucide-react";
import { ConnectionState, Track, type Room } from "livekit-client";
import { api, conversationTitle, type Call, type Conversation, type FriendRequest, type User } from "../lib/api";
import {
  cameraCapture,
  cameraPublish,
  loadMediaPreferences,
  microphoneCapture,
  readAudioProcessing,
  saveMediaPreferences,
  supportedAudioProcessing,
  updateScreenShareBitrate,
  type AudioProcessingState,
  type MediaPreferences,
} from "../lib/media";
import FriendsPanel from "./FriendsPanel";
import MediaSettingsPanel from "./MediaSettingsPanel";
import MessagesPanel from "./MessagesPanel";
import ParticipantPicker from "./ParticipantPicker";
import { applyMicrophoneProcessing } from "../lib/microphoneProcessor";

interface ChatShellProps {
  user: User;
  onLogout: () => void;
}

type Section = "messages" | "friends";
type FriendsTab = "search" | "all" | "requests";
type ShellPopover = "workspace" | "notifications" | "help" | null;
const CallPanel = lazy(() => import("./CallPanel"));

export default function ChatShell({ user, onLogout }: ChatShellProps) {
  const [section, setSection] = useState<Section>("messages");
  const [showWelcome, setShowWelcome] = useState(false);
  const [friendsInitialTab, setFriendsInitialTab] = useState<FriendsTab>("search");
  const [popover, setPopover] = useState<ShellPopover>(null);
  const [notificationRequests, setNotificationRequests] = useState<FriendRequest[]>([]);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => typeof Notification === "undefined" ? "denied" : Notification.permission);
  const [recentNotifications, setRecentNotifications] = useState<Array<{ id: string; title: string; conversationId: string }>>([]);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(() => new Set());
  const [showProfile, setShowProfile] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [messageVersion, setMessageVersion] = useState(0);
  const [currentCall, setCurrentCall] = useState<Call | null>(null);
  const [availableCalls, setAvailableCalls] = useState<Call[]>([]);
  const [callPending, setCallPending] = useState(false);
  const [callError, setCallError] = useState("");
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlError, setControlError] = useState("");
  const [media, setMedia] = useState(loadMediaPreferences);
  const [audioProcessingState, setAudioProcessingState] = useState<AudioProcessingState | null>(null);
  const mediaRef = useRef(media);
  const roomRef = useRef<Room | null>(null);
  const mediaQueue = useRef<Promise<void>>(Promise.resolve());
  const ringtoneRef = useRef<HTMLAudioElement>(null);
  const notifiedCalls = useRef(new Set<string>());
  const notifiedRequests = useMemo(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`coherent.notified-requests.${user.id}`) ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  }, [user.id]);
  const activeConversationRef = useRef(activeConversationId);
  const sectionRef = useRef(section);
  const conversationsRef = useRef(conversations);
  activeConversationRef.current = activeConversationId;
  sectionRef.current = section;
  conversationsRef.current = conversations;
  const initial = user.username.slice(0, 1).toUpperCase();
  const selectedConversation = showWelcome ? undefined : conversations.find((item) => item.id === activeConversationId);
  const busyInCall = Boolean(currentCall?.participants.some((participant) =>
    participant.user_id === user.id && (participant.state === "joined" || participant.state === "invited")
  ));
  const resumableCall = availableCalls.find((call) => call.conversation_id === activeConversationId
    && call.status === "active"
    && call.participants.some((participant) => participant.user_id === user.id && participant.state === "left"));
  const callCompact = Boolean(currentCall && (section !== "messages" || showWelcome || activeConversationId !== currentCall.conversation_id));
  const callPanelReady = Boolean(currentCall?.status === "active"
    && currentCall.participants.some((participant) => participant.user_id === user.id && participant.state === "joined")
    && !callCompact);
  const visibleConversations = conversations.filter((item) =>
    conversationTitle(item).toLowerCase().includes(conversationQuery.trim().toLowerCase()),
  );

  const refreshConversations = useCallback(async () => {
    const result = await api.conversations();
    setConversations(result.conversations);
    setActiveConversationId((current) => current ?? result.conversations[0]?.id ?? null);
    setConversationError("");
  }, []);

  const refreshPresence = useCallback(async () => {
    const result = await api.presence();
    setOnlineIds(new Set(result.online_user_ids));
  }, []);

  const showNotification = useCallback((id: string, title: string, body: string, conversationId: string) => {
    setRecentNotifications((current) => [{ id, title, conversationId }, ...current.filter((item) => item.id !== id)].slice(0, 8));
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const notice = new Notification(title, { body, icon: "/favicon.svg", tag: id });
      notice.onclick = () => {
        window.focus();
        setSection(conversationId ? "messages" : "friends");
        if (conversationId) setActiveConversationId(conversationId);
        else setFriendsInitialTab("requests");
        setShowWelcome(false);
        notice.close();
      };
    } catch {
      // The in-app notification remains available if this browser cannot show a system notification.
    }
  }, []);

  const refreshCalls = useCallback(async () => {
    const result = await api.currentCalls();
    for (const call of result.calls) {
      const invited = call.participants.some((participant) => participant.user_id === user.id && participant.state === "invited");
      if (!invited || notifiedCalls.current.has(call.id)) continue;
      notifiedCalls.current.add(call.id);
      showNotification(`call-${call.id}`, "Входящий звонок", `${call.caller_username} звонит тебе`, call.conversation_id);
    }
    setAvailableCalls(result.calls);
    setCurrentCall((current) => result.calls.find((call) => call.participants.some((participant) =>
      participant.user_id === user.id && participant.state === "joined"
    )) ?? result.calls.find((call) => call.participants.some((participant) =>
      participant.user_id === user.id && participant.state === "invited"
    )) ?? result.calls.find((call) => call.id === current?.id) ?? result.calls[0] ?? null);
  }, [showNotification, user.id]);

  useEffect(() => {
    let active = true;
    async function refreshRequests() {
      const result = await api.friendRequests();
      if (!active) return;
      setNotificationRequests(result.incoming);
      for (const request of result.incoming) {
        if (notifiedRequests.has(request.request_id)) continue;
        notifiedRequests.add(request.request_id);
        try {
          localStorage.setItem(`coherent.notified-requests.${user.id}`, JSON.stringify([...notifiedRequests].slice(-200)));
        } catch {
          // Notifications still work when browser storage is unavailable.
        }
        showNotification(`friend-${request.request_id}`, "Заявка в друзья", `${request.username} хочет добавить тебя в друзья`, "");
      }
    }
    void refreshRequests().catch(() => undefined);
    const timer = window.setInterval(() => void refreshRequests().catch(() => undefined), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [notifiedRequests, showNotification, user.id]);

  const incomingCallId = currentCall?.participants.some((participant) => participant.user_id === user.id && participant.state === "invited") ? currentCall.id : null;
  useEffect(() => {
    const ringtone = ringtoneRef.current;
    if (!ringtone) return;
    if (!incomingCallId) {
      ringtone.pause();
      ringtone.currentTime = 0;
      return;
    }
    ringtone.volume = 0.55;
    const play = () => { void ringtone.play().catch(() => undefined); };
    play();
    window.addEventListener("pointerdown", play);
    return () => { window.removeEventListener("pointerdown", play); ringtone.pause(); ringtone.currentTime = 0; };
  }, [incomingCallId]);

  useEffect(() => {
    if (busyInCall) return;
    const matching = availableCalls.find((call) => call.conversation_id === activeConversationId
      && call.status === "active"
      && call.participants.some((participant) => participant.user_id === user.id && participant.state === "left"));
    if (matching && matching.id !== currentCall?.id) setCurrentCall(matching);
  }, [activeConversationId, availableCalls, busyInCall, currentCall?.id, user.id]);

  useEffect(() => {
    void refreshConversations().catch((error: unknown) => {
      setConversationError(error instanceof Error ? error.message : "Не удалось загрузить беседы.");
    });
  }, [refreshConversations]);

  useEffect(() => {
    void refreshPresence().catch(() => undefined);
    const timer = window.setInterval(() => void refreshPresence().catch(() => undefined), 15000);
    return () => window.clearInterval(timer);
  }, [refreshPresence]);

  useEffect(() => {
    void refreshCalls().catch(() => undefined);
    const timer = window.setInterval(() => void refreshCalls().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [refreshCalls]);

  useEffect(() => {
    if (!currentCall || !currentCall.participants.some((participant) =>
      participant.user_id === user.id && participant.state === "joined"
    )) {
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
        void refreshPresence().catch(() => undefined);
        setMessageVersion((current) => current + 1);
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; message?: { id: string; sender_id: string; conversation_id: string; body: string } };
          if (payload.type === "call") {
            void refreshCalls().catch(() => undefined);
            void refreshConversations().catch(() => undefined);
            return;
          }
          if (payload.type !== "message" && payload.type !== "conversation") return;
          if (payload.type === "message" && payload.message && payload.message.sender_id !== user.id) {
            const message = payload.message;
            if (document.hidden || sectionRef.current !== "messages" || activeConversationRef.current !== message.conversation_id) {
              const conversation = conversationsRef.current.find((item) => item.id === message.conversation_id);
              showNotification(`message-${message.id}`, conversation ? conversationTitle(conversation) : "Новое сообщение", message.body, message.conversation_id);
            }
          }
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
  }, [refreshConversations, refreshCalls, refreshPresence, showNotification, user.id]);

  const setActiveRoom = useCallback((room: Room | null) => {
    roomRef.current = room;
    setAudioProcessingState(readAudioProcessing(room));
  }, []);

  const updateMedia = useCallback((patch: Partial<MediaPreferences>): Promise<void> => {
    const operation = mediaQueue.current.then(async () => {
      const current = mediaRef.current;
      const next = { ...current, ...patch };
      const supportedProcessing = supportedAudioProcessing();
      if (patch.noiseSuppression !== undefined && !supportedProcessing.noiseSuppression) {
        throw new Error("Этот браузер не поддерживает шумоподавление микрофона.");
      }
      if (patch.echoCancellation !== undefined && !supportedProcessing.echoCancellation) {
        throw new Error("Этот браузер не поддерживает подавление эха.");
      }
      if (patch.autoGainControl !== undefined && !supportedProcessing.autoGainControl) {
        throw new Error("Этот браузер не поддерживает автоматическую громкость микрофона.");
      }
      const room = roomRef.current;
      if (room?.state === ConnectionState.Connected) {
        const participant = room.localParticipant;
        const microphoneCaptureChanged = patch.noiseSuppression !== undefined
          || patch.echoCancellation !== undefined
          || patch.autoGainControl !== undefined;
        const cameraCaptureChanged = patch.videoCodec !== undefined
          || patch.videoQuality !== undefined;

        if (patch.microphoneEnabled !== undefined && next.microphoneEnabled !== current.microphoneEnabled) {
          try {
            await participant.setMicrophoneEnabled(next.microphoneEnabled, microphoneCapture(next));
          } catch (reason) {
            await participant.setMicrophoneEnabled(current.microphoneEnabled, microphoneCapture(current)).catch(() => undefined);
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
              cameraPublish(next),
            );
          } catch (reason) {
            if (cameraCaptureChanged && current.cameraEnabled) {
              await participant.setCameraEnabled(
                true,
                cameraCapture(current),
                cameraPublish(current),
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
        const actualProcessing = readAudioProcessing(room);
        const needsRefreshAfterUnmute = patch.microphoneEnabled === true && !current.microphoneEnabled
          && actualProcessing !== null
          && ((actualProcessing.noiseSuppression !== null && actualProcessing.noiseSuppression !== next.noiseSuppression)
            || (actualProcessing.echoCancellation !== null && actualProcessing.echoCancellation !== next.echoCancellation)
            || (actualProcessing.autoGainControl !== null && actualProcessing.autoGainControl !== next.autoGainControl));
        if (next.microphoneEnabled && (microphoneCaptureChanged || needsRefreshAfterUnmute)) {
          const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
          if (track) {
            try {
              await track.restartTrack(microphoneCapture(next));
            } catch (reason) {
              await track.restartTrack(microphoneCapture(current)).catch(() => undefined);
              throw reason;
            }
          }
        }
        if (next.microphoneEnabled && (patch.microphoneEnabled !== undefined || patch.microphoneVolume !== undefined
          || microphoneCaptureChanged || patch.microphoneId !== undefined)) {
          await applyMicrophoneProcessing(room, next.microphoneVolume, next.noiseSuppression ? "noisy" : "soft");
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
        if (microphoneCaptureChanged && next.microphoneEnabled) {
          const applied = readAudioProcessing(room);
          if ((patch.noiseSuppression !== undefined && applied?.noiseSuppression != null
              && applied.noiseSuppression !== next.noiseSuppression)
            || (patch.echoCancellation !== undefined && applied?.echoCancellation != null
              && applied.echoCancellation !== next.echoCancellation)
            || (patch.autoGainControl !== undefined && applied?.autoGainControl != null
              && applied.autoGainControl !== next.autoGainControl)) {
            const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
            if (track) await track.restartTrack(microphoneCapture(current)).catch(() => undefined);
            throw new Error("Браузер не применил обработку звука. Настройка сохранена прежней.");
          }
        }
        if (patch.screenShareBitrateMbps !== undefined) {
          await updateScreenShareBitrate(room, next.screenShareBitrateMbps);
        }
        if (patch.deafened !== undefined && next.deafened !== current.deafened) {
          await participant.setAttributes({ "coherent.deafened": next.deafened ? "true" : "false" }).catch(() => undefined);
        }
        setAudioProcessingState(readAudioProcessing(room));
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

  async function startCall() {
    if (!activeConversationId || busyInCall || callPending) return;
    if (resumableCall) {
      await acceptCall(resumableCall);
      return;
    }
    setCallPending(true);
    setCallError("");
    try {
      await updateMedia({ cameraEnabled: false });
      setCurrentCall(await api.startCall(activeConversationId));
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : "Не удалось начать звонок.");
      throw reason;
    } finally {
      setCallPending(false);
    }
  }

  async function createGroupCall(userIds: string[]) {
    if (busyInCall || callPending) return;
    setCallPending(true);
    setCallError("");
    try {
      await updateMedia({ cameraEnabled: false });
      const group = await api.createGroup(userIds);
      setConversations((current) => [group, ...current]);
      setActiveConversationId(group.id);
      setSection("messages");
      setShowWelcome(false);
      setCurrentCall(await api.startCall(group.id));
    } catch (reason) {
      setCallError(reason instanceof Error ? reason.message : "Не удалось создать групповой звонок.");
      throw reason;
    } finally {
      setCallPending(false);
    }
  }

  async function inviteToCall(userIds: string[]) {
    if (!currentCall) return;
    const call = await api.inviteCall(currentCall.id, userIds);
    setCurrentCall(call);
    void refreshConversations().catch(() => undefined);
  }

  async function renameGroup(conversationId: string, name: string) {
    const updated = await api.renameGroup(conversationId, name);
    setConversations((current) => current.map((item) => item.id === conversationId ? updated : item));
  }

  async function acceptCall(target: Call | null = currentCall) {
    if (!target || callPending) return;
    setCallPending(true);
    setCallError("");
    try {
      await updateMedia({ cameraEnabled: false });
      const call = await api.acceptCall(target.id);
      setCurrentCall(call);
      setAvailableCalls((current) => current.map((item) => item.id === call.id ? call : item));
      setActiveConversationId(call.conversation_id);
      setSection("messages");
      setShowWelcome(false);
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
      await updateMedia({ cameraEnabled: false }).catch(() => undefined);
      const call = await api.endCall(currentCall.id);
      setCurrentCall(call.status === "active" ? call : null);
      setAvailableCalls((current) => call.status === "active"
        ? current.some((item) => item.id === call.id) ? current.map((item) => item.id === call.id ? call : item) : [call, ...current]
        : current.filter((item) => item.id !== call.id));
      void refreshCalls().catch(() => undefined);
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
    setShowWelcome(false);
    setSection("messages");
    setMessageVersion((current) => current + 1);
    void refreshConversations().catch(() => undefined);
  }

  function openHome() {
    setSection("messages");
    setShowWelcome(true);
    setPopover(null);
  }

  function openFriends(tab: FriendsTab = "search") {
    setFriendsInitialTab(tab);
    setSection("friends");
    setPopover(null);
  }

  function openMessages() {
    setSection("messages");
    setShowWelcome(false);
    setPopover(null);
  }

  function togglePopover(next: Exclude<ShellPopover, null>) {
    setShowProfile(false);
    setSettingsOpen(false);
    if (popover === next) {
      setPopover(null);
      return;
    }
    setPopover(next);
    if (next === "notifications") {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission().then(setNotificationPermission).catch(() => setNotificationPermission("denied"));
      }
      setNotificationLoading(true);
      setNotificationError("");
      void api.friendRequests().then((result) => {
        setNotificationRequests(result.incoming);
      }).catch((reason: unknown) => {
        setNotificationError(reason instanceof Error ? reason.message : "Не удалось загрузить заявки.");
      }).finally(() => setNotificationLoading(false));
    }
  }

  useEffect(() => {
    if (!popover) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopover(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [popover]);

  return (
    <main className="app-shell">
      <aside className="server-rail">
        <button className="rail-home active" aria-label="Главная Coherent" title="Главная" onClick={openHome}>
          <span className="brand-mark"><span /><span /><span /></span>
        </button>
        <div className="rail-separator" />
        <button
          className={`rail-item ${section === "messages" ? "selected" : ""}`}
          aria-label="Сообщения"
          onClick={openMessages}
        >
          <MessageCircle size={21} />
        </button>
        <button
          className={`rail-item ${section === "friends" ? "selected" : ""}`}
          aria-label="Друзья"
          onClick={() => openFriends("all")}
        >
          <Users size={21} />
        </button>
        <button
          className="rail-item"
          aria-label="Поиск пользователей"
          onClick={() => openFriends("search")}
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
          onClick={() => { setPopover(null); setShowProfile((visible) => !visible); }}
          aria-label="Профиль"
        >
          <span className="avatar avatar-user">{initial}</span>
          <i />
        </button>
      </aside>

      <aside className="channel-sidebar">
        <button className="workspace-picker" onClick={() => togglePopover("workspace")} aria-expanded={popover === "workspace"} aria-label="Меню Coherent">
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
            onClick={openMessages}
          >
            <MessageCircle size={18} /> Сообщения
          </button>
          <div className={`sidebar-nav-friends ${section === "friends" ? "active" : ""}`}>
            <button className="sidebar-nav-item" onClick={() => openFriends("all")}>
              <Users size={18} /> Друзья
            </button>
            <button className="nav-add" aria-label="Найти новых друзей" title="Найти новых друзей" onClick={() => openFriends("search")}><Plus size={15} /></button>
          </div>
        </div>

        <div className="sidebar-section-title">
          <span>БЕСЕДЫ</span>
          <button aria-label="Создать группу" title="Создать групповой звонок" onClick={() => setShowGroupPicker(true)} disabled={busyInCall || callPending}>
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
                  setShowWelcome(false);
                }}
              >
                <span className="avatar avatar-user">{conversation.kind === "group" ? <UsersRound size={18} /> : conversationTitle(conversation)[0]?.toUpperCase()}</span>
                <span className="conversation-item-copy">
                  <strong>{conversationTitle(conversation)}</strong>
                  <small>{conversation.last_message?.body ?? "Беседа начата"}</small>
                </span>
                {conversation.kind === "direct" && conversation.other_user && onlineIds.has(conversation.other_user.id) && <i className="conversation-presence" title="В сети" />}
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
            <span>{section === "messages" ? selectedConversation ? conversationTitle(selectedConversation) : (currentCall?.status === "active" ? "Групповой звонок" : "Сообщения") : "Друзья"}</span>
            <span className="header-divider" />
            <span className="header-subtle">Личное пространство</span>
          </div>
          <div className="mobile-nav" aria-label="Разделы">
            <button className={section === "messages" ? "active" : ""} onClick={openMessages} aria-label="Сообщения"><MessageCircle size={18} /></button>
            <button className={section === "friends" ? "active" : ""} onClick={() => openFriends("all")} aria-label="Друзья"><Users size={18} /></button>
          </div>
          <div className="header-actions">
            {section === "messages" && selectedConversation && (
              <button
                className="header-icon header-call-button"
                onClick={() => void startCall().catch(() => undefined)}
                disabled={busyInCall || callPending}
                aria-label={`${resumableCall ? "Вернуться в звонок" : "Позвонить"}: ${conversationTitle(selectedConversation)}`}
                title={resumableCall ? "Вернуться в звонок" : "Начать голосовой звонок"}
              >
                <Phone size={19} />
              </button>
            )}
            {section === "messages" && selectedConversation?.kind === "direct" && (
              <button
                className="header-icon header-call-button"
                onClick={() => setShowGroupPicker(true)}
                disabled={busyInCall || callPending}
                aria-label="Начать групповой звонок"
                title="Начать групповой звонок"
              >
                <UsersRound size={19} />
              </button>
            )}
            <button className="header-icon" aria-label="Уведомления" title="Уведомления" aria-expanded={popover === "notifications"} onClick={() => togglePopover("notifications")}>
              <Bell size={18} />
            </button>
            <button className="header-icon" aria-label="Помощь" title="Помощь" aria-expanded={popover === "help"} onClick={() => togglePopover("help")}>
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
                onClick={() => { setActiveConversationId(conversation.id); setShowWelcome(false); }}
              >
                {conversationTitle(conversation)}
              </button>
            ))}
          </div>
        )}

        {currentCall && (
          <Suspense fallback={<div className="call-connect-note">Подготавливаем звонок...</div>}>
            <CallPanel
              call={currentCall}
              conversationTitle={conversations.find((item) => item.id === currentCall.conversation_id)?.name ?? undefined}
              isGroupConversation={conversations.find((item) => item.id === currentCall.conversation_id)?.kind === "group"}
              currentUserId={user.id}
              compact={callCompact}
              error={callError}
              pending={callPending}
              media={media}
              audioProcessingState={audioProcessingState}
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
                setShowWelcome(false);
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
            peerOnline={selectedConversation.other_user ? onlineIds.has(selectedConversation.other_user.id) : undefined}
            onRename={renameGroup}
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
                    <button className="primary-button welcome-button" onClick={() => openFriends("search")}>
                      <Users size={17} /> Найти собеседника <span className="button-arrow">↗</span>
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <FriendsPanel initialTab={friendsInitialTab} onStartConversation={startConversation} onlineIds={onlineIds} />
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

      {popover && <button className="shell-popover-dismiss" aria-label="Закрыть меню" onClick={() => setPopover(null)} />}
      {popover === "workspace" && (
        <div className="shell-popover shell-popover-workspace" role="menu" aria-label="Меню Coherent">
          <strong>Coherent</strong>
          <button role="menuitem" onClick={openHome}><Compass size={16} /> Главная</button>
          <button role="menuitem" onClick={openMessages}><MessageCircle size={16} /> Сообщения</button>
          <button role="menuitem" onClick={() => openFriends("all")}><Users size={16} /> Друзья</button>
          <button role="menuitem" onClick={() => { setPopover(null); setSettingsOpen(true); }}><Settings size={16} /> Звук и видео</button>
        </div>
      )}
      {popover === "notifications" && (
        <div className="shell-popover shell-popover-notifications" aria-label="Уведомления">
          <strong>Уведомления</strong>
          {notificationPermission === "default" && <button className="notification-permission" onClick={() => {
            void Notification.requestPermission().then(setNotificationPermission).catch(() => setNotificationPermission("denied"));
          }}><Bell size={16} /> Включить уведомления браузера</button>}
          {notificationPermission === "denied" && <p>Уведомления браузера отключены. Разреши их в настройках сайта.</p>}
          {currentCall?.participants.some((participant) => participant.user_id === user.id && participant.state === "invited") && (
            <button onClick={() => {
              setPopover(null);
              setSection("messages");
              setActiveConversationId(currentCall.conversation_id);
              setShowWelcome(false);
            }}><Phone size={16} /> Входящий звонок · открыть</button>
          )}
          {notificationLoading && <p>Загружаем заявки...</p>}
          {notificationError && <p role="alert">{notificationError}</p>}
          {!notificationLoading && !notificationError && notificationRequests.length === 0 && recentNotifications.length === 0 && <p>Новых уведомлений нет.</p>}
          {recentNotifications.map((notice) => <button className="notification-event" key={notice.id} onClick={() => {
            setPopover(null);
            setSection(notice.conversationId ? "messages" : "friends");
            if (notice.conversationId) setActiveConversationId(notice.conversationId);
            else setFriendsInitialTab("requests");
            setShowWelcome(false);
          }}><MessageCircle size={16} /> {notice.title}</button>)}
          {!notificationLoading && notificationRequests.slice(0, 4).map((request) => (
            <button key={request.request_id} onClick={() => openFriends("requests")}><UserPlus size={16} /> Заявка от {request.username}</button>
          ))}
          <button className="shell-popover-link" onClick={() => openFriends("requests")}>Открыть все заявки →</button>
        </div>
      )}
      {popover === "help" && (
        <div className="shell-popover shell-popover-help" aria-label="Помощь">
          <strong>Как пользоваться Coherent</strong>
          <p>Найди человека по имени, открой беседу и нажми трубку для звонка. Кнопка с людьми рядом начинает групповой звонок.</p>
          <p>Во время звонка сетка и размер плиток меняются через кнопку отображения. Устройства и обработка микрофона находятся в настройках.</p>
          <button onClick={() => openFriends("search")}><Search size={16} /> Найти человека</button>
          <button onClick={() => { setPopover(null); setSettingsOpen(true); }}><Settings size={16} /> Настроить звук и видео</button>
        </div>
      )}

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

      <audio ref={ringtoneRef} loop preload="auto" aria-hidden="true">
        <source src="/audio/Coherent_Aura.ogg" type="audio/ogg" />
        <source src="/audio/Coherent_Aura.mp3" type="audio/mpeg" />
      </audio>

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
        <MediaSettingsPanel media={media} audioProcessingState={audioProcessingState} onChange={changeMedia} onClose={() => setSettingsOpen(false)} />
      )}
      {showGroupPicker && (
        <ParticipantPicker
          title="Новый групповой звонок"
          submitLabel="Создать и позвонить"
          excludedIds={[user.id]}
          suggestedIds={selectedConversation?.kind === "direct" && selectedConversation.other_user ? [selectedConversation.other_user.id] : []}
          minSelect={2}
          maxSelect={9}
          onSubmit={createGroupCall}
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
