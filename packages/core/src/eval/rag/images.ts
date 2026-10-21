/**
 * Images in a RAG sample (planning/rag-testing.md §4j): a retrieved chunk, or the question, can hold a picture. A vision
 * judge reads it AS DATA: TestPion fetches or reads the bytes itself (under the network policy, so the judge's provider never
 * fetches a private URL), checks them (type by content, no SVG, size limits, the metadata of a photo removed) and sends them
 * base64-encoded. The judge's answer refers to them by sha256; a result keeps the image's reference and hash, never the bytes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RetrievedDoc } from '../../model/types.js';
import type { ChatImage } from '../../ai/types.js';
import { assertUrlAllowed } from '../../net/policy.js';
import { prepareImage, type PreparedImage } from '../../util/image-info.js';

export const IMAGE_LIMITS = { perImageBytes: 5 * 1024 * 1024, perSample: 16, perSampleBytes: 20 * 1024 * 1024 } as const;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?[^\s]*)?$/i;

/** Whether text is a reference to an image: a data URI, or a URL or path that ends with an image extension. */
export function isImageRef(s: string | undefined): s is string {
  if (!s) return false;
  const t = s.trim();
  if (t.length > 20_000_000 || /\s/.test(t.slice(0, 200)) && !t.startsWith('data:')) return false;
  return /^data:image\//i.test(t) || IMAGE_EXT.test(t);
}

/** The image a retrieved chunk holds: its `image` field, else a text that is itself an image reference. */
export const imageRefOf = (d: Pick<RetrievedDoc, 'text' | 'image'>): string | undefined => (d.image?.trim() ? d.image.trim() : isImageRef(d.text) ? d.text.trim() : undefined);

export interface ImageSource {
  /** Reads an http(s) URL (the network policy has been applied). */
  fetchUrl(url: string, maxBytes: number): Promise<Uint8Array>;
  /** Reads a file of the workspace. */
  readPath(path: string, maxBytes: number): Uint8Array;
}

/** The real sources: `fetch` after the network policy, and files inside the workspace folder only. */
export function defaultImageSource(workspaceRoot?: string): ImageSource {
  return {
    async fetchUrl(url, maxBytes) {
      await assertUrlAllowed(url);
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > maxBytes) throw new Error(`${Math.round(len / 1024 / 102.4) / 10} MB is over the ${maxBytes / 1024 / 1024} MB limit`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`${Math.round(buf.length / 1024 / 102.4) / 10} MB is over the ${maxBytes / 1024 / 1024} MB limit`);
      return buf;
    },
    readPath(path, maxBytes) {
      if (!workspaceRoot) throw new Error('an image file can only be read inside a workspace');
      const abs = resolve(workspaceRoot, path);
      const rel = relative(resolve(workspaceRoot), abs);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('the image path is outside the workspace folder');
      const size = statSync(abs).size;
      if (size > maxBytes) throw new Error(`${Math.round(size / 1024 / 102.4) / 10} MB is over the ${maxBytes / 1024 / 1024} MB limit`);
      return new Uint8Array(readFileSync(abs));
    },
  };
}

export interface LoadedImage {
  /** What the image was read from: the URL or path, or `data-uri` (never the bytes). */
  ref: string;
  /** The chunk it came from (`question` for the question's own). */
  from: string;
  prepared: PreparedImage;
}

export interface ImageSet {
  images: LoadedImage[];
  /** Images over the per-sample count, left out (the top-ranked are kept): said in the result. */
  omitted: number;
  /** Why the images cannot be sent at all (an image over a limit, not an image, unreadable): the metric is n/a with it. */
  problem?: string;
}

const refLabel = (ref: string) => (/^data:/i.test(ref) ? 'data-uri' : ref.length > 200 ? `${ref.slice(0, 197)}…` : ref);

