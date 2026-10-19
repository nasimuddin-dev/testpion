import type { Command } from 'commander';
import { applyTidy, draftTidyProposal, tidyCollection } from '@testpion/core';
import { green, yellow, dim, bold, printJson, withWorkspace, requireCollection, cliContext } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

/**
 * `testpion tidy <collection>`: duplicate requests, typed-in hosts, empty folders, unused variables; --remove-* fixes them.
 * `--ai` (AI-10, "Tidy this import"): the clean-up of a fresh Postman / curl / HAR / Insomnia / Bruno import as a verified
 * proposal — names and folders, a host and a token typed into many requests as variables, ids chained from the response
 * that returns them (tp.* scripts), tracking and duplicate requests dropped, optionally a flow; nothing is written
 * until --apply (or testpion ai apply <id>), and no request is changed to send something else.
 */
export function registerTidyCommand(program: Command): void {
  program
    .command('tidy')
    .description(
      'find what piles up in a collection: duplicate requests, hosts typed into URLs, empty folders, unused collection variables (--remove-* fixes those); --ai proposes the clean-up of an import: names, folders, hosts and tokens as variables, ids chained from earlier responses, tracking requests dropped',
    )
    .argument('<collection>', 'collection name or id')
    .option('--remove-duplicates', 'remove the copies of duplicate requests (the first of each stays)')
    .option('--remove-empty-folders', 'remove folders with no requests')
    .option('--remove-unused-variables', 'remove collection variables nothing uses')
    .option('--use-collection-auth', "make a repeated Authorization header the collection's auth (those requests inherit it)")
    .option('--ai', 'propose the clean-up of an import with the configured model (the findings TestPion makes itself come first): a verified proposal, nothing is written without --apply')
    .option('--flow', 'with --ai: also propose a flow that wires the requests (tests/flows/<collection>-tidied.yaml)')
    .option('--source <format>', 'with --ai: where the collection came from (har, postman, curl, insomnia, bruno): context for the model')
    .option('--hint <text>', 'with --ai: an extra instruction, e.g. "group by resource"')
    .option('--privacy <level>', 'with --ai: full (redacted, default) | metadata | names')
    .option('--provider <id>', 'with --ai: provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'with --ai: model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--no-model', 'with --ai: only what TestPion finds itself (no model is called)')
    .option('--apply', 'with --ai: apply the ticked changes (the verified ones; the model’s opt-in suggestions stay unticked)')
    .option('--dry-run', 'change nothing: with --remove-*, say how many would be removed; with --ai, send nothing and print what would be sent')
    .option('-e, --environment <name>', 'with --ai: environment whose variable names (never values) the model may know')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(
      (
        ref: string,
        o: {
          removeDuplicates?: boolean;
          removeEmptyFolders?: boolean;
          removeUnusedVariables?: boolean;
          useCollectionAuth?: boolean;
          ai?: boolean;
          flow?: boolean;
          source?: string;
          hint?: string;
          privacy?: string;
          provider?: string;
          model?: string | boolean;
          apply?: boolean;
          dryRun?: boolean;
          environment?: string;
          workspace?: string;
          json?: boolean;
        },
      ) => {
        return withWorkspace(o.workspace, async (store) => {
          const c = store.getCollection(requireCollection(store, ref).id);
          if (o.ai) {
            const item = { kind: 'collection' as const, collectionId: c.id };
            const ctx = cliContext(store, o.environment);
            try {
              await proposeCommand({
                store,
                ctx,
                json: !!o.json || machine(),
                task: 'tidy-import',
                item,
                context: { options: { flow: o.flow === true, ...(o.source ? { source: o.source } : {}) } },
                hint: o.hint,
                privacy: o.privacy,
                provider: o.provider,
                model: typeof o.model === 'string' ? o.model : undefined,
                ai: o.model !== false,
                dryRun: o.dryRun,
                apply: o.apply,
                draft: (reason) => draftTidyProposal(store, item, { surface: process.env.CI ? 'ci' : 'cli', reason, source: o.source }),
                appliedHint: () => `review the result: testpion requests "${c.name}"`,
                show: (p) => console.log(bold(`${c.name}: ${p.items.filter((i) => i.kind === 'collection').length} change(s) to review`)),
              });
            } finally {
              await ctx.dispose();
            }
            return;
          }
          const findings = tidyCollection(c);
          let removed = 0;
          if (o.removeDuplicates || o.removeEmptyFolders || o.removeUnusedVariables || o.useCollectionAuth) {
            const r = applyTidy(c, o);
            removed = r.removed;
            if (removed && !o.dryRun) store.saveCollection(r.collection);
          }
          if (o.json) return printJson({ collection: c.name, collectionId: c.id, findings, removed, ...(o.dryRun ? { dryRun: true } : {}) });
          if (!findings.length) return console.log(green(`${c.name} is tidy.`));
          const titles = { duplicate: 'Duplicate requests', 'hard-coded-host': 'Hosts typed into URLs', 'empty-folder': 'Empty folders', 'unused-variable': 'Unused variables', 'repeated-auth-header': 'The same Authorization header on many requests' } as const;
          for (const kind of Object.keys(titles) as Array<keyof typeof titles>) {
            const list = findings.filter((f) => f.kind === kind);
            if (!list.length) continue;
            console.log(bold(`\n${titles[kind]} (${list.length})`));
            for (const f of list.slice(0, 50)) {
              console.log(`  ${f.message}`);
              for (const w of f.where.slice(0, 4)) console.log(dim(`    ${w}`));
            }
          }
          if (removed) console.log(green(`\n${removed} ${o.dryRun ? 'would be removed (--dry-run: nothing changed)' : 'removed'}.`));
          else console.log(yellow('\nNothing removed: --remove-duplicates, --remove-empty-folders and --remove-unused-variables fix those; testpion replace puts a variable in place of a host; --ai proposes the clean-up of an import.'));
        });
      },
    );
}
