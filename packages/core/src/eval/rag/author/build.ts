/**
 * The evaluation a plan describes, built by TestPion from the plan (the model chooses; TestPion writes the file): a metric
 * that is not in the catalogue, cannot run on this data or has a pass mark outside its scale is dropped or fixed with a
 * note, never silently, so what is offered always runs. The result is a saved evaluation (library `evaluations`) as YAML text
 * for the review, plus the gates, which a saved evaluation has no field for: they travel as `--min` flags for `rag run`, a
 * monitor and CI, and the proposal says so.
 */
import { stringifyYaml } from '../../../util/lazy-yaml.js';
import type { CheckConfig } from '../../../model/types.js';
import type { SavedEvaluation } from '../../../runner/saved-evaluations.js';
import { columnName, metricToCheck, resolveMetric, type MetricDef } from '../metric-registry.js';
import { listOf } from '../lists.js';
import type { AuthorLocal, AuthorPlan } from './types.js';

export const MAX_INLINE_RECORDS = 300;

export interface BuiltEvaluation {
  evaluation: SavedEvaluation;
  /** The gates that survived, by canonical metric id (the lowest mean a run may have). */
  gates: Record<string, number>;
  /** `--min` flags a run, a monitor or CI takes. */
  gateFlags: string[];
  baseline: 'previous' | 'none';
  /** Records of the dataset in the evaluation, and how many the dataset has. */
  records: { used: number; total: number };
  /** What TestPion changed or dropped in the plan, one line each. */
  notes: string[];
  yaml: string;
}

const clean = (s: unknown, max = 80) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A name no saved evaluation has: "Clinic RAG", "Clinic RAG (2)" … */
export function freeName(base: string, existing: string[]): string {
  const used = new Set(existing.map((n) => n.toLowerCase()));
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  return name;
}

/** Whether a metric scores 0 to 1 (so a pass mark outside that range is a mistake). */
const unit = (d: MetricDef) => d.threshold === undefined || (d.threshold >= 0 && d.threshold <= 1);

function evaluatorOf(m: AuthorPlan['metrics'][number], local: AuthorLocal, supplied: Record<string, unknown>, notes: string[], seen: Set<string>): CheckConfig | undefined {
  const id = clean(m?.id, 80);
  const r = id ? resolveMetric(id) : undefined;
  if (!r) {
    notes.push(`Dropped "${id || '?'}": it is not a metric of the catalogue (testpion rag metrics lists them).`);
    return undefined;
  }
  const d = r.def;
  const miss = d.requires.filter((i) => !supplied[i]);
  if (miss.length) {
    notes.push(`Dropped ${d.id}: this data has no ${miss.join(', ')} for it${local.dataset ? '' : ' (no dataset was chosen)'}.`);
    return undefined;
  }
  // only options the metric declares; an invented one would be ignored by the check and look like a setting
  const opts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.options && typeof m.options === 'object' ? m.options : {})) {
    const o = d.options?.[k];
    if (o && typeof v === o.type && (!o.values || o.values.includes(String(v)))) opts[k] = v;
    else notes.push(`${d.id}: the option "${k}" is not one it has (or its value is wrong) and was left out.`);
  }
  let threshold = typeof m.threshold === 'number' && Number.isFinite(m.threshold) ? m.threshold : d.threshold;
  if (threshold !== undefined && unit(d) && (threshold < 0 || threshold > 1)) {
    notes.push(`${d.id}: a pass mark of ${threshold} is outside 0 to 1; its default ${d.threshold ?? 'mark'} is used.`);
    threshold = d.threshold;
  }
  const check = metricToCheck(id, { ...opts, ...(threshold !== undefined ? { threshold } : {}) });
  const col = columnName(d.id, { ...r.options, ...opts });
  if (seen.has(col)) {
    notes.push(`Dropped a second ${col}: it is already in the evaluation.`);
    return undefined;
  }
  seen.add(col);
  return check;
}

/** The records of the slice: tags, every n-th, then the limit (at most MAX_INLINE_RECORDS: the dataset is stored inside the evaluation). */
export function sliceRecords(records: Array<Record<string, unknown>>, slice: NonNullable<AuthorPlan['dataset']>['slice'], notes: string[]): Array<Record<string, unknown>> {
  let out = records;
  const tags = Array.isArray(slice?.tags) ? slice!.tags.map(String) : [];
  if (tags.length) {
    out = out.filter((r) => (listOf(r.tags) ?? []).some((t) => tags.includes(t)));
    if (!out.length) {
      notes.push(`No record has the tag(s) ${tags.join(', ')}: the whole dataset is used.`);
      out = records;
    }
  }
  const every = Math.floor(Number(slice?.every));
  if (every > 1) out = out.filter((_, i) => i % every === 0);
  const asked = Math.floor(Number(slice?.limit));
  let limit = Number.isFinite(asked) && asked >= 1 ? asked : out.length;
  if (limit > MAX_INLINE_RECORDS) {
    notes.push(`The dataset is stored inside the evaluation, so it keeps at most ${MAX_INLINE_RECORDS} records (the plan asked for ${limit}).`);
    limit = MAX_INLINE_RECORDS;
  }
  return out.slice(0, limit);
}

