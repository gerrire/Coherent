import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Exercise the same HTMLAudioElement + received WebRTC track used by a call,
// rather than only playing a local WebAudio oscillator. No microphone/network.
export async function checkCallAudioIsolation(): Promise<string> {
  const context = new AudioContext({ sampleRate: 48000 });
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const output = new Audio();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  const tracks: MediaStreamTrack[] = [...destination.stream.getTracks()];
  const removers: Array<() => void> = [];
  let captureId: number | null = null;
  let packets = 0, peak = 0, remotePeak = 0, controlPeak = 0;
  let nativeError = "";
  let started = false;
  try {
    await context.resume();
    oscillator.frequency.value = 1800;
    gain.gain.value = 0.04;
    oscillator.connect(gain); gain.connect(destination);
    // Start before negotiation/play(): some WebRTC senders do not emit audio
    // until the source is active, so awaiting play() first can deadlock the test.
    oscillator.start(); started = true;
    const incoming = new Promise<MediaStreamTrack>(resolve => { receiver.ontrack = event => resolve(event.track); });
    sender.addTrack(tracks[0], destination.stream);
    await sender.setLocalDescription(await sender.createOffer());
    await completeIce(sender);
    await receiver.setRemoteDescription(sender.localDescription!);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await completeIce(receiver);
    await sender.setRemoteDescription(receiver.localDescription!);
    let timeout = 0;
    const remote = await Promise.race([incoming, new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error("Локальная дорожка звонка не появилась.")), 5000);
    })]).finally(() => window.clearTimeout(timeout));
    tracks.push(remote);
    const remoteStream = new MediaStream([remote]);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(remoteStream).connect(analyser);
    output.srcObject = remoteStream;
    output.volume = 1;
    let playbackTimeout = 0;
    await Promise.race([output.play(), new Promise<never>((_, reject) => {
      playbackTimeout = window.setTimeout(() => reject(new Error("Принятая дорожка не начала воспроизведение.")), 5000);
    })]).finally(() => window.clearTimeout(playbackTimeout));
    removers.push(await listen<{ captureId: number; pcm: string }>("coherent:system-audio", ({ payload }) => {
      if (payload.captureId !== captureId) return;
      const bytes = Uint8Array.from(atob(payload.pcm), char => char.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer);
      peak = Math.max(peak, toneAmplitude(pcm, 1800));
      controlPeak = Math.max(controlPeak, toneAmplitude(pcm, 1000));
      packets++;
    }));
    removers.push(await listen<{ captureId: number; message: string }>("coherent:system-audio-error", ({ payload }) => {
      if (captureId === null || payload.captureId === captureId) nativeError = payload.message;
    }));
    captureId = await invoke<number>("start_system_audio");
    const samples = new Float32Array(analyser.fftSize);
    for (let sample = 0; sample < 80; sample++) {
      await new Promise(resolve => window.setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(samples);
      remotePeak = Math.max(remotePeak, ...samples.map(Math.abs));
      if (nativeError) throw new Error(nativeError);
    }
    if (remotePeak < 0.01 || output.paused) throw new Error("Проверочный звук WebRTC не воспроизводился; результат не засчитан.");
    if (packets < 10) throw new Error("Недостаточно данных системного звука; результат не засчитан.");
    const level = peak > 0 ? `${Math.round(20 * Math.log10(peak))} дБ` : "тишина";
    if (peak > 0.002) throw new Error(`Звук локального звонка попал в захват (${level}). Если играет другой звук, остановите его и повторите проверку.`);
    const control = controlPeak > 0.01 ? ` Внешний контрольный сигнал 1000 Гц присутствует (${Math.round(20 * Math.log10(controlPeak))} дБ).` : "";
    return `Принятый звук WebRTC воспроизведён локально и исключён из захвата (${level}, ${packets} пакетов).${control} Проверка не использовала микрофон и сервер.`;
  } finally {
    removers.forEach(remove => remove());
    if (captureId !== null) await invoke("stop_system_audio", { captureId }).catch(() => undefined);
    output.pause(); output.srcObject = null;
    if (started) oscillator.stop();
    oscillator.disconnect(); gain.disconnect();
    sender.close(); receiver.close(); tracks.forEach(track => track.stop());
    await context.close().catch(() => undefined);
  }
}

async function completeIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      if (peer.iceGatheringState !== "complete") return;
      window.clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", done); resolve();
    };
    const timer = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", done);
      reject(new Error("Локальное соединение проверки не установлено."));
    }, 5000);
    peer.addEventListener("icegatheringstatechange", done);
    done();
  });
}

/** Stereo tone amplitude; independent channels avoid cancelling a phase-inverted signal. */
export function toneAmplitude(pcm: Int16Array, frequency: number): number {
  const frames = Math.floor(pcm.length / 2);
  if (!frames) return 0;
  let maximum = 0;
  for (let channel = 0; channel < 2; channel++) {
    let real = 0, imaginary = 0;
    for (let frame = 0; frame < frames; frame++) {
      const angle = 2 * Math.PI * frequency * frame / 48000;
      const value = pcm[frame * 2 + channel] / 32768;
      real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
    }
    maximum = Math.max(maximum, 2 * Math.hypot(real, imaginary) / frames);
  }
  return maximum;
}
