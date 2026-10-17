/**
 * `testpion flow generate --collection <name|id> [--folder <name|id|path>]`: the configured model writes an integration
 * flow from the saved requests of a collection or a folder (AI-1). It proposes: the flow is verified (lint, variables,
 * a run on a mock of the collection) and kept as a proposal; `--apply` writes it under tests/, `--dry-run` sends
 * nothing and prints what would be sent. Without a model set up, the deterministic draft is the proposal (with a note).
 */
import type { Command } from 'commander';
import { formatUsd, plural } from '@testpion/shared';
import { aiRunDeps, applyProposal, draftFlowProposal, flowSourceRef, isAiSetupError, normalizeError, runAiTask, WorkspaceManager, type Proposal } from '@testpion/core';
import { cliContext, dim, green, printJson, withWorkspace, yellow } from '../shared.js';
import { machine } from '../output.js';
import { printPreview, printProposal } from './ai.js';

export function registerFlowGenerateCommand(program: Command): void {
  const flow = program.commands.find((c) => c.name() === 'flow');
  if (!flow) return;
  flow
    .command('generate')
    .description(
      'let the AI write an integration flow from a collection or folder: the steps are its saved requests (by id, never invented), ordered create → read → update → delete, values extracted and passed on, status and key-field checks, one or two error cases; verified (lint, variables, a run on a mock of the collection) and proposed — nothing is written until --apply (or testpion ai apply <id>)',
    )
    .requiredOption('--collection <nameOrId>', 'the collection')
    .option('--folder <nameOrId>', 'one folder of it: its name, its path (Orders/Refunds) or its id')
    .option('--hint <text>', 'an extra instruction, e.g. "also test pagination"')
    .option('--privacy <level>', 'full (redacted, default) | metadata (methods, URLs, shapes and names, no body values) | names')
    .option('--path <file>', 'the flow file to write, under tests/ (default tests/flows/<collection>-<folder>.yaml, a free name)')
    .option('--provider <id>', 'provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--no-ai', 'make the deterministic draft only (no model is called)')
    .option('--dry-run', 'send nothing: print what would be sent (messages, sections, tokens, cost, what was masked)')
    .option('--apply', 'write the flow when its verification did not fail (else it stays a proposal)')
    .option('-e, --environment <name>', 'environment whose variable names (never values) the flow may use')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print { proposal, preview, usage, applied } as JSON (for scripts and AI agents)')
    .action(
      async (o: {
        collection: string;
        folder?: string;
        hint?: string;
        privacy?: string;
        path?: string;
        provider?: string;
        model?: string;
        ai?: boolean;
        dryRun?: boolean;
        apply?: boolean;
        environment?: string;
        workspace?: string;
        json?: boolean;
      }) => {
        const parent = flow.opts() as { workspace?: string; json?: boolean };
        const json = !!(o.json || parent.json) || machine();
        return withWorkspace(o.workspace ?? parent.workspace, async (store) => {
          const item = flowSourceRef(store, { collection: o.collection, folder: o.folder });
          const settings = new WorkspaceManager().loadSettings();
          const ctx = cliContext(store, o.environment);
          const surface = process.env.CI ? 'ci' : 'cli';
          const verify = { variableNames: ctx.vars.names(), services: ctx.services };
          try {
            let proposal: Proposal | undefined;
            let result: Awaited<ReturnType<typeof runAiTask>> | undefined;
            let fallback: string | undefined;
            if (o.ai === false) proposal = await draftFlowProposal(store, item, { path: o.path, surface, reason: 'Made without AI (--no-ai): the deterministic draft.', verify });
            else
              try {
                result = await runAiTask(aiRunDeps({ ctx, settings, store, surface, env: process.env }), {
                  task: 'flow-from-collection',
                  item,
                  hint: o.hint,
                  privacy: o.privacy,
                  path: o.path,
                  provider: o.provider,
                  model: o.model,
                  dryRun: o.dryRun,
                });
                proposal = result.proposal;
              } catch (e) {
                // no model set up: the draft TestPion makes without one (AI is an upgrade, not a dependency)
                if (!isAiSetupError(e) || o.dryRun) throw e;
                fallback = normalizeError(e).message;
                proposal = await draftFlowProposal(store, item, { path: o.path, surface, reason: `No AI model is set up (${fallback}): this is the deterministic draft.`, verify });
              }
            if (result?.dryRun) return json ? printJson(result) : printPreview(result);
            if (!proposal) throw normalizeError(new Error(`The model proposed no flow: ${result?.problems.join('; ') || 'no steps'}`));
            const flowItem = proposal.items[0]!;
            const failing = flowItem.verification.some((b) => b.status === 'fail');
            const applied = o.apply && !failing ? applyProposal(store, proposal.id) : undefined;
            if (json)
              return printJson({
                proposal,
                ...(result
                  ? { model: `${result.provider}/${result.model}`, usage: result.usage, costUsd: result.costUsd, repairs: result.repairs, problems: result.problems }
                  : { model: 'none (deterministic draft)' }),
                ...(fallback ? { fallback } : {}),
                ...(applied ? { applied } : o.apply ? { applied: null, why: 'its verification failed: review it, then testpion ai apply <id> --items i1' } : {}),
              });
            console.log(dim(`# tests/${flowItem.path}\n`) + flowItem.after);
            printProposal(proposal, { applied: !!applied });
            if (result)
              console.log(
                dim(
                  `${result.provider}/${result.model} · ${result.usage.inputTokens.toLocaleString('en-US')} in / ${result.usage.outputTokens.toLocaleString('en-US')} out${result.costUsd !== undefined ? ` · ${formatUsd(result.costUsd)}` : ''}${result.repairs ? ` · ${plural(result.repairs, 'repair')}` : ''}`,
                ),
              );
            if (applied) console.log(green(`\nWrote tests/${flowItem.path}`) + dim(` · run it: testpion test tests/${flowItem.path} · undo: testpion ai undo ${proposal.id}`));
            else if (o.apply) console.log(yellow('\nNot written: its verification failed. Review it, then testpion ai apply ' + proposal.id));
          } finally {
            await ctx.dispose();
          }
        });
      },
    );
}
