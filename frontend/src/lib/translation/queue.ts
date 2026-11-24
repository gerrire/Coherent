import type { Caption } from "./transport";

export type TranslationJob =
  | { type: "recognize"; audio: Float32Array; createdAt: number; generation: number }
  | { type: "translate"; caption: Caption; createdAt: number };

/** Keep live speech current instead of building minutes of delayed translation. */
export class TranslationQueue {
  private audio: Extract<TranslationJob, { type: "recognize" }> | undefined;
  private captions: Extract<TranslationJob, { type: "translate" }>[] = [];
  private previousWasAudio = false;

  constructor(private readonly onDropped: () => void) {}

  pushAudio(audio: Float32Array, generation: number, now = Date.now()): void {
    if (this.audio) this.onDropped();
    this.audio = { type: "recognize", audio, generation, createdAt: now };
  }

  pushCaption(caption: Caption): void {
    if (this.captions.length >= 6) { this.captions.shift(); this.onDropped(); }
    this.captions.push({ type: "translate", caption, createdAt: caption.receivedAt });
  }

  take(now = Date.now()): TranslationJob | undefined {
    if (this.audio && now - this.audio.createdAt > 10_000) { this.audio = undefined; this.onDropped(); }
    while (this.captions[0] && now - this.captions[0].createdAt > 15_000) { this.captions.shift(); this.onDropped(); }
    if (this.audio && (!this.previousWasAudio || !this.captions.length)) {
      const next = this.audio;
      this.audio = undefined;
      this.previousWasAudio = true;
      return next;
    }
    this.previousWasAudio = false;
    return this.captions.shift();
  }

  clearAudio(): void { this.audio = undefined; }
  clear(): void { this.clearAudio(); this.captions = []; }
}
