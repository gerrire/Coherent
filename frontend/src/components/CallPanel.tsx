import { useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
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
  X,
} from "lucide-react";
import { Track, type Participant, type Room } from "livekit-client";
import { api, type Call, type CallJoin } from "../lib/api";
import {
  cameraCapture,
  microphoneCapture,
  type MediaPreferences,
} from "../lib/media";
import MediaSettingsPanel from "./MediaSettingsPanel";
import ParticipantPicker from "./ParticipantPicker";

type ViewMode = "grid" | "focus";
type TileDensity = "normal" | "compact";

interface CallPanelProps {
  call: Call;
  currentUserId: string;
  compact: boolean;
  error: string;
  pending: boolean;
  media: MediaPreferences;
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
  currentUserId,
  compact,
  error,
  pending,
  media,
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
  const group = call.participants.length > 2;
  const peer = call.caller_id === currentUserId ? call.callee_username : call.caller_username;
  const title = group ? "Групповой звонок" : peer;
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

  if (incoming || call.status === "ringing") {
    return (
      <aside className="call-invite" aria-label={`Звонок с ${peer}`}>
        <div className="call-invite-avatar">{peer.slice(0, 1).toUpperCase()}</div>
        <div className="call-invite-copy">
          <span>{incoming ? (group ? "ПРИГЛАШЕНИЕ В ГРУППУ" : "ВХОДЯЩИЙ ЗВОНОК") : "ИСХОДЯЩИЙ ЗВОНОК"}</span>
          <strong>{incoming ? call.caller_username : title}</strong>
          <small>{incoming ? (group ? `Участников: ${occupied}` : "Хочет поговорить с тобой") : "Ожидаем ответа..."}</small>
        </div>
        <div className="call-invite-actions">
          {incoming && (
            <button className="call-invite-accept" onClick={onAccept} disabled={pending} aria-label="Принять звонок" title="Принять">
              <Phone size={18} />
            </button>
          )}
          <button className="call-invite-end" onClick={onEnd} disabled={pending} aria-label={incoming ? "Отклонить звонок" : "Отменить звонок"} title={incoming ? "Отклонить" : "Отменить"}>
            <PhoneOff size={18} />
          </button>
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
        tileDensity={tileDensity}
        onRoomReady={onRoomReady}
        onMediaChange={onMediaChange}
        onFocus={onFocus}
        onToggleFullscreen={() => void toggleFullscreen()}
        onToggleView={() => setViewOpen((open) => !open)}
        onToggleSettings={onToggleSettings}
        onInvite={() => setInviteOpen(true)}
        canInvite={occupied < 10}
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
            <button className={viewMode === "focus" ? "active" : ""} onClick={() => setViewMode("focus")}>Активный участник</button>
          </div>
          <span>Размер плиток</span>
          <div className="call-view-options">
            <button className={tileDensity === "normal" ? "active" : ""} onClick={() => setTileDensity("normal")}>Обычный</button>
            <button className={tileDensity === "compact" ? "active" : ""} onClick={() => setTileDensity("compact")}>Компактный</button>
          </div>
        </div>
      )}
      {settingsOpen && !compact && <MediaSettingsPanel media={media} onChange={onMediaChange} onClose={onToggleSettings} />}
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
  const roomOptions = useMemo(() => ({ adaptiveStream: true, dynacast: true }), []);

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
      <RoomAudioRenderer muted={media.deafened} />
      {header}
      <CallStage call={call} mode={viewMode} density={tileDensity} />
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
      }
      if (selected.cameraEnabled) {
        await room.localParticipant.setCameraEnabled(
          true,
          cameraCapture(selected),
          { videoCodec: selected.videoCodec },
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
      <TrackToggle source={Track.Source.ScreenShare} captureOptions={{ audio: true }} publishOptions={{ videoCodec: media.videoCodec }} showIcon={false} className="call-control call-control-screen" aria-label={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} title={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} onDeviceError={(reason) => onError(reason.message)}>
        <MonitorUp size={20} />
      </TrackToggle>
      <button className="call-control call-control-end" onClick={onEnd} disabled={pending} aria-label="Выйти из звонка" title="Выйти из звонка">
        <PhoneOff size={20} />
      </button>
    </div>
  );
}

function CallStage({ call, mode, density }: { call: Call; mode: ViewMode; density: TileDensity }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const screen = tracks.find((track) => track.source === Track.Source.ScreenShare);
  const invited = call.participants.filter((member) =>
    member.state === "invited" && !participants.some((participant) => participant.identity === member.user_id)
  );
  const denseClass = density === "compact" ? "call-stage-dense" : "";

  function tile(participant: Participant) {
    const camera = tracks.find((track) =>
      track.participant.identity === participant.identity && track.source === Track.Source.Camera
    );
    const label = participant.isLocal ? "Ты" : participant.name || "Участник";
    return (
      <div className={`call-tile ${participant.isLocal ? "call-tile-local" : "call-tile-remote"} ${participant.isSpeaking ? "call-tile-speaking" : ""}`} key={participant.identity}>
        {camera ? <VideoTrack trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
        <span className="call-tile-name">{label}</span>
      </div>
    );
  }

  function invitedTile(member: Call["participants"][number]) {
    return (
      <div className="call-tile call-tile-remote call-tile-waiting" key={member.user_id}>
        <span className="call-tile-avatar">{member.username.slice(0, 1).toUpperCase()}</span>
        <span className="call-tile-name">{member.username}</span>
        <span className="call-waiting-label">Приглашён</span>
      </div>
    );
  }

  if (screen) {
    return (
      <div className={`call-stage call-stage-sharing ${denseClass}`}>
        <div className={`call-tile call-tile-screen ${screen.participant.isLocal ? "call-tile-local" : "call-tile-remote"}`}>
          <VideoTrack trackRef={screen} />
          <span className="call-tile-name">{screen.participant.isLocal ? "Твой экран" : `Экран: ${screen.participant.name || "участник"}`}</span>
        </div>
        <div className="call-stage-strip">
          {participants.map(tile)}
          {invited.map(invitedTile)}
        </div>
      </div>
    );
  }

  const focused = mode === "focus"
    ? participants.find((participant) => participant.isSpeaking && !participant.isLocal)
      ?? participants.find((participant) => !participant.isLocal)
      ?? participants[0]
    : undefined;
  if (focused && participants.length > 1) {
    return (
      <div className={`call-stage call-stage-sharing ${denseClass}`}>
        {tile(focused)}
        <div className="call-stage-strip">
          {participants.filter((participant) => participant.identity !== focused.identity).map(tile)}
          {invited.map(invitedTile)}
        </div>
      </div>
    );
  }

  return (
    <div className={`call-stage call-stage-grid ${denseClass} ${participants.length + invited.length > 2 ? "call-stage-group" : ""}`}>
      {participants.map(tile)}
      {invited.map(invitedTile)}
    </div>
  );
}
