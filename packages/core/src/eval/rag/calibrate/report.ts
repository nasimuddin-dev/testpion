/**
 * The calibration report: per metric (and per judge model within it), how well the judge agrees with the labels, where it
 * disagrees, and which threshold would agree most. Deterministic statistics over stored scores: no model is called.
 */
import { agreementOf, bootstrapAgreement, tuneThreshold, type Agreement, type Interval, type Tuning } from './stats.js';
import { OVERALL, type CalibrationSample, type Collected } from './collect.js';

export interface JudgeAgreement {
  judge: string;
  /** `member` of a jury: its own verdicts; `jury`: the verdict the jury gave together; `single`: a lone judge. */
  role?: 'member' | 'jury' | 'single';
  promptVersion?: string;
  agreement: Agreement;
  interval: Interval;
}

export interface Disagreement {
  record: string;
  resultId: string;
  /** What the judge said and what the person said. */
  judge: 'pass' | 'fail';
  human: 'pass' | 'fail';
  score?: number;
  question?: string;
  answer?: string;
  reason?: string;
  note?: string;
  /** A conversation: its last turns. */
  conversation?: Array<{ role: string; content: string }>;
  /** A jury: who said what. */
  jury?: Array<{ judge: string; pass: boolean }>;
}

export interface MetricCalibration {
  metric: string;
  /** The catalogue group of the metric (safety, conversation, agent …), when it has one. */
  group?: string;
  source: 'label' | 'review' | 'mixed';
  direction: 'higher' | 'lower';
  threshold?: number;
  agreement: Agreement;
  interval: Interval;
  byJudge: JudgeAgreement[];
  disagreements: Disagreement[];
  /** The threshold that agrees most with the labels (needs scores; absent for `overall` and for checks without a number). */
  tuning?: Tuning;
  /** Plain words: how far to trust this judge on this metric. */
  verdict: 'good' | 'fair' | 'poor' | 'unknown';
  advice: string;
}

export interface CalibrationReport {
  run?: string;
  labels?: string;
  results: number;
  labelled: number;
  stale: number;
  missing: number;
  metrics: MetricCalibration[];
}

/** Landis and Koch's bands, in the words the report uses: 0.6 and over is good, 0.4 to 0.6 fair, under that poor. */
export function kappaVerdict(a: Agreement): MetricCalibration['verdict'] {
  if (a.kappa === undefined) return 'unknown';
  return a.kappa >= 0.6 ? 'good' : a.kappa >= 0.4 ? 'fair' : 'poor';
}

function adviceOf(m: Pick<MetricCalibration, 'metric' | 'agreement' | 'verdict' | 'tuning' | 'group'>): string {
  const a = m.agreement;
  if (a.n < 10) return `Only ${a.n} labelled sample${a.n === 1 ? '' : 's'}: label at least 30 (both passes and fails) before relying on these numbers.`;
  if (m.verdict === 'unknown') return a.kappaNote ?? 'Kappa is not defined for these labels.';
  const lenient = a.confusion.fp > a.confusion.fn;
  const base = m.verdict === 'good' ? 'The judge agrees with you well on this metric.' : `The judge disagrees with you ${m.verdict === 'poor' ? 'often' : 'sometimes'} on this metric, mostly by being too ${lenient ? 'lenient (passes what you failed' + (m.group === 'safety' ? ': an unsafe answer gets through' : '') + ')' : 'strict (fails what you passed)'}.`;
  const tune = m.tuning?.gain !== undefined && m.tuning.gain >= 0.05 ? ` Moving the pass mark to ${m.tuning.threshold} would raise kappa by ${m.tuning.gain}.` : m.verdict !== 'good' ? ' Try a clearer criterion or examples for this metric, or a stronger judge model.' : '';
  return base + tune;
}

const sourceOf = (xs: CalibrationSample[]): MetricCalibration['source'] => (xs.every((x) => x.source === 'label') ? 'label' : xs.every((x) => x.source === 'review') ? 'review' : 'mixed');

/** The report over collected samples. `tune` adds the best threshold per metric. `maxDisagreements` bounds each list. */
export function calibrationReport(c: Collected, o: { tune?: boolean; run?: string; labels?: string; maxDisagreements?: number; seed?: number } = {}): CalibrationReport {
  const by = new Map<string, CalibrationSample[]>();
  for (const s of c.samples) by.set(s.metric, [...(by.get(s.metric) ?? []), s]);
  const metrics: MetricCalibration[] = [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([metric, xs]) => {
      const pairs = xs.map((x) => ({ judge: x.judgePass, human: x.humanPass }));
      const agreement = agreementOf(pairs);
      const judges = [...new Set(xs.map((x) => x.judge))];
      const byJudge: JudgeAgreement[] = judges.map((j) => {
        const js = xs.filter((x) => x.judge === j);
        const p = js.map((x) => ({ judge: x.judgePass, human: x.humanPass }));
        const pv = [...new Set(js.map((x) => x.promptVersion).filter(Boolean))].join(', ');
        return { judge: j, role: js.some((x) => x.jury) ? ('jury' as const) : ('single' as const), ...(pv ? { promptVersion: pv } : {}), agreement: agreementOf(p), interval: bootstrapAgreement(p, { seed: o.seed }) };
      });
      // a jury votes as one, but each member also has its own numbers against the same labels
      const members = [...new Set(xs.flatMap((x) => x.jury?.map((m) => m.judge) ?? []))];
      for (const name of members) {
        const p = xs.flatMap((x) => {
          const m = x.jury?.find((j) => j.judge === name);
          return m ? [{ judge: m.pass, human: x.humanPass }] : [];
        });
        byJudge.push({ judge: name, role: 'member', agreement: agreementOf(p), interval: bootstrapAgreement(p, { seed: o.seed }) });
      }
      const scored = xs.filter((x) => x.score !== undefined && metric !== OVERALL);
      const thr = xs.find((x) => x.threshold !== undefined)?.threshold;
      const direction = xs[0]!.direction;
      const tuning = o.tune && scored.length ? tuneThreshold(scored.map((x) => ({ score: x.score!, human: x.humanPass })), direction, thr) : undefined;
      const part = { metric, agreement, tuning, verdict: kappaVerdict(agreement), group: xs[0]!.group };
      return {
        metric,
        ...(xs[0]!.group ? { group: xs[0]!.group } : {}),
        source: sourceOf(xs),
        direction,
        ...(thr !== undefined ? { threshold: thr } : {}),
        agreement,
        interval: bootstrapAgreement(pairs, { seed: o.seed }),
        byJudge,
        disagreements: xs
          .filter((x) => x.judgePass !== x.humanPass)
          .slice(0, o.maxDisagreements ?? 20)
          .map((x) => ({ record: x.record, resultId: x.resultId, judge: x.judgePass ? 'pass' : 'fail', human: x.humanPass ? 'pass' : 'fail', ...(x.score !== undefined ? { score: x.score } : {}), question: x.question, answer: x.answer, reason: x.reason, note: x.note, ...(x.conversation ? { conversation: x.conversation } : {}), ...(x.jury ? { jury: x.jury.map((j) => ({ judge: j.judge, pass: j.pass })) } : {}) })),
        ...(tuning ? { tuning } : {}),
        verdict: part.verdict,
        advice: adviceOf(part),
      };
    });
  return { ...(o.run ? { run: o.run } : {}), ...(o.labels ? { labels: o.labels } : {}), results: c.results, labelled: c.samples.length, stale: c.stale, missing: c.missing, metrics };
}
