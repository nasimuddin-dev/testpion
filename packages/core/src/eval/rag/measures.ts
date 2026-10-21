/**
 * The deterministic RAG measures, as pure functions (no model, no network): answer against reference (normalised match,
 * token F1, ROUGE-1/2/L) and the retrieval against the gold chunk ids (precision and recall by id). Each has its
 * worked example in tests/unit/rag-measures.test.ts and in docs/ai-testing/rag.md.
 */

/** SQuAD normalisation: lower case, punctuation removed, the articles a/an/the removed, spaces collapsed. */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower-case word tokens (letters and digits), nothing removed. */
export const wordTokens = (s: string): string[] => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];

interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

const prf = (overlap: number, predicted: number, reference: number): Prf => {
  if (!overlap || !predicted || !reference) return { precision: 0, recall: 0, f1: 0 };
  const precision = overlap / predicted;
  const recall = overlap / reference;
  return { precision, recall, f1: (2 * precision * recall) / (precision + recall) };
};

const counts = (items: string[]) => {
  const m = new Map<string, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** Token-overlap precision, recall and F1 (the SQuAD F1; `normalize` also removes punctuation and articles first). */
export function tokenOverlap(prediction: string, reference: string, o: { normalize?: boolean } = {}): Prf {
  const tokens = (s: string) => wordTokens(o.normalize ? normalizeAnswer(s) : s);
  const p = tokens(prediction);
  const r = tokens(reference);
  const rc = counts(r);
  let common = 0;
  for (const w of p) {
    const n = rc.get(w) ?? 0;
    if (n > 0) {
      common++;
      rc.set(w, n - 1);
    }
  }
  return prf(common, p.length, r.length);
}

export type RougeType = 'rouge1' | 'rouge2' | 'rougeL';

const ngrams = (t: string[], n: number) => {
  const out: string[] = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n).join(' '));
  return out;
};

/** The length of the longest common subsequence of two token lists (O(n·m) time, O(m) space). */
export function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * ROUGE-1, ROUGE-2 (clipped n-gram overlap) or ROUGE-L (longest common subsequence) between a prediction and a
 * reference. Tokens are lower-case words; there is no stemming (the Python rouge-score package can stem), so inflected
 * words differ from its numbers.
 */
export function rouge(prediction: string, reference: string, type: RougeType = 'rougeL'): Prf {
  const p = wordTokens(prediction);
  const r = wordTokens(reference);
  if (type === 'rougeL') return prf(lcsLength(p, r), p.length, r.length);
  const n = type === 'rouge1' ? 1 : 2;
  const pg = ngrams(p, n);
  const rg = counts(ngrams(r, n));
  let overlap = 0;
  for (const g of pg) {
    const c = rg.get(g) ?? 0;
    if (c > 0) {
      overlap++;
      rg.set(g, c - 1);
    }
  }
  return prf(overlap, pg.length, ngrams(r, n).length);
}

/** Retrieval against the gold ids: precision = retrieved ids that are gold / retrieved, recall = gold ids retrieved / gold. */
export function idRetrieval(retrieved: string[], gold: string[]): { precision: number; recall: number; hits: string[]; missed: string[]; extra: string[] } {
  const ret = [...new Set(retrieved)];
  const ref = new Set(gold);
  const hits = ret.filter((id) => ref.has(id));
  const got = new Set(ret);
  return {
    precision: ret.length ? hits.length / ret.length : 0,
    recall: ref.size ? hits.length / ref.size : 0,
    hits,
    missed: [...ref].filter((id) => !got.has(id)),
    extra: ret.filter((id) => !ref.has(id)),
  };
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
