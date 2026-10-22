import {
  ScreenSharePresets,
  Track,
  VideoPresets,
  type AudioCaptureOptions,
  LocalAudioTrack,
  LocalVideoTrack,
  type Room,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
} from "livekit-client";

export type VideoCodec = "vp8" | "h264" | "vp9" | "av1";
export type VideoQuality = "360p" | "720p" | "1080p";
export type ScreenShareQuality = "720p" | "1080p" | "1440p" | "native";
export type ScreenShareContent = "text" | "motion";
export type ScreenShareFrameRate = 15 | 30 | 60;
export type NoiseProcessor = "browser" | "rnnoise";
export type RnnoisePreset = "natural" | "balanced" | "strong";

export interface MediaPreferences {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  deafened: boolean;
  microphoneId: string;
  microphoneVolume: number;
  cameraId: string;
  speakerId: string;
  videoCodec: VideoCodec;
  videoQuality: VideoQuality;
  screenShareQuality: ScreenShareQuality;
  screenShareContent: ScreenShareContent;
  screenShareCodec: VideoCodec;
  screenShareFrameRate: ScreenShareFrameRate;
  screenShareBitrateMbps: number;
  noiseSuppression: boolean;
  noiseProcessor: NoiseProcessor;
  rnnoisePreset: RnnoisePreset;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface AudioProcessingState {
  noiseSuppression: boolean | null;
  echoCancellation: boolean | null;
  autoGainControl: boolean | null;
}

export function supportedAudioProcessing(): { noiseSuppression: boolean; echoCancellation: boolean; autoGainControl: boolean } {
  const supported = navigator.mediaDevices?.getSupportedConstraints();
  return {
    noiseSuppression: supported?.noiseSuppression === true,
    echoCancellation: supported?.echoCancellation === true,
    autoGainControl: supported?.autoGainControl === true,
  };
}

export function readAudioProcessing(room: Room | null): AudioProcessingState | null {
  const localTrack = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  const track = localTrack instanceof LocalAudioTrack ? localTrack : null;
  if (!track || track.mediaStreamTrack.readyState !== "live") return null;
  const settings = track.getSourceTrackSettings();
  return {
    noiseSuppression: typeof settings.noiseSuppression === "boolean" ? settings.noiseSuppression : null,
    echoCancellation: typeof settings.echoCancellation === "boolean" ? settings.echoCancellation : null,
    autoGainControl: typeof settings.autoGainControl === "boolean" ? settings.autoGainControl : null,
  };
}

const STORAGE_KEY = "coherent.media-preferences";

export const defaultMediaPreferences: MediaPreferences = {
  microphoneEnabled: true,
  cameraEnabled: false,
  deafened: false,
  microphoneId: "",
  microphoneVolume: 100,
  cameraId: "",
  speakerId: "",
  videoCodec: "h264",
  videoQuality: "1080p",
  screenShareQuality: "native",
  screenShareContent: "text",
  screenShareCodec: "h264",
  screenShareFrameRate: 30,
  screenShareBitrateMbps: 20,
  noiseSuppression: false,
  noiseProcessor: "browser",
  rnnoisePreset: "balanced",
  echoCancellation: true,
  autoGainControl: false,
};

export function loadMediaPreferences(): MediaPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MediaPreferences> & {
      qualityDefaultsVersion?: number;
      audioDefaultsVersion?: number;
      screenShareDefaultsVersion?: number;
      screenShareBitrateDefaultsVersion?: number;
      strongNoiseSuppression?: boolean;
    };
    const { strongNoiseSuppression, ...stored } = saved;
    const codecs: VideoCodec[] = ["vp8", "h264", "vp9", "av1"];
    const qualities: VideoQuality[] = ["360p", "720p", "1080p"];
    const legacyDefaults = saved.qualityDefaultsVersion !== 2
      && saved.videoCodec === "vp8" && saved.videoQuality === "720p";
    const storedCodec = legacyDefaults ? "h264" : saved.videoCodec;
    const storedQuality = legacyDefaults ? "1080p" : saved.videoQuality;
    const legacyAudioDefaults = saved.audioDefaultsVersion !== 1
      && saved.noiseSuppression === true
      && saved.echoCancellation === true
      && saved.autoGainControl === true;
    return {
      ...defaultMediaPreferences,
      ...stored,
      cameraEnabled: false,
      microphoneVolume: typeof saved.microphoneVolume === "number" && Number.isFinite(saved.microphoneVolume)
        ? Math.min(100, Math.max(0, Math.round(saved.microphoneVolume))) : 100,
      noiseSuppression: strongNoiseSuppression || (legacyAudioDefaults ? false : saved.noiseSuppression ?? defaultMediaPreferences.noiseSuppression),
      noiseProcessor: saved.noiseProcessor === "rnnoise" ? "rnnoise" : "browser",
      rnnoisePreset: (["natural", "balanced", "strong"] as RnnoisePreset[]).includes(saved.rnnoisePreset as RnnoisePreset)
        ? saved.rnnoisePreset! : "balanced",
      autoGainControl: legacyAudioDefaults ? false : saved.autoGainControl ?? defaultMediaPreferences.autoGainControl,
      videoCodec: codecs.includes(storedCodec as VideoCodec) ? storedCodec! : "h264",
      videoQuality: qualities.includes(storedQuality as VideoQuality) ? storedQuality! : "1080p",
      screenShareQuality: saved.screenShareDefaultsVersion !== 1 && saved.screenShareQuality === "1080p"
        ? "native" : (["720p", "1080p", "1440p", "native"] as ScreenShareQuality[]).includes(saved.screenShareQuality as ScreenShareQuality)
          ? saved.screenShareQuality! : "native",
      screenShareContent: saved.screenShareContent === "motion" ? "motion" : "text",
      screenShareCodec: codecs.includes(saved.screenShareCodec as VideoCodec) ? saved.screenShareCodec! : "h264",
      screenShareFrameRate: saved.screenShareFrameRate === 15 || saved.screenShareFrameRate === 60 ? saved.screenShareFrameRate : 30,
      screenShareBitrateMbps: saved.screenShareBitrateDefaultsVersion !== 1 && saved.screenShareBitrateMbps === 12
        ? 20 : typeof saved.screenShareBitrateMbps === "number" && Number.isFinite(saved.screenShareBitrateMbps)
          ? Math.min(50, Math.max(1, Math.round(saved.screenShareBitrateMbps))) : 20,
    };
  } catch {
    return defaultMediaPreferences;
  }
}

