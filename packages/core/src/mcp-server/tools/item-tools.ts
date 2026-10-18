import { kindsWith } from '@testpion/shared';
import { removeItem, restoreItem } from '../../kinds/ops.js';
import { TRASH_DAYS } from '../../storage/trash.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

/**
 * Delete and restore any item by its ref, through the kinds' ops facet (the same function as RPC `item.remove` /
 * `item.restore` and `testpion item delete / restore`): a collection, an environment, a dataset, an API definition or
 * an MCP server goes to Recently deleted, from where restore_item (or the app, or `testpion trash restore`) brings it
 * back for 30 days. A request or folder of a collection is delete_request's.
 */
export function itemTools({ store }: { store: WorkspaceStore }): Tool[] {
  const kinds = kindsWith('trash').map((k) => k.id);
  return [
    {
      name: 'delete_item',
      write: true,
      description: `Delete an item of the workspace to Recently deleted (kept ${TRASH_DAYS} days; restore_item puts it back with its id), by its \`ref\`: the ref of search_workspace / resolve_ref / what_needs_attention results ({kind, …ids}), its testpion://open link, or the short form kind:id (collection:<id>, environment:<id>, dataset:<name>, spec:specs/<path>, mcp-server:<id>). Kinds that go to the trash (list_kinds, capability trash): ${kinds.join(', ')}. A request or folder of a collection: delete_request. Returns the trash entry id, the item's kind, id and name.`,
      inputSchema: {
        type: 'object',
        properties: { ref: { description: 'The ItemRef object, its testpion://open link, or the short form kind:id', anyOf: [{ type: 'object' }, { type: 'string' }] } },
        required: ['ref'],
      },
      run: (a) => removeItem(store, a.ref),
    },
    {
      name: 'restore_item',
      write: true,
      description: `Put back an item deleted to Recently deleted, by the trash entry id delete_item returned (\`<kind>/<entry>\`; \`testpion trash list\` prints them). An item whose id or name is taken again comes back under a new id, named "… (restored)"; a dataset or API definition whose name is taken goes back as name-restored.ext. Returns its kind, id, name and ref.`,
      inputSchema: { type: 'object', properties: { trash_id: str('The trash entry id (delete_item’s trashId)') }, required: ['trash_id'] },
      run: (a) => restoreItem(store, String(a.trash_id ?? a.trashId ?? '')),
    },
  ];
}
