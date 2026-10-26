import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  CircleHelp,
  Compass,
  Headphones,
  Hash,
  LogOut,
  MessageCircle,
  Menu,
  Mic,
  MicOff,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  UserPlus,
  Video,
  VideoOff,
  VolumeX,
} from "lucide-react";
import { ConnectionState, Track, type Room } from "livekit-client";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, displayName, conversationTitle, type Call, type Conversation, type FriendRequest, type User, type CommunityServer } from "../lib/api";
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
import ClientSettingsDialog, { type ClientSettingsSection } from "./ClientSettingsDialog";
import IncomingCallCard from "./IncomingCallCard";
import DeviceApprovalPanel from "./DeviceLinkPanel";
import { messagingFor, closeMessaging } from "../lib/crypto/messaging";
import MessagesPanel from "./MessagesPanel";
import ParticipantPicker from "./ParticipantPicker";
import ProfileSettingsDialog from "./ProfileSettingsDialog";
import AdminPanel from "./AdminPanel";
import ServerDialog from "./ServerDialog";
import { applyMicrophoneProcessing, prepareRnnoise } from "../lib/microphoneProcessor";
import { disablePush, enablePush } from "../lib/push";
import { connectAppEvents } from "../lib/events";
import { desktopNotify, desktopRaiseIncomingCall, setUpdateMediaBusy } from "../lib/desktop";

interface ChatShellProps {
  user: User;
  onLogout: () => void;
  onUserChange: (user: User) => void;
}

type Section = "messages" | "friends";
type FriendsTab = "search" | "all" | "requests";
type ShellPopover = "workspace" | "notifications" | "help" | null;
const CallPanel = lazy(() => import("./CallPanel"));

