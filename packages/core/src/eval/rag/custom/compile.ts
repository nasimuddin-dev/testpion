/**
 * A custom metric file becomes a metric (planning/rag-testing.md §4d): a definition in the same registry as the built-in
 * ones, under `custom/<id>` (and the bare id when no built-in uses that name), and a check the engine runs wherever a check
 * runs. `syncCustomMetrics(store)` registers every valid file of the workspace's `metrics/` folder and removes the ones whose
 * file went away; every host calls it when it starts a run, so an edit made outside the app counts at the next run.
 */
import type { CustomMetricExampleSample, CustomMetricFile } from '@testpion/shared';
import type { CheckConfig, CheckResult } from '../../../model/types.js';
import type { ProviderRegistry } from '../../../ai/index.js';
import { listMetricFiles } from '../../../storage/metric-files.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import { registerCheck, unregisterCheck } from '../../checks.js';
import type { RagJudgeSetup } from '@testpion/shared';
import type { RagJudgeHost } from '../judge.js';
import { judgeEstimate } from '../metric-defs.js';
import { getMetric, metricCatalogue, nameTaken, registerMetric, resolveMetric, unregisterMetric, type MetricDef, type MetricInput } from '../metric-registry.js';
import { contextOfSample } from '../try-metric.js';
import { defaultThreshold, checkOf, type CustomCheck } from './kinds.js';
import { parseFormula } from './formula.js';
import { parseCustomMetric, scoringHash, type MetricProblem } from './file.js';

export interface CompiledMetric {
  def: MetricDef;
  check: CustomCheck;
  file: CustomMetricFile;
  hash: string;
}

const HOW: Record<CustomMetricFile['kind'], (f: CustomMetricFile) => string> = {
  judge: (f) => (Array.isArray(f.scale) ? `A judge rates the answer from ${f.scale[0]} to ${f.scale[1]} against the criterion; the score is the rating on that scale from 0 to 1.` : 'A judge decides whether the answer meets the criterion: 1 or 0.'),
  checklist: (f) => `A judge checks ${f.items?.length ?? 0} yes/no criteria in one call; the score is the weighted share that are met.`,
  rule: (f) => `${f.rules?.length ?? 0} deterministic rules (${f.combine ?? 'all'}): no model.`,
  formula: (f) => `${f.expression ?? ''}: an expression over other metrics, which run first.`,
  'embedding-set': () => 'The cosine closeness of the answer to the good answers (and its distance from the bad ones), by embedding.',
  script: () => 'A sandboxed script returns the score from the sample (no network, no files).',
};