/** Reads and checks the images of a sample; the first problem stops it (a picture is never silently dropped, except past the count limit). */
export async function loadImages(refs: Array<{ ref: string; from: string }>, src: ImageSource, limits: { perImageBytes: number; perSample: number; perSampleBytes: number } = IMAGE_LIMITS): Promise<ImageSet> {
  const kept = refs.slice(0, limits.perSample);
  const out: LoadedImage[] = [];
  let total = 0;
  for (const { ref, from } of kept) {
    let raw: Uint8Array;
    if (/^data:image\/…;sha256=/.test(ref)) return { images: out, omitted: 0, problem: `the picture of ${from} was not stored (a result keeps the hash of an inline image, never its bytes): run the target again to score pictures` };
    try {
      if (/^data:image\//i.test(ref)) {
        const m = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(ref);
        if (!m) return { images: out, omitted: 0, problem: `an image of ${from} is a data URI that is not base64` };
        if (m[1]!.length * 0.75 > limits.perImageBytes) return { images: out, omitted: 0, problem: `an image of ${from} is ${Math.round((m[1]!.length * 0.75) / 1024 / 102.4) / 10} MB, over the ${limits.perImageBytes / 1024 / 1024} MB limit` };
        raw = Buffer.from(m[1]!, 'base64');
      } else if (/^https?:\/\//i.test(ref)) raw = await src.fetchUrl(ref, limits.perImageBytes);
      else raw = src.readPath(ref, limits.perImageBytes);
    } catch (e) {
      return { images: out, omitted: 0, problem: `image ${refLabel(ref)} of ${from} could not be read: ${(e as Error).message}` };
    }
    if (raw.length > limits.perImageBytes) return { images: out, omitted: 0, problem: `image ${refLabel(ref)} of ${from} is ${Math.round(raw.length / 1024 / 102.4) / 10} MB, over the ${limits.perImageBytes / 1024 / 1024} MB limit` };
    const prepared = prepareImage(raw);
    if ('refused' in prepared) return { images: out, omitted: 0, problem: `image ${refLabel(ref)} of ${from}: ${prepared.refused}` };
    total += prepared.originalBytes;
    if (total > limits.perSampleBytes) return { images: out, omitted: 0, problem: `the images of this sample are over ${limits.perSampleBytes / 1024 / 1024} MB together` };
    out.push({ ref: refLabel(ref), from, prepared });
  }
  return { images: out, omitted: Math.max(0, refs.length - kept.length) };
}

/** The images as the AI layer takes them. */
export const toChatImages = (images: LoadedImage[]): ChatImage[] => images.map((i) => ({ mime: i.prepared.mime as ChatImage['mime'], data: i.prepared.bytes.toString('base64'), sha256: i.prepared.sha256 }));

/** What a result keeps of the images: where each came from and its hash, never the bytes. */
export const imageMeta = (images: LoadedImage[]) => images.map((i) => ({ ref: i.ref, from: i.from, mime: i.prepared.mime, bytes: i.prepared.bytes.length, ...(i.prepared.width ? { width: i.prepared.width, height: i.prepared.height } : {}), sha256: i.prepared.sha256 }));

/** A chunk as a stored sample keeps it: an inline image becomes its hash (a result never holds image bytes). */
export function scrubDocImage<T extends { image?: string; text: string }>(d: T): T {
  const scrub = (s: string) => (/^data:image\//i.test(s) ? `data:image/…;sha256=${createHash('sha256').update(s).digest('hex').slice(0, 16)}` : s);
  return { ...d, ...(d.image ? { image: scrub(d.image) } : {}), text: /^data:image\//i.test(d.text) ? scrub(d.text) : d.text };
}

/** A dataset record as a result keeps it: the question's inline pictures become hashes. */
export const storableRecord = <T extends { images?: string[] }>(r: T): T => (r.images ? { ...r, images: r.images.map((i) => scrubDocImage({ text: i }).text) } : r);

/** The refs of a sample's images: the question's own (a dataset's `images` column) first, then each chunk's, in rank order. */
export function sampleImageRefs(question: string | undefined, questionImages: string[] | undefined, contexts: Array<Pick<RetrievedDoc, 'id' | 'text' | 'image'>> | undefined): Array<{ ref: string; from: string }> {
  const refs: Array<{ ref: string; from: string }> = [];
  for (const q of questionImages ?? []) refs.push({ ref: q, from: 'the question' });
  if (isImageRef(question)) refs.push({ ref: question.trim(), from: 'the question' });
  for (const d of contexts ?? []) {
    const r = imageRefOf(d);
    if (r) refs.push({ ref: r, from: `context ${d.id}` });
  }
  return refs;
}
