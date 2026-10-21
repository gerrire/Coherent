import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  AudioTrack,
  LiveKitRoom,
  StartAudio,
  TrackToggle,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import {
  Camera,
  CameraOff,
  LayoutGrid,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Phone,
  PhoneOff,
  Settings2,
  UserPlus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { AudioPresets, ConnectionQuality, RoomEvent, Track, type Participant, type Room } from "livekit-client";
import { api, type Call, type CallJoin } from "../lib/api";
import {
  cameraCapture,
  cameraPublish,
  microphoneCapture,
  screenShareCapture,
  screenSharePublish,
  type AudioProcessingState,
  type MediaPreferences,
} from "../lib/media";
import MediaSettingsPanel from "./MediaSettingsPanel";
import ParticipantPicker from "./ParticipantPicker";
import { applyMicrophoneProcessing } from "../lib/microphoneProcessor";

type ViewMode = "grid" | "focus";
type TileDensity = "normal" | "compact";
const VOLUME_STORAGE_KEY = "coherent-participant-volumes";

function loadParticipantVolumes(): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(VOLUME_STORAGE_KEY) || "{}") as Record<string, number>;
    return Object.fromEntries(Object.entries(stored).filter(([id, value]) =>
      id.length > 0 && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 200
    ));
  } catch {
    return {};
  }
}

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
  onFocus,
}: CallPanelProps) {
  const self = call.participants.find((participant) => participant.user_id === currentUserId);
  const incoming = self?.state === "invited";
  const reconnectable = call.status === "active" && self?.state === "left";
  const group = isGroupConversation || call.participants.length > 2;
  const peer = call.caller_id === currentUserId ? call.callee_username : call.caller_username;
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
          <strong>{incoming ? call.caller_username : title}</strong>
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
  onToggleFullscreen,
  onToggleView,
  onToggleSettings,
  onInvite,
  canInvite,
  onEnd,
  pending,
}: {
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
  onToggleFullscreen: () => void;
  onToggleView: () => void;
  onToggleSettings: () => void;
  onInvite: () => void;
  canInvite: boolean;
  onEnd: () => void;
  pending: boolean;
}) {
  const [join, setJoin] = useState<CallJoin | null>(null);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [connected, setConnected] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [participantVolumes, setParticipantVolumes] = useState(loadParticipantVolumes);
  const roomOptions = useMemo(() => ({
    adaptiveStream: true,
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

  function changeParticipantVolume(userId: string, volume: number) {
    setParticipantVolumes((current) => ({ ...current, [userId]: volume }));
  }

  useEffect(() => {
    let active = true;
    api.joinCall(call.id).then((result) => {
      if (active) setJoin(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось подключиться к звонку.");
    });
    return () => { active = false; };
  }, [call.id]);

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
      {compact ? (
        <button className="call-focus-button" onClick={onFocus} aria-label="Вернуться к беседе со звонком" title="Вернуться к беседе">
          <MessageCircle size={17} />
        </button>
      ) : (
        <div className="call-header-tools">
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
    return <>{header}<div className="call-connect-error" role="alert">{error}<button onClick={onEnd}>Выйти</button></div></>;
  }
  if (!join) return <>{header}<div className="call-connect-note">Подключаем звонок...</div></>;

  return (
    <LiveKitRoom
      serverUrl={join.server_url}
      token={join.token}
      connect
      audio={false}
      video={false}
      options={roomOptions}
      onConnected={() => setConnected(true)}
      onDisconnected={() => setConnected(false)}
      onError={(reason) => setError(reason.message)}
    >
      <CallMediaBridge connected={connected} media={media} onRoomReady={onRoomReady} onError={setMediaError} />
      <CallAudioRenderer muted={media.deafened} volumes={participantVolumes} />
      {header}
      <CallConnectionNotice />
      <CallStage call={call} mode={viewMode} onModeChange={onModeChange} density={tileDensity} volumes={participantVolumes} onVolumeChange={changeParticipantVolume} />
      <div className="call-surface-controls">
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
      if (selected.microphoneEnabled) {
        await room.localParticipant.setMicrophoneEnabled(true, microphoneCapture(selected));
        await applyMicrophoneProcessing(room, selected.microphoneVolume, selected.strongNoiseSuppression ? "strong" : selected.noiseSuppression ? "off" : "soft");
      }
      if (selected.cameraEnabled) {
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

  const protectScreenAudio = useCallback(() => {
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
    room.on(RoomEvent.LocalTrackPublished, protectScreenAudio);
    return () => { room.off(RoomEvent.LocalTrackPublished, protectScreenAudio); };
  }, [room, protectScreenAudio]);

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
      <TrackToggle source={Track.Source.ScreenShare} captureOptions={screenShareCapture(media)} publishOptions={screenSharePublish(media)} showIcon={false} className="call-control call-control-screen" aria-label={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} title={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} onDeviceError={(reason) => onError(reason.message)} onChange={onScreenShareChange} onClick={() => onError("")}>
        <MonitorUp size={20} />
      </TrackToggle>
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
  return <p className="call-network-notice">Связь нестабильна: звук может прерываться. Если идёт демонстрация, попробуй режим 720p в настройках видео.</p>;
}

function CallAudioRenderer({ muted, volumes }: { muted: boolean; volumes: Record<string, number> }) {
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio], { onlySubscribed: true });
  return <>{tracks.filter((track) => !track.participant.isLocal).map((track) => (
    <AudioTrack
      key={`${track.participant.identity}-${track.source}`}
      trackRef={track}
      volume={muted ? 0 : (volumes[track.participant.identity] ?? 100) / 100}
    />
  ))}</>;
}

function ParticipantTile({ participant, camera, volume, onVolumeOpen }: {
  participant: Participant;
  camera: ComponentProps<typeof VideoTrack>["trackRef"] | undefined;
  volume: number;
  onVolumeOpen: () => void;
}) {
  const isSpeaking = useIsSpeaking(participant);
  const label = participant.isLocal ? "Ты" : participant.name || "Участник";
  return (
    <div className={`call-tile ${isSpeaking ? "call-tile-speaking" : ""}`} onContextMenu={participant.isLocal ? undefined : (event) => { event.preventDefault(); onVolumeOpen(); }}>
      {camera ? <VideoTrack trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
      <span className="call-tile-name">{label}</span>
      {!participant.isLocal && (
        <button type="button" className="call-tile-volume-button" onClick={onVolumeOpen} title={`Громкость: ${label}`} aria-label={`Громкость: ${label}`}>
          {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      )}
    </div>
  );
}

function CallStage({ call, mode, onModeChange, density, volumes, onVolumeChange }: {
  call: Call;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  density: TileDensity;
  volumes: Record<string, number>;
  onVolumeChange: (userId: string, volume: number) => void;
}) {
  const participants = useParticipants();
  const [volumeOpenFor, setVolumeOpenFor] = useState<string | null>(null);
  const [selectedScreenOwner, setSelectedScreenOwner] = useState<string | null>(null);
  const previousScreenCount = useRef(0);
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const screens = tracks.filter((track) => track.source === Track.Source.ScreenShare);
  const screen = screens.find((track) => track.participant.identity === selectedScreenOwner) ?? screens[0];
  const invited = call.participants.filter((member) =>
    member.state === "invited" && !participants.some((participant) => participant.identity === member.user_id)
  );
  const tileCount = screens.length + participants.length + invited.length;
  const denseClass = density === "compact" ? "call-stage-dense" : "";
  const selectedVolumeParticipant = participants.find((participant) => participant.identity === volumeOpenFor);

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
      onVolumeOpen={() => setVolumeOpenFor(participant.identity)}
    />;
  }

  function invitedTile(member: Call["participants"][number]) {
    return (
      <div className="call-tile call-tile-waiting" key={member.user_id}>
        <span className="call-tile-avatar">{member.username.slice(0, 1).toUpperCase()}</span>
        <span className="call-tile-name">{member.username}</span>
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
      {participants.map((participant) => {
        const label = participant.isLocal ? "Ты" : participant.name || "Участник";
        const camera = cameraFor(participant);
        const volume = volumes[participant.identity] ?? 100;
        return <div className="call-sidebar-person" key={participant.identity}>
          <div className="call-sidebar-preview">
            {camera ? <VideoTrack trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
          </div>
          <span className="call-sidebar-person-name">{label}</span>
          {!participant.isLocal && <label className="call-sidebar-volume">
            <span>{volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />} {volume}%</span>
            <input aria-label={`Громкость: ${label}`} type="range" min="0" max="200" value={volume} onChange={(event) => onVolumeChange(participant.identity, Number(event.target.value))} />
          </label>}
        </div>;
      })}
      {invited.map((member) => <div className="call-sidebar-invited" key={member.user_id}>{member.username} · приглашён</div>)}
    </div>
  );

  const volumePanel = selectedVolumeParticipant && <aside className="call-volume-popover" aria-label={`Громкость: ${selectedVolumeParticipant.name || "участник"}`}>
    <div className="call-volume-popover-heading">
      <strong>{selectedVolumeParticipant.name || "Участник"}</strong>
      <button onClick={() => setVolumeOpenFor(null)} aria-label="Закрыть громкость"><X size={16} /></button>
    </div>
    <label>
      Громкость: {volumes[selectedVolumeParticipant.identity] ?? 100}%
      <input type="range" min="0" max="200" value={volumes[selectedVolumeParticipant.identity] ?? 100} onChange={(event) => onVolumeChange(selectedVolumeParticipant.identity, Number(event.target.value))} />
    </label>
  </aside>;

  if (screen && mode === "focus") {
    return <>
      <div className={`call-stage call-stage-sharing ${denseClass}`}>
        <div className="call-tile call-tile-screen">
          <VideoTrack trackRef={screen} />
          <span className="call-tile-name">{screenLabel(screen.participant)}</span>
        </div>
        {sidebar}
      </div>
      {volumePanel}
    </>;
  }

  if (screens.length > 0) {
    return <>
      <div className={`call-stage call-stage-grid call-stage-with-screens ${denseClass} ${tileCount > 2 ? "call-stage-group" : ""} ${tileCount > 4 ? "call-stage-many" : ""}`}>
        {screens.map((item) => <div className="call-tile call-tile-screen" key={`screen-${item.participant.identity}`}>
          <VideoTrack trackRef={item} />
          <span className="call-tile-name">{screenLabel(item.participant)}</span>
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
