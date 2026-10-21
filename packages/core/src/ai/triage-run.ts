/**
 * `triageRun`: the one call every host makes for AI-2 (the app's `ai.triageRun`, `testpion ai triage`, `testpion test …
 * --triage`, MCP `ai_triage_run`). The run's evidence is gathered once (run-evidence.ts), the `triage-run` task runs on
 * it (the model's causes, fixes proposed and verified), and the answer is a report: the groups, the findings (the
 * model's, or TestPion's without one) and the proposal. No model set up (or `noAi`): the deterministic report, with why.
 */
import { normalizeError } from '../errors.js';
import type { TokenUsage } from '../model/types.js';
import { isAiSetupError } from './flow-from-collection.js';
import { runEvidence } from './run-evidence.js';
import { deterministicFindings, reportOf, withEvidence, type TriageReport } from './triage.js';
import { runAiTask, type AiPreview, type AiRunDeps } from './tasks/run.js';

interface TriageOptions {
  /** A run id, or 'last' (the newest finished run with failures). */
  runId: string;
  privacy?: string;
  hint?: string;
  provider?: string;
  model?: string;
  /** Send nothing: the report without a model, and what would be sent. */
  dryRun?: boolean;
  /** No model: TestPion's grouping and likely causes only. */
  noAi?: boolean;
  maxTokens?: number;
}

export interface TriageResult extends TriageReport {
  usage?: TokenUsage;
  costUsd?: number;
  repairs?: number;
  problems?: string[];
  dryRun?: boolean;
  preview?: Omit<AiPreview, 'messages'> & { messages?: AiPreview['messages'] };
}

export async function triageRun(deps: AiRunDeps, o: TriageOptions): Promise<TriageResult> {
  if (!deps.store) throw new Error('triageRun needs the workspace');
  const store = deps.store;
  const ev = await runEvidence(store, o.runId);
  const plain = (fallback?: string): TriageResult => reportOf(ev, { findings: deterministicFindings(ev), ai: false, ...(fallback ? { fallback } : {}) });
  if (o.noAi) return plain('Made without AI (as asked): TestPion grouped the failures and named the likely causes.');
  try {
    const r = await withEvidence(store, ev, () =>
      runAiTask(deps, { task: 'triage-run', item: { kind: 'run', runId: ev.runId }, privacy: o.privacy, hint: o.hint, provider: o.provider, model: o.model, dryRun: o.dryRun, maxTokens: o.maxTokens }),
    );
    if (r.dryRun) return { ...plain(), dryRun: true, preview: r.preview };
    const p = r.proposal;
    return {
      ...reportOf(ev, {
        findings: p?.findings?.length ? p.findings : deterministicFindings(ev),
        ai: !!p?.findings?.some((f) => f.id.startsWith('c')),
        ...(p?.summary ? { summary: p.summary } : {}),
        model: `${r.provider}/${r.model}`,
        ...(p ? { proposal: p } : {}),
        ...(!p ? { fallback: `The model's answer had no usable causes${r.problems.length ? `: ${r.problems.slice(0, 2).join('; ')}` : ''}.` } : {}),
      }),
      usage: r.usage,
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      repairs: r.repairs,
      problems: r.problems,
    };
  } catch (e) {
    // no model set up: the grouping is still the answer (AI is an upgrade, not a dependency)
    if (!isAiSetupError(e) || o.dryRun) throw e;
    return plain(`No AI model is set up (${normalizeError(e).message}): TestPion grouped the failures and named the likely causes.`);
  }
}
