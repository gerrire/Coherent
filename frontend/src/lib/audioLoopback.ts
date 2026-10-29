/** Local-only WebRTC test. No STUN/TURN, service connection, recording or speaker output. */
export async function createAudioLoopback(track: MediaStreamTrack, signal: AbortSignal) {
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const playback = document.createElement("audio");
  playback.muted = true; playback.volume = 0; playback.autoplay = true;
  let received: MediaStreamTrack | undefined;
  const close = () => { playback.pause(); playback.srcObject = null; sender.close(); receiver.close(); received?.stop(); };
  signal.addEventListener("abort", close, { once: true });
  const pendingToSender: RTCIceCandidate[] = [], pendingToReceiver: RTCIceCandidate[] = [];
  sender.onicecandidate = event => {
    if (!event.candidate) return;
    if (receiver.remoteDescription) void receiver.addIceCandidate(event.candidate).catch(() => undefined);
    else pendingToReceiver.push(event.candidate);
  };
  receiver.onicecandidate = event => {
    if (!event.candidate) return;
    if (sender.remoteDescription) void sender.addIceCandidate(event.candidate).catch(() => undefined);
    else pendingToSender.push(event.candidate);
  };
  let resolveTrack!: (track: MediaStreamTrack) => void;
  const gotTrack = new Promise<MediaStreamTrack>(resolve => { resolveTrack = resolve; });
  receiver.ontrack = event => {
    received = event.track;
    playback.srcObject = new MediaStream([event.track]);
    void playback.play().catch(() => undefined);
    resolveTrack(event.track);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) throw new DOMException("Проверка отменена", "AbortError");
    sender.addTrack(track, new MediaStream([track]));
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription!);
    for (const candidate of pendingToReceiver) await receiver.addIceCandidate(candidate);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription!);
    for (const candidate of pendingToSender) await sender.addIceCandidate(candidate);
    const remoteTrack = await Promise.race([gotTrack, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Локальная передача WebRTC не запустилась.")), 5000);
    })]);
    return { track: remoteTrack, close: () => { signal.removeEventListener("abort", close); close(); },
      receivedStats: async () => {
        const stats = await receiver.getStats();
        const sourceStats = await sender.getStats();
        let sourceLevel = 0, sourceEnergy = 0;
        sourceStats.forEach(stat => { if (stat.type === "media-source" && stat.kind === "audio") { sourceLevel = stat.audioLevel ?? 0; sourceEnergy = stat.totalAudioEnergy ?? 0; } });
        let energy = 0, packets = 0, level = 0;
        stats.forEach(stat => { if (stat.type === "inbound-rtp" && stat.kind === "audio") {
          energy += stat.totalAudioEnergy ?? 0; packets += stat.packetsReceived ?? 0; level = Math.max(level, stat.audioLevel ?? 0);
        } });
        return { energy, packets, level, sourceLevel, sourceEnergy, state: receiver.connectionState, muted: remoteTrack.muted };
      },
      sentBytes: async () => {
        const stats = await sender.getStats();
        let bytes = 0;
        stats.forEach(stat => { if (stat.type === "outbound-rtp" && stat.kind === "audio") bytes += stat.bytesSent ?? 0; });
        return bytes;
      },
    };
  } catch (error) { signal.removeEventListener("abort", close); close(); throw error; }
  finally { clearTimeout(timer); }
}
