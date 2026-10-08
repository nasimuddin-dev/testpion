import type { Command } from 'commander';
import { applyTidy, tidyCollection, } from '@testpion/core';
import { green, yellow, dim, bold, printJson, withWorkspace, requireCollection } from '../shared.js';

/** `testpion tidy <collection>`: duplicate requests, typed-in hosts, empty folders, unused variables; --remove-* fixes them. */
export function registerTidyCommand(program: Command): void {
  program
    .command('tidy')
    .description('find what piles up in a collection: duplicate requests, hosts typed into URLs, empty folders, unused collection variables (--remove-* fixes those)')
    .argument('<collection>', 'collection name or id')
    .option('--remove-duplicates', 'remove the copies of duplicate requests (the first of each stays)')
    .option('--remove-empty-folders', 'remove folders with no requests')
    .option('--remove-unused-variables', 'remove collection variables nothing uses')
    .option('--use-collection-auth', "make a repeated Authorization header the collection's auth (those requests inherit it)")
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((ref: string, o: { removeDuplicates?: boolean; removeEmptyFolders?: boolean; removeUnusedVariables?: boolean; useCollectionAuth?: boolean; workspace?: string; json?: boolean }) => {
      return withWorkspace(o.workspace, (store) => {
        const c = store.getCollection(requireCollection(store, ref).id);
        const findings = tidyCollection(c);
        let removed = 0;
        if (o.removeDuplicates || o.removeEmptyFolders || o.removeUnusedVariables || o.useCollectionAuth) {
          const r = applyTidy(c, o);
          removed = r.removed;
          if (removed) store.saveCollection(r.collection);
        }
        if (o.json) return printJson({ collection: c.name, collectionId: c.id, findings, removed });
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
        if (removed) console.log(green(`\n${removed} removed.`));
        else console.log(yellow('\nNothing removed: --remove-duplicates, --remove-empty-folders and --remove-unused-variables fix those; testpion replace puts a variable in place of a host.'));
      });
    });
}
