/**
 * The import previews one session keeps for the import that follows (what a preview read; the window never sends the files twice).
 * They are the session's own: another user's previews neither share this memory nor push these out. Bounded three ways: how many,
 * how old, and how many bytes of text they hold together (the host's `importBytes`: 512 MB on a computer of one person, less on a
 * shared server).
 */
import type { ImportInput, SkippedFile } from '@testpion/core';

export interface PreviewSession {
  inputs: ImportInput[];
  skipped: SkippedFile[];
  at: number;
}

export const PREVIEW_TTL_MS = 30 * 60_000;
/** Previews kept at once: the oldest goes when a new one needs the room. */
export const MAX_PREVIEWS = 8;
/** The default byte budget of one session's previews, and of one upload. */
export const DEFAULT_IMPORT_BYTES = 512 * 1024 * 1024;

const sizeOf = (s: PreviewSession) => s.inputs.reduce((n, i) => n + i.text.length, 0);

export class ImportPreviews {
  private readonly map = new Map<string, { s: PreviewSession; bytes: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly maxBytes = DEFAULT_IMPORT_BYTES) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    let n = 0;
    for (const v of this.map.values()) n += v.bytes;
    return n;
  }

  get(id: string): PreviewSession | undefined {
    return this.map.get(id)?.s;
  }

  delete(id: string): boolean {
    return this.map.delete(id);
  }

  /** Drop what expired. */
  sweep(now = Date.now()): void {
    for (const [k, v] of this.map) if (now - v.s.at > PREVIEW_TTL_MS) this.map.delete(k);
  }

  /** Keep a preview; expired ones go first, then the oldest while there are too many previews or too many bytes. */
  remember(id: string, s: PreviewSession, now = Date.now()): void {
    this.sweep(now);
    this.map.set(id, { s, bytes: sizeOf(s) });
    this.schedule();
    // a Map keeps insertion order: the first key is the oldest (the one just kept stays)
    while (this.map.size > 1 && (this.map.size > MAX_PREVIEWS || this.bytes > this.maxBytes)) this.map.delete(this.map.keys().next().value as string);
  }

  /** Expired previews go on a timer too, not only when the next one arrives. */
  private schedule(): void {
    if (this.timer || !this.map.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sweep();
      this.schedule();
    }, PREVIEW_TTL_MS / 3);
    this.timer.unref?.();
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.map.clear();
  }
}
