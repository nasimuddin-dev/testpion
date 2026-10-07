import type { Command } from 'commander';
import { applyTidy, tidyCollection, WorkspaceManager } from '@testpion/core';
import { EXIT, bold, dim, green, yellow, CliError, openWorkspace } from '../shared.js';

/** `testpion tidy <collection>`: duplicate requests, typed-in hosts, empty folders, unused variables; --remove-* fixes them. */
export function registerTidyCommand(program: Command): void {
  program
    .command('tidy')
    .description('find what piles up in a collection: duplicate requests, hosts typed into URLs, empty folders, unused collection variables (--remove-* fixes those)')
    .argument('<collection>', 'collection name or id')
    .option('--remove-duplicates', 'remove the copies of duplicate requests (the first of each stays)')
    .option('--remove-empty-folders', 'remove folders with no requests')
    .option('--remove-unused-variables', 'remove collection variables nothing uses')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((ref: string, o: { removeDuplicates?: boolean; removeEmptyFolders?: boolean; removeUnusedVariables?: boolean; workspace?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const want = ref.toLowerCase();
        const s = store.listCollections().find((x) => x.id.toLowerCase() === want) ?? store.listCollections().find((x) => x.name.toLowerCase() === want);
        if (!s) throw new CliError(`No collection "${ref}"`, EXIT.CONFIG_ERROR);
        const c = store.getCollection(s.id);
        const findings = tidyCollection(c);
        let removed = 0;
        if (o.removeDuplicates || o.removeEmptyFolders || o.removeUnusedVariables) {
          const r = applyTidy(c, o);
          removed = r.removed;
          if (removed) store.saveCollection(r.collection);
        }
        if (o.json) return console.log(JSON.stringify({ collection: c.name, findings, removed }, null, 2));
        if (!findings.length) return console.log(green(`${c.name} is tidy.`));
        const titles = { duplicate: 'Duplicate requests', 'hard-coded-host': 'Hosts typed into URLs', 'empty-folder': 'Empty folders', 'unused-variable': 'Unused variables' } as const;
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
      } finally {
        store.close();
      }
    });
}
