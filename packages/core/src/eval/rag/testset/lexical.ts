/**
 * The small deterministic text measures of test-set generation: content terms, BM25 ranking over the corpus' chunks,
 * token-set similarity, the share of an answer's terms found in its chunks, and a seeded random generator. No model, no
 * dependency: they decide what a verifier may say without asking one.
 */
import { wordTokens } from '../measures.js';
import type { Chunk } from './types.js';

const STOP = new Set(
  'a an and are as at be but by can could do does did for from has have had how i if in into is it its of on or our so than that the their them then there these they this those to was we were what when where which who whom why will with would you your not no yes about also any each other some such only over under more most very'.split(' '),
);

/** A crude stem (opens, opened, opening -> open) so a question and a passage meet when they differ by an ending; applied to both sides, so it need not be linguistically right. */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) if (w.length - suffix.length >= 3 && w.endsWith(suffix) && !w.endsWith('ss')) return w.slice(0, -suffix.length);
  return w;
}

/** Lower-cased, stemmed words without stop words; single characters are dropped. */
export const contentTerms = (s: string): string[] => wordTokens(s).filter((w) => !STOP.has(w) && w.length > 1).map(stem);

export const termSet = (s: string): Set<string> => new Set(contentTerms(s));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The share of `text`'s content terms that appear in `against` (0 when `text` has none). */
export function coverage(text: string, against: string): number {
  const t = termSet(text);
  if (!t.size) return 0;
  const a = termSet(against);
  let hit = 0;
  for (const x of t) if (a.has(x)) hit++;
  return hit / t.size;
}

/** The longest run of consecutive words of `a` that also occurs in `b`, as a share of `a`'s words (copy detection). */
export function copiedShare(a: string, b: string): number {
  const x = wordTokens(a);
  if (x.length < 4) return 0;
  const hay = ` ${wordTokens(b).join(' ')} `;
  let best = 0;
  for (let i = 0; i < x.length; i++) {
    let lo = best;
    // extend the run while the phrase is still found
    while (i + lo < x.length && hay.includes(` ${x.slice(i, i + lo + 1).join(' ')} `)) lo++;
    best = Math.max(best, lo);
  }
  return best / x.length;
}

export interface Ranked {
  chunk: Chunk;
  score: number;
  /** Share of the query's content terms this chunk holds. */
  covers: number;
}

/** BM25 (k1 1.2, b 0.75) of a query over the chunks, best first; ties by chunk order so the result is stable. */
export function bm25(chunks: Chunk[], query: string, top = 5): Ranked[] {
  const q = [...termSet(query)];
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => contentTerms(c.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = chunks.length;
  const ranked = chunks.map((chunk, i) => {
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    let hit = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      hit++;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.length) / avg));
    }
    return { chunk, score, covers: hit / q.length, i };
  });
  return ranked
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, top)
    .map(({ chunk, score, covers }) => ({ chunk, score, covers }));
}

/** A seeded generator (mulberry32 over a string seed): the same seed picks the same chunks. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) (h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)), (h = (h << 13) | (h >>> 19));
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
