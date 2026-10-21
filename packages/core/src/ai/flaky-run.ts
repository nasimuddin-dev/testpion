/**
 * AI-5 for every host: `analyzeFlaky` (the app's "Why is this flaky?", `testpion ai run analyze-flaky --item …`, MCP
 * `ai_analyze_flaky`) and `attemptFix` ("Attempt to fix": the chosen items applied, then the test run again N times —
 * default 5 — through the ordinary runner, and the verdict kept with the proposal: stable when it passed every time).
 * Without a model the analysis is the signals TestPion read from the history.
 */
import { ApsError, normalizeError } from '../errors.js';
import type { TestResult, TokenUsage } from '../model/types.js';
import type { ExecServices } from '../runner/execute.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { isAiSetupError } from './flow-from-collection.js';
import { deterministicFlakyFinding, flakyEvidence, flakyTestId, withFlakyEvidence, type FlakyEvidence, type FlakyRerun } from './flaky.js';
import { getProposal, saveProposal, type Proposal, type ProposalAttempt, type ProposalFinding } from './proposal.js';
import { applyProposal, type ApplyResult } from './proposal-apply.js';
import { runAiTask, type AiPreview, type AiRunDeps } from './tasks/run.js';

export interface FlakyReport {
  testId: string;
  name: string;
  signals: FlakyEvidence['signals'];
  runs: FlakyEvidence['runs'];
  finding: ProposalFinding;
  ai: boolean;
  model?: string;
  fallback?: string;
  proposal?: Proposal;
  /** How Attempt to fix runs it (its file, or its collection request). */
  rerun?: FlakyRerun;
  usage?: TokenUsage;
  costUsd?: number;
  repairs?: number;
  problems?: string[];
  dryRun?: boolean;
  preview?: Omit<AiPreview, 'messages'> & { messages?: AiPreview['messages'] };
}

export async function analyzeFlaky(deps: AiRunDeps, o: { item: unknown; privacy?: string; hint?: string; provider?: string; model?: string; dryRun?: boolean; noAi?: boolean }): Promise<FlakyReport> {
  if (!deps.store) throw new Error('analyzeFlaky needs the workspace');
  const store = deps.store;
  const ev = await flakyEvidence(store, await flakyTestId(store, o.item));
  const base = { testId: ev.testId, name: ev.name, signals: ev.signals, runs: ev.runs, ...(ev.rerun ? { rerun: ev.rerun } : {}) };
  const plain = (fallback?: string): FlakyReport => ({ ...base, finding: deterministicFlakyFinding(ev), ai: false, ...(fallback ? { fallback } : {}) });
  if (o.noAi) return plain('Made without AI (as asked): the signals TestPion read from the test history.');
  try {
    const r = await withFlakyEvidence(store, ev, () =>
      runAiTask(deps, { task: 'analyze-flaky', item: { kind: 'test-case', testId: ev.testId }, privacy: o.privacy, hint: o.hint, provider: o.provider, model: o.model, dryRun: o.dryRun }),
    );
    if (r.dryRun) return { ...plain(), dryRun: true, preview: r.preview };
    const p = r.proposal;
    return {
      ...base,
      finding: p?.findings?.[0] ?? deterministicFlakyFinding(ev),
      ai: !!p?.findings?.length,
      model: `${r.provider}/${r.model}`,
      ...(p ? { proposal: p } : { fallback: `The model's answer had no usable analysis${r.problems.length ? `: ${r.problems.slice(0, 2).join('; ')}` : ''}.` }),
      usage: r.usage,
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      repairs: r.repairs,
      problems: r.problems,
    };
  } catch (e) {
    if (!isAiSetupError(e) || o.dryRun) throw e;
    return plain(`No AI model is set up (${normalizeError(e).message}): these are the signals TestPion read from the test history.`);
  }
}

/** The services of a run in an environment (the host's engine context), and how to let them go. */
type ServicesFor = (environment?: string) => Promise<{ services: ExecServices; dispose(): Promise<void> | void }>;

