/**
 * Compare mode (AU-16): one evaluation, several variants of it (another prompt version, another model, or both) run on the
 * same cases, and one comparison to read: pass rate, cost and speed per variant, the winner of each row and a sentence.
 * The app (`eval.runVariants`, `eval.variantsSummary`), `testpion eval run --variants` / `eval variants` and the MCP tools
 * (`run_evaluation` with `variants`, `eval_variants`) share this file, so they say the same words.
 */
import { ApsError } from '../errors.js';
import type { RunSummary } from '../model/types.js';
import { evalMatrixPage, resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import type { EvalVariant, SavedEvaluation } from '../runner/saved-evaluations.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { runResults } from '../runner/run-results.js';
import { evalCaseKey, evalMs } from './report.js';
import { trajectoryOf, type Trajectory } from './trajectory.js';
import { diffTrajectory } from './trajectory-diff.js';
import { formatEstimateUsd } from './llm-estimate.js';

type Store = Pick<WorkspaceStore, 'root' | 'runDir' | 'meta'>;

/** The name the first variant, the evaluation as it is, goes by. */
export const CURRENT_VARIANT = 'Current';
/** At most this many columns: the comparison is for a choice between a few. */
export const MAX_VARIANTS = 6;

export interface RunnableVariant {
  /** A, B, C … */
  letter: string;
  label: string;
  /** The name of its runs: "<evaluation> · <label>". */
  runName: string;
  /** The evaluation with the variant's changes, named as its runs are. */
  draft: SavedEvaluation;
}

export const variantRunName = (evaluation: string, label: string): string => `${evaluation} · ${label}`;

/** The variants of an evaluation: the evaluation itself first, then each of its `variants`, as evaluations ready to run. */
export function evaluationVariants(d: SavedEvaluation): RunnableVariant[] {
  const extra: EvalVariant[] = (d.variants ?? []).slice(0, MAX_VARIANTS - 1);
  const seen = new Set<string>([CURRENT_VARIANT.toLowerCase()]);
  const list: Array<EvalVariant | undefined> = [undefined, ...extra];
  const { variants: _drop, ...base } = d;
  return list.map((v, i) => {
    const label = v ? String(v.label || `Variant ${i + 1}`).trim() : CURRENT_VARIANT;
    if (v) {
      if (seen.has(label.toLowerCase())) throw new ApsError('ValidationError', `Two variants are called "${label}": give each its own name`, { suggestions: [] });
      seen.add(label.toLowerCase());
    }
    const runName = variantRunName(d.name, label);
    const draft: SavedEvaluation = {
      ...base,
      name: runName,
      ...(v?.provider ? { provider: v.provider, model: v.model ?? '' } : {}),
      ...(v?.model ? { model: v.model } : {}),
      ...(v?.prompt ? { prompt: v.prompt } : {}),
      ...(v?.system ? { system: v.system } : {}),
      ...(typeof v?.temperature === 'number' ? { temperature: v.temperature } : {}),
    };
    return { letter: String.fromCharCode(65 + i), label, runName, draft };
  });
}

export interface EvalVariantColumn {
  letter: string;
  label: string;
  runId?: string;
  model?: string;
  passed: number;
  total: number;
  passRate: number;
  costUsd: number;
  avgMs?: number;
  /** An agent evaluation (A-9): the tool calls it made per case, and how many cases used the same tools as the first variant. */
  agent?: { avgToolCalls: number; avgModelCalls: number; sameToolsAsFirst?: number; cases: number };
}

export interface EvalVariantRow {
  metric: 'passed' | 'cost' | 'time' | 'tools' | 'same-tools';
  label: string;
  /** The value in each variant, as words, in column order. */
  values: string[];
  /** The letter of the winner; absent for a tie or a row that says nothing (everything free). */
  winner?: string;
  /** "A (+2)", "B (4x cheaper)", "tie". */
  winnerText: string;
}

export interface EvalVariantsSummary {
  evaluation: string;
  /** Every variant has a finished run. */
  ready: boolean;
  /** The variants still running or never run. */
  waiting: string[];
  columns: EvalVariantColumn[];
  rows: EvalVariantRow[];
  /** Cases that got worse or better in a later variant against the first. */
  cases?: { gotWorse: number; gotBetter: number };
  /** The conclusion in one sentence (more when the variants are more than two). */
  conclusion: string;
  /** The run ids in column order: they open in the matrix, the first as the baseline. */
  runs: string[];
}

const ratio = (a: number, b: number): string => {
  const r = Math.round((a / b) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const andJoin = (l: string[]) => (l.length < 2 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

/**
 * The comparison of the runs of an evaluation's variants: the latest finished run of each variant's run name, or the runs
 * given (`runs`, in column order).
 */
export async function variantsSummary(store: Store, o: { evaluation: SavedEvaluation; runs?: string[] }): Promise<EvalVariantsSummary> {
  const variants = evaluationVariants(o.evaluation);
  const found: Array<{ v: RunnableVariant; runId?: string; summary?: RunSummary }> = variants.map((v, i) => {
    const ref = o.runs?.[i];
    if (ref) {
      // a run that has not finished (it is still going) is waited for, not an error
      try {
        const r = resolveRunRef(store, ref);
        return { v, runId: r.runId, summary: readRunSummary(store, r.runId) };
      } catch {
        return { v };
      }
    }
    for (const m of store.meta.listRuns({ query: v.runName, limit: 50 }).items) {
      if (m.name !== v.runName) continue;
      const s = readRunSummary(store, m.id);
      if (s && !s.cancelled) return { v, runId: m.id, summary: s };
    }
    return { v };
  });
  const waiting = found.filter((f) => !f.summary).map((f) => `${f.v.letter}: ${f.v.label}`);
  const columns: EvalVariantColumn[] = found.map((f) => {
    const s = f.summary;
    const total = s ? s.total - s.skipped : 0;
    return {
      letter: f.v.letter,
      label: f.v.label,
      ...(f.runId ? { runId: f.runId } : {}),
      ...(f.v.draft.model ? { model: `${f.v.draft.provider}/${f.v.draft.model}` } : {}),
      passed: s?.passed ?? 0,
      total,
      passRate: total ? (s?.passed ?? 0) / total : 0,
      costUsd: s?.costUsd ?? 0,
      ...(s?.latency.count ? { avgMs: Math.round(s.latency.mean) } : {}),
    };
  });
  const ready = waiting.length === 0 && columns.length > 0;
  const rows: EvalVariantRow[] = [];
  let conclusion = ready ? '' : `Waiting for ${waiting.join(', ')}.`;
  let cases: EvalVariantsSummary['cases'];
  if (ready) {
    // the column with the one best value (highest rate, lowest cost or time); a tie has no winner
    const best = (pick: (c: EvalVariantColumn) => number | undefined, dir: 1 | -1): EvalVariantColumn | undefined => {
      const vals = columns.map(pick).filter((x): x is number => x !== undefined);
      if (vals.length < 2 || new Set(vals).size < 2) return undefined;
      const top = dir === 1 ? Math.max(...vals) : Math.min(...vals);
      const ties = columns.filter((c) => pick(c) === top);
      return ties.length === 1 ? ties[0] : undefined;
    };
    const first = columns[0]!;
    const lowest = Math.min(...columns.map((c) => c.passed));
    const pBest = best((c) => c.passRate, 1);
    rows.push({ metric: 'passed', label: 'Passed', values: columns.map((c) => `${c.passed} of ${c.total}`), winner: pBest?.letter, winnerText: pBest ? `${pBest.letter} (+${pBest.passed - lowest})` : 'tie' });
    const anyCost = columns.some((c) => c.costUsd > 0);
    const cBest = anyCost ? best((c) => c.costUsd, -1) : undefined;
    const worstCost = Math.max(...columns.map((c) => c.costUsd));
    rows.push({
      metric: 'cost',
      label: `Cost for ${plural(first.total, 'case')}`,
      values: columns.map((c) => (c.costUsd > 0 ? formatEstimateUsd(c.costUsd) : 'free')),
      winner: cBest?.letter,
      winnerText: cBest ? `${cBest.letter} (${cBest.costUsd > 0 ? `${ratio(worstCost, cBest.costUsd)}x cheaper` : 'free'})` : anyCost ? 'tie' : 'free',
    });
    const tBest = best((c) => c.avgMs, -1);
    const worstMs = Math.max(...columns.map((c) => c.avgMs ?? 0));
    rows.push({
      metric: 'time',
      label: 'Average time',
      values: columns.map((c) => (c.avgMs !== undefined ? evalMs(c.avgMs) : '–')),
      winner: tBest?.letter,
      winnerText: tBest?.avgMs ? `${tBest.letter} (${ratio(worstMs, tBest.avgMs)}x faster)` : 'tie',
    });
    // an agent evaluation (A-9): the tools each variant used, per case, and whether they are the first variant's
    if (o.evaluation.type === 'agent' && columns.every((c) => c.runId)) {
      const per: Array<Map<string, Trajectory>> = [];
      for (const c of columns) {
        const m = new Map<string, Trajectory>();
        for await (const r of runResults(store, c.runId!)) {
          const t = trajectoryOf(r);
          if (t) m.set(evalCaseKey(r.id), t);
        }
        per.push(m);
      }
      columns.forEach((c, i) => {
        const trajs = [...per[i]!.values()];
        if (!trajs.length) return;
        const calls = (t: Trajectory) => t.items.filter((x) => x.kind === 'tool').length;
        const same = i === 0 ? undefined : [...per[i]!].filter(([k, t]) => per[0]!.has(k) && diffTrajectory(per[0]!.get(k)!, t).kind === 'same').length;
        c.agent = { avgToolCalls: Math.round((trajs.reduce((n, t) => n + calls(t), 0) / trajs.length) * 10) / 10, avgModelCalls: Math.round((trajs.reduce((n, t) => n + t.modelCalls, 0) / trajs.length) * 10) / 10, ...(same !== undefined ? { sameToolsAsFirst: same } : {}), cases: trajs.length };
      });
      if (columns.every((c) => c.agent)) {
        const calls = columns.map((c) => c.agent!.avgToolCalls);
        const fewest = Math.min(...calls);
        const win = calls.filter((x) => x === fewest).length === 1 && new Set(calls).size > 1 ? columns[calls.indexOf(fewest)] : undefined;
        rows.push({ metric: 'tools', label: 'Tool calls per case', values: columns.map((c) => String(c.agent!.avgToolCalls)), winner: win?.letter, winnerText: win ? `${win.letter} (fewest)` : 'tie' });
        if (columns.length > 1) rows.push({ metric: 'same-tools', label: `Same tools as ${columns[0]!.letter}`, values: columns.map((c) => (c.agent!.sameToolsAsFirst === undefined ? '–' : `${c.agent!.sameToolsAsFirst} of ${c.agent!.cases}`)), winnerText: '–' });
      }
    }
    // the cases that moved against the first variant
    if (columns.length > 1 && columns.every((c) => c.runId)) {
      try {
        const page = await evalMatrixPage(store, { runs: columns.map((c) => c.runId!), baseline: columns[0]!.runId!, limit: 1 });
        cases = { gotWorse: page.counts.regressed, gotBetter: page.counts.improved };
      } catch {
        /* the cases of the runs do not line up: the sentence goes without them */
      }
    }
    conclusion = conclusionOf(columns, cases);
    const other = columns.slice(1).filter((c) => c.agent?.sameToolsAsFirst !== undefined && c.agent.sameToolsAsFirst < c.agent.cases);
    if (other.length) conclusion += ` ${andJoin(other.map((c) => `${c.letter} used other tools in ${c.agent!.cases - c.agent!.sameToolsAsFirst!} of ${plural(c.agent!.cases, 'case')}`))}.`;
  }
  return { evaluation: o.evaluation.name, ready, waiting, columns, rows, ...(cases ? { cases } : {}), conclusion, runs: columns.map((c) => c.runId).filter((x): x is string => !!x) };
}

/** The sentence under the table. Two variants: the second against the first. More: who is best at each row. */
function conclusionOf(cols: EvalVariantColumn[], cases?: { gotWorse: number; gotBetter: number }): string {
  if (cols.length < 2) return 'Add a variant to compare: another prompt version or another model.';
  const moved = cases && (cases.gotWorse || cases.gotBetter);
  if (cols.length === 2) {
    const [a, b] = cols as [EvalVariantColumn, EvalVariantColumn];
    const good: string[] = [];
    const bad: string[] = [];
    if (a.costUsd > 0 && b.costUsd === 0) good.push('costs nothing');
    else if (a.costUsd > 0 && b.costUsd < a.costUsd * 0.9) good.push(`costs ${ratio(a.costUsd, b.costUsd)}x less`);
    else if (a.costUsd > 0 && b.costUsd > a.costUsd * 1.1) bad.push(`costs ${ratio(b.costUsd, a.costUsd)}x more`);
    if (a.avgMs && b.avgMs && b.avgMs < a.avgMs * 0.9) good.push(`runs ${ratio(a.avgMs, b.avgMs)}x faster`);
    else if (a.avgMs && b.avgMs && b.avgMs > a.avgMs * 1.1) bad.push(`runs ${ratio(b.avgMs, a.avgMs)}x slower`);
    const d = b.passed - a.passed;
    if (d > 0) good.push(`passes ${plural(d, 'case')} more`);
    else if (d < 0) bad.push(`passes ${plural(-d, 'case')} fewer`);
    const look = moved ? ` ${plural(cases!.gotWorse, 'case')} got worse and ${cases!.gotBetter} got better: look at them.` : '';
    if (!good.length && !bad.length) return moved ? `A and B pass the same number of cases at about the same cost and speed, but not the same cases.${look}` : 'A and B give the same results at about the same cost and speed.';
    // good news first; a loss in pass rate is said last so it is not lost
    return `B ${andJoin(good.length ? good : bad)}${good.length && bad.length ? `, but ${andJoin(bad)}` : ''}.${look}`;
  }
  const top = [...cols].sort((x, y) => y.passRate - x.passRate || x.costUsd - y.costUsd)[0]!;
  const cheapest = cols.filter((c) => c.costUsd > 0).sort((x, y) => x.costUsd - y.costUsd)[0];
  const fastest = cols.filter((c) => c.avgMs).sort((x, y) => (x.avgMs ?? 0) - (y.avgMs ?? 0))[0];
  return [`Most passed: ${top.letter} (${top.passed} of ${top.total}).`, cheapest ? `Cheapest: ${cheapest.letter}.` : '', fastest ? `Fastest: ${fastest.letter}.` : '', 'No variant is best at everything: pick by what matters to you.'].filter(Boolean).join(' ');
}
