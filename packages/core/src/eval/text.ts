/** Lightweight text utilities used by heuristic evaluators (no external NLP dependencies). */

const STOPWORDS = new Set(
  'a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those i you he she we they me my your our their them his her not no do does did have has had can could should would will shall may might must so than too very just also into over under about what which who whom whose when where why how all any each few more most other some such only own same both there here out up down off again further once'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 || /\d/.test(w));
}

export function contentWords(text: string): string[] {
  return tokenize(text).filter((w) => !STOPWORDS.has(w));
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => contentWords(s).length > 0);
}

/** Cosine similarity over term-frequency vectors. */
export function lexicalCosine(a: string, b: string): number {
  const ta = termFreq(contentWords(a));
  const tb = termFreq(contentWords(b));
  let dot = 0;
  for (const [k, v] of ta) dot += v * (tb.get(k) ?? 0);
  const na = Math.sqrt([...ta.values()].reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt([...tb.values()].reduce((s, v) => s + v * v, 0));
  return na && nb ? dot / (na * nb) : a.trim() === b.trim() ? 1 : 0;
}

/** Token-overlap F1 (SQuAD-style). */
export function tokenF1(prediction: string, reference: string): number {
  const p = contentWords(prediction);
  const r = contentWords(reference);
  if (!p.length || !r.length) return p.length === r.length ? 1 : 0;
  const rc = termFreq(r);
  let common = 0;
  for (const w of p) {
    const n = rc.get(w) ?? 0;
    if (n > 0) {
      common++;
      rc.set(w, n - 1);
    }
  }
  if (!common) return 0;
  const precision = common / p.length;
  const recall = common / r.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Fraction of `needle`'s content words present in `haystack`. */
export function coverage(needle: string, haystack: string): number {
  return coverageIn(needle, wordSet(haystack));
}

/** The content words of a text as a set: build it once when many needles are checked against the same text. */
export const wordSet = (text: string) => new Set(contentWords(text));

/** `coverage` against a prepared word set. */
export function coverageIn(needle: string, haystack: Set<string>): number {
  const n = contentWords(needle);
  if (!n.length) return 1;
  return n.filter((w) => haystack.has(w)).length / n.length;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function termFreq(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}