export function saveMediaPreferences(value: MediaPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, cameraEnabled: false, qualityDefaultsVersion: 2, audioDefaultsVersion: 1, screenShareDefaultsVersion: 1, screenShareBitrateDefaultsVersion: 1 }));
  } catch {
    // The current call still works when browser storage is unavailable.
  }
}

export function microphoneCapture(value: MediaPreferences): AudioCaptureOptions {
  return {
    deviceId: value.microphoneId || undefined,
    noiseSuppression: value.noiseProcessor === "browser" && value.noiseSuppression,
    echoCancellation: value.echoCancellation,
    autoGainControl: value.autoGainControl,
    voiceIsolation: false,
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
      priority: "low",
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
    // Keep the selected tab's audio, but do not feed the call's own playback back through system capture.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "exclude",
    contentHint: value.screenShareContent,
    // Safari 17 can downscale display capture when explicit dimensions are supplied.
    // An explicit zero-sized preset skips LiveKit's 1080p default without constraining native capture.
    resolution: value.screenShareQuality === "native"
      ? { width: 0, height: 0, frameRate: value.screenShareFrameRate }
      : safari ? undefined : {
        width: value.screenShareQuality === "720p" ? 1280 : value.screenShareQuality === "1440p" ? 2560 : 1920,
        height: value.screenShareQuality === "720p" ? 720 : value.screenShareQuality === "1440p" ? 1440 : 1080,
        frameRate: value.screenShareFrameRate,
      },
  };
}

export function screenSharePublish(value: MediaPreferences): TrackPublishOptions {
  return {
    videoCodec: supportedVideoCodec(value.screenShareCodec),
    screenShareEncoding: {
      maxBitrate: value.screenShareBitrateMbps * 1_000_000,
      maxFramerate: value.screenShareFrameRate,
      priority: "high",
    },
    screenShareSimulcastLayers: value.screenShareContent === "motion"
      ? value.screenShareQuality === "720p" ? [ScreenSharePresets.h360fps15] : [ScreenSharePresets.h720fps15]
      : [],
    degradationPreference: value.screenShareContent === "text"
      ? "maintain-resolution" : "maintain-framerate",
    simulcast: value.screenShareContent === "motion",
  };
}

export async function updateScreenShareBitrate(room: Room, bitrateMbps: number): Promise<void> {
  const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
  if (!(track instanceof LocalVideoTrack) || !track.sender) return;
  const sender = track.sender;
  const params = sender.getParameters();
  if (!params.encodings.length) return;
  const maxBitrate = bitrateMbps * 1_000_000;
  await sender.setParameters({
    ...params,
    encodings: params.encodings.map((encoding, index) => ({
      ...encoding,
      maxBitrate: index === params.encodings.length - 1 ? maxBitrate : Math.min(encoding.maxBitrate ?? maxBitrate, maxBitrate),
    })),
  });
}
