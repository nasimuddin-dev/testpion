import { Command } from 'commander';
import { removeItem, restoreItem, trashKindsText, TRASH_DAYS } from '@testpion/core';
import { dim, green, printJson, withWorkspace } from '../shared.js';

/**
 * `testpion item delete <ref>` / `item restore <id>`: delete any item to Recently deleted by its ref and put it back,
 * through the kinds' ops facet (the same function as the app's `item.remove` / `item.restore` and MCP `delete_item` /
 * `restore_item`). A request or folder of a collection is edited in the app or with MCP delete_request.
 */
export function registerItemCommand(program: Command): void {
  const item = program.command('item').description(`one item of a workspace by its ref (kind:id, a testpion://open link, or the JSON of a "ref" field): delete it to Recently deleted, restore it`);
  item
    .command('delete')
    .description(`delete an item to Recently deleted (kept ${TRASH_DAYS} days): ${trashKindsText()}. The ref: collection:<id>, environment:<id>, dataset:<name>, spec:specs/<path>, mcp-server:<id>`)
    .argument('<ref>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print { trashId, ref, kind, id, name } as JSON')
    .action((ref: string, o: { workspace: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const r = removeItem(store, ref);
        if (o.json) return printJson(r);
        console.log(`${green(`Deleted ${r.kind} "${r.name}"`)} ${dim(`(${r.trashId}; testpion item restore "${r.trashId}" puts it back)`)}`);
      }),
    );
  item
    .command('restore')
    .description('put back a deleted item by its id in Recently deleted (from `item delete` or `trash list`); a name that is taken again gets "(restored)"')
    .argument('<id>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print { kind, id, name, ref } as JSON')
    .action((id: string, o: { workspace: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const r = restoreItem(store, id);
        if (o.json) return printJson(r);
        console.log(green(`Restored ${r.kind} "${r.name}"`));
      }),
    );
}