/** The definition a file compiles to. */
export function defOf(f: CustomMetricFile, hash: string): MetricDef {
  const id = `custom/${f.id}`;
  const judged = f.kind === 'judge' || f.kind === 'checklist';
  const inputs = (f.inputs ?? ['question', 'answer']) as MetricInput[];
  const requires: MetricInput[] = [...new Set<MetricInput>(['answer', ...inputs.filter((i) => i !== 'answer'), ...(f.kind === 'judge' && f.reference === 'guided' ? (['reference'] as const) : [])])];
  const refs = f.kind === 'formula' ? parseFormula(f.expression ?? '').refs.map((r) => resolveMetric(r)?.def).filter((d): d is MetricDef => !!d) : [];
  const formulaJudged = refs.some((d) => d.judge === 'service' || d.kind === 'judged');
  const first = f.examples?.[0];
  const kind: MetricDef['kind'] = judged || formulaJudged ? 'judged' : f.kind === 'embedding-set' ? 'embedding' : 'deterministic';
  const def: MetricDef = {
    id,
    name: f.name || f.id,
    group: 'custom',
    kind,
    direction: f.direction ?? 'higher',
    what: f.description?.trim() || `${f.name || f.id}: a custom ${f.kind} metric of this workspace.`,
    how: HOW[f.kind](f),
    example: first ? `Example “${first.name ?? 'first'}”: ${first.expect === 'pass' ? 'passes' : 'fails'}.` : 'No example yet: add examples to the file; they are its regression tests.',
    requires: f.kind === 'formula' ? [...new Set(refs.flatMap((d) => d.requires))] : f.kind === 'rule' || f.kind === 'script' || f.kind === 'embedding-set' ? ['answer'] : requires,
    ...(f.kind === 'embedding-set' ? { optional: ['goodAnswers' as MetricInput] } : {}),
    threshold: defaultThreshold(f),
    check: id,
    aliases: nameTaken(f.id, id) ? [] : [f.id],
    judge: judged || formulaJudged ? 'service' : undefined,
    prompts: judged ? [`${f.id}-t<hash of the criteria>`] : undefined,
    calls: f.kind === 'judge' ? String(Math.max(1, f.votes ?? 1)) : f.kind === 'checklist' ? '1' : f.kind === 'formula' ? 'the sum of its inputs' : f.kind === 'embedding-set' ? '0 model calls, one embedding call' : '0',
    version: `${f.id}-v${f.version ?? 1}`,
    sources: [],
    custom: { kind: f.kind, fileVersion: f.version ?? 1, hash, file: `metrics/${f.id}.yaml` },
    estimate: (s, o) => {
      if (f.kind === 'judge') return judgeEstimate(s, { calls: Math.max(1, f.votes ?? 1), prompt: 120 + Math.ceil((f.criteria?.length ?? 0) / 4), reads: ['answerTokens', ...(inputs.includes('question') ? (['questionTokens'] as const) : []), ...(inputs.includes('contexts') ? (['contextTokens'] as const) : []), ...(f.reference === 'guided' || inputs.includes('reference') ? (['referenceTokens'] as const) : [])], items: () => 1 });
      if (f.kind === 'checklist') return judgeEstimate(s, { prompt: 120 + (f.items ?? []).reduce((a, i) => a + Math.ceil((typeof i === 'string' ? i : i.text).length / 4), 0), reads: ['questionTokens', 'answerTokens'], items: () => f.items?.length ?? 1 });
      if (f.kind === 'embedding-set') return { llmCalls: 0, embedCalls: 1, inputTokens: s.answerTokens + (f.good?.length ?? 1) * s.referenceTokens, outputTokens: 0 };
      if (f.kind === 'formula')
        return refs.reduce((a, d) => {
          const e = d.estimate?.(s, o) ?? { llmCalls: 0, embedCalls: 0, inputTokens: 0, outputTokens: 0 };
          return { llmCalls: a.llmCalls + e.llmCalls, embedCalls: a.embedCalls + e.embedCalls, inputTokens: a.inputTokens + e.inputTokens, outputTokens: a.outputTokens + e.outputTokens };
        }, { llmCalls: 0, embedCalls: 0, inputTokens: 0, outputTokens: 0 });
      return { llmCalls: 0, embedCalls: 0, inputTokens: 0, outputTokens: 0 };
    },
  };
  return def;
}

export function compileCustomMetric(f: CustomMetricFile): CompiledMetric {
  const hash = scoringHash(f);
  const def = defOf(f, hash);
  const inner = checkOf(f);
  // every score says which version of the file and which hash of what it computes produced it
  const check: CustomCheck = async (cfg, ctx) => {
    const r = await inner(cfg, ctx);
    return { ...r, metadata: { ...(r.metadata ?? {}), customMetric: { id: def.id, version: f.version ?? 1, hash } } };
  };
  return { def, check, file: f, hash };
}

const registered = new Map<string, string>();

export function registerCustomMetric(c: CompiledMetric): void {
  const old = getMetric(c.def.id);
  if (old) unregisterMetric(c.def.id);
  registerMetric(c.def);
  registerCheck(c.def.check, c.check);
  registered.set(c.def.id, c.hash);
}

export function unregisterCustomMetric(id: string): void {
  unregisterMetric(id);
  unregisterCheck(id);
  registered.delete(id);
}

export interface SyncResult {
  /** The ids registered, `custom/<id>`. */
  registered: string[];
  /** Files that could not be registered, with why. */
  files: Array<{ id: string; path: string; problems: MetricProblem[] }>;
}

/** Formula metrics that read each other in a circle cannot run: found over the whole set, since a file only knows its own text. */
function cycleProblems(all: Map<string, CustomMetricFile>): Map<string, MetricProblem> {
  const edges = new Map<string, string[]>();
  for (const [id, f] of all) {
    if (f.kind !== 'formula') continue;
    const reads = parseFormula(f.expression ?? '').refs.map((r) => (r.startsWith('custom/') ? r.slice(7) : r.replace(/_/g, '-'))).filter((r) => all.has(r));
    edges.set(id, reads);
  }
  const out = new Map<string, MetricProblem>();
  const visit = (id: string, path: string[]) => {
    if (path.includes(id)) {
      for (const p of path.slice(path.indexOf(id))) out.set(p, { level: 'error', field: 'expression', message: `The formulas ${[...path.slice(path.indexOf(id)), id].join(' → ')} read each other in a circle.` });
      return;
    }
    for (const n of edges.get(id) ?? []) visit(n, [...path, id]);
  };
  for (const id of edges.keys()) visit(id, []);
  return out;
}

