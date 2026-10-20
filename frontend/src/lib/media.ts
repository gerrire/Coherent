import {
  ScreenSharePresets,
  Track,
  VideoPresets,
  type AudioCaptureOptions,
  type Room,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
} from "livekit-client";

export type VideoCodec = "vp8" | "h264" | "vp9" | "av1";
export type VideoQuality = "360p" | "720p" | "1080p";
export type ScreenShareQuality = "1080p" | "native";
export type ScreenShareContent = "text" | "motion";

export interface MediaPreferences {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  deafened: boolean;
  microphoneId: string;
  cameraId: string;
  speakerId: string;
  videoCodec: VideoCodec;
  videoQuality: VideoQuality;
  screenShareQuality: ScreenShareQuality;
  screenShareContent: ScreenShareContent;
  noiseSuppression: boolean;
  echoCancellation: boolean;
}

export interface AudioProcessingState {
  noiseSuppression: boolean | null;
  echoCancellation: boolean | null;
}

export function supportedAudioProcessing(): { noiseSuppression: boolean; echoCancellation: boolean } {
  const supported = navigator.mediaDevices?.getSupportedConstraints();
  return {
    noiseSuppression: supported?.noiseSuppression === true,
    echoCancellation: supported?.echoCancellation === true,
  };
}

export function readAudioProcessing(room: Room | null): AudioProcessingState | null {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (!track || track.readyState !== "live") return null;
  const settings = track.getSettings();
  return {
    noiseSuppression: typeof settings.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
    echoCancellation: typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
  };
}

const STORAGE_KEY = "coherent.media-preferences";

export const defaultMediaPreferences: MediaPreferences = {
  microphoneEnabled: true,
  cameraEnabled: false,
  deafened: false,
  microphoneId: "",
  cameraId: "",
  speakerId: "",
  videoCodec: "h264",
  videoQuality: "1080p",
  screenShareQuality: "1080p",
  screenShareContent: "text",
  noiseSuppression: true,
  echoCancellation: true,
};

export function loadMediaPreferences(): MediaPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MediaPreferences> & { qualityDefaultsVersion?: number };
    const codecs: VideoCodec[] = ["vp8", "h264", "vp9", "av1"];
    const qualities: VideoQuality[] = ["360p", "720p", "1080p"];
    const legacyDefaults = saved.qualityDefaultsVersion !== 2
      && saved.videoCodec === "vp8" && saved.videoQuality === "720p";
    const storedCodec = legacyDefaults ? "h264" : saved.videoCodec;
    const storedQuality = legacyDefaults ? "1080p" : saved.videoQuality;
    return {
      ...defaultMediaPreferences,
      ...saved,
      videoCodec: codecs.includes(storedCodec as VideoCodec) ? storedCodec! : "h264",
      videoQuality: qualities.includes(storedQuality as VideoQuality) ? storedQuality! : "1080p",
      screenShareQuality: saved.screenShareQuality === "native" ? "native" : "1080p",
      screenShareContent: saved.screenShareContent === "motion" ? "motion" : "text",
    };
  } catch {
    return defaultMediaPreferences;
  }
}

export function saveMediaPreferences(value: MediaPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, qualityDefaultsVersion: 2 }));
  } catch {
    // The current call still works when browser storage is unavailable.
  }
}

export function microphoneCapture(value: MediaPreferences): AudioCaptureOptions {
  return {
    deviceId: value.microphoneId || undefined,
    noiseSuppression: value.noiseSuppression,
    echoCancellation: value.echoCancellation,
    autoGainControl: true,
  };
}

export function cameraCapture(value: MediaPreferences): VideoCaptureOptions {
  const resolution = {
    "360p": VideoPresets.h360.resolution,
    "720p": VideoPresets.h720.resolution,
    "1080p": VideoPresets.h1080.resolution,
  }[value.videoQuality];
  return {
    deviceId: value.cameraId || undefined,
    resolution,
  };
}

export function supportedVideoCodec(codec: VideoCodec): VideoCodec {
  if (typeof RTCRtpSender === "undefined" || !RTCRtpSender.getCapabilities) return codec;
  const capabilities = RTCRtpSender.getCapabilities("video");
  if (!capabilities) return codec;
  const supported = capabilities.codecs.some(
    (item) => item.mimeType.toLowerCase() === `video/${codec}`,
  );
  return supported ? codec : "vp8";
}

export function cameraPublish(value: MediaPreferences): TrackPublishOptions {
  const layers = value.videoQuality === "1080p"
    ? [VideoPresets.h360, VideoPresets.h720]
    : value.videoQuality === "720p" ? [VideoPresets.h360] : [];
  const preset = {
    "360p": VideoPresets.h360,
    "720p": VideoPresets.h720,
    "1080p": VideoPresets.h1080,
  }[value.videoQuality];
  return {
    videoCodec: supportedVideoCodec(value.videoCodec),
    videoEncoding: {
      ...preset.encoding,
      maxBitrate: value.videoQuality === "1080p" ? 5_000_000 : preset.encoding.maxBitrate,
    },
    videoSimulcastLayers: layers,
    simulcast: true,
  };
}

export function screenShareCapture(value: MediaPreferences): ScreenShareCaptureOptions {
  const safari = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (/Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg|CriOS/i.test(navigator.userAgent));
  return {
    audio: true,
    contentHint: value.screenShareContent,
    // Safari 17 can downscale display capture when explicit dimensions are supplied.
    resolution: safari ? undefined : value.screenShareQuality === "native"
      ? { width: 3840, height: 2160, frameRate: 30 }
      : ScreenSharePresets.h1080fps30.resolution,
  };
}

export function screenSharePublish(value: MediaPreferences): TrackPublishOptions {
  return {
    videoCodec: supportedVideoCodec(value.videoCodec),
    screenShareEncoding: value.screenShareQuality === "native"
      ? { maxBitrate: 10_000_000, maxFramerate: 30 }
      : ScreenSharePresets.h1080fps30.encoding,
    screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
    degradationPreference: value.screenShareContent === "text"
      ? "maintain-resolution" : "maintain-framerate",
    simulcast: true,
  };
}
