/** `testpion test from-request`: Save as test from the terminal (WF-07), the same as the app's and the `save_test` MCP tool. */
import type { Command } from 'commander';
import { ApsError, parseItemRef, saveTest, type CollectionNode, type ItemRef, type WorkspaceStore } from '@testpion/core';
import { EXIT, CliError, green, printJson, requireCollection, withWorkspace, WORKSPACE_OPTION } from '../shared.js';

/** "Collection/Folder/Request", "Collection/Folder" or "Collection": the item it names, as a ref. */
function refOfPath(store: WorkspaceStore, target: string): ItemRef {
  const parts = target
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new CliError('Give "Collection/Request", "Collection/Folder" or a collection', EXIT.CONFIG_ERROR);
  const c = requireCollection(store, parts[0]!, { loadable: true });
  if (parts.length === 1) return { kind: 'collection', collectionId: c.id };
  let nodes: CollectionNode[] = c.items;
  let found: CollectionNode | undefined;
  for (const name of parts.slice(1)) {
    found = nodes.find((n) => n.id === name) ?? nodes.find((n) => n.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new CliError(`No "${name}" in ${parts.slice(0, parts.indexOf(name)).join(' / ') || c.name}`, EXIT.CONFIG_ERROR);
    nodes = found.kind === 'folder' ? found.items : [];
  }
  return found!.kind === 'folder' ? { kind: 'folder', collectionId: c.id, folderId: found!.id } : { kind: 'request', collectionId: c.id, requestId: found!.id };
}

export function registerTestFromCommand(program: Command): void {
  const test = program.commands.find((c) => c.name() === 'test');
  if (!test) return;
  test
    .command('from-request')
    .description('save a saved request as a test file under tests/ (a folder or a whole collection: one file with a test per request), like Save as test in the app')
    .argument('<item>', '"Collection/Folder/Request", "Collection/Folder", "Collection", or an item ref (testpion://open?… or kind:id)')
    .option(...WORKSPACE_OPTION)
    .option('-n, --name <name>', 'test name (default: the request’s)')
    .option('--json', 'print { path, tests, ref } as JSON')
    // `test` has -w and --json of its own, and commander gives a parent's options to the parent: read them from both
    .action((item: string, _o: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals() as { workspace?: string; name?: string; json?: boolean };
      return withWorkspace(o.workspace, (store) => {
        // a ref (testpion://open?…, kind:id, JSON) or a path of names
        const ref = parseItemRef(item) ?? refOfPath(store, item);
        try {
          const r = saveTest(store, { name: o.name, ref });
          const out = { path: `tests/${r.path}`, tests: r.tests, ref: { kind: 'test' as const, path: r.path } };
          if (o.json) printJson(out);
          else console.log(green(`Saved ${out.path}${r.tests > 1 ? ` (${r.tests} tests)` : ''}. Run it with: testpion test ${out.path}`));
        } catch (e) {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        }
      });
    });
}
