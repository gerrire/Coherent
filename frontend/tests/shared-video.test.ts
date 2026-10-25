import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SharedVideo } from '../src/lib/sharedVideo';

let deliver: (event: any) => void;
let release: ReturnType<typeof vi.fn>;
let copy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  release = vi.fn(); copy = vi.fn();
  vi.stubGlobal('window', { chrome: { webview: {
    addEventListener: (_name: string, callback: any) => { deliver = callback; },
    removeEventListener: vi.fn(), releaseBuffer: release,
  } } });
  vi.stubGlobal('VideoFrame', class { constructor(bytes: Uint8Array, options: unknown) { copy(new Uint8Array(bytes), options); } });
});
afterEach(() => vi.unstubAllGlobals());
const send = (id: number, buffer: ArrayBuffer) => deliver({ additionalData: { kind: 'coherent-screen', captureId: id }, getBuffer: () => buffer });

it('copies a read-only frame and never transfers or changes the producer buffer', () => {
  const shared = SharedVideo.create(vi.fn())!;
  const buffer = new Uint8Array([1, 2, 3, 255]).buffer;
  send(7, buffer); shared.select(7);
  shared.frame(7, 1, 1);
  expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 255]);
  expect(copy).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 255]), expect.objectContaining({ format: 'BGRA' }));
  expect(() => shared.frame(7, 3840, 2160)).toThrow('размер');
  shared.dispose(); shared.dispose();
  expect(release).toHaveBeenCalledOnce();
});

it('releases stale mappings without replacing the current capture', () => {
  const shared = SharedVideo.create(vi.fn())!;
  const current = new ArrayBuffer(4), stale = new ArrayBuffer(4);
  shared.select(8); send(8, current); send(7, stale);
  expect(shared.has(8)).toBe(true);
  expect(shared.has(7)).toBe(false);
  expect(release).toHaveBeenCalledWith(stale);
  shared.dispose();
  expect(release).toHaveBeenCalledWith(current);
});