export default function ChatShell({ user, onLogout, onUserChange }: ChatShellProps) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [servers, setServers] = useState<CommunityServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [serverDialogManage, setServerDialogManage] = useState(false);
  const [channelConversation, setChannelConversation] = useState<Conversation | null>(null);
  const selectedServer = servers.find((server) => server.id === selectedServerId);
  const channelLoad = useRef(0);
  const channelConversationRef = useRef(channelConversation);
  const serversRef = useRef(servers);
  const linkedChannelOpened = useRef(false);
  channelConversationRef.current = channelConversation;
  serversRef.current = servers;
  const refreshServers = useCallback(async () => setServers(await api.servers()), []);
  const refreshOpenChannel = useCallback(async () => {
    const channel = channelConversationRef.current;
    if (!channel?.server_id || !channel.channel_id) return;
    const load = channelLoad.current;
    const updated = await api.serverConversation(channel.server_id, channel.channel_id);
    if (load === channelLoad.current && channelConversationRef.current?.id === updated.id) setChannelConversation(updated);
  }, []);
  useEffect(() => { void refreshServers().catch(() => undefined); }, [refreshServers]);
  useEffect(() => {
    if (linkedChannelOpened.current) return;
    const linkedId = new URLSearchParams(window.location.search).get("conversation");
    const server = servers.find((item) => item.channels.some((channel) => channel.conversation_id === linkedId));
    const channel = server?.channels.find((item) => item.conversation_id === linkedId);
    if (server && channel) {
      linkedChannelOpened.current = true;
      void openChannel(server, channel.id);
    }
  }, [servers]);
  const [section, setSection] = useState<Section>("messages");
  const [showWelcome, setShowWelcome] = useState(false);
  const [friendsInitialTab, setFriendsInitialTab] = useState<FriendsTab>("search");
  const [popover, setPopover] = useState<ShellPopover>(null);
  const [notificationRequests, setNotificationRequests] = useState<FriendRequest[]>([]);
  const [friendRequestVersion, setFriendRequestVersion] = useState(0);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [pushError, setPushError] = useState("");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => isTauri() ? "granted" : typeof Notification === "undefined" ? "denied" : Notification.permission);
  const [recentNotifications, setRecentNotifications] = useState<Array<{ id: string; title: string; conversationId: string }>>([]);
  const [hasNewNotifications, setHasNewNotifications] = useState(() => {
    try {
      return localStorage.getItem(`coherent.new-notifications.${user.id}`) === "1";
    } catch {
      return false;
    }
  });
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`coherent.dismissed-notifications.${user.id}`) ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  });
  const [onlineIds, setOnlineIds] = useState<Set<string>>(() => new Set());
  const [showProfile, setShowProfile] = useState(false);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  useEffect(() => {
    const refresh = () => { void messagingFor(user.id).refreshKeys().then(() => setMessageVersion(n => n + 1)).catch(() => {}); };
    const profile = () => setProfileSettingsOpen(true);
    refresh();
    const timer = window.setInterval(() => { void messagingFor(user.id).refreshKeys().catch(() => {}); }, 60000);
    window.addEventListener("coherent-security-changed", refresh);
    window.addEventListener("coherent-open-profile", profile);
    return () => { window.clearInterval(timer); window.removeEventListener("coherent-security-changed", refresh); window.removeEventListener("coherent-open-profile", profile); closeMessaging(user.id); };
  }, [user.id]);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ nonce: number; conversationId: string; files: File[] } | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [messageVersion, setMessageVersion] = useState(0);
  const [currentCall, setCurrentCall] = useState<Call | null>(null);
  const [callCollapsed, setCallCollapsed] = useState(false);
  const [availableCalls, setAvailableCalls] = useState<Call[]>([]);
  const [callPending, setCallPending] = useState(false);
  const [callError, setCallError] = useState("");
  const [showGroupPicker, setShowGroupPicker] = useState(false);
  const [callSettingsOpen, setCallSettingsOpen] = useState(false);
  const [clientSettingsOpen, setClientSettingsOpen] = useState(false);
  const [clientSettingsSection, setClientSettingsSection] = useState<ClientSettingsSection>("appearance");
  const [controlError, setControlError] = useState("");
  const [media, setMedia] = useState(loadMediaPreferences);
  const [audioProcessingState, setAudioProcessingState] = useState<AudioProcessingState | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const mediaRef = useRef(media);
  const roomRef = useRef<Room | null>(null);
  const mediaQueue = useRef<Promise<void>>(Promise.resolve());
  const ringtoneRef = useRef<HTMLAudioElement>(null);
  const socketReadyRef = useRef(false);
  const dropNonceRef = useRef(0);
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
  const popoverRef = useRef(popover);
  const dismissedNotificationIdsRef = useRef(dismissedNotificationIds);
  activeConversationRef.current = activeConversationId;
  sectionRef.current = section;
  conversationsRef.current = conversations;
  popoverRef.current = popover;
  dismissedNotificationIdsRef.current = dismissedNotificationIds;
  const initial = displayName(user).slice(0, 1).toUpperCase();
  const selectedConversation = showWelcome ? undefined : channelConversation?.id === activeConversationId ? channelConversation : conversations.find((item) => item.id === activeConversationId);
  const busyInCall = Boolean(currentCall?.participants.some((participant) =>
    participant.user_id === user.id && (participant.state === "joined" || participant.state === "invited")
  ));
  const microphoneLive = roomRef.current?.state === ConnectionState.Connected;
  useEffect(() => {
    setUpdateMediaBusy(busyInCall);
    return () => setUpdateMediaBusy(false);
  }, [busyInCall]);
  const microphoneButtonLabel = microphoneLive
    ? media.microphoneEnabled ? "Выключить микрофон" : "Включить микрофон"
    : media.microphoneEnabled ? "Подключаться с выключенным микрофоном" : "Подключаться с включённым микрофоном";
  const microphoneButtonTitle = microphoneLive ? microphoneButtonLabel
    : media.microphoneEnabled
      ? "При входе микрофон включён. Нажми, чтобы входить без микрофона"
      : "При входе микрофон выключен. Нажми, чтобы входить с микрофоном";
  const resumableCall = availableCalls.find((call) => call.conversation_id === activeConversationId
    && call.status === "active"
    && call.participants.some((participant) => participant.user_id === user.id && participant.state === "left"));
  const callCompact = Boolean(currentCall && (callCollapsed || section !== "messages" || showWelcome || activeConversationId !== currentCall.conversation_id));
  const callPanelReady = Boolean(currentCall?.status === "active"
    && currentCall.participants.some((participant) => participant.user_id === user.id && participant.state === "joined")
    && !callCompact);
  const visibleConversations = conversations.filter((item) =>
    conversationTitle(item).toLowerCase().includes(conversationQuery.trim().toLowerCase()),
  );

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("friends") === "requests") {
      setSection("friends");
      setFriendsInitialTab("requests");
    } else if (query.has("conversation")) {
      setSection("messages");
      setShowWelcome(false);
    }
  }, []);

  const activatePush = useCallback(async () => {
    if (isTauri()) return;
    try {
      await enablePush();
      setPushError("");
    } catch {
      setPushError("Уведомления в открытой вкладке работают. Доставка при закрытой вкладке сейчас недоступна.");
    }
  }, []);

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") void activatePush();
  }, [activatePush, user.id]);

  useEffect(() => {
    function dragOver(event: DragEvent) {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDraggingFiles(true);
    }
    function drop(event: DragEvent) {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDraggingFiles(false);
      const target = channelConversationRef.current?.id
        || conversationsRef.current.find((item) => item.id === activeConversationRef.current)?.id
        || conversationsRef.current[0]?.id;
      if (!target) {
        setConversationError("Открой беседу, чтобы отправить файл");
        return;
      }
      if (channelConversationRef.current?.id !== target) navigateConversation(target);
      else { setSection("messages"); setShowWelcome(false); }
      setPendingFiles({ nonce: ++dropNonceRef.current, conversationId: target, files: Array.from(event.dataTransfer.files) });
    }
    function dragLeave(event: DragEvent) {
      if (!event.relatedTarget) setDraggingFiles(false);
    }
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", drop);
    window.addEventListener("dragleave", dragLeave);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragleave", dragLeave);
    };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateHeight = () => {
      const shell = shellRef.current;
      if (!shell) return;
      if (window.matchMedia("(max-width: 680px), (max-height: 520px) and (pointer: coarse)").matches) {
        shell.style.setProperty("--coherent-visible-height", `${Math.round(viewport.height + viewport.offsetTop)}px`);
      } else {
        shell.style.removeProperty("--coherent-visible-height");
      }
    };
    updateHeight();
    viewport.addEventListener("resize", updateHeight);
    viewport.addEventListener("scroll", updateHeight);
    window.addEventListener("resize", updateHeight);
    return () => {
      viewport.removeEventListener("resize", updateHeight);
      viewport.removeEventListener("scroll", updateHeight);
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  const refreshConversations = useCallback(async () => {
    const result = await api.conversations();
    setConversations(result.conversations);
    const linkedId = new URLSearchParams(window.location.search).get("conversation");
    setActiveConversationId((current) => current ?? result.conversations.find((item) => item.id === linkedId)?.id ?? result.conversations[0]?.id ?? null);
    setConversationError("");
  }, []);

  const refreshPresence = useCallback(async () => {
    const result = await api.presence();
    setOnlineIds(new Set(result.online_user_ids));
  }, []);

  const showNotification = useCallback((id: string, title: string, body: string, conversationId: string) => {
    if (dismissedNotificationIdsRef.current.has(id)) return;
    setRecentNotifications((current) => [{ id, title, conversationId }, ...current.filter((item) => item.id !== id)].slice(0, 8));
    if (popoverRef.current !== "notifications") {
      setHasNewNotifications(true);
      try {
        localStorage.setItem(`coherent.new-notifications.${user.id}`, "1");
      } catch {
        // The indicator remains visible until the page is reloaded.
      }
    }
    if (isTauri()) {
      // A call has its own centered overlay and ringtone; a Windows toast obscures it.
      if (id.startsWith("call-")) return;
      if (!id.startsWith("message-") || document.hasFocus()) {
        void desktopNotify(title, body, id.startsWith("message-") ? "message" : id.startsWith("friend-") ? "friend" : "call");
      }
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const notice = new Notification(title, { body, icon: "/favicon.svg", tag: id });
      notice.onclick = () => {
        window.focus();
        setSection(conversationId ? "messages" : "friends");
        if (conversationId) navigateConversation(conversationId);
        else setFriendsInitialTab("requests");
        setShowWelcome(false);
        notice.close();
      };
    } catch {
      // The in-app notification remains available if this browser cannot show a system notification.
    }
  }, [user.id]);

  const markConversationRead = useCallback(async (conversationId: string, messageId: string) => {
    await api.markConversationRead(conversationId, messageId);
    setConversations((current) => current.map((item) => item.id === conversationId && item.last_message?.id === messageId
      ? { ...item, unread: false }
      : item));
  }, []);

  function clearNotifications() {
    const ids = [
      ...recentNotifications.map((item) => item.id),
      ...notificationRequests.map((item) => `friend-${item.request_id}`),
      ...(incomingCallId ? [`call-${incomingCallId}`] : []),
    ];
    const next = new Set([...dismissedNotificationIds, ...ids].slice(-200));
    setDismissedNotificationIds(next);
    dismissedNotificationIdsRef.current = next;
    try {
      localStorage.setItem(`coherent.dismissed-notifications.${user.id}`, JSON.stringify([...next]));
    } catch {
      // Clearing still works for this session when browser storage is unavailable.
    }
    setRecentNotifications([]);
    setHasNewNotifications(false);
    try {
      localStorage.removeItem(`coherent.new-notifications.${user.id}`);
    } catch {
      // The indicator is cleared for this session.
    }
  }

  const refreshCalls = useCallback(async () => {
    const result = await api.currentCalls();
    for (const call of result.calls) {
      const invited = call.participants.some((participant) => participant.user_id === user.id && participant.state === "invited");
      if (!invited || notifiedCalls.current.has(call.id)) continue;
      notifiedCalls.current.add(call.id);
      showNotification(`call-${call.id}`, "Входящий звонок", `${(call.caller_display_name || call.caller_username)} звонит тебе`, call.conversation_id);
      void desktopRaiseIncomingCall(call.id);
    }
    setAvailableCalls(result.calls);
    setCurrentCall((current) => result.calls.find((call) => call.participants.some((participant) =>
      participant.user_id === user.id && participant.state === "joined"
    )) ?? result.calls.find((call) => call.participants.some((participant) =>
      participant.user_id === user.id && participant.state === "invited"
    )) ?? result.calls.find((call) => call.id === current?.id) ?? result.calls[0] ?? null);
  }, [showNotification, user.id]);

  const refreshRequests = useCallback(async () => {
    const result = await api.friendRequests();
    setNotificationRequests(result.incoming);
    for (const request of result.incoming) {
      if (notifiedRequests.has(request.request_id)) continue;
      notifiedRequests.add(request.request_id);
      try {
        localStorage.setItem(`coherent.notified-requests.${user.id}`, JSON.stringify([...notifiedRequests].slice(-200)));
      } catch {
        // Notifications still work when browser storage is unavailable.
      }
      showNotification(`friend-${request.request_id}`, "Заявка в друзья", `${displayName(request)} хочет добавить тебя в друзья`, "");
    }
  }, [notifiedRequests, showNotification, user.id]);

  useEffect(() => { void refreshRequests().catch(() => undefined); }, [refreshRequests]);

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

  useEffect(() => { void refreshPresence().catch(() => undefined); }, [refreshPresence]);
  useEffect(() => { void refreshCalls().catch(() => undefined); }, [refreshCalls]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen("desktop-call-updated", () => { void refreshCalls().catch(() => undefined); })
      .then((dispose) => { unlisten = dispose; })
      .catch(() => undefined);
    return () => unlisten?.();
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
    let disconnect: (() => void) | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let reconnectDelay = 1000;

    function connect() {
      void connectAppEvents(() => {
        socketReadyRef.current = true;
        reconnectDelay = 1000;
        void refreshConversations().catch(() => undefined);
        void refreshPresence().catch(() => undefined);
        void refreshRequests().catch(() => undefined);
        void refreshCalls().catch(() => undefined);
        void refreshServers().catch(() => undefined);
        void refreshOpenChannel().catch(() => undefined);
        setFriendRequestVersion((current) => current + 1);
        setMessageVersion((current) => current + 1);
      }, (data) => {
        try {
          const payload = JSON.parse(data) as { type?: string; message?: { id: string; sender_id: string; conversation_id: string; body: string } };
          if (payload.type === "call") {
            void refreshCalls().catch(() => undefined);
            void refreshConversations().catch(() => undefined);
            return;
          }
          if (payload.type === "server") {
            void refreshServers().catch(() => undefined);
            setMessageVersion((current) => current + 1);
            return;
          }
          if (payload.type === "friend_request") {
            void refreshRequests().catch(() => undefined);
            setFriendRequestVersion((current) => current + 1);
            return;
          }
          if (payload.type === "device_link") { window.dispatchEvent(new Event("coherent-device-link")); return; }
          if (payload.type === "security") {
            window.dispatchEvent(new Event("coherent-security-changed"));
            setMessageVersion(current => current + 1);
            return;
          }
          if (payload.type === "profile") {
            void refreshConversations().catch(() => undefined);
            void refreshRequests().catch(() => undefined);
            void refreshCalls().catch(() => undefined);
            void refreshOpenChannel().catch(() => undefined);
            void api.me().then(onUserChange).catch(() => undefined);
            setFriendRequestVersion((current) => current + 1);
            return;
          }
          if (payload.type === "presence") {
            void refreshPresence().catch(() => undefined);
            return;
          }
          if (payload.type !== "message" && payload.type !== "conversation") return;
          if (payload.type === "message" && payload.message && payload.message.sender_id !== user.id) {
            const message = payload.message;
            if (document.hidden || !document.hasFocus() || sectionRef.current !== "messages" || activeConversationRef.current !== message.conversation_id) {
              const conversation = conversationsRef.current.find((item) => item.id === message.conversation_id);
              showNotification(`message-${message.id}`, conversation ? conversationTitle(conversation) : "Новое сообщение", message.body, message.conversation_id);
            }
          }
          void refreshConversations().catch(() => undefined);
          setMessageVersion((current) => current + 1);
        } catch {
          // Ignore an event with an unknown payload.
        }
      }, (code) => {
        socketReadyRef.current = false;
        if (stopped || code === 1008) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }, user.id).then((cleanup) => {
        if (stopped) cleanup();
        else disconnect = cleanup;
      }).catch(() => {
        if (!stopped) reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      });
    }

    connect();
    let reconciliationTick = 0;
    const pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      reconciliationTick += 1;
      if (socketReadyRef.current && reconciliationTick % 4 !== 0) return;
      void refreshConversations().catch(() => undefined);
      void refreshPresence().catch(() => undefined);
      void refreshRequests().catch(() => undefined);
      void refreshCalls().catch(() => undefined);
      setMessageVersion((current) => current + 1);
    }, 15000);
    const onVisible = () => {
      if (document.hidden) return;
      void refreshConversations().catch(() => undefined);
      void refreshCalls().catch(() => undefined);
      void refreshRequests().catch(() => undefined);
      void refreshPresence().catch(() => undefined);
      setMessageVersion((current) => current + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      socketReadyRef.current = false;
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(reconnectTimer);
      disconnect?.();
    };
  }, [refreshConversations, refreshCalls, refreshPresence, refreshRequests, refreshServers, refreshOpenChannel, showNotification, user.id]);

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
        if (patch.noiseProcessor === "rnnoise" && next.microphoneEnabled) await prepareRnnoise();
        const participant = room.localParticipant;
        const microphoneCaptureChanged = patch.noiseSuppression !== undefined
          || (patch.noiseProcessor !== undefined && current.noiseSuppression)
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
          && ((actualProcessing.noiseSuppression !== null && actualProcessing.noiseSuppression !== (next.noiseProcessor === "browser" && next.noiseSuppression))
            || (actualProcessing.echoCancellation !== null && actualProcessing.echoCancellation !== next.echoCancellation)
            || (actualProcessing.autoGainControl !== null && actualProcessing.autoGainControl !== next.autoGainControl));
        if (next.microphoneEnabled && (microphoneCaptureChanged || needsRefreshAfterUnmute)) {
          const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
          if (track) {
            try {
              await track.mediaStreamTrack.applyConstraints(microphoneCapture(next));
            } catch (reason) {
              try {
                await track.restartTrack(microphoneCapture(next));
              } catch {
                await track.restartTrack(microphoneCapture(current)).catch(() => undefined);
                throw reason;
              }
            }
          }
        }
        if (next.microphoneEnabled && (patch.microphoneEnabled !== undefined || patch.microphoneVolume !== undefined
          || patch.noiseProcessor !== undefined
          || microphoneCaptureChanged || patch.microphoneId !== undefined || patch.rnnoisePreset !== undefined)) {
          try {
            await applyMicrophoneProcessing(room, next.microphoneVolume, next.noiseSuppression ? "noisy" : "soft", next.noiseProcessor, next.rnnoisePreset);
          } catch (reason) {
            const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
            try {
              await applyMicrophoneProcessing(room, current.microphoneVolume, current.noiseSuppression ? "noisy" : "soft", current.noiseProcessor, current.rnnoisePreset);
            } catch {
              if (track) {
                await track.stopProcessor().catch(() => undefined);
                await track.restartTrack(microphoneCapture(current)).catch(() => undefined);
              }
            }
            throw reason;
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
        if (microphoneCaptureChanged && next.microphoneEnabled) {
          const applied = readAudioProcessing(room);
          if ((patch.noiseSuppression !== undefined && applied?.noiseSuppression != null
              && applied.noiseSuppression !== (next.noiseProcessor === "browser" && next.noiseSuppression))
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
    const load = ++channelLoad.current;
    setSelectedServerId(null);
    setChannelConversation(null);
    const conversation = await api.openConversation(userId);
    if (load !== channelLoad.current) return;
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
    setActiveConversationId(conversation.id);
    setShowWelcome(false);
    setSection("messages");
    setMessageVersion((current) => current + 1);
    void refreshConversations().catch(() => undefined);
  }

  function openHome() {
    channelLoad.current += 1;
    setSelectedServerId(null);
    setChannelConversation(null);
    setMobileNavigationOpen(false);
    setSection("messages");
    setShowWelcome(true);
    setPopover(null);
  }

  function openFriends(tab: FriendsTab = "search") {
    channelLoad.current += 1;
    setSelectedServerId(null);
    setChannelConversation(null);
    setMobileNavigationOpen(false);
    setFriendsInitialTab(tab);
    setSection("friends");
    setPopover(null);
  }

  function openMessages() {
    channelLoad.current += 1;
    setSelectedServerId(null);
    setChannelConversation(null);
    if (channelConversationRef.current?.id === activeConversationId) setActiveConversationId(conversations[0]?.id ?? null);
    setMobileNavigationOpen(false);
    setSection("messages");
    setShowWelcome(false);
    setPopover(null);
  }

  function openClientSettings(section: ClientSettingsSection = "appearance") {
    setPopover(null);
    setShowProfile(false);
    setCallSettingsOpen(false);
    setClientSettingsSection(section);
    setClientSettingsOpen(true);
  }

  async function openChannel(server: CommunityServer, channelId: string) {
    const load = ++channelLoad.current;
    setSelectedServerId(server.id);
    setChannelConversation(null);
    setActiveConversationId(null);
    setSection("messages");
    setShowWelcome(false);
    setMobileNavigationOpen(false);
    setConversationError("");
    try {
      const conversation = await api.serverConversation(server.id, channelId);
      if (load !== channelLoad.current) return;
      setChannelConversation(conversation);
      setActiveConversationId(conversation.id);
      setMessageVersion((value) => value + 1);
    } catch (reason) {
      if (load === channelLoad.current) setConversationError(reason instanceof Error ? reason.message : "Не удалось открыть канал");
    }
  }

  function openServer(server: CommunityServer) {
    setSelectedServerId(server.id);
    if (server.channels[0]) void openChannel(server, server.channels[0].id);
  }

  function navigateConversation(conversationId: string) {
    const server = serversRef.current.find((item) => item.channels.some((channel) => channel.conversation_id === conversationId));
    const channel = server?.channels.find((item) => item.conversation_id === conversationId);
    if (server && channel) { void openChannel(server, channel.id); return; }
    channelLoad.current += 1;
    setSelectedServerId(null);
    setChannelConversation(null);
    setActiveConversationId(conversationId);
    setSection("messages");
    setShowWelcome(false);
    setMobileNavigationOpen(false);
  }

  function togglePopover(next: Exclude<ShellPopover, null>) {
    setShowProfile(false);
    setCallSettingsOpen(false);
    if (popover === next) {
      setPopover(null);
      return;
    }
    setPopover(next);
    if (next === "notifications") {
      setHasNewNotifications(false);
      try {
        localStorage.removeItem(`coherent.new-notifications.${user.id}`);
      } catch {
        // The indicator is cleared for this session.
      }
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission().then((permission) => {
          setNotificationPermission(permission);
          if (permission === "granted") void activatePush();
        }).catch(() => setNotificationPermission("denied"));
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
    <main className="app-shell" ref={shellRef}>
      {mobileNavigationOpen && <button className="mobile-drawer-backdrop" aria-label="Закрыть меню бесед" onClick={() => setMobileNavigationOpen(false)} />}
      <div className={`workspace-navigation ${mobileNavigationOpen ? "is-open" : ""}`} onKeyDown={(event) => { if (event.key === "Escape") setMobileNavigationOpen(false); }}>
      <aside className="server-rail">
        <button className="rail-home active" aria-label="Главная Coherent" title="Главная" onClick={openHome}>
          <span className="brand-mark"><span /><span /><span /></span>
        </button>
        <div className="rail-separator" />
        {servers.map((server) => <button key={server.id} className={`rail-item community-rail-item ${selectedServerId === server.id ? "selected" : ""}`} title={server.name} aria-label={`Открыть сервер ${server.name}`} onClick={() => openServer(server)}>{server.name.slice(0, 2).toUpperCase()}</button>)}
        <button className="rail-item" title="Создать сервер или присоединиться" aria-label="Добавить сервер" onClick={() => { setServerDialogManage(false); setServerDialogOpen(true); }}><Plus size={22} /></button>
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
          className="rail-item rail-settings"
          aria-label="Открыть настройки клиента"
          title="Настройки клиента"
          onClick={() => openClientSettings()}
        >
          <Settings size={20} />
        </button>
      </aside>

      <aside className="channel-sidebar">
        <button className="workspace-picker" onClick={() => { if (selectedServer) { setServerDialogManage(true); setServerDialogOpen(true); } else togglePopover("workspace"); }} aria-expanded={popover === "workspace"} aria-label={selectedServer ? "Управление сервером" : "Меню Coherent"}>
          <span className="workspace-symbol">
            <span className="brand-mark"><span /><span /><span /></span>
          </span>
          <span className="workspace-name">{selectedServer?.name || "Когерент"}</span>
          <ChevronDown size={16} />
        </button>

        {selectedServer ? <div className="community-channel-list"><div className="community-server-caption">{selectedServer.member_count} участников<button onClick={() => { setServerDialogManage(true); setServerDialogOpen(true); }} aria-label="Настройки сервера"><Settings size={16} /></button></div>{[...new Set(selectedServer.channels.map((channel) => channel.category))].map((category) => <section key={category}><h3>{category}</h3>{selectedServer.channels.filter((channel) => channel.category === category).map((channel) => <button key={channel.id} className={`community-channel ${activeConversationId === channel.conversation_id ? "active" : ""}`} onClick={() => void openChannel(selectedServer, channel.id)}><Hash size={17} /><span>{channel.name}</span></button>)}</section>)}{conversationError && <p className="conversation-error" role="alert">{conversationError}</p>}</div> : <>
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
                  channelLoad.current += 1;
                  setActiveConversationId(conversation.id);
                  setSection("messages");
                  setShowWelcome(false);
                  setMobileNavigationOpen(false);
                  setSelectedServerId(null);
                  setChannelConversation(null);
                }}
              >
                <span className="conversation-avatar-wrap"><span className="avatar avatar-user">{conversation.kind === "group" ? <UsersRound size={18} /> : conversationTitle(conversation)[0]?.toUpperCase()}</span>
                  {conversation.kind === "direct" && conversation.other_user && onlineIds.has(conversation.other_user.id) && <i className="conversation-presence" title="В сети" />}
                </span>
                <span className="conversation-item-copy">
                  <strong>{conversationTitle(conversation)}</strong>
                  <small>{conversation.last_message?.body || (conversation.last_message?.attachment_count ? "Вложение" : "Беседа начата")}</small>
                </span>
                {conversation.unread && <i className="conversation-unread" title="Непрочитанные сообщения" aria-label="Непрочитанные сообщения" />}
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
            <strong>Когерент в разработке</strong>
            <small>Мы создаём место для общения</small>
          </div>
        </div>
        </>}
      </aside>
      </div>

      <section className="content-area">
        <header className="content-header">
          <button className="mobile-menu-toggle header-icon" onClick={() => setMobileNavigationOpen(true)} aria-label="Открыть меню бесед и серверов" aria-expanded={mobileNavigationOpen}><Menu size={22} /></button>
          <div className="header-location">
            <MessageCircle size={19} />
            <span>{section === "messages" ? selectedConversation ? conversationTitle(selectedConversation) : (currentCall?.status === "active" ? "Групповой звонок" : "Сообщения") : "Друзья"}</span>
            <span className="header-divider" />
            <span className="header-subtle">{selectedServer?.name || "Личное пространство"}</span>
          </div>
          <div className="mobile-nav" aria-label="Разделы">
            <button className={section === "messages" ? "active" : ""} onClick={openMessages} aria-label="Сообщения"><MessageCircle size={18} /></button>
            <button className={section === "friends" ? "active" : ""} onClick={() => openFriends("all")} aria-label="Друзья"><Users size={18} /></button>
          </div>
          <div className="header-actions">
            <button className="header-icon mobile-settings-button" aria-label="Настройки клиента" title="Настройки" onClick={() => openClientSettings()}><Settings size={18} /></button>
            {section === "messages" && selectedConversation && !selectedConversation.server_id && (
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
              {hasNewNotifications && <i className="notification-new-dot" aria-hidden="true" />}
            </button>
            <button className="header-icon" aria-label="Помощь" title="Помощь" aria-expanded={popover === "help"} onClick={() => togglePopover("help")}>
              <CircleHelp size={18} />
            </button>
            <span className="header-user">{displayName(user)}</span>
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
                {conversation.unread && <i className="mobile-conversation-unread" title="Непрочитанные сообщения" />}
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
              settingsOpen={callSettingsOpen}
              onToggleSettings={() => setCallSettingsOpen((open) => !open)}
              onMediaChange={changeMedia}
              onRoomReady={setActiveRoom}
              onInvite={inviteToCall}
              onAccept={() => void acceptCall()}
              onEnd={() => void endCall()}
              onCollapse={() => setCallCollapsed(true)}
              onFocus={() => {
                setCallCollapsed(false);
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
            onRead={markConversationRead}
            callError={currentCall ? "" : callError}
            peerOnline={selectedConversation.other_user ? onlineIds.has(selectedConversation.other_user.id) : undefined}
            onRename={renameGroup}
            incomingFiles={pendingFiles}
            onFilesConsumed={(nonce) => setPendingFiles((current) => current?.nonce === nonce ? null : current)}
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
                    <span className="welcome-pulse" /> ПЕРВОЕ ПРОСТРАНСТВО КОГЕРЕНТ
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
            <FriendsPanel initialTab={friendsInitialTab} requestVersion={friendRequestVersion} onStartConversation={startConversation} onlineIds={onlineIds} />
          )}
        </div>
        )}

        <footer className="app-statusbar">
          <span><i className="status-dot" /> Сессия активна</span>
          <span>Когерент</span>
        </footer>
      </section>

      {popover && <button className="shell-popover-dismiss" aria-label="Закрыть меню" onClick={() => setPopover(null)} />}
      {popover === "workspace" && (
        <div className="shell-popover shell-popover-workspace" role="menu" aria-label="Меню Coherent">
          <strong>Coherent</strong>
          <button role="menuitem" onClick={openHome}><Compass size={16} /> Главная</button>
          <button role="menuitem" onClick={openMessages}><MessageCircle size={16} /> Сообщения</button>
          <button role="menuitem" onClick={() => openFriends("all")}><Users size={16} /> Друзья</button>
          <button role="menuitem" onClick={() => openClientSettings("media")}><Settings size={16} /> Звук и видео</button>
        </div>
      )}
      {popover === "notifications" && (
        <div className="shell-popover shell-popover-notifications" aria-label="Уведомления">
          <div className="notification-heading"><strong>Уведомления</strong><button onClick={clearNotifications} disabled={recentNotifications.length === 0 && notificationRequests.every((item) => dismissedNotificationIds.has(`friend-${item.request_id}`)) && (!incomingCallId || dismissedNotificationIds.has(`call-${incomingCallId}`))}>Очистить всё</button></div>
          {notificationPermission === "default" && <button className="notification-permission" onClick={() => {
            void Notification.requestPermission().then((permission) => {
              setNotificationPermission(permission);
              if (permission === "granted") void activatePush();
            }).catch(() => setNotificationPermission("denied"));
          }}><Bell size={16} /> Включить уведомления браузера</button>}
          {notificationPermission === "denied" && <p>Уведомления браузера отключены. Разреши их в настройках сайта.</p>}
          {pushError && <p role="alert">{pushError}</p>}
          {currentCall?.participants.some((participant) => participant.user_id === user.id && participant.state === "invited") && !dismissedNotificationIds.has(`call-${currentCall.id}`) && (
            <button onClick={() => {
              setPopover(null);
              setSection("messages");
              setActiveConversationId(currentCall.conversation_id);
              setShowWelcome(false);
            }}><Phone size={16} /> Входящий звонок · открыть</button>
          )}
          {notificationLoading && <p>Загружаем заявки...</p>}
          {notificationError && <p role="alert">{notificationError}</p>}
          {!notificationLoading && !notificationError && notificationRequests.every((item) => dismissedNotificationIds.has(`friend-${item.request_id}`)) && recentNotifications.length === 0 && (!incomingCallId || dismissedNotificationIds.has(`call-${incomingCallId}`)) && <p>Новых уведомлений нет.</p>}
          {recentNotifications.filter((notice) => !notice.id.startsWith("friend-")).map((notice) => <button className="notification-event" key={notice.id} onClick={() => {
            setPopover(null);
            setSection(notice.conversationId ? "messages" : "friends");
            if (notice.conversationId) navigateConversation(notice.conversationId);
            else setFriendsInitialTab("requests");
            setShowWelcome(false);
          }}><MessageCircle size={16} /> {notice.title}</button>)}
          {!notificationLoading && notificationRequests.filter((request) => !dismissedNotificationIds.has(`friend-${request.request_id}`)).slice(0, 4).map((request) => (
            <button key={request.request_id} onClick={() => openFriends("requests")}><UserPlus size={16} /> Заявка от {displayName(request)}</button>
          ))}
        </div>
      )}
      {popover === "help" && (
        <div className="shell-popover shell-popover-help" aria-label="Помощь">
          <strong>Как пользоваться Coherent</strong>
          <p>Найди человека по имени, открой беседу и нажми трубку для звонка. Кнопка с людьми рядом начинает групповой звонок.</p>
          <p>Во время звонка сетка и размер плиток меняются через кнопку отображения. Устройства и обработка микрофона находятся в настройках.</p>
          <button onClick={() => openFriends("search")}><Search size={16} /> Найти человека</button>
          <button onClick={() => openClientSettings("media")}><Settings size={16} /> Настроить звук и видео</button>
        </div>
      )}

      {showProfile && (
        <div className="profile-menu">
          <div className="profile-menu-user">
            <span className="avatar avatar-user">{initial}</span>
            <div><strong>{displayName(user)}</strong><span>В сети</span></div>
            <MoreHorizontal size={18} />
          </div>
          <button onClick={() => { setShowProfile(false); setProfileSettingsOpen(true); }}><Settings size={16} /> Настройки профиля</button>
          {user.is_admin && <button onClick={() => { setShowProfile(false); setAdminPanelOpen(true); }}><ShieldCheck size={16} /> Админ-панель</button>}
          <button onClick={() => { void disablePush().catch(() => undefined).finally(onLogout); }}><LogOut size={16} /> Выйти из аккаунта</button>
        </div>
      )}

      {profileSettingsOpen && <ProfileSettingsDialog user={user} onUpdated={onUserChange} onClose={() => setProfileSettingsOpen(false)} />}
      {serverDialogOpen && <ServerDialog server={serverDialogManage ? selectedServer : undefined} currentUserId={user.id} onClose={() => setServerDialogOpen(false)} onSaved={(server) => { setServers((current) => [...current.filter((item) => item.id !== server.id), server]); openServer(server); }} />}
      {adminPanelOpen && <AdminPanel onClose={() => setAdminPanelOpen(false)} />}
      {clientSettingsOpen && <ClientSettingsDialog
        section={clientSettingsSection}
        onSectionChange={setClientSettingsSection}
        onClose={() => setClientSettingsOpen(false)}
        media={media}
        audioProcessingState={audioProcessingState}
        onMediaChange={changeMedia}
      />}

      {draggingFiles && <div className="file-drop-overlay" aria-hidden="true">Перетащи файл сюда, чтобы прикрепить к беседе</div>}

      {!isTauri() && incomingCallId && currentCall && <div className="incoming-call-backdrop" role="dialog" aria-modal="true" aria-label="Входящий звонок">
        <IncomingCallCard caller={(currentCall.caller_display_name || currentCall.caller_username)} error={callError} busy={callPending} onDecline={() => void endCall()} onAccept={() => void acceptCall()} />
      </div>}

      <audio ref={ringtoneRef} loop preload="auto" aria-hidden="true">
        <source src="/audio/Coherent_Aura.ogg" type="audio/ogg" />
        <source src="/audio/Coherent_Aura.mp3" type="audio/mpeg" />
      </audio>

      <div className="account-bar">
        <button className="account-profile" onClick={() => { setPopover(null); setShowProfile((visible) => !visible); }} aria-expanded={showProfile} aria-label="Открыть профиль">
          <span className="avatar avatar-user"
            role="img"
            aria-label={displayName(user)}
          >
            {initial}
          </span>
          <span className="account-name">
            <strong>{displayName(user)}</strong>
            <small className="account-online"><i /> В сети</small>
          </span>
        </button>
        <div className="account-controls">
          <button className={media.microphoneEnabled ? "is-on" : "is-off"} aria-label={microphoneButtonLabel} title={microphoneButtonTitle} onClick={() => void changeMedia({ microphoneEnabled: !media.microphoneEnabled }).catch(() => undefined)}>
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
      {callSettingsOpen && !callPanelReady && (
        <MediaSettingsPanel media={media} audioProcessingState={audioProcessingState} onChange={changeMedia} onClose={() => setCallSettingsOpen(false)} />
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
      <DeviceApprovalPanel accountId={user.id} />
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
