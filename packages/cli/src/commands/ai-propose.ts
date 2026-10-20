/**
 * What the AI commands that propose files and collection changes share (`generate tests`, `tidy --ai`): run the task with
 * the configured model (or, with `--no-ai` / no model set up, TestPion's own deterministic proposal), print the proposal and
 * its verification, and apply it only with `--apply` and only the items whose verification did not fail.
 */
import { formatUsd, plural } from '@testpion/shared';
import { aiRunDeps, applyProposal, isAiSetupError, normalizeError, runAiTask, WorkspaceManager, type AiTaskResult, type EngineContext, type Proposal, type WorkspaceStore } from '@testpion/core';
import { dim, green, printJson, yellow } from '../shared.js';
import { printPreview, printProposal } from './ai.js';

export interface ProposeOptions {
  store: WorkspaceStore;
  ctx: EngineContext;
  json: boolean;
  task: string;
  item: Parameters<typeof runAiTask>[1]['item'];
  context?: Record<string, unknown>;
  hint?: string;
  /** What to generate (a description). */
  question?: string;
  privacy?: string;
  path?: string;
  provider?: string;
  model?: string;
  ai?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  /** TestPion's own proposal (no model set up, `--no-ai`). */
  draft?(reason: string): Promise<Proposal>;
  /** What to print after the proposal when it was applied. */
  appliedHint(p: Proposal): string;
  /** The text shown above the proposal (the file or the outline it proposes). */
  show(p: Proposal): void;
}

export async function proposeCommand(o: ProposeOptions): Promise<void> {
  const settings = new WorkspaceManager().loadSettings();
  const surface = process.env.CI ? 'ci' : 'cli';
  let proposal: Proposal | undefined;
  let result: AiTaskResult | undefined;
  let fallback: string | undefined;
  if (o.ai === false) {
    if (!o.draft) throw normalizeError(new Error('--no-ai: TestPion makes nothing of this without a model'));
    proposal = await o.draft('Made without AI (--no-ai): the deterministic proposal.');
  } else
    try {
      result = await runAiTask(aiRunDeps({ ctx: o.ctx, settings, store: o.store, surface, env: process.env }), {
        task: o.task,
        item: o.item,
        context: o.context,
        hint: o.hint,
        question: o.question,
        privacy: o.privacy,
        path: o.path,
        provider: o.provider,
        model: o.model,
        dryRun: o.dryRun,
      });
      proposal = result.proposal;
    } catch (e) {
      // no model set up: what TestPion builds itself (AI is an upgrade, not a dependency)
      if (!isAiSetupError(e) || o.dryRun || !o.draft) throw e;
      fallback = normalizeError(e).message;
      proposal = await o.draft(`No AI model is set up (${fallback}): this is the deterministic proposal.`);
    }
  if (result?.dryRun) return o.json ? printJson(result) : printPreview(result);
  if (!proposal) throw normalizeError(new Error(`The model proposed nothing usable: ${result?.problems.join('; ') || 'no change'}`));
  const failing = proposal.items.filter((i) => i.verification.some((b) => b.status === 'fail')).length;
  const ticked = proposal.items.filter((i) => i.selected && i.kind !== 'text').length;
  const applied = o.apply && ticked ? applyProposal(o.store, proposal.id) : undefined;
  if (o.json)
    return printJson({
      proposal,
      ...(result ? { model: `${result.provider}/${result.model}`, usage: result.usage, costUsd: result.costUsd, repairs: result.repairs, problems: result.problems } : { model: 'none (deterministic)' }),
      ...(fallback ? { fallback } : {}),
      ...(applied ? { applied } : o.apply ? { applied: null, why: failing ? 'its verification failed: review it, then testpion ai apply <id> --items …' : 'nothing was ticked' } : {}),
    });
  o.show(proposal);
  printProposal(proposal, { applied: !!applied });
  if (result)
    console.log(
      dim(`${result.provider}/${result.model} · ${result.usage.inputTokens.toLocaleString('en-US')} in / ${result.usage.outputTokens.toLocaleString('en-US')} out${result.costUsd !== undefined ? ` · ${formatUsd(result.costUsd)}` : ''}${result.repairs ? ` · ${plural(result.repairs, 'repair')}` : ''}`),
    );
  if (applied) console.log(green(`\nApplied ${plural(applied.applied.length, 'item')}`) + dim(` · ${o.appliedHint(proposal)} · undo: testpion ai undo ${proposal.id}`) + (applied.skipped.length ? yellow(` · skipped ${applied.skipped.length}: ${applied.skipped[0]!.reason}`) : ''));
  else if (o.apply) console.log(yellow('\nNothing was applied: no item is ticked (its verification failed, or the model suggests it for you to opt in). Review, then testpion ai apply ' + proposal.id + ' --items …'));
}
