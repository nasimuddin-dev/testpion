/**
 * RPC handlers of AI-2 (failed-run triage) and AI-5 (flaky-test analysis): the window's "Explain and fix failures with
 * AI" and "Why is this flaky?" call the same core functions as the CLI (`testpion ai triage`, `testpion ai attempt-fix`)
 * and the MCP server (`ai_triage_run`, `ai_analyze_flaky`, `ai_attempt_fix`). They propose; applying is `ai.applyProposal`.
 */
import { analyzeFlaky, attemptFix, shortId, triageRun, type ItemRef } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { linkedController } from '../request-context.js';

export function aiTriageHandlers(be: Backend): Handlers {
  return {
    /** A failed run's failures grouped by cause, explained, with verified fixes (`dryRun`: the grouping and what would be sent). */
    'ai.triageRun': (p: { runId: string; privacy?: string; hint?: string; dryRun?: boolean; noAi?: boolean; requestId?: string; environment?: string }) =>
      be.withAiDeps(p, (deps) => triageRun(deps, { runId: p.runId, privacy: p.privacy, hint: p.hint, dryRun: p.dryRun, noAi: p.noAi })),
    /** Why a test is flaky, with a verified fix (`item`: test-case:<id> or test:<path>[:<step>]). */
    'ai.analyzeFlaky': (p: { item: ItemRef | string; privacy?: string; hint?: string; dryRun?: boolean; noAi?: boolean; requestId?: string }) =>
      be.withAiDeps(p, (deps) => analyzeFlaky(deps, { item: p.item, privacy: p.privacy, hint: p.hint, dryRun: p.dryRun, noAi: p.noAi })),
    /** Attempt to fix: apply the chosen items of a flaky analysis and run the test `times` times (production asks like any run); `ai.cancel` stops it. */
    'ai.attemptFix': async (p: { id: string; items?: string[]; times?: number; requestId?: string }) => {
      const key = p.requestId ?? shortId('af-');
      const ctrl = linkedController();
      be.controllers.set(key, ctrl);
      try {
        return await attemptFix({
          store: be.ws,
          proposalId: p.id,
          items: p.items,
          times: p.times,
          signal: ctrl.signal,
          servicesFor: async (environment) => {
            const ctx = be.context({ environment });
            return { services: ctx.services, dispose: () => ctx.dispose() };
          },
        });
      } finally {
        be.controllers.delete(key);
      }
    },
  };
}
