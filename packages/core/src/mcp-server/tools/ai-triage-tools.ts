/**
 * MCP tools for AI-2 and AI-5 with TestPion's configured model: `ai_triage_run` (a failed run's failures grouped by
 * cause, explained, with verified fixes as a proposal), `ai_analyze_flaky` (why a test is flaky, with a verified fix) and
 * `ai_attempt_fix` (a flaky fix applied, then the test run again N times for a verdict; confirmed). They propose:
 * `ai_apply_proposal` applies a triage's fixes. Without a model the first two return TestPion's own grouping / signals.
 */
import { aiRunDeps } from '../../ai/tasks/run.js';
import { triageRun } from '../../ai/triage-run.js';
import { analyzeFlaky, attemptFix } from '../../ai/flaky-run.js';
import type { Proposal } from '../../ai/proposal.js';
import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { parseItemRef, toItemRef } from '@testpion/shared';
import { str, type Tool } from '../tool.js';

const forAgent = (p: Proposal) => ({ ...p, items: p.items.map((i) => ({ ...i, before: i.before && i.before.length > 4000 ? `${i.before.slice(0, 4000)} …` : i.before })) });

const PRIVACY = {
  type: 'string',
  enum: ['full', 'metadata', 'names'],
  description: 'full (redacted, default), metadata (statuses, checks, endpoints and shapes; no body values, no failure messages), names',
};

/**
 * `checkEnvironment`: the MCP server's own check of an environment a tool runs in (production only when the server was
 * started with --allow-production); without one, a production environment is refused.
 */
export function aiTriageTools({
  store,
  secrets,
  settings,
  checkEnvironment = (name) => {
    const env = name ? store.getEnvironment(name) : undefined;
    if (env?.isProduction) throw new ApsError('ConfigurationError', `"${env.name}" is a production environment; the MCP server does not send to production unless started with --allow-production`);
  },
}: {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  checkEnvironment?: (name: string | undefined) => unknown;
}): Tool[] {
  const deps = (environment?: string) => {
    const ctx = createEngineContext({ store, secrets, settings, environment });
    return { ctx, deps: aiRunDeps({ ctx, settings, store, surface: 'mcp' }) };
  };
  return [
    {
      name: 'ai_triage_run',
      description:
        "Explain and fix a failed run's failures with TestPion's configured model (the user's key or a local model): the failures grouped deterministically (same failed check, status and endpoint), then causes — one may explain many groups (an expired token behind 12 failures) — each with evidence (the failing request and response, the failed check, what changed since the same test's last passing run), a confidence and a fix: a check to change, an edit of the test, a variable to set, or none (the API regressed: a bug report). Every fix is verified before it is offered (the changed check passes on the failing response, is compared with the last passing one and must not accept any response; a patched file lints). It only proposes: apply with ai_apply_proposal after the user agrees, then run the affected tests again (run_tests / run_collection). Without a model: the grouping with likely causes (`fallback` says why).",
      inputSchema: {
        type: 'object',
        properties: {
          run: str('The run: its id (list_runs, recent_failures), or "last" (the newest finished run with failures; default)'),
          privacy: PRIVACY,
          hint: str('An extra instruction, e.g. "the token was rotated yesterday"'),
          noAi: { type: 'boolean', description: 'Only the deterministic grouping (no model is called)' },
          dryRun: { type: 'boolean', description: 'Send nothing: the grouping, and what would be sent with the token and cost estimate' },
        },
      },
      run: async (a) => {
        const { ctx, deps: d } = deps();
        try {
          const t = await triageRun(d, {
            runId: a.run ? String(a.run) : 'last',
            privacy: a.privacy ? String(a.privacy) : undefined,
            hint: a.hint ? String(a.hint) : undefined,
            noAi: a.noAi === true,
            dryRun: a.dryRun === true,
          });
          const { proposal, ...rest } = t;
          return {
            ...rest,
            ...(proposal
              ? {
                  proposal: forAgent(proposal),
                  next: `Show the user each finding with its evidence and the fixes with their verification; apply the ones they accept with ai_apply_proposal { id: "${proposal.id}", items: [...] }, then run the affected tests again.`,
                }
              : {}),
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'ai_analyze_flaky',
      description:
        'Why is this test flaky (it passes and fails without a change)? TestPion reads its results across runs — pass rate, flips, retries, the environments and statuses of its failures, the latency of passes and failures — and the configured model names the pattern (timing, ordering, shared state, a time-dependent value, an external dependency, a rate limit, a data collision) with evidence and proposes a fix that makes it stable without hiding a failure (a wait with until:, a stable check, isolated data; a retry only as a last resort, flagged; skipping or quarantining is never offered), verified before it is offered. Apply and prove it with ai_attempt_fix. Without a model: the signals and a likely pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          item: { description: 'The test: test-case:<testId> (flaky_tests names them) or test:<path>[:<step>]' },
          privacy: PRIVACY,
          hint: str('An extra instruction'),
          noAi: { type: 'boolean', description: 'Only the signals TestPion reads (no model is called)' },
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['item'],
      },
      run: async (a) => {
        const item = typeof a.item === 'string' ? parseItemRef(a.item) : toItemRef(a.item);
        if (!item) throw new ApsError('ValidationError', `"${String(a.item)}" is not a test`, { suggestions: ['Use test-case:<testId> (from flaky_tests) or test:<path>[:<step>].'] });
        const { ctx, deps: d } = deps();
        try {
          const r = await analyzeFlaky(d, { item, privacy: a.privacy ? String(a.privacy) : undefined, hint: a.hint ? String(a.hint) : undefined, noAi: a.noAi === true, dryRun: a.dryRun === true });
          const { proposal, ...rest } = r;
          return {
            ...rest,
            ...(proposal
              ? {
                  proposal: forAgent(proposal),
                  next: `Show the user the pattern, its evidence and the fix; with their yes, ai_attempt_fix { id: "${proposal.id}", confirm: true } applies it and runs the test 5 times.`,
                }
              : {}),
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'ai_attempt_fix',
      write: true,
      description:
        "Attempt to fix a flaky test: apply the fix of an ai_analyze_flaky proposal (its ticked items, or `items`) and run the test again `times` times (default 5, at most 20) through the ordinary runner, in the environment of its runs; the verdict (stable: passed every time; flaky; failing) is kept with the proposal. It changes the test file or request and sends the test's requests: ask the user first. ai_undo_proposal puts the test back.",
      inputSchema: {
        type: 'object',
        properties: {
          id: str('The proposal id from ai_analyze_flaky'),
          items: { type: 'array', items: { type: 'string' }, description: 'Item ids to apply (default: the ticked ones)' },
          times: { type: 'number', description: 'How often to run the test (1–20, default 5)' },
        },
        required: ['id'],
      },
      run: async (a) => {
        const r = await attemptFix({
          store,
          proposalId: String(a.id),
          items: Array.isArray(a.items) ? a.items.map(String) : undefined,
          times: typeof a.times === 'number' ? a.times : undefined,
          servicesFor: async (environment) => {
            checkEnvironment(environment); // as run_tests: refused before the fix is applied
            const ctx = createEngineContext({ store, secrets, settings, environment });
            return { services: ctx.services, dispose: () => ctx.dispose() };
          },
        });
        return {
          attempt: r.attempt,
          ...(r.applied ? { applied: r.applied } : {}),
          proposal: r.proposal.id,
          ...(r.attempt.verdict !== 'stable' ? { next: `Not stable: tell the user; ai_undo_proposal { id: "${r.proposal.id}" } puts the test back.` } : {}),
        };
      },
    },
  ];
}
