/**
 * The statistics of judge calibration (planning/rag-testing.md R4; ai-features.md AI-11): how well a judge's pass/fail
 * verdicts agree with a person's. Pure functions over pairs of booleans; "pass" is the positive class and the person is the
 * truth, so TPR is how many of the answers a person passed the judge also passed. Cohen's kappa is reported (not only raw
 * agreement) because most RAG samples pass, and a judge that always says "pass" agrees with them most of the time.
 */
import { mulberry32 } from '../../../util/random.js';

export interface Pair {
  /** The judge's verdict at the metric's threshold. */
  judge: boolean;
  /** The person's label. */
  human: boolean;
}

export interface Confusion {
  /** judge pass, human pass */
  tp: number;
  /** judge pass, human fail (the judge is too lenient) */
  fp: number;
  /** judge fail, human pass (the judge is too strict) */
  fn: number;
  /** judge fail, human fail */
  tn: number;
}

export interface Agreement {
  n: number;
  confusion: Confusion;
  accuracy?: number;
  /** Cohen's kappa; absent when it is not defined (see `kappaNote`). */
  kappa?: number;
  kappaNote?: string;
  tpr?: number;
  tnr?: number;
  precision?: number;
  recall?: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const div = (a: number, b: number): number | undefined => (b > 0 ? a / b : undefined);

export function confusionOf(pairs: ReadonlyArray<Pair>): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const p of pairs) {
    if (p.judge) p.human ? c.tp++ : c.fp++;
    else p.human ? c.fn++ : c.tn++;
  }
  return c;
}

/** Cohen's kappa of a 2x2 table, or why it is undefined (all samples fall in one class on both sides, or no samples). */
export function cohenKappa(c: Confusion): { kappa?: number; note?: string } {
  const n = c.tp + c.fp + c.fn + c.tn;
  if (n === 0) return { note: 'no labelled samples' };
  const po = (c.tp + c.tn) / n;
  const pe = ((c.tp + c.fp) * (c.tp + c.fn) + (c.fn + c.tn) * (c.fp + c.tn)) / (n * n);
  if (pe >= 1) return { note: 'the judge and the labels all fall in one class, so chance agreement is complete and kappa is not defined' };
  return { kappa: (po - pe) / (1 - pe) };
}

export function agreementOf(pairs: ReadonlyArray<Pair>): Agreement {
  const c = confusionOf(pairs);
  const n = pairs.length;
  const k = cohenKappa(c);
  const tpr = div(c.tp, c.tp + c.fn);
  return {
    n,
    confusion: c,
    ...(n ? { accuracy: r3((c.tp + c.tn) / n) } : {}),
    ...(k.kappa !== undefined ? { kappa: r3(k.kappa) } : { kappaNote: k.note }),
    ...(tpr !== undefined ? { tpr: r3(tpr), recall: r3(tpr) } : {}),
    ...(div(c.tn, c.tn + c.fp) !== undefined ? { tnr: r3(div(c.tn, c.tn + c.fp)!) } : {}),
    ...(div(c.tp, c.tp + c.fp) !== undefined ? { precision: r3(div(c.tp, c.tp + c.fp)!) } : {}),
  };
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 1e-9)))]!;

export interface Interval {
  kappa?: [number, number];
  accuracy?: [number, number];
  rounds: number;
}

/** A seeded bootstrap 95% interval of kappa and accuracy: the same pairs always give the same interval. */
export function bootstrapAgreement(pairs: ReadonlyArray<Pair>, o: { seed?: number; rounds?: number } = {}): Interval {
  const n = pairs.length;
  const rounds = o.rounds ?? (n > 2000 ? 200 : 1000);
  if (n < 3) return { rounds: 0 };
  const rnd = mulberry32((o.seed ?? 0x5eed) + n);
  const kappas: number[] = [];
  const accs: number[] = [];
  for (let b = 0; b < rounds; b++) {
    const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (let i = 0; i < n; i++) {
      const p = pairs[Math.floor(rnd() * n)]!;
      if (p.judge) p.human ? c.tp++ : c.fp++;
      else p.human ? c.fn++ : c.tn++;
    }
    accs.push((c.tp + c.tn) / n);
    const k = cohenKappa(c).kappa;
    if (k !== undefined) kappas.push(k);
  }
  accs.sort((a, b) => a - b);
  kappas.sort((a, b) => a - b);
  return {
    rounds,
    accuracy: [r3(quantile(accs, 0.025)), r3(quantile(accs, 0.975))],
    // an interval of kappa needs enough resamples where it is defined
    ...(kappas.length >= rounds / 2 ? { kappa: [r3(quantile(kappas, 0.025)), r3(quantile(kappas, 0.975))] as [number, number] } : {}),
  };
}

