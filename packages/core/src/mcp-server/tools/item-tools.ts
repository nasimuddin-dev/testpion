import { removeItem, restoreItem } from '../../kinds/ops.js';
import { itemUses } from '../../transfer/item-uses.js';
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
  return [
    {
      name: 'delete_item',
      write: true,
      description: `Delete an item to Recently deleted (kept ${TRASH_DAYS} days; restore_item puts it back with its id), by its \`ref\`: an ItemRef ({kind, …ids}), its testpion://open link, or kind:id. Kinds: those with the trash capability (list_kinds). A request or folder of a collection: delete_request. Returns the trash entry id, kind, id and name.`,
      inputSchema: {
        type: 'object',
        properties: { ref: { description: 'The ItemRef object, its testpion://open link, or the short form kind:id', anyOf: [{ type: 'object' }, { type: 'string' }] } },
        required: ['ref'],
      },
      run: (a) => removeItem(store, a.ref),
    },
    {
      name: 'item_uses',
      description: 'What an item uses and what uses it (read only), by `ref` (see delete_item): { item, uses, usedBy, missing }.',
      inputSchema: {
        type: 'object',
        properties: { ref: { anyOf: [{ type: 'object' }, { type: 'string' }] } },
        required: ['ref'],
      },
      run: (a) => itemUses(store, a.ref),
    },
    {
      name: 'restore_item',
      write: true,
      description: `Put back an item deleted to Recently deleted, by the trash entry id delete_item returned (\`<kind>/<entry>\`). A name taken again gets "(restored)", an id taken again a new id. Returns its kind, id, name and ref.`,
      inputSchema: { type: 'object', properties: { trash_id: str('delete_item’s trashId') }, required: ['trash_id'] },
      run: (a) => restoreItem(store, String(a.trash_id ?? a.trashId ?? '')),
    },
  ];
}
