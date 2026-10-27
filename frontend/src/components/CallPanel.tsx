import { messagingFor } from "../lib/crypto/messaging";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import {
  AudioTrack,
  LiveKitRoom,
  StartAudio,
  TrackToggle,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useParticipantAttributes,
  useParticipantTracks,
  useRoomContext,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import {
  Camera,
  CameraOff,
  LayoutGrid,
  LockKeyhole,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Phone,
  PhoneOff,
  Settings2,
  ChevronsDown,
  ChevronsUp,
  UserPlus,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from "lucide-react";
import { AudioPresets, ConnectionQuality, ExternalE2EEKeyProvider, isE2EESupported, Room, RoomEvent, Track, type Participant } from "livekit-client";
import { api, displayName, type Call, type CallJoin } from "../lib/api";
import {
  cameraCapture,
  cameraPublish,
  microphoneCapture,
  screenShareCapture,
  screenSharePublish,
  updateScreenShareBitrate,
  type AudioProcessingState,
  type MediaPreferences,
} from "../lib/media";
import MediaSettingsPanel from "./MediaSettingsPanel";
import ParticipantPicker from "./ParticipantPicker";
import { applyMicrophoneProcessing } from "../lib/microphoneProcessor";
import { NativeScreenAudio } from "../lib/nativeScreenAudio";
import { NativeScreenShare, type ScreenSource } from "../lib/nativeScreenShare";
import DesktopSharePicker from "./DesktopSharePicker";
import { isTauri } from "@tauri-apps/api/core";
import { cancelDesktopMediaRequests } from "../lib/desktopPermissions";

type ViewMode = "grid" | "focus";
type TileDensity = "normal" | "compact";
const VOLUME_STORAGE_KEY = "coherent-participant-volumes";
const SCREEN_VOLUME_STORAGE_KEY = "coherent-screen-volumes";
const KEY_EMOJIS = ["🔒", "🌙", "⭐", "🌿", "🦊", "🍋", "🎲", "🪐", "🐳", "🎯", "🍀", "🔥", "🦋", "🎵", "🧩", "💎"];
let speechContext: AudioContext | undefined;
let speechContextUsers = 0;

function acquireSpeechContext(): AudioContext {
  speechContext ??= new AudioContext({ latencyHint: "interactive" });
  speechContextUsers += 1;
  return speechContext;
}

function releaseSpeechContext(context: AudioContext): void {
  speechContextUsers -= 1;
  if (speechContextUsers === 0 && speechContext === context) {
    speechContext = undefined;
    void context.close();
  }
}

async function keyFingerprint(key: string): Promise<{ emoji: string; code: string }> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return {
    emoji: Array.from(hash.slice(0, 4), (byte) => KEY_EMOJIS[byte % KEY_EMOJIS.length]).join(" "),
    code: Array.from(hash.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function loadVolumes(key: string, maximum: number): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(stored).filter(([id, value]) =>
      id.length > 0 && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ));
  } catch {
    return {};
  }
}

const loadParticipantVolumes = () => loadVolumes(VOLUME_STORAGE_KEY, 200);
const loadScreenVolumes = () => loadVolumes(SCREEN_VOLUME_STORAGE_KEY, 100);

interface CallPanelProps {
  call: Call;
  conversationTitle?: string;
  isGroupConversation?: boolean;
  currentUserId: string;
  compact: boolean;
  error: string;
  pending: boolean;
  media: MediaPreferences;
  audioProcessingState: AudioProcessingState | null;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  onMediaChange: (patch: Partial<MediaPreferences>) => Promise<void>;
  onRoomReady: (room: Room | null) => void;
  onInvite: (userIds: string[]) => Promise<void>;
  onAccept: () => void;
  onEnd: () => void;
  onCollapse: () => void;
  onFocus: () => void;
}

export default function CallPanel({
  call,
  conversationTitle,
  isGroupConversation,
  currentUserId,
  compact,
  error,
  pending,
  media,
  audioProcessingState,
  settingsOpen,
  onToggleSettings,
  onMediaChange,
  onRoomReady,
  onInvite,
  onAccept,
  onEnd,
  onCollapse,
  onFocus,
}: CallPanelProps) {
  const self = call.participants.find((participant) => participant.user_id === currentUserId);
  const incoming = self?.state === "invited";
  const reconnectable = call.status === "active" && self?.state === "left";
  const group = isGroupConversation || call.participants.length > 2;
  const peer = call.caller_id === currentUserId ? (call.callee_display_name || call.callee_username) : (call.caller_display_name || call.caller_username);
  const title = group ? conversationTitle || "Групповой звонок" : peer;
  const occupied = call.participants.filter((participant) =>
    participant.state === "invited" || participant.state === "joined"
  ).length;
  const panelRef = useRef<HTMLElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isViewportFullscreen, setIsViewportFullscreen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [tileDensity, setTileDensity] = useState<TileDensity>("normal");
  const [viewOpen, setViewOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => () => {
    void messagingFor(currentUserId).releaseMedia(call.id).catch(() => undefined);
  }, [call.id, currentUserId]);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    if (!isViewportFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsViewportFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isViewportFullscreen]);

  async function toggleFullscreen() {
    const panel = panelRef.current;
    if (!panel) return;
    if (isViewportFullscreen) {
      setIsViewportFullscreen(false);
      return;
    }
    if (document.fullscreenElement === panel) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    try {
      await panel.requestFullscreen();
    } catch {
      setIsViewportFullscreen(true);
    }
  }

  if (incoming || call.status === "ringing" || reconnectable) {
    return (
      <aside className="call-invite" aria-label={`Звонок с ${peer}`}>
        <div className="call-invite-avatar">{peer.slice(0, 1).toUpperCase()}</div>
        <div className="call-invite-copy">
          <span>{reconnectable ? "ЗВОНОК ПРОДОЛЖАЕТСЯ" : incoming ? (group ? "ПРИГЛАШЕНИЕ В ГРУППУ" : "ВХОДЯЩИЙ ЗВОНОК") : "ИСХОДЯЩИЙ ЗВОНОК"}</span>
          <strong>{incoming ? (call.caller_display_name || call.caller_username) : title}</strong>
          <small>{reconnectable ? call.participants.some((participant) => participant.state === "joined")
            ? `${call.participants.filter((participant) => participant.state === "joined").length} в звонке · можно вернуться`
            : `Можно вернуться до ${new Date(call.expires_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
            : incoming ? (group ? `Участников: ${occupied}` : "Хочет поговорить с тобой") : "Ожидаем ответа..."}</small>
        </div>
        <div className="call-invite-actions">
          {(incoming || reconnectable) && (
            <button className={`call-invite-accept ${reconnectable ? "call-invite-rejoin" : ""}`} onClick={onAccept} disabled={pending} aria-label={reconnectable ? "Вернуться в звонок" : "Принять звонок"} title={reconnectable ? "Вернуться" : "Принять"}>
              <Phone size={18} />{reconnectable && <span>Вернуться</span>}
            </button>
          )}
          {!reconnectable && <button className="call-invite-end" onClick={onEnd} disabled={pending} aria-label={incoming ? "Отклонить звонок" : "Отменить звонок"} title={incoming ? "Отклонить" : "Отменить"}>
            <PhoneOff size={18} />
          </button>}
        </div>
        {error && <p className="call-invite-error" role="alert">{error}</p>}
      </aside>
    );
  }

  return (
    <section ref={panelRef} className={`call-surface ${compact ? "call-surface-compact" : "call-surface-expanded"} ${isViewportFullscreen ? "call-surface-maximized" : ""}`} aria-label={`Разговор: ${title}`}>
      <CallRoom
        currentUserId={currentUserId}
        key={call.id}
        call={call}
        title={title}
        compact={compact}
        isFullscreen={isFullscreen || isViewportFullscreen}
        media={media}
        viewMode={viewMode}
        onModeChange={setViewMode}
        tileDensity={tileDensity}
        onRoomReady={onRoomReady}
        onMediaChange={onMediaChange}
        onFocus={onFocus}
        onCollapse={() => {
          if (document.fullscreenElement === panelRef.current) void document.exitFullscreen();
          setIsViewportFullscreen(false);
          onCollapse();
        }}
        onToggleFullscreen={() => void toggleFullscreen()}
        onToggleView={() => setViewOpen((open) => !open)}
        onToggleSettings={onToggleSettings}
        onInvite={() => setInviteOpen(true)}
        canInvite={group && occupied < 10}
        onEnd={onEnd}
        pending={pending}
      />
      {error && <p className="call-surface-error" role="alert">{error}</p>}
      {viewOpen && !compact && (
        <div className="call-view-menu" aria-label="Отображение звонка">
          <div className="call-view-menu-heading"><strong>Отображение</strong><button onClick={() => setViewOpen(false)} aria-label="Закрыть"><X size={16} /></button></div>
          <span>Раскладка</span>
          <div className="call-view-options">
            <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")}>Сетка</button>
            <button className={viewMode === "focus" ? "active" : ""} onClick={() => setViewMode("focus")}>Крупный план</button>
          </div>
          <span>Размер плиток</span>
          <div className="call-view-options">
            <button className={tileDensity === "normal" ? "active" : ""} onClick={() => setTileDensity("normal")}>Обычный</button>
            <button className={tileDensity === "compact" ? "active" : ""} onClick={() => setTileDensity("compact")}>Компактный</button>
          </div>
        </div>
      )}
      {settingsOpen && !compact && <MediaSettingsPanel media={media} audioProcessingState={audioProcessingState} onChange={onMediaChange} onClose={onToggleSettings} />}
      {inviteOpen && (
        <ParticipantPicker
          title="Добавить в звонок"
          excludedIds={call.participants.filter((participant) => participant.state === "invited" || participant.state === "joined").map((participant) => participant.user_id)}
          maxSelect={Math.max(0, 10 - occupied)}
          onSubmit={onInvite}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </section>
  );
}

function CallRoom({
  currentUserId,
  call,
  title,
  compact,
  isFullscreen,
  media,
  viewMode,
  onModeChange,
  tileDensity,
  onRoomReady,
  onMediaChange,
  onFocus,
  onCollapse,
  onToggleFullscreen,
  onToggleView,
  onToggleSettings,
  onInvite,
  canInvite,
  onEnd,
  pending,
}: {
  currentUserId: string;
  call: Call;
  title: string;
  compact: boolean;
  isFullscreen: boolean;
  media: MediaPreferences;
  viewMode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  tileDensity: TileDensity;
  onRoomReady: (room: Room | null) => void;
  onMediaChange: (patch: Partial<MediaPreferences>) => Promise<void>;
  onFocus: () => void;
  onCollapse: () => void;
  onToggleFullscreen: () => void;
  onToggleView: () => void;
  onToggleSettings: () => void;
  onInvite: () => void;
  canInvite: boolean;
  onEnd: () => void;
  pending: boolean;
}) {
  const [join, setJoin] = useState<(CallJoin & { callId: string }) | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [connected, setConnected] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [participantVolumes, setParticipantVolumes] = useState(loadParticipantVolumes);
  const [screenVolumes, setScreenVolumes] = useState(loadScreenVolumes);
  const [encryptedRoom, setEncryptedRoom] = useState<{ callId: string; room: Room; fingerprint: { emoji: string; code: string } } | null>(null);
  const roomOptions = useMemo(() => ({
    adaptiveStream: { pixelDensity: 2 },
    dynacast: true,
    webAudioMix: true,
    audioCaptureDefaults: { voiceIsolation: false },
    publishDefaults: {
      audioPreset: { ...AudioPresets.musicHighQuality, priority: "high" as const },
      dtx: false,
      red: true,
    },
  }), []);

  useEffect(() => {
    try { localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(participantVolumes)); } catch { /* Storage may be disabled. */ }
  }, [participantVolumes]);

  useEffect(() => {
    try { localStorage.setItem(SCREEN_VOLUME_STORAGE_KEY, JSON.stringify(screenVolumes)); } catch { /* Storage may be disabled. */ }
  }, [screenVolumes]);

  function changeParticipantVolume(userId: string, volume: number) {
    setParticipantVolumes((current) => ({ ...current, [userId]: volume }));
  }

  function changeScreenVolume(userId: string, volume: number) {
    setScreenVolumes((current) => ({ ...current, [userId]: volume }));
  }

  useEffect(() => {
    let active = true;
    setJoin(null);
    setEncryptedRoom(null);
    api.joinCall(call.id).then((result) => {
      if (active) setJoin({ ...result, callId: call.id });
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось подключиться к звонку.");
    });
    return () => { active = false; };
  }, [call.id, joinAttempt]);

  useEffect(() => {
    if (!join || join.callId !== call.id) return;
    let active = true;
    let room: Room | undefined;
    let worker: Worker | undefined;
    let refreshTimer: number | undefined;
    let refreshKey: (() => void) | undefined;
    async function prepareEncryption() {
      if (!isE2EESupported()) throw new Error("Этот браузер не поддерживает сквозное шифрование звонков.");
      if (!join?.media_conversation_id) throw new Error("Обнови клиент для защищённых звонков.");
      const mediaKey = await messagingFor(currentUserId).mediaKey(call.id);
      const provider = new ExternalE2EEKeyProvider();
      worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
      room = new Room({ ...roomOptions, encryption: { keyProvider: provider, worker } });
      await provider.setKey(mediaKey.key);
      await room.setE2EEEnabled(true);
      const fingerprint = await keyFingerprint(mediaKey.key);
      if (active) setEncryptedRoom({ callId: call.id, room, fingerprint });
      let previousKey = mediaKey.key, refreshing = false;
      refreshKey = () => {
        if (!active || refreshing) return; refreshing = true;
        void messagingFor(currentUserId).mediaKey(call.id).then(async next => {
          if (!active || next.key === previousKey) return;
          await provider.setKey(next.key); previousKey = next.key;
          const nextFingerprint = await keyFingerprint(next.key);
          if (active && room) setEncryptedRoom({callId:call.id,room,fingerprint:nextFingerprint});
        }).catch(reason => {
          if (active) { setError(reason instanceof Error ? reason.message : "Не удалось обновить ключ звонка"); void room?.disconnect(); }
        }).finally(() => { refreshing = false; });
      };
      window.addEventListener("coherent-media-membership", refreshKey);
      refreshTimer = window.setInterval(refreshKey, 5000);
    }
    void prepareEncryption().catch((reason: unknown) => {
      if (room) void room.disconnect();
      worker?.terminate();
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось включить шифрование звонка.");
    });
    return () => {
      active = false;
      if (refreshTimer) window.clearInterval(refreshTimer);
      if (refreshKey) window.removeEventListener("coherent-media-membership", refreshKey);
      if (room) void room.disconnect();
      worker?.terminate();
    };
  }, [join, roomOptions, call.id, currentUserId]);

  function retryConnection() {
    setError("");
    setJoin(null);
    setConnected(false);
    setJoinAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - Date.parse(call.answered_at ?? call.created_at)) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [call.answered_at, call.created_at]);

  const time = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const joinedCount = call.participants.filter((participant) => participant.state === "joined").length;
  const header = (
    <div className="call-surface-header">
      <span className={`call-connected-dot ${error ? "is-error" : connected ? "is-connected" : ""}`} aria-hidden="true" />
      <div className="call-surface-title">
        <strong>{title}</strong>
        <small>{error || (connected ? `${joinedCount} в звонке · ${time}` : "Подключение...")}</small>
      </div>
      {connected && encryptedRoom?.callId === call.id && <span className="call-encryption" title={`Сквозное шифрование медиа. Ключ создают устройства через MLS. Серверы Когерента и LiveKit его не получают. Сверь эмодзи и код с собеседниками: ${encryptedRoom.fingerprint.code}`}><LockKeyhole size={13} /> Шифрование <span>{encryptedRoom.fingerprint.emoji}</span></span>}
      {compact ? (
        <button className="call-focus-button" onClick={onFocus} aria-label="Развернуть звонок" title="Развернуть звонок">
          <ChevronsDown size={17} />
        </button>
      ) : (
        <div className="call-header-tools">
          <button className="call-focus-button" onClick={onCollapse} aria-label="Свернуть звонок в полосу" title="Свернуть звонок"><ChevronsUp size={17} /></button>
          <button className="call-focus-button" onClick={onInvite} disabled={!canInvite} aria-label="Добавить участников" title="Добавить участников"><UserPlus size={17} /></button>
          <button className="call-focus-button" onClick={onToggleView} aria-label="Параметры отображения" title="Параметры отображения"><LayoutGrid size={17} /></button>
          <button className="call-focus-button" onClick={onToggleSettings} aria-label="Настройки звука и видео" title="Настройки звука и видео"><Settings2 size={17} /></button>
          <button className="call-focus-button" onClick={onToggleFullscreen} aria-label={isFullscreen ? "Выйти из полноэкранного режима" : "Открыть звонок на весь экран"} title={isFullscreen ? "Выйти из полноэкранного режима" : "На весь экран"}>
            {isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      )}
    </div>
  );

  if (error) {
    return <>{header}<div className="call-connect-error" role="alert">{error}<div className="call-connect-error-actions"><button className="call-connect-retry" onClick={retryConnection}>Повторить подключение</button><button onClick={onEnd}>Выйти</button></div></div></>;
  }
  if (!join || join.callId !== call.id || !encryptedRoom || encryptedRoom.callId !== call.id) return <>{header}<div className="call-connect-note">Подключаем защищённый звонок...</div></>;

  return (
    <LiveKitRoom
      serverUrl={join.server_url}
      token={join.token}
      room={encryptedRoom.room}
      connect
      audio={false}
      video={false}
      onConnected={() => setConnected(true)}
      onDisconnected={() => setConnected(false)}
      onError={(reason) => setError(reason.message)}
      onEncryptionError={(reason) => { setError(`Ошибка шифрования: ${reason.message}`); void encryptedRoom.room.disconnect(); }}
    >
      <CallMediaBridge connected={connected} media={media} onRoomReady={onRoomReady} onError={setMediaError} />
      <CallAudioRenderer muted={media.deafened} volumes={participantVolumes} screenVolumes={screenVolumes} />
      {header}
      <CallStage call={call} mode={viewMode} onModeChange={onModeChange} density={tileDensity} volumes={participantVolumes} onVolumeChange={changeParticipantVolume} screenVolumes={screenVolumes} onScreenVolumeChange={changeScreenVolume} media={media} />
      <div className="call-surface-controls">
        <CallConnectionNotice />
        <StartAudio className="call-start-audio" label="Включить звук" />
        <CallControls media={media} onMediaChange={onMediaChange} onError={setMediaError} onEnd={onEnd} pending={pending} />
      </div>
      {mediaError && <p className="call-surface-error" role="alert">{mediaError}</p>}
    </LiveKitRoom>
  );
}

function CallMediaBridge({
  connected,
  media,
  onRoomReady,
  onError,
}: {
  connected: boolean;
  media: MediaPreferences;
  onRoomReady: (room: Room | null) => void;
  onError: (message: string) => void;
}) {
  const room = useRoomContext();
  const mediaRef = useRef(media);
  mediaRef.current = media;

  useEffect(() => {
    if (!connected) return;
    let active = true;
    async function prepare() {
      const selected = mediaRef.current;
      await room.localParticipant.setAttributes({ "coherent.deafened": selected.deafened ? "true" : "false" }).catch(() => undefined);
      if (!active) return;
      if (selected.microphoneEnabled) {
        await room.localParticipant.setMicrophoneEnabled(true, microphoneCapture(selected));
        try {
          await applyMicrophoneProcessing(room, selected.microphoneVolume, selected.noiseSuppression ? "noisy" : "soft", selected.noiseProcessor, selected.rnnoisePreset);
        } catch (reason) {
          await room.localParticipant.setMicrophoneEnabled(false);
          throw reason;
        }
      }
      if (selected.cameraEnabled) {
        if (!active) return;
        await room.localParticipant.setCameraEnabled(
          true,
          cameraCapture(selected),
          cameraPublish(selected),
        );
      }
      if (selected.speakerId) {
        await room.switchActiveDevice("audiooutput", selected.speakerId);
      }
    }
    void prepare().catch((reason: unknown) => {
      if (active) onError(reason instanceof Error ? reason.message : "Не удалось включить устройство.");
    }).finally(() => {
      if (active) onRoomReady(room);
    });
    return () => {
      active = false;
      cancelDesktopMediaRequests();
      onRoomReady(null);
    };
  }, [connected, room, onRoomReady, onError]);
  return null;
}

function CallControls({
  media,
  onMediaChange,
  onError,
  onEnd,
  pending,
}: {
  media: MediaPreferences;
  onMediaChange: (patch: Partial<MediaPreferences>) => Promise<void>;
  onError: (message: string) => void;
  onEnd: () => void;
  pending: boolean;
}) {
  const { isScreenShareEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const checkedShareId = useRef<string | null>(null);
  const nativeAudio = useRef<NativeScreenAudio | null>(null);
  const nativeShare = useRef<NativeScreenShare | null>(null);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [shareStarting, setShareStarting] = useState(false);
  const shareOperation = useRef(false);

  useEffect(() => () => {
    const share = nativeShare.current;
    nativeShare.current = null;
    if (share) void share.stop();
  }, []);

  async function startNativeShare(source: ScreenSource) {
    if (shareOperation.current) return;
    shareOperation.current = true;
    setShareStarting(true);
    onError("");
    const share = new NativeScreenShare(room);
    nativeShare.current = share;
    try {
      await share.start(source.id, media, () => {
        if (nativeShare.current === share) {
          nativeShare.current = null;
          onError("Демонстрация экрана остановлена.");
        }
      });
      setSharePickerOpen(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Не удалось начать демонстрацию.");
      if (nativeShare.current === share) nativeShare.current = null;
    } finally {
      shareOperation.current = false;
      setShareStarting(false);
    }
  }

  async function stopNativeShare() {
    const share = nativeShare.current;
    nativeShare.current = null;
    if (share) await share.stop();
  }

  useEffect(() => {
    if (!isTauri()) return;
    if (isScreenShareEnabled && media.systemAudioEnabled) {
      const bridge = new NativeScreenAudio(room);
      nativeAudio.current = bridge;
      void bridge.start(onError).catch((reason: unknown) => {
        onError(reason instanceof Error ? reason.message : "Не удалось передать звук компьютера.");
      });
    } else {
      const bridge = nativeAudio.current;
      nativeAudio.current = null;
      if (bridge) void bridge.stop();
    }
    return () => {
      const bridge = nativeAudio.current;
      nativeAudio.current = null;
      if (bridge) void bridge.stop();
    };
  }, [isScreenShareEnabled, media.systemAudioEnabled, room, onError]);

  const protectScreenAudio = useCallback(() => {
    if (isTauri()) return;
    const video = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
    const audio = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    if (!video || !audio || checkedShareId.current === video.id) return;
    const handle = (video as MediaStreamTrack & {
      getCaptureHandle?: () => { handle: string; origin?: string } | null;
    }).getCaptureHandle?.();
    const isCoherentTab = handle?.handle === "coherent" && handle.origin === window.location.origin;
    const isWholeScreen = (video.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface === "monitor";
    if (!isCoherentTab && !isWholeScreen) return;
    checkedShareId.current = video.id;
    void room.localParticipant.unpublishTrack(audio).then(() => {
      onError(isCoherentTab
        ? "Звук вкладки Coherent отключён, чтобы не было эха."
        : "Звук всего компьютера отключён. Для показа со звуком выбери отдельную вкладку.");
    }).catch((reason: unknown) => {
      onError(reason instanceof Error ? reason.message : "Не удалось отключить системный звук.");
    });
  }, [room, onError]);

  useEffect(() => {
    const onPublished = () => {
      protectScreenAudio();
      void updateScreenShareBitrate(room, media.screenShareBitrateMbps).catch(() => undefined);
    };
    room.on(RoomEvent.LocalTrackPublished, onPublished);
    return () => { room.off(RoomEvent.LocalTrackPublished, onPublished); };
  }, [room, protectScreenAudio, media.screenShareBitrateMbps]);

  const onScreenShareChange = useCallback((enabled: boolean) => {
    if (enabled) {
      protectScreenAudio();
    } else {
      checkedShareId.current = null;
    }
  }, [protectScreenAudio]);

  function change(patch: Partial<MediaPreferences>) {
    void onMediaChange(patch).catch((reason: unknown) => {
      onError(reason instanceof Error ? reason.message : "Не удалось изменить устройство.");
    });
  }
  return (
    <div className="call-control-group">
      <button className="call-control" onClick={() => change({ microphoneEnabled: !media.microphoneEnabled })} aria-label={media.microphoneEnabled ? "Выключить микрофон" : "Включить микрофон"} title={media.microphoneEnabled ? "Выключить микрофон" : "Включить микрофон"}>
        {media.microphoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}
      </button>
      <button className="call-control call-control-camera" onClick={() => change({ cameraEnabled: !media.cameraEnabled })} aria-label={media.cameraEnabled ? "Выключить камеру" : "Включить камеру"} title={media.cameraEnabled ? "Выключить камеру" : "Включить камеру"}>
        {media.cameraEnabled ? <Camera size={20} /> : <CameraOff size={20} />}
      </button>
      {isTauri() ? <button className="call-control call-control-screen" aria-label={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} title={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} disabled={shareStarting} onClick={() => { if (isScreenShareEnabled) void stopNativeShare(); else setSharePickerOpen(true); }}><MonitorUp size={20} /></button>
        : <TrackToggle source={Track.Source.ScreenShare} captureOptions={screenShareCapture(media)} publishOptions={screenSharePublish(media)} showIcon={false} className="call-control call-control-screen" aria-label={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} title={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} onDeviceError={(reason) => onError(reason.message)} onChange={onScreenShareChange} onClick={() => onError("")}><MonitorUp size={20} /></TrackToggle>}
      {sharePickerOpen && <DesktopSharePicker onChoose={(source) => { void startNativeShare(source); }} onClose={() => { if (!shareStarting) setSharePickerOpen(false); }} busy={shareStarting} />}
      <button className="call-control call-control-end" onClick={onEnd} disabled={pending} aria-label="Выйти из звонка" title="Выйти из звонка">
        <PhoneOff size={20} />
      </button>
    </div>
  );
}

function CallConnectionNotice() {
  const room = useRoomContext();
  const [weakConnection, setWeakConnection] = useState(false);

  useEffect(() => {
    const update = () => {
      const participants = [room.localParticipant, ...room.remoteParticipants.values()];
      setWeakConnection(participants.some((participant) =>
        participant.connectionQuality === ConnectionQuality.Poor
        || participant.connectionQuality === ConnectionQuality.Lost
      ));
    };
    update();
    room.on(RoomEvent.ConnectionQualityChanged, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    return () => {
      room.off(RoomEvent.ConnectionQualityChanged, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
    };
  }, [room]);

  if (!weakConnection) return null;
  return <p className="call-network-notice" role="status" aria-label="Нестабильная связь. Звук может прерываться." title="Связь нестабильна: звук может прерываться. Для демонстрации можно снизить качество в настройках видео.">
    <WifiOff size={14} aria-hidden="true" />
    <span className="call-network-notice-text" aria-hidden="true">Нестабильная связь</span>
  </p>;
}

function CallAudioRenderer({ muted, volumes, screenVolumes }: { muted: boolean; volumes: Record<string, number>; screenVolumes: Record<string, number> }) {
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio], { onlySubscribed: true });
  return <>{tracks.filter((track) => !track.participant.isLocal).map((track) => (
    <AudioTrack
      key={`${track.participant.identity}-${track.source}`}
      trackRef={track}
      volume={muted ? 0 : (track.source === Track.Source.ScreenShareAudio
        ? screenVolumes[track.participant.identity] ?? 100
        : volumes[track.participant.identity] ?? 100) / 100}
    />
  ))}</>;
}

function ParticipantStatus({ participant, media, inline = false }: { participant: Participant; media: MediaPreferences; inline?: boolean }) {
  const microphoneTracks = useParticipantTracks([Track.Source.Microphone], participant.identity);
  const { attributes } = useParticipantAttributes({ participant });
  const hasActiveMicrophone = microphoneTracks.some((track) => !track.publication.isMuted);
  const micOff = !hasActiveMicrophone || (participant.isLocal && !media.microphoneEnabled);
  const deafened = participant.isLocal ? media.deafened : attributes?.["coherent.deafened"] === "true";
  if (!micOff && !deafened) return null;
  return <span className={`call-participant-status ${inline ? "call-participant-status-inline" : ""}`}>
    {micOff && <span title="Микрофон выключен" aria-label="Микрофон выключен"><MicOff size={14} /></span>}
    {deafened && <span title="Не слышит собеседников" aria-label="Не слышит собеседников"><VolumeX size={14} /></span>}
  </span>;
}

function VideoWithResolution({ trackRef, onAspectRatioChange }: {
  trackRef: NonNullable<ComponentProps<typeof VideoTrack>["trackRef"]>;
  onAspectRatioChange?: (ratio: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onAspectRatioChangeRef = useRef(onAspectRatioChange);
  onAspectRatioChangeRef.current = onAspectRatioChange;
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      setResolution((previous) => previous?.width === width && previous.height === height
        ? previous : width && height ? { width, height } : null);
      if (width && height) onAspectRatioChangeRef.current?.(width / height);
    };
    video.addEventListener("resize", update);
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("emptied", update);
    update();
    const timer = window.setInterval(update, 2000);
    return () => {
      video.removeEventListener("resize", update);
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("emptied", update);
      window.clearInterval(timer);
    };
  }, [trackRef.publication.track?.mediaStreamTrack.id]);

  return <>
    <VideoTrack trackRef={trackRef} ref={videoRef} />
    {resolution && <span className="call-tile-resolution" title="Разрешение отображаемого видео">{resolution.width}×{resolution.height}</span>}
  </>;
}

function ParticipantTile({ participant, camera, volume, onVolumeOpen, media }: {
  participant: Participant;
  camera: ComponentProps<typeof VideoTrack>["trackRef"] | undefined;
  volume: number;
  onVolumeOpen: () => void;
  media: MediaPreferences;
}) {
  const isSpeaking = useFastSpeaking(participant);
  const label = participant.isLocal ? "Ты" : participant.name || "Участник";
  return (
    <div className={`call-tile ${isSpeaking ? "call-tile-speaking" : ""}`} onContextMenu={participant.isLocal ? undefined : (event) => { event.preventDefault(); onVolumeOpen(); }}>
      {camera ? <VideoWithResolution trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
      <ParticipantStatus participant={participant} media={media} />
      <span className="call-tile-name">{label}</span>
      {!participant.isLocal && (
        <button type="button" className="call-tile-volume-button" onClick={onVolumeOpen} title={`Громкость: ${label}`} aria-label={`Громкость: ${label}`}>
          {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      )}
    </div>
  );
}

function useFastSpeaking(participant: Participant): boolean {
  const serverSpeaking = useIsSpeaking(participant);
  const microphone = useParticipantTracks([Track.Source.Microphone], participant.identity)[0]?.publication.track?.mediaStreamTrack;
  const [localSpeaking, setLocalSpeaking] = useState(false);
  useEffect(() => {
    setLocalSpeaking(false);
    if (!microphone || microphone.readyState !== "live") return;
    const context = acquireSpeechContext();
    const source = context.createMediaStreamSource(new MediaStream([microphone]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let lastVoice = 0;
    void context.resume().catch(() => undefined);
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const sample of samples) power += sample * sample;
      const rms = Math.sqrt(power / samples.length);
      if (rms > 0.012) lastVoice = performance.now();
      setLocalSpeaking(performance.now() - lastVoice < 180);
    }, 60);
    return () => {
      window.clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      releaseSpeechContext(context);
    };
  }, [microphone]);
  return localSpeaking || serverSpeaking;
}

function SidebarParticipant({ participant, camera, volume, onVolumeChange, media }: {
  participant: Participant;
  camera: ComponentProps<typeof VideoTrack>["trackRef"] | undefined;
  volume: number;
  onVolumeChange: (userId: string, volume: number) => void;
  media: MediaPreferences;
}) {
  const isSpeaking = useFastSpeaking(participant);
  const label = participant.isLocal ? "Ты" : participant.name || "Участник";
  return <div className={`call-sidebar-person ${isSpeaking ? "call-sidebar-person-speaking" : ""}`}>
    <div className="call-sidebar-preview">
      {camera ? <VideoTrack trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
    </div>
    <div className="call-sidebar-person-heading">
      <span className="call-sidebar-person-name">{label}</span>
      <ParticipantStatus participant={participant} media={media} inline />
    </div>
    {!participant.isLocal && <label className="call-sidebar-volume">
      <span>{volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />} {volume}%</span>
      <input aria-label={`Громкость: ${label}`} type="range" min="0" max="200" value={volume} onChange={(event) => onVolumeChange(participant.identity, Number(event.target.value))} />
    </label>}
  </div>;
}

function FocusedScreen({ trackRef, style, label, volumeButton, onAspectRatioChange }: {
  trackRef: NonNullable<ComponentProps<typeof VideoTrack>["trackRef"]>;
  style: CSSProperties;
  label: string;
  volumeButton: ReactNode;
  onAspectRatioChange: (ratio: number) => void;
}) {
  return <div className="call-tile call-tile-screen" style={style}>
    <VideoWithResolution trackRef={trackRef} onAspectRatioChange={onAspectRatioChange} />
    <span className="call-tile-name">{label}</span>
    {volumeButton}
  </div>;
}

function CallStage({ call, mode, onModeChange, density, volumes, onVolumeChange, screenVolumes, onScreenVolumeChange, media }: {
  call: Call;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  density: TileDensity;
  volumes: Record<string, number>;
  onVolumeChange: (userId: string, volume: number) => void;
  screenVolumes: Record<string, number>;
  onScreenVolumeChange: (userId: string, volume: number) => void;
  media: MediaPreferences;
}) {
  const participants = useParticipants();
  const [volumeOpenFor, setVolumeOpenFor] = useState<{ userId: string; source: "microphone" | "screen" } | null>(null);
  const [selectedScreenOwner, setSelectedScreenOwner] = useState<string | null>(null);
  const [screenAspectRatios, setScreenAspectRatios] = useState<Record<string, number>>({});
  const previousScreenCount = useRef(0);
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const screens = tracks.filter((track) => track.source === Track.Source.ScreenShare);
  const screen = screens.find((track) => track.participant.identity === selectedScreenOwner) ?? screens[0];
  const focusedScreenTrackId = screen?.publication.track?.mediaStreamTrack.id ?? screen?.participant.identity;
  const focusedScreenAspect = focusedScreenTrackId ? screenAspectRatios[focusedScreenTrackId] ?? 16 / 9 : 16 / 9;
  const focusedScreenStyle = {
    "--call-screen-aspect": focusedScreenAspect,
    "--call-screen-width": `${focusedScreenAspect * 100}cqh`,
    "--call-screen-sidebar-width": `${focusedScreenAspect * 144}px`,
  } as CSSProperties;
  const invited = call.participants.filter((member) =>
    member.state === "invited" && !participants.some((participant) => participant.identity === member.user_id)
  );
  const tileCount = screens.length + participants.length + invited.length;
  const denseClass = density === "compact" ? "call-stage-dense" : "";
  const selectedVolumeParticipant = participants.find((participant) => participant.identity === volumeOpenFor?.userId);

  useEffect(() => {
    if (previousScreenCount.current === 0 && screens.length > 0) onModeChange("focus");
    previousScreenCount.current = screens.length;
  }, [screens.length, onModeChange]);

  useEffect(() => {
    if (!volumeOpenFor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVolumeOpenFor(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [volumeOpenFor]);

  function cameraFor(participant: Participant) {
    return tracks.find((track) =>
      track.participant.identity === participant.identity && track.source === Track.Source.Camera
        && !track.publication.isMuted && track.publication.track?.mediaStreamTrack.readyState === "live"
    );
  }

  function tile(participant: Participant) {
    return <ParticipantTile
      key={participant.identity}
      participant={participant}
      camera={cameraFor(participant)}
      volume={volumes[participant.identity] ?? 100}
      media={media}
      onVolumeOpen={() => setVolumeOpenFor({ userId: participant.identity, source: "microphone" })}
    />;
  }

  function invitedTile(member: Call["participants"][number]) {
    return (
      <div className="call-tile call-tile-waiting" key={member.user_id}>
        <span className="call-tile-avatar">{displayName(member).slice(0, 1).toUpperCase()}</span>
        <span className="call-tile-name">{displayName(member)}</span>
        <span className="call-waiting-label">Приглашён</span>
      </div>
    );
  }

  function screenLabel(owner: Participant) {
    return owner.isLocal ? "Твой экран" : `Экран: ${owner.name || "участник"}`;
  }

  const sidebar = (
    <div className="call-stage-sidebar">
      {screens.length > 1 && <div className="call-share-picker">
        <strong>Трансляции</strong>
        {screens.map((item) => <button
          key={item.participant.identity}
          className={screen?.participant.identity === item.participant.identity ? "active" : ""}
          onClick={() => setSelectedScreenOwner(item.participant.identity)}
        >{screenLabel(item.participant)}</button>)}
      </div>}
      <strong className="call-sidebar-heading">Участники</strong>
      {participants.map((participant) => <SidebarParticipant key={participant.identity} participant={participant} camera={cameraFor(participant)} volume={volumes[participant.identity] ?? 100} onVolumeChange={onVolumeChange} media={media} />)}
      {invited.map((member) => <div className="call-sidebar-invited" key={member.user_id}>{displayName(member)} · приглашён</div>)}
    </div>
  );

  const screenVolumeSelected = volumeOpenFor?.source === "screen";
  const selectedVolume = selectedVolumeParticipant && (screenVolumeSelected
    ? screenVolumes[selectedVolumeParticipant.identity] ?? 100
    : volumes[selectedVolumeParticipant.identity] ?? 100);
  const volumePanel = selectedVolumeParticipant && <aside className={`call-volume-popover ${screenVolumeSelected ? "call-volume-popover-screen" : ""}`} aria-label={`${screenVolumeSelected ? "Громкость демонстрации" : "Громкость"}: ${selectedVolumeParticipant.name || "участник"}`}>
    <div className="call-volume-popover-heading">
      <strong>{screenVolumeSelected ? screenLabel(selectedVolumeParticipant) : selectedVolumeParticipant.name || "Участник"}</strong>
      <button onClick={() => setVolumeOpenFor(null)} aria-label="Закрыть громкость"><X size={16} /></button>
    </div>
    <label>
      {screenVolumeSelected ? "Громкость демонстрации" : "Громкость"}: {selectedVolume}%
      <input type="range" min="0" max={screenVolumeSelected ? "100" : "200"} value={selectedVolume} onChange={(event) => {
        const change = screenVolumeSelected ? onScreenVolumeChange : onVolumeChange;
        change(selectedVolumeParticipant.identity, Number(event.target.value));
      }} />
    </label>
  </aside>;

  function screenVolumeButton(owner: Participant) {
    if (owner.isLocal) return null;
    const volume = screenVolumes[owner.identity] ?? 100;
    const label = screenLabel(owner);
    return <button type="button" className="call-screen-volume-button" onClick={() => setVolumeOpenFor({ userId: owner.identity, source: "screen" })} title={`Громкость демонстрации: ${label}`} aria-label={`Громкость демонстрации: ${label}`}>
      {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </button>;
  }

  if (screen && mode === "focus") {
    return <>
      <div className={`call-stage call-stage-sharing ${denseClass}`}>
        <FocusedScreen trackRef={screen} style={focusedScreenStyle} label={screenLabel(screen.participant)} volumeButton={screenVolumeButton(screen.participant)} onAspectRatioChange={(ratio) => setScreenAspectRatios((current) => current[focusedScreenTrackId!] === ratio ? current : { ...current, [focusedScreenTrackId!]: ratio })} />
        {sidebar}
      </div>
      {volumePanel}
    </>;
  }

  if (screens.length > 0) {
    return <>
      <div className={`call-stage call-stage-grid call-stage-with-screens ${denseClass} ${tileCount > 2 ? "call-stage-group" : ""} ${tileCount > 4 ? "call-stage-many" : ""}`}>
        {screens.map((item) => <div className="call-tile call-tile-screen" key={`screen-${item.participant.identity}`}>
          <VideoWithResolution trackRef={item} />
          <span className="call-tile-name">{screenLabel(item.participant)}</span>
          {screenVolumeButton(item.participant)}
          <button className="call-screen-focus-button" onClick={() => { setSelectedScreenOwner(item.participant.identity); onModeChange("focus"); }} aria-label={`Крупно: ${screenLabel(item.participant)}`}>Открыть крупно</button>
        </div>)}
        {participants.map(tile)}
        {invited.map(invitedTile)}
      </div>
      {volumePanel}
    </>;
  }

  const focused = mode === "focus"
    ? participants.find((participant) => participant.isSpeaking && !participant.isLocal)
      ?? participants.find((participant) => !participant.isLocal)
      ?? participants[0]
    : undefined;
  if (focused && participants.length > 1) {
    return <>
      <div className={`call-stage call-stage-sharing ${denseClass}`}>
        {tile(focused)}
        {sidebar}
      </div>
      {volumePanel}
    </>;
  }

  return <>
    <div className={`call-stage call-stage-grid ${denseClass} ${participants.length + invited.length > 2 ? "call-stage-group" : ""} ${participants.length + invited.length > 4 ? "call-stage-many" : ""}`}>
      {participants.map(tile)}
      {invited.map(invitedTile)}
    </div>
    {volumePanel}
  </>;
}
