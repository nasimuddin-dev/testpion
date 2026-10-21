/**
 * `testpion rag author`: the AI drafts a complete RAG evaluation for a target (dataset slice, metrics with pass marks and
 * why, judge options, gates), TestPion drops what cannot run on the data and dry-runs the rest on a few samples (nothing is
 * sent by the dry run), and the proposal is saved as a saved evaluation only with --apply.
 */
import { Command } from 'commander';
import { EXIT, CliError, bold, cliContext, dim, withWorkspace } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

export function registerRagAuthorCommands(rag: Command): void {
  rag
    .command('author')
    .description('the AI drafts a complete evaluation for a RAG target (metrics with pass marks, dataset slice, judge options, gates), dry-runs it on a few samples without sending anything, and saves it as a saved evaluation with --apply')
    .requiredOption('--target <name>', 'the RAG target (testpion rag targets)')
    .option('--dataset <file>', 'a dataset under datasets/ (its columns decide which metrics can run)')
    .option('--docs <paths...>', 'documents or folders of the workspace: their titles and headings are shown to the model, never their text')
    .option('--spec <file>', 'an API definition under specs/ (its operations are shown to the model)')
    .option('--goal <text>', 'what you want to find out ("does it answer from the handbook, and never invent a dose")')
    .option('--name <name>', 'the name of the evaluation')
    .option('--judge <provider/model>', 'the judge of the judged metrics (default: the AI settings’ large model)')
    .option('--apply', 'save the evaluation when its checks pass')
    .option('--estimate', 'show what would be sent and what it costs; send nothing')
    .option('--dry-run', 'the same as --estimate')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>')
    .option('--provider <name>', 'the model that drafts (default: the AI settings’ large model)')
    .option('--model <name>')
    .option('--json', 'print as JSON')
    .action(async (o: { target: string; dataset?: string; docs?: string[]; spec?: string; goal?: string; name?: string; judge?: string; apply?: boolean; estimate?: boolean; dryRun?: boolean; workspace?: string; environment?: string; provider?: string; model?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const ctx = cliContext(store, o.environment);
        try {
          await proposeCommand({
            store,
            ctx,
            json: !!o.json || machine(),
            task: 'rag-author-evaluation',
            item: undefined,
            context: { target: o.target, dataset: o.dataset, docs: o.docs, spec: o.spec, goal: o.goal, name: o.name, judge: o.judge },
            question: o.goal,
            provider: o.provider,
            model: o.model,
            ai: true,
            dryRun: !!o.estimate || !!o.dryRun,
            apply: o.apply,
            appliedHint: () => 'saved in Evaluations; run it with `testpion rag run <name>`',
            show: (p) => {
              console.log(`${bold(p.items[0]?.title ?? 'Evaluation')}\n${dim('─'.repeat(40))}\n${p.items[0]?.after ?? ''}`);
              if (p.summary) console.log(`\n${p.summary}`);
              for (const n of p.notes ?? []) console.log(dim(`  note: ${n}`));
            },
          });
        } finally {
          await ctx.dispose();
        }
      }),
    );
}
