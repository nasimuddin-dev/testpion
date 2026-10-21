/**
 * Pairs a run's judged results with human labels (planning/rag-testing.md R4). Labels are matched to results by dataset
 * record (the id after the last `:` of the result id) and by metric; a person's good/bad review of a whole result stands in
 * for the metric `overall` (pass = every check of the result passed) when there is no label for it. A label made about a
 * different answer than the one this run gave is left out and counted as stale: a verdict on another answer says nothing
 * about this one. Pure: the results are passed in (the runner reads them).
 */
import type { TestResult } from '../../../model/types.js';
import { resolveMetric } from '../metric-registry.js';
import { hash12, recordOfResult, transcriptText, type RagLabel } from './labels.js';

export const OVERALL = 'overall';

export interface CalibrationSample {
  record: string;
  resultId: string;
  metric: string;
  /** Where the human verdict came from. */
  source: 'label' | 'review';
  /** The metric's own score and the pass mark used (absent for `overall` or a check without a number). */
  score?: number;
  threshold?: number;
  direction: 'higher' | 'lower';
  judgePass: boolean;
  humanPass: boolean;
  /** `provider/model` of the judge as the check recorded it (a jury: `jury of 3 (majority)`). */
  judge: string;
  /** A jury: what each member said about this sample. */
  jury?: Array<{ judge: string; pass: boolean; score?: number }>;
  /** The catalogue group of the metric (safety, conversation, agent …). */
  group?: string;
  /** A conversation: its last turns (the metrics of a conversation judge the whole transcript). */
  conversation?: Array<{ role: string; content: string }>;
  promptVersion?: string;
  question?: string;
  answer?: string;
  reason?: string;
  note?: string;
}

export interface Collected {
  samples: CalibrationSample[];
  /** Labels whose record is not in this run, or about an answer that is not this run's. */
  missing: number;
  stale: number;
  results: number;
}

const canon = (m: string) => resolveMetric(m)?.def.id ?? m;
const judgeName = (j: unknown): string => {
  const x = j as { provider?: string; model?: string } | undefined;
  return x?.provider || x?.model ? `${x.provider ?? '?'}/${x.model ?? '?'}` : 'no judge recorded';
};

export interface CollectOptions {
  labels?: RagLabel[];
  /** result id → rating, from `runReviews` */
  reviews?: Record<string, { rating?: 'good' | 'bad' }>;
  /** Edited pass marks by column key or metric id, replacing the checks' own (a what-if). */
  thresholds?: Record<string, number>;
  /** Only these metrics (ids, aliases or check names). */
  metrics?: string[];
}

export async function collectSamples(results: AsyncIterable<TestResult>, o: CollectOptions = {}): Promise<Collected> {
  const byRecord = new Map<string, RagLabel[]>();
  for (const l of o.labels ?? []) byRecord.set(l.record, [...(byRecord.get(l.record) ?? []), l]);
  const want = o.metrics?.length ? new Set(o.metrics.map(canon)) : undefined;
  const out: Collected = { samples: [], missing: 0, stale: 0, results: 0 };
  const seenRecords = new Set<string>();
  for await (const r of results) {
    out.results++;
    const rag = (r.metadata?.rag ?? {}) as { query?: string; sample?: { answer?: string }; record?: { turns?: Array<{ role: string; content: string }> } };
    const record = recordOfResult(r.id);
    const turns = rag.record?.turns;
    const transcript = hash12(transcriptText(turns));
    seenRecords.add(record);
    const labels = byRecord.get(record) ?? [];
    const answer = rag.sample?.answer;
    // a label about another answer, or about a conversation that went differently, says nothing about this one
    const stale = (l: RagLabel) => (l.answerHash !== undefined && answer !== undefined && l.answerHash !== hash12(answer)) || (l.transcriptHash !== undefined && transcript !== undefined && l.transcriptHash !== transcript);
    const common = { record, resultId: r.id, question: rag.query, answer: answer?.slice(0, 1200), ...(turns?.length ? { conversation: turns.slice(-12).map((t) => ({ role: t.role, content: String(t.content).slice(0, 300) })) } : {}) };
    let overall = false;
    for (const l of labels) {
      if (l.metric === OVERALL) {
        if (stale(l)) {
          out.stale++;
          continue;
        }
        if (want && !want.has(OVERALL)) continue;
        overall = true;
        const scores = r.checks.map((c) => c.score).filter((s): s is number => typeof s === 'number');
        out.samples.push({ ...common, metric: OVERALL, source: 'label', direction: 'higher', ...(scores.length ? { score: Math.min(...scores) } : {}), judgePass: r.status === 'passed', humanPass: l.label === 'pass', judge: 'all checks', note: l.note });
        continue;
      }
      const c = r.checks.find((x) => canon(x.name || x.type) === canon(l.metric) || x.name === l.metric || x.type === l.metric);
      if (!c) continue;
      if (want && !want.has(canon(c.name || c.type)) && !want.has(canon(c.type))) continue;
      const md = (c.metadata ?? {}) as { na?: string; threshold?: number; judge?: unknown; promptVersion?: string; panel?: { judges?: Array<{ provider?: string; model?: string; score?: number; passed?: boolean }>; aggregate?: string } };
      if (md.na) continue;
      if (stale(l)) {
        out.stale++;
        continue;
      }
      const def = resolveMetric(c.type)?.def;
      const direction = def?.direction === 'lower' ? 'lower' : 'higher';
      const key = c.name || c.type;
      const threshold = o.thresholds?.[key] ?? o.thresholds?.[canon(c.type)] ?? (typeof md.threshold === 'number' ? md.threshold : def?.threshold);
      const score = typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : undefined;
      const members = md.panel?.judges;
      const judgePass = score !== undefined && threshold !== undefined ? (direction === 'lower' ? score <= threshold : score >= threshold) : c.passed;
      out.samples.push({
        ...common,
        metric: key,
        source: 'label',
        ...(score !== undefined ? { score } : {}),
        ...(threshold !== undefined ? { threshold } : {}),
        direction,
        judgePass,
        humanPass: l.label === 'pass',
        judge: members && members.length > 1 ? `jury of ${members.length} (${md.panel?.aggregate ?? 'majority'})` : judgeName(md.judge),
        ...(members && members.length > 1 ? { jury: members.map((j) => ({ judge: judgeName(j), pass: j.passed === true, ...(typeof j.score === 'number' ? { score: j.score } : {}) })) } : {}),
        ...(def?.group ? { group: def.group } : {}),
        ...(md.promptVersion ? { promptVersion: md.promptVersion } : {}),
        reason: c.message?.slice(0, 400),
        note: l.note,
      });
    }
    // a person's good/bad review of the whole result, where no label says it better
    const rating = o.reviews?.[r.id]?.rating;
    if (rating && !overall && (!want || want.has(OVERALL))) {
      const scores = r.checks.map((c) => c.score).filter((s): s is number => typeof s === 'number');
      out.samples.push({ ...common, metric: OVERALL, source: 'review', direction: 'higher', ...(scores.length ? { score: Math.min(...scores) } : {}), judgePass: r.status === 'passed', humanPass: rating === 'good', judge: 'all checks' });
    }
  }
  for (const l of o.labels ?? []) if (!seenRecords.has(l.record)) out.missing++;
  return out;
}
