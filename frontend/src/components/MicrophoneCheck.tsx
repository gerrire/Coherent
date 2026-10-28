import { useEffect, useState } from "react";
import { Track, type Room } from "livekit-client";
import { microphoneCapture, microphoneError, type MediaPreferences } from "../lib/media";
import { resumeAudioContext } from "../lib/audioContext";

export default function MicrophoneCheck({ media, room }: { media: MediaPreferences; room?: Room | null }) {
  const [checking, setChecking] = useState(false);
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!checking) return;
    let active = true;
    let context: AudioContext | undefined;
    let ownedStream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let interval = 0;
    let deadline = 0;
    const cleanup = () => {
      window.clearInterval(interval); window.clearTimeout(deadline);
      source?.disconnect(); analyser?.disconnect();
      ownedStream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
    };
    async function start() {
      setStatus("Подключаем микрофон…"); setLevel(0);
      // Resume from the click before awaiting capture permissions.
      context = new AudioContext({ latencyHint: "interactive" });
      await resumeAudioContext(context);
      if (!active) return;
      const live = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      let track = live && !live.isMuted && live.mediaStreamTrack.readyState === "live" ? live.mediaStreamTrack : undefined;
      if (!track) {
        try { ownedStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneCapture(media) }); }
        catch (error) {
          if (!media.microphoneId || !(error instanceof Error) || !["NotFoundError", "OverconstrainedError"].includes(error.name)) throw error;
          ownedStream = await navigator.mediaDevices.getUserMedia({ audio: microphoneCapture({ ...media, microphoneId: "" }) });
        }
        track = ownedStream.getAudioTracks()[0];
      }
      if (!active) { cleanup(); return; }
      if (!track) throw new Error("Микрофон не передаёт звуковую дорожку.");
      source = context.createMediaStreamSource(new MediaStream([track]));
      analyser = context.createAnalyser(); analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let detected = false;
      const started = Date.now();
      setStatus("Скажи несколько слов. Проверка не воспроизводит звук в динамиках.");
      interval = window.setInterval(() => {
        if (!analyser || !active) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const value = Math.min(100, Math.round(rms * 600));
        setLevel(value);
        if (value > 2) { detected = true; setStatus(live && track === live.mediaStreamTrack ? "Сигнал дорожки звонка поступает." : "Сигнал микрофона поступает."); }
        else if (!detected && Date.now() - started > 5000) setStatus("Сигнал не обнаружен. Проверь кнопку mute на микрофоне, устройство и разрешения Windows.");
      }, 100);
      deadline = window.setTimeout(() => { setChecking(false); setStatus(detected ? "Проверка завершена: звук поступает." : "Звука нет. Выбери другой вход или проверь микрофон в настройках Windows."); }, 20_000);
    }
    void start().catch(error => { if (active) { setStatus(microphoneError(error)); setChecking(false); } cleanup(); });
    return () => { active = false; cleanup(); };
    // A changed input stops the previous capture before starting another one.
  }, [checking, media.microphoneId, room]);

  return <div className="microphone-check">
    <button type="button" onClick={() => setChecking(current => !current)}>{checking ? "Остановить проверку" : "Проверить микрофон"}</button>
    <meter min={0} max={100} value={checking ? level : 0} aria-label="Уровень микрофона" />
    {status && <small role="status">{status}</small>}
  </div>;
}
