import type { Command } from 'commander';
import { moveCollectionVariablesToEnvironments, WorkspaceManager } from '@testpion/core';
import { EXIT, bold, dim, green, yellow, CliError, openWorkspace } from '../shared.js';

/** `testpion vars move <collection> --to <environments>`: collection variables into environments (each can set its own value). */
export function registerVarsMoveCommand(program: Command): void {
  const vars = program.commands.find((c) => c.name() === 'vars') ?? program.command('vars');
  vars
    .command('move')
    .description(
      'move collection variables into environments: a collection variable wins over every environment, so moved there each environment can set its own value (one that has the variable keeps its value)',
    )
    .argument('<collection>', 'collection name or id')
    .requiredOption('--to <environments>', 'environment names or ids, comma separated')
    .option('--keys <keys>', 'variables to move, comma separated (default: all of the collection)')
    .option('--dry-run', 'only say what would happen')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (ref: string, o: { to: string; keys?: string; dryRun?: boolean; workspace?: string; json?: boolean }) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const want = ref.toLowerCase();
        const c = store.listCollections().find((x) => x.id.toLowerCase() === want) ?? store.listCollections().find((x) => x.name.toLowerCase() === want);
        if (!c) throw new CliError(`No collection "${ref}"`, EXIT.CONFIG_ERROR);
        let r;
        try {
          r = await moveCollectionVariablesToEnvironments(store, {
            collectionId: c.id,
            keys: o.keys
              ?.split(',')
              .map((k) => k.trim())
              .filter(Boolean),
            environments: o.to
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean),
            dryRun: o.dryRun,
          });
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (o.json) return console.log(JSON.stringify({ ...r, dryRun: !!o.dryRun }, null, 2));
        console.log(bold(`${r.moved.length} variable${r.moved.length === 1 ? '' : 's'} of ${c.name}${o.dryRun ? ' would move' : ' moved'}`));
        for (const e of r.environments) console.log(`  ${e.name}: ${green(`${e.added.length} added`)}${e.kept.length ? dim(`, ${e.kept.length} kept (it has them: ${e.kept.join(', ')})`) : ''}`);
        if (r.notMoved.length) console.log(yellow(`Not moved (secret: move them in the app, which keeps their values in the OS secret store): ${r.notMoved.join(', ')}`));
        if (o.dryRun) console.log(yellow('Nothing saved (--dry-run).'));
      } finally {
        store.close();
      }
    });
}
