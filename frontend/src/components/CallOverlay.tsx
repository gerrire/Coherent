import { useEffect, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useParticipants,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import { Camera, Mic, MonitorUp, Phone, PhoneOff } from "lucide-react";
import { Track } from "livekit-client";
import { api, type Call, type CallJoin } from "../lib/api";

interface CallOverlayProps {
  call: Call;
  currentUserId: string;
  error: string;
  pending: boolean;
  onAccept: () => void;
  onEnd: () => void;
}

export default function CallOverlay({
  call,
  currentUserId,
  error,
  pending,
  onAccept,
  onEnd,
}: CallOverlayProps) {
  const incoming = call.callee_id === currentUserId;
  const peer = incoming ? call.caller_username : call.callee_username;

  return (
    <div className="call-backdrop" role="dialog" aria-modal="true" aria-label={`Звонок с ${peer}`}>
      <div className={`call-card ${call.status === "active" ? "call-card-active" : ""}`}>
        {call.status === "ringing" ? (
          <div className="call-ringing">
            <span className="call-avatar">{peer.slice(0, 1).toUpperCase()}</span>
            <span className="call-eyebrow">{incoming ? "ВХОДЯЩИЙ ЗВОНОК" : "ИСХОДЯЩИЙ ЗВОНОК"}</span>
            <h2>{peer}</h2>
            <p>{incoming ? "Хочет поговорить с тобой" : "Ожидаем ответа..."}</p>
            {error && <p className="call-error" role="alert">{error}</p>}
            <div className="call-actions">
              {incoming && (
                <button className="call-accept" onClick={onAccept} disabled={pending}>
                  <Phone size={18} /> Принять
                </button>
              )}
              <button className="call-end" onClick={onEnd} disabled={pending}>
                <PhoneOff size={18} /> {incoming ? "Отклонить" : "Отменить"}
              </button>
            </div>
          </div>
        ) : (
          <div className="call-active-layout">
            <div className="call-active-header">
              <div>
                <span className="call-eyebrow">ЛИЧНЫЙ ЗВОНОК</span>
                <h2>{peer}</h2>
              </div>
              <span className="call-live-pill"><i /> На связи</span>
            </div>
            <CallRoom call={call} peer={peer} onEnd={onEnd} pending={pending} />
            {error && <p className="call-error" role="alert">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function CallRoom({
  call,
  peer,
  onEnd,
  pending,
}: {
  call: Call;
  peer: string;
  onEnd: () => void;
  pending: boolean;
}) {
  const [join, setJoin] = useState<CallJoin | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.joinCall(call.id).then((result) => {
      if (active) setJoin(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось подключиться к звонку.");
    });
    return () => { active = false; };
  }, [call.id]);

  if (error) {
    return <div className="call-connection-error" role="alert">{error}<button onClick={onEnd}>Завершить</button></div>;
  }
  if (!join) return <div className="call-connecting">Подключаем звонок...</div>;

  return (
    <LiveKitRoom
      serverUrl={join.server_url}
      token={join.token}
      connect
      audio
      video={false}
      onError={(reason) => setError(reason.message)}
    >
      <RoomAudioRenderer />
      <StartAudio label="Включить звук" />
      <CallStage peer={peer} />
      <div className="call-controls">
        <TrackToggle source={Track.Source.Microphone} showIcon={false} className="call-control">
          <Mic size={17} /> Микрофон
        </TrackToggle>
        <TrackToggle source={Track.Source.Camera} showIcon={false} className="call-control">
          <Camera size={17} /> Камера
        </TrackToggle>
        <TrackToggle
          source={Track.Source.ScreenShare}
          captureOptions={{ audio: true }}
          showIcon={false}
          className="call-control"
        >
          <MonitorUp size={17} /> Экран
        </TrackToggle>
        <button className="call-end" onClick={onEnd} disabled={pending}>
          <PhoneOff size={17} /> Завершить
        </button>
      </div>
    </LiveKitRoom>
  );
}

function CallStage({ peer }: { peer: string }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);

  return (
    <div className="call-stage">
      {participants.map((participant) => {
        const published = tracks.filter((track) => track.participant.identity === participant.identity);
        const video = published.find((track) => track.source === Track.Source.ScreenShare)
          ?? published.find((track) => track.source === Track.Source.Camera);
        const label = participant.isLocal ? "Ты" : participant.name || peer;
        return (
          <div className="call-participant" key={participant.identity}>
            {video ? <VideoTrack trackRef={video} /> : <span className="call-participant-avatar">{label.slice(0, 1).toUpperCase()}</span>}
            <span className="call-participant-name">{label}{video?.source === Track.Source.ScreenShare ? " · экран" : ""}</span>
          </div>
        );
      })}
      {participants.length < 2 && <div className="call-waiting">Ожидаем второго участника...</div>}
    </div>
  );
}