/** Run the test once (its whole file: the steps it waits for run too); its result, or why it did not run. */
async function runOnce(store: WorkspaceStore, rerun: FlakyRerun, services: ExecServices, name: string, signal?: AbortSignal): Promise<TestResult | undefined> {
  const [{ runTests }, { streamTests }, { runCollection }] = await Promise.all([import('../runner/runner.js'), import('../runner/loader.js'), import('../runner/collection-run.js')]);
  let result: TestResult | undefined;
  const onEvent = (e: { type: string; result?: TestResult }) => {
    if (e.type !== 'test-end' || !e.result) return;
    const id = e.result.id;
    if (rerun.kind === 'tests' ? id === rerun.testId : id.replace(/@\d+(#\d+)?$/, '') === rerun.requestId) result ??= e.result;
  };
  if (rerun.kind === 'tests')
    await runTests({ name, tests: streamTests([rerun.path], store.path('tests')), services, signal, concurrency: 1, traceMode: 'none', onEvent: onEvent as never, environment: rerun.environment });
  else
    await runCollection({
      name,
      collection: store.getCollection(rerun.collectionId),
      selection: [rerun.requestId],
      services,
      signal,
      traceMode: 'none',
      onEvent: onEvent as never,
      environment: rerun.environment,
    });
  return result;
}

/**
 * What Attempt to fix would run, read before anything is applied: the flaky-analysis proposal, the test's name and how
 * it runs again (with the environment of its runs, which hosts check: the production guard asks or refuses there).
 */
export async function attemptFixTarget(store: WorkspaceStore, proposalId: string): Promise<{ proposal: Proposal; name: string; rerun: FlakyRerun }> {
  const p = getProposal(store, proposalId);
  if (p.task !== 'analyze-flaky')
    throw new ApsError('ValidationError', `Attempt to fix works on a flaky-test analysis; ${p.id} is a ${p.task} proposal`, { suggestions: ['Apply it (testpion ai apply) and run the tests again.'] });
  if (p.status === 'discarded') throw new ApsError('ConfigurationError', `The AI proposal "${p.id}" was discarded`, { suggestions: ['Run the analysis again.'] });
  const ev = await flakyEvidence(store, await flakyTestId(store, p.request?.item));
  if (!ev.rerun) throw new ApsError('ConfigurationError', `"${ev.name}" can't be run again: its test file or request is gone`);
  return { proposal: p, name: ev.name, rerun: ev.rerun };
}

/**
 * Attempt to fix (see the module comment): applies the chosen items of an open proposal (an applied one is run again
 * as it is), runs the test `times` times and records the verdict on the proposal. Nothing is undone automatically: a
 * verdict that is not `stable` says so, and Undo puts the test back.
 */
export async function attemptFix(o: {
  store: WorkspaceStore;
  servicesFor: ServicesFor;
  proposalId: string;
  items?: string[];
  times?: number;
  signal?: AbortSignal;
}): Promise<{ attempt: ProposalAttempt; applied?: ApplyResult; proposal: Proposal }> {
  const { proposal: p, name, rerun: target } = await attemptFixTarget(o.store, o.proposalId);
  const times = Math.min(Math.max(Math.round(o.times ?? 5), 1), 20);
  // the host's services first: a host that refuses the environment (production without consent) refuses before the fix is applied
  const { services, dispose } = await o.servicesFor(target.environment);
  let passed = 0;
  const failures: string[] = [];
  let applied: ApplyResult | undefined;
  try {
    applied = p.status === 'open' ? applyProposal(o.store, p.id, { items: o.items }) : undefined;
    // read again after applying (the fix may have changed the test it runs), in the environment the services were made for
    const rerun: FlakyRerun = { ...((await flakyEvidence(o.store, await flakyTestId(o.store, p.request?.item))).rerun ?? target), environment: target.environment };
    for (let i = 0; i < times; i++) {
      if (o.signal?.aborted) throw new ApsError('CancelledError', 'Attempt to fix was stopped');
      const r = await runOnce(o.store, rerun, services, `Attempt to fix: ${name} (${i + 1}/${times})`, o.signal);
      if (r?.status === 'passed') passed++;
      else if (failures.length < 5)
        failures.push(
          r
            ? (r.error?.message ??
                r.checks
                  .filter((c) => !c.passed)
                  .map((c) => `${c.name}: ${c.message}`)
                  .join('; ') ??
                r.status)
            : 'it did not run',
        );
    }
  } finally {
    await dispose();
  }
  const attempt: ProposalAttempt = {
    at: new Date().toISOString(),
    items: applied?.applied.map((a) => a.item) ?? getProposal(o.store, p.id).applied?.items ?? [],
    runs: times,
    passed,
    verdict: passed === times ? 'stable' : passed === 0 ? 'failing' : 'flaky',
    ...(failures.length ? { failures } : {}),
  };
  const now = getProposal(o.store, p.id);
  const proposal = saveProposal(o.store, { ...now, attempts: [...(now.attempts ?? []), attempt].slice(-10) });
  return { attempt, ...(applied ? { applied } : {}), proposal };
}
