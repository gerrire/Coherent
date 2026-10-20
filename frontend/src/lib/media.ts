import { Track, VideoPresets, type AudioCaptureOptions, type Room, type VideoCaptureOptions } from "livekit-client";

export type VideoCodec = "vp8" | "h264" | "vp9" | "av1";
export type VideoQuality = "360p" | "720p" | "1080p";

export interface MediaPreferences {
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  deafened: boolean;
  microphoneId: string;
  cameraId: string;
  speakerId: string;
  videoCodec: VideoCodec;
  videoQuality: VideoQuality;
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
  videoCodec: "vp8",
  videoQuality: "720p",
  noiseSuppression: true,
  echoCancellation: true,
};

export function loadMediaPreferences(): MediaPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MediaPreferences>;
    const codecs: VideoCodec[] = ["vp8", "h264", "vp9", "av1"];
    const qualities: VideoQuality[] = ["360p", "720p", "1080p"];
    return {
      ...defaultMediaPreferences,
      ...saved,
      videoCodec: codecs.includes(saved.videoCodec as VideoCodec) ? saved.videoCodec! : "vp8",
      videoQuality: qualities.includes(saved.videoQuality as VideoQuality) ? saved.videoQuality! : "720p",
    };
  } catch {
    return defaultMediaPreferences;
  }
}

export function saveMediaPreferences(value: MediaPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
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
