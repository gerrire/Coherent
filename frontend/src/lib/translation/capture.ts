export interface MicrophoneCapture { close(): void }

export async function captureMicrophone(
  track: MediaStreamTrack,
  onAudio: (audio: Float32Array) => void,
  onError: (message: string) => void,
): Promise<MicrophoneCapture> {
  const context = new AudioContext({ latencyHint: "playback" });
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let clock: GainNode | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    track.removeEventListener("ended", ended);
    source?.disconnect();
    if (node) { node.port.onmessage = null; node.onprocessorerror = null; node.port.close(); node.disconnect(); }
    clock?.disconnect();
    void context.close().catch(() => undefined);
    // The call owns this track. Stopping it would also mute the actual call.
  };
  const ended = () => close();
  track.addEventListener("ended", ended, { once: true });
  try {
    await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}translation-capture.js?v=1`);
    if (closed || track.readyState !== "live") { close(); return { close }; }
    node = new AudioWorkletNode(context, "coherent-translation-capture", {
      channelCount: 1, channelCountMode: "explicit", numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    node.port.onmessage = ({ data }) => {
      if (!closed && track.enabled && !track.muted && data?.type === "audio" && data.audio instanceof Float32Array) onAudio(data.audio);
    };
    node.onprocessorerror = () => { close(); onError("Не удалось обработать микрофон для перевода. Обычный звонок продолжается."); };
    source = context.createMediaStreamSource(new MediaStream([track]));
    clock = context.createGain();
    clock.gain.value = 0;
    source.connect(node);
    node.connect(clock);
    clock.connect(context.destination);
    await context.resume();
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
