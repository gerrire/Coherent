type SharedBufferEvent = Event & {
  additionalData?: { kind?: string; captureId?: number };
  getBuffer(): ArrayBuffer;
};
interface NativeWebView {
  addEventListener(name: 'sharedbufferreceived', callback: (event: SharedBufferEvent) => void): void;
  removeEventListener(name: 'sharedbufferreceived', callback: (event: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

/** One bounded read-only mapping. VideoFrame copies pixels before ACK, so the
 * producer never writes while the encoder might still be reading the mapping. */
export class SharedVideo {
  private buffers = new Map<number, ArrayBuffer>();
  private disposed = false;
  private expected: number | null = null;
  private constructor(private webview: NativeWebView, private changed: () => void) {
    webview.addEventListener('sharedbufferreceived', this.receive);
  }
  static create(changed: () => void): SharedVideo | null {
    const webview = (window as unknown as { chrome?: { webview?: NativeWebView } }).chrome?.webview;
    return webview && typeof VideoFrame !== 'undefined' ? new SharedVideo(webview, changed) : null;
  }
  private receive = (event: SharedBufferEvent) => {
    if (event.additionalData?.kind !== 'coherent-screen') return;
    const id = event.additionalData.captureId;
    const buffer = event.getBuffer();
    if (this.disposed || typeof id !== 'number' || (this.expected !== null && id !== this.expected)) { this.webview.releaseBuffer(buffer); return; }
    const previous = this.buffers.get(id);
    if (previous) this.webview.releaseBuffer(previous);
    if (this.buffers.size >= 2 && !previous) {
      const [oldId, oldBuffer] = this.buffers.entries().next().value!;
      this.webview.releaseBuffer(oldBuffer);
      this.buffers.delete(oldId);
    }
    this.buffers.set(id, buffer);
    this.changed();
  };
  select(id: number) {
    this.expected = id;
    for (const [key, buffer] of this.buffers) {
      if (key !== id) { this.webview.releaseBuffer(buffer); this.buffers.delete(key); }
    }
  }
  has(id: number): boolean { return this.buffers.has(id); }
  frame(id: number, width: number, height: number): VideoFrame {
    const buffer = this.buffers.get(id);
    const length = width * height * 4;
    if (!buffer || !Number.isSafeInteger(length) || length < 4 || length > buffer.byteLength)
      throw new Error('Некорректный размер кадра Windows.');
    // The constructor copies the read-only view; never transfer/detach or modify it.
    return new VideoFrame(new Uint8Array(buffer, 0, length), {
      format: 'BGRA', codedWidth: width, codedHeight: height,
      timestamp: Math.round(performance.now() * 1000),
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.webview.removeEventListener('sharedbufferreceived', this.receive);
    for (const buffer of this.buffers.values()) this.webview.releaseBuffer(buffer);
    this.buffers.clear();
  }
}
