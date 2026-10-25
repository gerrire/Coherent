import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import type { MediaPreferences } from '../src/lib/media';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, callback) => {
  bridge.handlers.set(name, callback);
  return () => bridge.handlers.delete(name);
}) }));
vi.mock('../src/lib/media', () => ({ screenSharePublish: (media: MediaPreferences) => ({ videoCodec: media.screenShareCodec,
  screenShareEncoding: { maxBitrate: media.screenShareBitrateMbps * 1_000_000, maxFramerate: media.screenShareFrameRate } }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const media = { screenShareQuality: '720p', screenShareFrameRate: 15, screenShareBitrateMbps: 6 } as MediaPreferences;
let track: { stop: ReturnType<typeof vi.fn>; requestFrame: ReturnType<typeof vi.fn> };
let participant: { publishTrack: ReturnType<typeof vi.fn>; unpublishTrack: ReturnType<typeof vi.fn> };
const emit = (name: string, payload: unknown) => bridge.handlers.get(name)?.({ payload });

beforeEach(() => {
  bridge.handlers.clear();
  bridge.invoke.mockReset().mockResolvedValue(undefined);
  track = { stop: vi.fn(), requestFrame: vi.fn() };
  participant = { publishTrack: vi.fn().mockResolvedValue({}), unpublishTrack: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('window', globalThis);
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), captureStream: () => ({ getVideoTracks: () => [track] }) };
  vi.stubGlobal('document', { createElement: () => canvas });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    resume = vi.fn().mockResolvedValue(undefined);
    close = vi.fn(async () => { this.state = 'closed'; });
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [track] } }; }
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    connect = vi.fn(); disconnect = vi.fn();
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('native screen lifecycle', () => {
  it('uses the selected high quality on the shared-memory path without the former desktop caps', async () => {
    const { SharedVideo } = await import('../src/lib/sharedVideo');
    const shared = { select: vi.fn(), dispose: vi.fn() };
    vi.spyOn(SharedVideo, 'create').mockReturnValue(shared as unknown as SharedVideo);
    const { NativeScreenShare } = await import('../src/lib/nativeScreenShare');
    bridge.invoke.mockImplementation(name => Promise.resolve(name === 'desktop_screen_start' ? 20 : undefined));
    const share = new NativeScreenShare({ localParticipant: participant } as unknown as Room);
    const starting = share.start('window-high-quality', { ...media, screenShareQuality: '2160p', screenShareFrameRate: 60,
      screenShareBitrateMbps: 50, screenShareCodec: 'av1' }, vi.fn());
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('desktop_screen_start', {
      sourceId: 'window-high-quality', frameRate: 60, sharedMemory: true,
    }));
    emit('coherent:screen-frame', { captureId: 20, width: 3840, height: 2160, jpeg: 'AA==' });
    await starting;
    expect(participant.publishTrack).toHaveBeenCalledWith(track, expect.objectContaining({ videoCodec: 'av1',
      screenShareEncoding: { maxBitrate: 50_000_000, maxFramerate: 60 } }));
    await share.stop();
    expect(shared.dispose).toHaveBeenCalledOnce();
  });

  it('stops a capture which finishes starting after the user has already left', async () => {
    const { NativeScreenShare } = await import('../src/lib/nativeScreenShare');
    const startReply = deferred<number>();
    bridge.invoke.mockImplementation(name => name === 'desktop_screen_start' ? startReply.promise : Promise.resolve());
    const share = new NativeScreenShare({ localParticipant: participant } as unknown as Room);
    const starting = share.start('window-test', media, vi.fn());
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('desktop_screen_start', expect.anything()));
    const stopping = share.stop();
    startReply.resolve(17);
    await Promise.all([starting, stopping]);
    expect(bridge.invoke).toHaveBeenCalledWith('desktop_screen_stop', { captureId: 17 });
    expect(participant.publishTrack).not.toHaveBeenCalled();
    expect(bridge.handlers.size).toBe(0);
  });

  it('unpublishes a track even when stop happens while publication is in flight', async () => {
    const { NativeScreenShare } = await import('../src/lib/nativeScreenShare');
    const publication = deferred<object>();
    bridge.invoke.mockImplementation(name => Promise.resolve(name === 'desktop_screen_start' ? 18 : undefined));
    participant.publishTrack.mockReturnValue(publication.promise);
    const share = new NativeScreenShare({ localParticipant: participant } as unknown as Room);
    const starting = share.start('window-test', media, vi.fn());
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('desktop_screen_start', expect.anything()));
    emit('coherent:screen-frame', { captureId: 18, width: 1280, height: 720, jpeg: 'AA==' });
    await vi.waitFor(() => expect(participant.publishTrack).toHaveBeenCalled());
    const stopping = share.stop();
    publication.resolve({});
    await Promise.all([starting, stopping]);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(participant.unpublishTrack).toHaveBeenCalledWith(track);
    expect(bridge.handlers.size).toBe(0);
  });

  it('refreshes an unchanged first frame after publication for a new subscriber', async () => {
    const { NativeScreenShare } = await import('../src/lib/nativeScreenShare');
    bridge.invoke.mockImplementation(name => Promise.resolve(name === 'desktop_screen_start' ? 19 : undefined));
    const share = new NativeScreenShare({ localParticipant: participant } as unknown as Room);
    const starting = share.start('window-test', media, vi.fn());
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('desktop_screen_start', expect.anything()));
    emit('coherent:screen-frame', { captureId: 19, width: 1280, height: 720, jpeg: 'AA==' });
    await starting;
    expect(track.requestFrame).toHaveBeenCalledOnce();
    await share.stop();
  });
});

describe('native audio lifecycle', () => {
  it('cleans a producer created after cancellation without publishing it', async () => {
    const { NativeScreenAudio } = await import('../src/lib/nativeScreenAudio');
    const startReply = deferred<number>();
    bridge.invoke.mockImplementation(name => name === 'start_system_audio' ? startReply.promise : Promise.resolve());
    const audio = new NativeScreenAudio({ localParticipant: participant } as unknown as Room);
    const starting = audio.start(vi.fn());
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith('start_system_audio'));
    const stopping = audio.stop();
    startReply.resolve(31);
    await Promise.all([starting, stopping]);
    expect(bridge.invoke).toHaveBeenCalledWith('stop_system_audio', { captureId: 31 });
    expect(participant.publishTrack).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(bridge.handlers.size).toBe(0);
  });

  it('ignores delayed errors and packets from the previous capture', async () => {
    const { NativeScreenAudio } = await import('../src/lib/nativeScreenAudio');
    bridge.invoke.mockImplementation(name => Promise.resolve(name === 'start_system_audio' ? 32 : undefined));
    const error = vi.fn();
    const audio = new NativeScreenAudio({ localParticipant: participant } as unknown as Room);
    await audio.start(error);
    emit('coherent:system-audio-error', { captureId: 31, message: 'old failure' });
    expect(error).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    emit('coherent:system-audio-error', { captureId: 32, message: 'current failure' });
    await audio.stop();
    expect(error).toHaveBeenCalledWith('current failure');
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
