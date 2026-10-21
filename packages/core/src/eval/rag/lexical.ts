/**
 * The lexical and structural measures of the catalogue (planning/rag-testing.md §2.3, type 5), as pure functions with no
 * dependency: BLEU and chrF as sacreBLEU computes them (so a number here can be compared with Ragas' `bleu_score` and
 * `chrf_score`), a number check, a JSON diff, set precision/recall/F1 of labels and the quoted-span alignment. Each has its
 * worked example in tests/unit/rag-lexical.test.ts.
 */
import { levenshtein } from './ir.js';

/* ------------------------------------------------------------------ BLEU */

/**
 * sacreBLEU's `13a` tokenizer (the WMT default): punctuation is split off, except a period or comma between digits.
 * Written from the reference implementation's regular expressions so the n-gram statistics are the same.
 */
export function tokenize13a(line: string): string[] {
  let s = line.replace(/<skipped>/g, '').replace(/-\n/g, '').replace(/\n/g, ' ');
  if (s.includes('&')) s = s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = ` ${s} `;
  s = s.replace(/([{-~[-` -&(-+:-@/])/g, ' $1 ');
  s = s.replace(/([^0-9])([.,])/g, '$1 $2 ');
  s = s.replace(/([.,])([^0-9])/g, ' $1 $2');
  s = s.replace(/([0-9])(-)/g, '$1 $2 ');
  return s.split(/\s+/).filter(Boolean);
}

const ngramCounts = (tokens: string[], n: number): Map<string, number> => {
  const m = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const g = tokens.slice(i, i + n).join(' ');
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
};

interface BleuStats {
  correct: number[];
  total: number[];
  hypLen: number;
  refLen: number;
}

/** The sufficient statistics of one hypothesis/reference pair (clipped n-gram matches per order, lengths). */
function bleuStats(hyp: string, ref: string, maxOrder = 4): BleuStats {
  const h = tokenize13a(hyp);
  const r = tokenize13a(ref);
  const correct: number[] = [];
  const total: number[] = [];
  for (let n = 1; n <= maxOrder; n++) {
    const hc = ngramCounts(h, n);
    const rc = ngramCounts(r, n);
    let match = 0;
    let all = 0;
    for (const [g, c] of hc) {
      all += c;
      match += Math.min(c, rc.get(g) ?? 0);
    }
    correct.push(match);
    total.push(all);
  }
  return { correct, total, hypLen: h.length, refLen: r.length };
}

/** BLEU from summed statistics, with sacreBLEU's `exp` smoothing: 0..100. */
function bleuFromStats(st: BleuStats, maxOrder = 4): number {
  if (st.hypLen === 0) return 0;
  const precisions = new Array<number>(maxOrder).fill(0);
  let smooth = 1;
  for (let n = 0; n < maxOrder; n++) {
    if (st.total[n] === 0) break;
    if (st.correct[n] === 0) {
      smooth *= 2;
      precisions[n] = 100 / (smooth * st.total[n]!);
    } else precisions[n] = (100 * st.correct[n]!) / st.total[n]!;
  }
  const bp = st.hypLen >= st.refLen ? 1 : Math.exp(1 - st.refLen / st.hypLen);
  // sacreBLEU's log of a zero precision is a hugely negative number, so a hypothesis shorter than the order scores about 0
  const log = (p: number) => (p > 0 ? Math.log(p) : -9999999999);
  return bp * Math.exp(precisions.reduce((a, p) => a + log(p), 0) / maxOrder);
}

/** Ragas splits both texts on ". " and scores them as one corpus; `whole` scores each text as a single segment. */
function bleuSegments(text: string, mode: 'ragas' | 'whole'): string[] {
  if (mode === 'whole') return [text];
  const parts = text.split('. ').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

/** Corpus BLEU (0..1) of an answer against a reference, as Ragas' BleuScore (sacreBLEU `corpus_bleu` / 100). */
export function bleu(answer: string, reference: string, o: { segmentation?: 'ragas' | 'whole'; maxOrder?: number } = {}): { score: number; stats: BleuStats } {
  const mode = o.segmentation ?? 'ragas';
  const maxOrder = o.maxOrder ?? 4;
  const a = bleuSegments(answer, mode);
  const r = bleuSegments(reference, mode);
  const sum: BleuStats = { correct: new Array<number>(maxOrder).fill(0), total: new Array<number>(maxOrder).fill(0), hypLen: 0, refLen: 0 };
  // a segment is compared with the reference segment at the same position; surplus segments meet an empty one
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const st = bleuStats(a[i] ?? '', r[i] ?? '', maxOrder);
    st.correct.forEach((c, n) => (sum.correct[n]! += c));
    st.total.forEach((c, n) => (sum.total[n]! += c));
    sum.hypLen += st.hypLen;
    sum.refLen += st.refLen;
  }
  return { score: bleuFromStats(sum, maxOrder) / 100, stats: sum };
}

/* ------------------------------------------------------------------ chrF */

const charNgrams = (s: string, n: number): Map<string, number> => {
  const m = new Map<string, number>();
  const chars = [...s];
  for (let i = 0; i + n <= chars.length; i++) {
    const g = chars.slice(i, i + n).join('');
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
};

/**
 * chrF as sacreBLEU computes it (character order 6, word order 0, beta 2, whitespace ignored): the character n-gram
 * precision and recall are averaged over the orders that both texts have, and the F-beta of the two averages is the score.
 */
export function chrf(hyp: string, ref: string, o: { charOrder?: number; beta?: number } = {}): number {
  const order = o.charOrder ?? 6;
  const factor = (o.beta ?? 2) ** 2;
  const h = hyp.replace(/\s+/g, '');
  const r = ref.replace(/\s+/g, '');
  let avgP = 0;
  let avgR = 0;
  let effective = 0;
  for (let n = 1; n <= order; n++) {
    const hc = charNgrams(h, n);
    const rc = charNgrams(r, n);
    let nh = 0;
    let nr = 0;
    let match = 0;
    for (const [g, c] of hc) {
      nh += c;
      match += Math.min(c, rc.get(g) ?? 0);
    }
    for (const c of rc.values()) nr += c;
    if (nh > 0 && nr > 0) {
      avgP += match / nh;
      avgR += match / nr;
      effective++;
    }
  }
  if (!effective) return 0;
  avgP /= effective;
  avgR /= effective;
  return avgP + avgR > 0 ? ((1 + factor) * avgP * avgR) / (factor * avgP + avgR) : 0;
}

/* ------------------------------------------------------------------ numbers, JSON, labels */

/** The first number in a text (`$1,250.50` → 1250.5, `95%` → 95), or undefined. */
export function firstNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /-?\d[\d,]*(?:\.\d+)?(?:[eE][+-]?\d+)?|-?\.\d+/.exec(v);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,(?=\d{3}\b)/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** 1 − |a − b| / max(|a|, |b|): 1 for two equal numbers (and two zeros), never below 0. */
export function numericSimilarity(a: number, b: number): number {
  if (a === b) return 1;
  const d = Math.max(Math.abs(a), Math.abs(b));
  return d === 0 ? 1 : Math.max(0, 1 - Math.abs(a - b) / d);
}

export type NumericOp = '==' | '!=' | '>' | '>=' | '<' | '<=';
export function numericCompare(a: number, b: number, op: NumericOp, epsilon = 0): boolean {
  switch (op) {
    case '==':
      return Math.abs(a - b) <= epsilon;
    case '!=':
      return Math.abs(a - b) > epsilon;
    case '>':
      return a - b > epsilon;
    case '>=':
      return a - b >= -epsilon;
    case '<':
      return b - a > epsilon;
    case '<=':
      return b - a >= -epsilon;
  }
}

const textSimilarity = (a: string, b: string) => {
  const longer = Math.max(a.length, b.length);
  return longer ? 1 - levenshtein(a.slice(0, 4000), b.slice(0, 4000)) / longer : 1;
};

/**
 * Braintrust's JSONDiff: objects average the similarity of every key of either side (a missing key is 0), arrays average
 * element by element over the longer length, strings use the edit similarity, numbers the numeric one, the rest are equal or not.
 */
export function jsonSimilarity(a: unknown, b: unknown): number {
  if (a === b) return 1;
  if (a === null || b === null || a === undefined || b === undefined) return 0;
  if (typeof a === 'number' && typeof b === 'number') return numericSimilarity(a, b);
  if (typeof a === 'string' && typeof b === 'string') return textSimilarity(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    if (!n) return 1;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += i < a.length && i < b.length ? jsonSimilarity(a[i], b[i]) : 0;
    return sum / n;
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    if (!keys.size) return 1;
    let sum = 0;
    for (const k of keys) {
      const x = (a as Record<string, unknown>)[k];
      const y = (b as Record<string, unknown>)[k];
      sum += k in (a as object) && k in (b as object) ? jsonSimilarity(x, y) : 0;
    }
    return sum / keys.size;
  }
  return 0;
}

/** Precision, recall and F1 of two label sets (case and surrounding space ignored by default). */
export function labelPrf(predicted: string[], expected: string[], o: { caseSensitive?: boolean } = {}): { precision: number; recall: number; f1: number; hits: string[]; missing: string[]; extra: string[] } {
  const norm = (s: string) => (o.caseSensitive ? s.trim() : s.trim().toLowerCase());
  const p = new Map(predicted.map((x) => [norm(x), x]));
  const e = new Map(expected.map((x) => [norm(x), x]));
  const hits = [...p.keys()].filter((k) => e.has(k));
  const precision = p.size ? hits.length / p.size : 0;
  const recall = e.size ? hits.length / e.size : 0;
  return {
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    hits: hits.map((k) => p.get(k)!),
    missing: [...e.keys()].filter((k) => !p.has(k)).map((k) => e.get(k)!),
    extra: [...p.keys()].filter((k) => !e.has(k)).map((k) => p.get(k)!),
  };
}

/** The quoted spans of a text with at least `minWords` words ("…", “…”, or '…' that does not start inside a word). */
export function quotedSpans(text: string, minWords = 3): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|“([^”]+)”|(?:^|[^\p{L}\p{N}])'([^']+)'(?![\p{L}\p{N}])/gu;
  for (const m of text.matchAll(re)) {
    const span = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (span.split(/\s+/).filter(Boolean).length >= minWords) out.push(span);
  }
  return out;
}

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Which quoted spans of the answer occur verbatim (case-folded) in the contexts. */
export function quotedSpansAlignment(answer: string, contexts: string[], o: { minWords?: number; caseSensitive?: boolean } = {}): { spans: string[]; found: boolean[] } {
  const spans = quotedSpans(answer, o.minWords ?? 3);
  const f = (s: string) => (o.caseSensitive ? s.replace(/\s+/g, ' ').trim() : fold(s));
  const hay = contexts.map(f);
  return { spans, found: spans.map((s) => hay.some((h) => h.includes(f(s)))) };
}