/** Registers the workspace's valid metric files and forgets the ones that are gone. */
export function syncCustomMetrics(store: Pick<WorkspaceStore, 'path'>): SyncResult {
  const files = listMetricFiles(store);
  const known = new Set(files.map((f) => f.id));
  const parsed = new Map<string, CustomMetricFile>();
  const problems = new Map<string, { path: string; problems: MetricProblem[] }>();
  for (const f of files) {
    const p = parseCustomMetric(f.text, { fileId: f.id, known });
    if (p.metric) parsed.set(f.id, p.metric);
    problems.set(f.id, { path: f.path, problems: p.problems });
  }
  const cycles = cycleProblems(parsed);
  const now = new Set<string>();
  // a formula that reads another custom metric is registered after it (its definition takes the inputs of what it reads)
  const dependsOn = (f: CustomMetricFile) => (f.kind === 'formula' ? parseFormula(f.expression ?? '').refs.map((r) => (r.startsWith('custom/') ? r.slice(7) : r.replace(/_/g, '-'))).filter((r) => known.has(r) && r !== f.id) : []);
  let pending = [...parsed.values()].filter((f) => {
    const cyc = cycles.get(f.id);
    if (cyc) problems.get(f.id)!.problems.push(cyc);
    return !cyc;
  });
  for (let progress = true; pending.length && progress; ) {
    progress = false;
    for (const f of [...pending]) {
      if (dependsOn(f).some((d) => !now.has(`custom/${d}`))) continue;
      registerCustomMetric(compileCustomMetric(f));
      now.add(`custom/${f.id}`);
      pending = pending.filter((x) => x !== f);
      progress = true;
    }
  }
  for (const f of pending) problems.get(f.id)!.problems.push({ level: 'error', field: 'expression', message: `It reads a custom metric that has an error (${dependsOn(f).filter((d) => !now.has(`custom/${d}`)).join(', ')}).` });
  for (const id of [...registered.keys()]) if (!now.has(id)) unregisterCustomMetric(id);
  return {
    registered: [...now],
    files: [...problems.entries()].filter(([, v]) => v.problems.length).map(([id, v]) => ({ id, path: v.path, problems: v.problems })),
  };
}

/** The custom metrics registered now. */
export const customMetrics = (): MetricDef[] => metricCatalogue().filter((m) => m.custom);

/* ------------------------------------------------------------------ examples */

export interface ExampleResult {
  index: number;
  name?: string;
  expect: 'pass' | 'fail';
  /** What the metric gave: pass, fail, or n/a (no score: a missing input, a script error). */
  got: 'pass' | 'fail' | 'na';
  ok: boolean;
  score?: number;
  message: string;
}

/** The sample an example describes, in the form a check context is built from. */
export function exampleSample(s: CustomMetricExampleSample) {
  return {
    question: s.question,
    answer: s.answer,
    reference: s.reference,
    contexts: (s.contexts ?? []).map((c, i) => (typeof c === 'string' ? { id: `doc-${i + 1}`, text: c } : { id: c.id ?? `doc-${i + 1}`, text: c.text })),
    referenceContexts: s.referenceContexts,
    referenceIds: s.referenceIds,
    record: s.record as never,
  };
}

/** Runs the examples of a metric through its check: each must come out as the example says. */
export async function runMetricExamples(c: CompiledMetric, deps: { providers?: ProviderRegistry; ragJudge?: RagJudgeHost; judge?: RagJudgeSetup; signal?: AbortSignal; only?: number[] }): Promise<ExampleResult[]> {
  const out: ExampleResult[] = [];
  for (const [index, ex] of (c.file.examples ?? []).entries()) {
    if (deps.only && !deps.only.includes(index)) continue;
    const ctx = contextOfSample(exampleSample(ex.sample), { judge: deps.judge, providers: deps.providers, ragJudge: deps.ragJudge, signal: deps.signal });
    ctx.ragRun = { strict: true, metrics: [c.def.id] };
    let r: CheckResult;
    try {
      r = await c.check({ type: c.def.check } as CheckConfig, ctx);
    } catch (e) {
      r = { type: c.def.check, name: c.def.id, passed: false, source: 'deterministic', message: (e as Error).message };
    }
    const na = !!(r.metadata as { na?: string } | undefined)?.na || typeof r.score !== 'number';
    const got: ExampleResult['got'] = na ? 'na' : r.passed ? 'pass' : 'fail';
    out.push({ index, ...(ex.name ? { name: ex.name } : {}), expect: ex.expect, got, ok: got === ex.expect, ...(typeof r.score === 'number' ? { score: r.score } : {}), message: r.message.slice(0, 300) });
  }
  return out;
}
