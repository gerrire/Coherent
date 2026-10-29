import { useEffect, useState } from "react";
import { Track, type Room } from "livekit-client";
import { microphoneCapture, microphoneError, type MediaPreferences } from "../lib/media";
import { resumeAudioContext } from "../lib/audioContext";
import type { MicrophoneProcessor } from "../lib/microphoneProcessor";
import { createAudioLoopback } from "../lib/audioLoopback";

export default function MicrophoneCheck({ media, room }: { media: MediaPreferences; room?: Room | null }) {
  const [checking, setChecking] = useState(false);
  const [level, setLevel] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [sentBytes, setSentBytes] = useState(0);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!checking) return;
    let active = true;
    let context: AudioContext | undefined;
    let ownedStream: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let inputSource: MediaStreamAudioSourceNode | undefined;
    let inputAnalyser: AnalyserNode | undefined;
    let processor: MicrophoneProcessor | undefined;
    let processingSkipped = false;
    let loopback: Awaited<ReturnType<typeof createAudioLoopback>> | undefined;
    const abort = new AbortController();
    let interval = 0;
    let deadline = 0;
    const cleanup = () => {
      window.clearInterval(interval); window.clearTimeout(deadline);
      abort.abort(); loopback?.close();
      source?.disconnect(); analyser?.disconnect();
      inputSource?.disconnect(); inputAnalyser?.disconnect();
      void processor?.destroy().catch(() => undefined);
      ownedStream?.getTracks().forEach(track => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
    };
    async function start() {
      setStatus("Подключаем микрофон…"); setLevel(0); setInputLevel(0); setSentBytes(0);
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
      inputSource = context.createMediaStreamSource(new MediaStream([track]));
      inputAnalyser = context.createAnalyser(); inputAnalyser.fftSize = 1024;
      inputSource.connect(inputAnalyser);
      if (ownedStream) {
        const rawTrack = track;
        const { MicrophoneProcessor } = await import("../lib/microphoneProcessor");
        loopback = await createAudioLoopback(track, abort.signal);
        if (!active) { cleanup(); return; }
        // Exercise the same DSP graph used by calls, not a separate raw-input meter.
        processor = new MicrophoneProcessor(media.microphoneVolume, media.noiseSuppression ? "noisy" : "soft", media.noiseProcessor, media.rnnoisePreset);
        try {
          await processor.init({ kind: Track.Kind.Audio, track, audioContext: context });
          track = processor.processedTrack ?? track;
          await loopback.replaceTrack(track);
        } catch {
          await processor.destroy(); processor = undefined;
          await loopback.replaceTrack(rawTrack);
          processingSkipped = true;
          // Calls use the live source too if optional DSP cannot initialize.
        }
        if (!active) { cleanup(); return; }
        track = loopback.track;
      }
      source = context.createMediaStreamSource(new MediaStream([track]));
      analyser = context.createAnalyser(); analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const inputSamples = new Float32Array(1024);
      let detected = false;
      let samplesRead = 0;
      const started = Date.now();
      setStatus("Скажи несколько слов. Проверка не воспроизводит звук в динамиках.");
      interval = window.setInterval(() => {
        if (!analyser || !active) return;
        analyser.getFloatTimeDomainData(samples);
        inputAnalyser?.getFloatTimeDomainData(inputSamples);
        const inputRms = Math.sqrt(inputSamples.reduce((sum, sample) => sum + sample * sample, 0) / inputSamples.length);
        setInputLevel(Math.min(100, Math.round(inputRms * 600)));
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const value = Math.min(100, Math.round(rms * 600));
        if (++samplesRead % 10 === 0 && loopback) void loopback.sentBytes()
          .then(bytes => { if (active) setSentBytes(bytes); }).catch(() => undefined);
        setLevel(value);
        if (value > 2) {
          detected = true;
          setStatus(live ? "Сигнал отправляемой дорожки звонка поступает." : processingSkipped || processor?.usesFallback()
            ? "Звук передаётся. Неисправное шумоподавление автоматически обойдено."
            : "Звук проходит обработку и локальную передачу WebRTC.");
        }
        else if (!detected && Date.now() - started > 5000) setStatus("Сигнал не обнаружен. Проверь кнопку mute на микрофоне, устройство и разрешения Windows.");
      }, 100);
      if (loopback) void loopback.sentBytes().then(bytes => { if (active) setSentBytes(bytes); }).catch(() => undefined);
      deadline = window.setTimeout(() => { setChecking(false); setStatus(detected ? "Проверка завершена: звук поступает." : "Звука нет. Выбери другой вход или проверь микрофон в настройках Windows."); }, 20_000);
    }
    void start().catch(error => { if (active) { setStatus(microphoneError(error)); setChecking(false); } cleanup(); });
    return () => { active = false; cleanup(); };
    // A changed input stops the previous capture before starting another one.
  }, [checking, media.microphoneId, media.microphoneVolume, media.noiseProcessor, media.noiseSuppression, media.rnnoisePreset, room]);

  return <div className="microphone-check">
    <button type="button" onClick={() => setChecking(current => !current)}>{checking ? "Остановить проверку" : "Проверить микрофон"}</button>
    <small>Вход микрофона</small><meter min={0} max={100} value={checking ? inputLevel : 0} aria-label="Уровень микрофона" />
    <small>{room ? "Отправляемая дорожка" : "После обработки и WebRTC"}</small><meter min={0} max={100} value={checking ? level : 0} aria-label="Уровень передаваемого звука" />
    {sentBytes > 0 && <small>Локальные аудиопакеты: {sentBytes} байт.</small>}
    {status && <small role="status">{status}</small>}
  </div>;
}