export function buildEvaluation(plan: AuthorPlan, local: AuthorLocal, o: { supplied: Record<string, unknown> }): BuiltEvaluation {
  const notes: string[] = [];
  const seen = new Set<string>();
  const evaluators = (Array.isArray(plan?.metrics) ? plan.metrics : []).map((m) => evaluatorOf(m, local, o.supplied, notes, seen)).filter((e): e is CheckConfig => !!e);
  const records = local.dataset ? sliceRecords(local.dataset.records, plan.dataset?.slice, notes) : [];
  const j = plan.judge ?? {};
  const judge: NonNullable<SavedEvaluation['judge']> = {};
  const provider = local.judge?.provider ?? (j.provider ? clean(j.provider, 60) : undefined);
  if (provider) Object.assign(judge, { provider, ...((local.judge ? local.judge.model : j.model) ? { model: clean(local.judge ? local.judge.model : j.model, 80) } : {}) });
  if (typeof j.samplingShare === 'number') {
    if (j.samplingShare > 0 && j.samplingShare <= 1) judge.sampleShare = j.samplingShare;
    else notes.push(`The judged share ${j.samplingShare} is not more than 0 and at most 1: every sample is judged.`);
  }
  if (j.shortCircuit === true) judge.shortCircuit = true;
  if (j.shareClaims === true) judge.shareClaims = true;
  const gates: Record<string, number> = {};
  for (const [k, v] of Object.entries(plan.gates && typeof plan.gates === 'object' ? plan.gates : {})) {
    const r = resolveMetric(k);
    if (!r) notes.push(`Dropped the gate on "${k}": it is not a metric of the catalogue.`);
    else if (typeof v !== 'number' || !Number.isFinite(v) || (unit(r.def) && (v < 0 || v > 1))) notes.push(`Dropped the gate ${k}=${String(v)}: a gate is a mean on the metric's own scale (0 to 1 for most).`);
    else if (!evaluators.some((e) => resolveMetric(e.type)?.def.id === r.def.id)) notes.push(`Dropped the gate on ${r.def.id}: the evaluation does not run it.`);
    else gates[r.def.id] = v;
  }
  const name = freeName(local.name ?? (clean(plan.name, 60) || `${local.target.name} evaluation`), local.existing);
  if (!evaluators.length) notes.push('No metric is left: add metrics before this evaluation can run.');
  const evaluation: SavedEvaluation = {
    name,
    type: 'rag',
    provider: '',
    model: '',
    prompt: '{{question}}',
    format: 'text',
    datasetFormat: 'jsonl',
    dataset: records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
    expectedField: 'reference',
    evaluators,
    concurrency: Math.max(1, Math.min(local.target.limits?.concurrency ?? 4, 16)),
    retries: 1,
    target: local.target.name,
    ...(Object.keys(judge).length ? { judge } : {}),
    ...(typeof j.maxCostUsd === 'number' && j.maxCostUsd >= 0 ? { maxJudgeCostUsd: j.maxCostUsd } : {}),
    ...(typeof j.maxCalls === 'number' && j.maxCalls >= 0 ? { maxJudgeCalls: Math.floor(j.maxCalls) } : {}),
  };
  const gateFlags = Object.entries(gates).map(([k, v]) => `--min ${k}=${v}`);
  const baseline = plan.baseline === 'previous' ? 'previous' : 'none';
  const head = [`# AI-drafted by TestPion for the target "${local.target.name}": review the metrics and pass marks before running it.`, ...(gateFlags.length ? [`# Gates (a saved evaluation has no field for them): testpion rag run "${name}" ${gateFlags.join(' ')}${baseline === 'previous' ? ' --baseline <previous run>' : ''}`] : [])];
  // the dataset is shown as its size, not repeated in the review (it is the dataset's own file)
  const shown = { ...evaluation, dataset: records.length ? `<${records.length} record${records.length === 1 ? '' : 's'} of ${local.dataset?.name}, kept in the evaluation>` : '' };
  return { evaluation, gates, gateFlags, baseline, records: { used: records.length, total: local.dataset?.total ?? 0 }, notes, yaml: `${head.join('\n')}\n${stringifyYaml(shown, { lineWidth: 0 })}` };
}
