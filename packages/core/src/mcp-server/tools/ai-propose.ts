/**
 * What the MCP tools that propose changes with TestPion's configured model share (`spec_tests_generate`, `tidy_import`,
 * `security_tests_generate`, `contract_drift`, `write_script`): run the task with the model the user set up, return the
 * proposal for the agent to show the user, and — when no model is set up, or `noAi` is passed — TestPion's own
 * deterministic proposal with the reason. Nothing is written: `ai_apply_proposal` does that, after the user agrees.
 */
import { aiRunDeps, runAiTask, type AiTaskRequest } from '../../ai/tasks/run.js';
import { isAiSetupError } from '../../ai/flow-from-collection.js';
import type { Proposal } from '../../ai/proposal.js';
import { createEngineContext } from '../../engine.js';
import { normalizeError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';

/** A proposal as an agent reads it: items with their verification, without the before text of big files. */
export const forAgent = (p: Proposal) => ({ ...p, items: p.items.map((i) => ({ ...i, before: i.before && i.before.length > 4000 ? `${i.before.slice(0, 4000)} …` : i.before })) });

/** A list as agents give it: an array, or a comma-separated string. */
export const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export const PRIVACY = { type: 'string', enum: ['full', 'metadata', 'names'], description: 'full (redacted, default), metadata (shapes and names; no body values), names' };

export interface ProposeCall {
  task: string;
  item?: AiTaskRequest['item'];
  question?: string;
  context?: Record<string, unknown>;
  /** The tool's arguments: hint, privacy, path, environment, noAi, dryRun, preferStable. */
  a: Record<string, unknown>;
  /** The response a script or checks are verified against. */
  response?: AiTaskRequest['response'];
  previous?: AiTaskRequest['previous'];
  /** TestPion's own proposal (no model set up, `noAi`). */
  draft?(reason: string): Promise<Proposal>;
  /** What the agent should do with the proposal. */
  next(p: Proposal): string;
}

export function createProposer({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }) {
  return async function propose(o: ProposeCall): Promise<Record<string, unknown>> {
    const ctx = createEngineContext({ store, secrets, settings, environment: o.a.environment ? String(o.a.environment) : undefined });
    try {
      if (o.a.noAi === true && o.draft) {
        const p = await o.draft('Made without AI (noAi): the deterministic proposal.');
        return { proposal: forAgent(p), next: o.next(p) };
      }
      try {
        const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), {
          task: o.task,
          item: o.item,
          question: o.question,
          context: o.context,
          response: o.response,
          previous: o.previous,
          hint: o.a.hint ? String(o.a.hint) : undefined,
          privacy: o.a.privacy ? String(o.a.privacy) : undefined,
          path: o.a.path ? String(o.a.path) : undefined,
          dryRun: o.a.dryRun === true,
          ...(typeof o.a.preferStable === 'boolean' ? { preferStable: o.a.preferStable } : {}),
        });
        if (r.dryRun) return { dryRun: true, preview: r.preview };
        const { preview, proposal, ...rest } = r;
        return {
          ...rest,
          sent: { privacy: preview.privacy, contextTokens: preview.context.tokens, masked: preview.redactionCount, local: preview.local },
          ...(proposal ? { proposal: forAgent(proposal), next: o.next(proposal) } : {}),
        };
      } catch (e) {
        if (!isAiSetupError(e) || o.a.dryRun === true || !o.draft) throw e;
        const why = normalizeError(e).message;
        const p = await o.draft(`No AI model is set up (${why}): this is the deterministic proposal.`);
        return { fallback: why, proposal: forAgent(p), next: o.next(p) };
      }
    } finally {
      await ctx.dispose();
    }
  };
}
