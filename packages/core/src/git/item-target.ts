import { parseItemRef, toItemRef, type ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { addressOf, addressOfRef, type ItemAddress } from './item-address.js';

/** What the app, the CLI and the MCP tools say to name an item: an ItemRef, a ref as text, or a file with an item id. */
export interface ItemTargetInput {
  ref?: unknown;
  file?: string;
  itemId?: string;
}

/**
 * The address of the item an input names. A ref as text is a `testpion://open` link, JSON, or `kind:id` (`mcp-server:weather`,
 * `request:<collection>:<request>`, `environment:staging`); a file is a workspace path, optionally `path#itemId`
 * (`mcp-servers.json#weather`, `library/ai-prompts.json#p1`).
 */
export function resolveItemTarget(store: WorkspaceStore, input: ItemTargetInput | string): ItemAddress {
  const i: ItemTargetInput = typeof input === 'string' ? (/^(testpion:|\{)/i.test(input.trim()) || /^[a-z-]+:[^\\/]/i.test(input.trim()) && !/^[a-z]:[\\/]/i.test(input.trim()) ? { ref: input } : { file: input }) : input;
  if (i.ref !== undefined && i.ref !== null && i.ref !== '') {
    const ref: ItemRef | undefined = typeof i.ref === 'string' ? parseItemRef(i.ref) : toItemRef(i.ref);
    if (!ref) throw new ApsError('ValidationError', `Not an item reference: ${typeof i.ref === 'string' ? i.ref : JSON.stringify(i.ref)}`, { suggestions: ['Use a testpion:// link, a short ref such as mcp-server:weather, or a file path (optionally path#itemId).'] });
    const a = addressOfRef(ref, { collectionFile: (id) => store.collectionFileOf(id), environmentFile: (id) => store.environmentFileOf(id) });
    if (!a) throw new ApsError('ValidationError', `${ref.kind} items are not kept in git`, { suggestions: ['Use an item of a versioned kind, or a file path.'] });
    return a;
  }
  if (i.file) {
    const hash = i.file.indexOf('#');
    const file = hash >= 0 ? i.file.slice(0, hash) : i.file;
    return addressOf(file, i.itemId ?? (hash >= 0 ? i.file.slice(hash + 1) : undefined));
  }
  throw new ApsError('ValidationError', 'Name the item: a ref (testpion:// link or kind:id) or a file');
}
