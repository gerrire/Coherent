import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, isTauri: () => true }));
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  bridge.invoke.mockReset().mockResolvedValue({ microphone: false, camera: false });
  getUserMedia = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('location', { search: '' });
});
afterEach(() => vi.unstubAllGlobals());

it('does not open a permission dialog after the call ended during a slow settings read', async () => {
  let complete!: (value: unknown) => void;
  bridge.invoke.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const consent = await import('../src/lib/desktopPermissions');
  consent.installDesktopMediaConsent();
  const pending = navigator.mediaDevices.getUserMedia({ audio: true });
  const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
  consent.cancelDesktopMediaRequests();
  complete({ microphone: false, camera: false });
  await result;
  expect(consent.getMediaAccessRequest()).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
});

it('stops a device stream which arrives after cancellation', async () => {
  bridge.invoke.mockResolvedValue({ microphone: true, camera: true });
  let complete!: (value: unknown) => void;
  const stop = vi.fn();
  getUserMedia.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const consent = await import('../src/lib/desktopPermissions');
  consent.installDesktopMediaConsent();
  const pending = navigator.mediaDevices.getUserMedia({ video: true });
  const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  consent.cancelDesktopMediaRequests();
  complete({ getTracks: () => [{ stop }] });
  await result;
  expect(stop).toHaveBeenCalledOnce();
});
