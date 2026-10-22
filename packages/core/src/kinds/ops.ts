import { ITEM_REF_FIELDS, kindInfoOf, parseItemRef, toItemRef, type ItemRef, type KindId } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { kind, kindOfItemRef } from './registry.js';

/**
 * Delete and restore for every host (the window's RPC `item.remove` / `item.restore`, the CLI `testpion item`, MCP
 * `delete_item` / `restore_item`, a cloud server): one function over the kinds' `ops` facet. A kind without the trash
 * capability says why instead of deleting.
 */

export interface RemovedItem {
  /** The trash entry (restoreItem takes it). */
  trashId: string;
  ref: ItemRef;
  kind: KindId;
  /** The item's own id (the ref's first id). */
  id: string;
  name: string;
}

export interface RestoredItem {
  kind: KindId;
  id: string;
  name: string;
  /** The restored item's ref (its id may be new when the old one was taken again). */
  ref?: ItemRef;
}

/** A ref as any host gives it: the object, its JSON, a testpion://open link or the short form kind:id. */
export function itemRefOf(value: unknown): ItemRef {
  let ref = typeof value === 'string' ? parseItemRef(value) : toItemRef(value);
  // kind:id for a kind whose first id is optional (environment:<id>): parseItemRef reads required ids only
  const short = typeof value === 'string' ? /^([a-z-]+):(.+)$/.exec(value.trim()) : undefined;
  if (short && (!ref || !refId(ref)) && short[1]! in ITEM_REF_FIELDS) ref = toItemRef({ kind: short[1], [ITEM_REF_FIELDS[short[1] as keyof typeof ITEM_REF_FIELDS][0]!.replace(/\?$/, '')]: short[2] }) ?? ref;
  if (!ref) throw new ApsError('ValidationError', 'Not a ref: give {kind, …ids}, a testpion://open link, or kind:id (collection:<id>, environment:<id>, dataset:<name>, spec:specs/<path>, mcp-server:<id>)');
  return ref;
}

/** The id a kind's ops take: the ref's first id (a collection's id, a dataset's name, a spec's path …). */
function refId(ref: ItemRef): string | undefined {
  const field = ITEM_REF_FIELDS[ref.kind][0]!.replace(/\?$/, '');
  const v = (ref as unknown as Record<string, unknown>)[field];
  return typeof v === 'string' && v ? v : undefined;
}

/** A ref of a kind by the id its ops answer with (the kind's first id field). */
function refOfId(kindId: KindId, id: string): ItemRef | undefined {
  const info = kindInfoOf(kindId);
  if (!info?.ref) return undefined;
  const r: Record<string, string> = { kind: info.ref, [ITEM_REF_FIELDS[info.ref][0]!.replace(/\?$/, '')]: id };
  if (info.ref === 'saved' && info.library) r.library = info.library;
  return toItemRef(r);
}

/** Move an item to Recently deleted (undo: restoreItem with the trash id); the item's name as it was. */
export function removeItem(store: WorkspaceStore, value: unknown): RemovedItem {
  const ref = itemRefOf(value);
  const def = kindOfItemRef(ref);
  const info = def.info;
  if (!info || !def.ops) {
    const label = info?.label ?? ref.kind;
    const state = info?.capabilities.trash;
    const why = state && state !== true ? ('na' in state ? state.na : `planned for ${state.planned}`) : 'it has no delete of its own';
    throw new ApsError('ValidationError', `${label}: cannot be deleted to Recently deleted (${why})`, {
      suggestions: ['`testpion kinds <kind>` / list_kinds say what each kind offers; a request or folder of a collection is deleted with delete_request.'],
    });
  }
  const id = refId(ref);
  if (!id) throw new ApsError('ValidationError', `${info.label}: the ref names no item`, { suggestions: [] });
  const found = def.resolve?.(store, ref);
  const trashId = def.ops.remove(store, id);
  return { trashId, ref, kind: info.id, id, name: found?.ok ? found.label : id };
}

/** Put back an item deleted to Recently deleted (`<kind>/<entry>` from removeItem, `testpion trash list` or RPC trash.list). */
export function restoreItem(store: WorkspaceStore, trashId: string): RestoredItem {
  const id = String(trashId ?? '');
  const def = kindInfoOf(id.slice(0, id.indexOf('/'))) ? kind(id.slice(0, id.indexOf('/')) as KindId) : undefined;
  if (!def?.ops) throw new ApsError('ValidationError', `Not an entry of Recently deleted: ${id}`, { suggestions: ['`testpion trash list` (Recently deleted) prints the entries with their ids.'] });
  const back = def.ops.restore(store, id);
  const ref = refOfId(def.info.id, back.id);
  return { kind: def.info.id, ...back, ...(ref ? { ref } : {}) };
}
