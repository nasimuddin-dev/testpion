/**
 * `testpion rag draft-references <dataset>`: the AI drafts reference answers for the records of a captured dataset that have
 * none, from the passages each record retrieved (not from the system's own answer), checks every draft against them and
 * offers the drafts as a proposal; --apply replaces the ticked records in the dataset (one `testpion ai undo` puts it back).
 */
import { Command } from 'commander';
import { EXIT, CliError, bold, cliContext, dim, withWorkspace } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

export function registerRagReferencesCommands(rag: Command): void {
  rag
    .command('draft-references')
    .description('the AI drafts reference answers for the records of a captured dataset that have none (written from the passages each record retrieved, each checked against them) as a proposal; --apply writes the ticked ones into the dataset')
    .argument('<dataset>', 'the dataset: datasets/<name>.jsonl (the name is enough)')
    .option('--ids <ids...>', 'only these record ids')
    .option('--limit <n>', 'how many records at most (1 to 12)', '8')
    .option('--judge <provider/model>', 'the judge that checks each draft against its passages (default: the AI settings’ large model)')
    .option('--apply', 'replace the ticked records when the run is done (a draft whose checks failed is unticked)')
    .option('--estimate', 'show what would be sent and what it costs; send nothing')
    .option('--dry-run', 'the same as --estimate')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>')
    .option('--provider <name>', 'the model that drafts (default: the AI settings’ large model)')
    .option('--model <name>')
    .option('--json', 'print as JSON')
    .action(async (dataset: string, o: { ids?: string[]; limit: string; judge?: string; apply?: boolean; estimate?: boolean; dryRun?: boolean; workspace?: string; environment?: string; provider?: string; model?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const ctx = cliContext(store, o.environment);
        try {
          await proposeCommand({
            store,
            ctx,
            json: !!o.json || machine(),
            task: 'rag-draft-references',
            item: undefined,
            context: { dataset, ids: o.ids, limit: Number(o.limit), judge: o.judge },
            question: undefined,
            provider: o.provider,
            model: o.model,
            ai: true,
            dryRun: !!o.estimate || !!o.dryRun,
            apply: o.apply,
            appliedHint: () => `the references are in ${dataset}; undo with \`testpion ai undo <proposal>\``,
            show: (p) => {
              console.log(`${bold(p.title)}\n${dim('─'.repeat(40))}`);
              for (const i of p.items) {
                const rec = (i.data as { record: { reference: string; answerable: boolean } }).record;
                console.log(`${i.selected ? '[x]' : '[ ]'} ${i.title}\n    ${rec.answerable ? rec.reference : dim('(unanswerable from the retrieved passages)')}`);
              }
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
