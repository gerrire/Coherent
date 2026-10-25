import { invoke, isTauri } from "@tauri-apps/api/core";

export type MediaAccess = { microphone: boolean; camera: boolean };
type Request = { microphone: boolean; camera: boolean; resolve: (allow: boolean) => void };
let request: Request | null = null;
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
const listeners = new Set<() => void>();
export const getMediaAccessRequest = () => request;
export const subscribeMediaAccess = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getMediaAccess = () => invoke<MediaAccess>("desktop_media_permissions_get");
export const setMediaAccess = (value: MediaAccess) => invoke("desktop_media_permissions_set", { value });
export function answerMediaAccess(allow: boolean) {
  const pending = request;
  request = null;
  listeners.forEach(listener => listener());
  pending?.resolve(allow);
}

export function cancelDesktopMediaRequests() {
  generation++;
  answerMediaAccess(false);
}

async function ensureAccess(constraints: MediaStreamConstraints, check: () => void) {
  const value = await getMediaAccess();
  check();
  const microphone = Boolean(constraints.audio) && !value.microphone;
  const camera = Boolean(constraints.video) && !value.camera;
  if (!microphone && !camera) return;
  const allowed = await new Promise<boolean>(resolve => {
    request = { microphone, camera, resolve };
    listeners.forEach(listener => listener());
  });
  check();
  if (!allowed) throw new DOMException("Доступ к устройству отменён.", "NotAllowedError");
  await setMediaAccess({ microphone: value.microphone || microphone, camera: value.camera || camera });
}

export function installDesktopMediaConsent() {
  if (!isTauri() || new URLSearchParams(location.search).has("window") || !navigator.mediaDevices) return;
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints) => {
    const current = generation;
    const check = () => { if (current !== generation) throw new DOMException("Запрос устройства отменён.", "AbortError"); };
    const next = queue.then(() => { check(); return ensureAccess(constraints, check); });
    queue = next.catch(() => undefined);
    await next;
    check();
    // Windows retains the final say on device access.
    const stream = await original(constraints);
    if (current !== generation) { stream.getTracks().forEach(track => track.stop()); check(); }
    return stream;
  };
}
