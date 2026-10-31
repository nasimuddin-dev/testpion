/**
 * A word-by-word diff of two texts (a prompt before and after an edit): the segments in order, each `same`, `add` (only in the new
 * text) or `del` (only in the old). Whitespace stays with the words, so joining the `same` and `add` segments gives the new text and the
 * `same` and `del` segments give the old one. Longest common subsequence over words, so it is exact; a text over `MAX_WORDS` words is
 * compared line by line instead, to stay fast.
 */
export interface WordSegment {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface WordDiff {
  segments: WordSegment[];
  added: number;
  removed: number;
  /** One sentence: "Added 12 words, removed 4." or "No change." */
  text: string;
}

import { plural } from './format.js';

const MAX_WORDS = 3000;

const tokens = (s: string, byLine: boolean): string[] => (byLine ? (s.match(/[^\n]*\n|[^\n]+/g) ?? []) : (s.match(/\s+|[^\s]+/g) ?? []));
const countWords = (segs: WordSegment[], type: WordSegment['type']) => segs.filter((s) => s.type === type).reduce((n, s) => n + (s.text.match(/\S+/g)?.length ?? 0), 0);

export function wordDiff(before: string, after: string): WordDiff {
  const big = (before.match(/\S+/g)?.length ?? 0) > MAX_WORDS || (after.match(/\S+/g)?.length ?? 0) > MAX_WORDS;
  const a = tokens(before, big);
  const b = tokens(after, big);
  // trim the common start and end: most edits are small
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) (hiA--, hiB--);
  const x = a.slice(lo, hiA);
  const y = b.slice(lo, hiB);
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const raw: WordSegment[] = a.slice(0, lo).map((text) => ({ type: 'same' as const, text }));
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (raw.push({ type: 'same', text: x[i]! }), i++, j++);
    else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) raw.push({ type: 'del', text: x[i++]! });
    else raw.push({ type: 'add', text: y[j++]! });
  }
  while (i < x.length) raw.push({ type: 'del', text: x[i++]! });
  while (j < y.length) raw.push({ type: 'add', text: y[j++]! });
  for (const t of a.slice(hiA)) raw.push({ type: 'same', text: t });
  const segments: WordSegment[] = [];
  for (const s of raw) {
    const last = segments[segments.length - 1];
    if (last && last.type === s.type) last.text += s.text;
    else segments.push({ ...s });
  }
  const added = countWords(segments, 'add');
  const removed = countWords(segments, 'del');
  const text = !added && !removed ? (before === after ? 'No change.' : 'Only spacing changed.') : [added ? `Added ${plural(added, 'word')}` : '', removed ? `${added ? 'removed' : 'Removed'} ${plural(removed, 'word')}` : ''].filter(Boolean).join(', ') + '.';
  return { segments, added, removed, text };
}