interface ScoredPair {
  score: number;
  human: boolean;
}

export interface Tuning {
  /** The threshold with the most agreement (kappa, then accuracy), nearest the current one on a tie. */
  threshold: number;
  agreement: Agreement;
  current?: { threshold: number; agreement: Agreement };
  /** Kappa at the best threshold less kappa at the current one (absent when either is undefined). */
  gain?: number;
  /** Fewer than this many labels of each class make a tuned threshold fragile. */
  warning?: string;
}

const passAt = (score: number, t: number, dir: 'higher' | 'lower') => (dir === 'higher' ? score >= t : score <= t);
const pairsAt = (xs: ReadonlyArray<ScoredPair>, t: number, dir: 'higher' | 'lower'): Pair[] => xs.map((x) => ({ judge: passAt(x.score, t, dir), human: x.human }));
/** Kappa first, then accuracy; when the labels are all one class kappa means nothing, so accuracy decides. */
const key = (a: Agreement, oneClass: boolean) => (oneClass ? [a.accuracy ?? 0, 0] : [a.kappa ?? -2, a.accuracy ?? 0]);

/**
 * Scan every threshold that changes a verdict and keep the one that agrees best with the labels. The reported threshold
 * is the middle of the gap between the two scores it separates (rounded to 3 decimals when that still separates them), so
 * it does not sit exactly on a stored score.
 */
export function tuneThreshold(xs: ReadonlyArray<ScoredPair>, dir: 'higher' | 'lower', current?: number): Tuning | undefined {
  if (!xs.length) return undefined;
  const vals = [...new Set(xs.map((x) => x.score))].sort((a, b) => a - b);
  // a candidate is a score value (pass iff score >= it for 'higher', <= it for 'lower'), plus "everything passes" / "nothing passes" ends
  let best: { t: number; a: Agreement; dist: number } | undefined;
  const oneClass = xs.every((x) => x.human === xs[0]!.human);
  const consider = (t: number) => {
    const a = agreementOf(pairsAt(xs, t, dir));
    const dist = current === undefined ? 0 : Math.abs(t - current);
    const [k1, c1] = key(a, oneClass);
    const [k2, c2] = best ? key(best.a, oneClass) : [-Infinity, -Infinity];
    if (!best || k1! > k2! || (k1 === k2 && c1! > c2!) || (k1 === k2 && c1 === c2 && dist < best.dist)) best = { t, a, dist };
  };
  for (const v of vals) consider(v);
  const b = best!;
  // move the chosen value to the middle of the gap towards the side that fails
  const i = vals.indexOf(b.t);
  const other = dir === 'higher' ? vals[i - 1] : vals[i + 1];
  let t = b.t;
  if (other !== undefined) {
    const mid = (b.t + other) / 2;
    const rounded = Math.round(mid * 1000) / 1000;
    const sep = (x: number) => (dir === 'higher' ? x > other && x <= b.t : x < other && x >= b.t);
    t = sep(rounded) ? rounded : sep(mid) ? mid : b.t;
  }
  const cur = current === undefined ? undefined : { threshold: current, agreement: agreementOf(pairsAt(xs, current, dir)) };
  const pos = xs.filter((x) => x.human).length;
  const neg = xs.length - pos;
  return {
    threshold: Math.round(t * 10000) / 10000,
    agreement: b.a,
    ...(cur ? { current: cur } : {}),
    ...(cur && cur.agreement.kappa !== undefined && b.a.kappa !== undefined ? { gain: r3(b.a.kappa - cur.agreement.kappa) } : {}),
    ...(Math.min(pos, neg) < 5 ? { warning: `Only ${Math.min(pos, neg)} label${Math.min(pos, neg) === 1 ? '' : 's'} of one class: label more samples (5 or more of each) before trusting a tuned threshold.` } : {}),
  };
}
