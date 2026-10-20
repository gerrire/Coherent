import { useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useLocalParticipant,
  useParticipants,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import {
  Camera,
  CameraOff,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Phone,
  PhoneOff,
} from "lucide-react";
import { Track } from "livekit-client";
import { api, type Call, type CallJoin } from "../lib/api";

interface CallPanelProps {
  call: Call;
  currentUserId: string;
  compact: boolean;
  error: string;
  pending: boolean;
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
  onAccept,
  onEnd,
  onFocus,
}: CallPanelProps) {
  const incoming = call.callee_id === currentUserId;
  const peer = incoming ? call.caller_username : call.callee_username;
  const panelRef = useRef<HTMLElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isViewportFullscreen, setIsViewportFullscreen] = useState(false);

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

  if (call.status === "ringing") {
    return (
      <aside className="call-invite" aria-label={`Звонок с ${peer}`}>
        <div className="call-invite-avatar">{peer.slice(0, 1).toUpperCase()}</div>
        <div className="call-invite-copy">
          <span>{incoming ? "ВХОДЯЩИЙ ЗВОНОК" : "ИСХОДЯЩИЙ ЗВОНОК"}</span>
          <strong>{peer}</strong>
          <small>{incoming ? "Хочет поговорить с тобой" : "Ожидаем ответа..."}</small>
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
    <section ref={panelRef} className={`call-surface ${compact ? "call-surface-compact" : "call-surface-expanded"} ${isViewportFullscreen ? "call-surface-maximized" : ""}`} aria-label={`Разговор с ${peer}`}>
      <CallRoom call={call} peer={peer} compact={compact} isFullscreen={isFullscreen || isViewportFullscreen} onFocus={onFocus} onToggleFullscreen={() => void toggleFullscreen()} onEnd={onEnd} pending={pending} />
      {error && <p className="call-surface-error" role="alert">{error}</p>}
    </section>
  );
}

function CallRoom({
  call,
  peer,
  compact,
  isFullscreen,
  onFocus,
  onToggleFullscreen,
  onEnd,
  pending,
}: {
  call: Call;
  peer: string;
  compact: boolean;
  isFullscreen: boolean;
  onFocus: () => void;
  onToggleFullscreen: () => void;
  onEnd: () => void;
  pending: boolean;
}) {
  const [join, setJoin] = useState<CallJoin | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [seconds, setSeconds] = useState(0);

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
  const header = (
    <div className="call-surface-header">
      <span className={`call-connected-dot ${error ? "is-error" : connected ? "is-connected" : ""}`} aria-hidden="true" />
      <div className="call-surface-title">
        <strong>{peer}</strong>
        <small>{error || (connected ? `Голосовая связь · ${time}` : "Подключение...")}</small>
      </div>
      {compact && (
        <button className="call-focus-button" onClick={onFocus} aria-label="Вернуться к беседе со звонком" title="Вернуться к беседе">
          <MessageCircle size={17} />
        </button>
      )}
      {!compact && (
        <button className="call-focus-button" onClick={onToggleFullscreen} aria-label={isFullscreen ? "Выйти из полноэкранного режима" : "Открыть звонок на весь экран"} title={isFullscreen ? "Выйти из полноэкранного режима" : "На весь экран"}>
          {isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      )}
    </div>
  );

  if (error) {
    return <>{header}<div className="call-connect-error" role="alert">{error}<button onClick={onEnd}>Завершить</button></div></>;
  }
  if (!join) return <>{header}<div className="call-connect-note">Подключаем звонок...</div></>;

  return (
    <LiveKitRoom
      serverUrl={join.server_url}
      token={join.token}
      connect
      audio
      video={false}
      onConnected={() => setConnected(true)}
      onDisconnected={() => setConnected(false)}
      onError={(reason) => setError(reason.message)}
    >
      <RoomAudioRenderer />
      {header}
      <CallStage peer={peer} />
      <div className="call-surface-controls">
        <StartAudio className="call-start-audio" label="Включить звук" />
        <CallControls onEnd={onEnd} pending={pending} />
      </div>
    </LiveKitRoom>
  );
}

function CallControls({ onEnd, pending }: { onEnd: () => void; pending: boolean }) {
  const { isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  return (
    <div className="call-control-group">
      <TrackToggle source={Track.Source.Microphone} showIcon={false} className="call-control" aria-label={isMicrophoneEnabled ? "Выключить микрофон" : "Включить микрофон"} title={isMicrophoneEnabled ? "Выключить микрофон" : "Включить микрофон"}>
        {isMicrophoneEnabled ? <Mic size={20} /> : <MicOff size={20} />}
      </TrackToggle>
      <TrackToggle source={Track.Source.Camera} showIcon={false} className="call-control call-control-camera" aria-label={isCameraEnabled ? "Выключить камеру" : "Включить камеру"} title={isCameraEnabled ? "Выключить камеру" : "Включить камеру"}>
        {isCameraEnabled ? <Camera size={20} /> : <CameraOff size={20} />}
      </TrackToggle>
      <TrackToggle source={Track.Source.ScreenShare} captureOptions={{ audio: true }} showIcon={false} className="call-control call-control-screen" aria-label={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"} title={isScreenShareEnabled ? "Остановить показ экрана" : "Показать экран"}>
        <MonitorUp size={20} />
      </TrackToggle>
      <button className="call-control call-control-end" onClick={onEnd} disabled={pending} aria-label="Завершить звонок" title="Завершить звонок">
        <PhoneOff size={20} />
      </button>
    </div>
  );
}

function CallStage({ peer }: { peer: string }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const screen = tracks.find((track) => track.source === Track.Source.ScreenShare);

  if (screen) {
    return (
      <div className="call-stage call-stage-sharing">
        <div className="call-tile call-tile-screen">
          <VideoTrack trackRef={screen} />
          <span className="call-tile-name">{screen.participant.isLocal ? "Твой экран" : `Экран: ${screen.participant.name || peer}`}</span>
        </div>
        <div className="call-stage-strip">
          {participants.map((participant) => {
            const camera = tracks.find((track) => track.participant.identity === participant.identity && track.source === Track.Source.Camera);
            const label = participant.isLocal ? "Ты" : participant.name || peer;
            return (
              <div className={`call-tile ${participant.isSpeaking ? "call-tile-speaking" : ""}`} key={participant.identity}>
                {camera ? <VideoTrack trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
                <span className="call-tile-name">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="call-stage">
      {participants.map((participant) => {
        const camera = tracks.find((track) => track.participant.identity === participant.identity && track.source === Track.Source.Camera);
        const label = participant.isLocal ? "Ты" : participant.name || peer;
        return (
          <div className={`call-tile ${participant.isSpeaking ? "call-tile-speaking" : ""}`} key={participant.identity}>
            {camera ? <VideoTrack trackRef={camera} /> : <span className="call-tile-avatar">{label.slice(0, 1).toUpperCase()}</span>}
            <span className="call-tile-name">{label}</span>
          </div>
        );
      })}
      {participants.length < 2 && (
        <div className="call-tile call-tile-waiting">
          <span className="call-tile-avatar">{peer.slice(0, 1).toUpperCase()}</span>
          <span className="call-tile-name">{peer}</span>
          <span className="call-waiting-label">Ожидаем подключения...</span>
        </div>
      )}
    </div>
  );
}
