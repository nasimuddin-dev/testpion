import { KIND_IDS, KIND_INFO, kindOfRef, type Capability, type ItemRef, type KindId } from '@testpion/shared';
import { collectionKinds } from './collection.js';
import { environmentKinds } from './environment.js';
import { fileKinds } from './files.js';
import { itemsInFileKinds } from './items-in-file.js';
import { libraryKinds, resolveSaved } from './library-kind.js';
import { recordKinds } from './records.js';
import type { ItemKindDef, KindDefs } from './types.js';

/**
 * The item-kind registry, engine half: every kind of packages/shared/src/item-kinds.ts with the facets that read or
 * write its data (planning/master-roadmap.md §1). No other module branches on a kind; they ask `kind(…)`.
 */
const FACETS: KindDefs[] = [collectionKinds, environmentKinds, fileKinds, itemsInFileKinds, libraryKinds, recordKinds];

const DEFS: Readonly<Record<KindId, ItemKindDef>> = Object.freeze(
  Object.fromEntries(
    KIND_IDS.map((id) => {
      const facets = FACETS.filter((f) => f[id]);
      if (facets.length > 1) throw new Error(`The kind ${id} has facets in two kind files`);
      return [id, { info: KIND_INFO[id], ...(facets[0]?.[id] ?? {}) }];
    }),
  ) as Record<KindId, ItemKindDef>,
);

/** One kind's definition. */
export const kind = (id: KindId): ItemKindDef => DEFS[id];

/** Every kind (live ones only unless `all`), optionally those with a capability (`true`) or a facet. */
export function kinds(o: { capability?: Capability; facet?: 'resolve' | 'ops'; all?: boolean } = {}): ItemKindDef[] {
  return KIND_IDS.map((id) => DEFS[id]).filter((d) => (o.all || !d.info.since) && (!o.capability || d.info.capabilities[o.capability] === true) && (!o.facet || !!d[o.facet]));
}

/** The facets that resolve a library item of a library this version doesn't know. */
const UNKNOWN_LIBRARY: Pick<ItemKindDef, 'resolve'> = { resolve: (store, ref) => resolveSaved(store, ref as Extract<ItemRef, { kind: 'saved' }>) };

/** The definition that handles a ref ('saved' by its library; a library this version doesn't know still resolves). */
export function kindOfItemRef(ref: ItemRef): Pick<ItemKindDef, 'resolve' | 'ops'> & { info?: ItemKindDef['info'] } {
  const info = kindOfRef(ref as ItemRef & { library?: string });
  return info ? DEFS[info.id] : UNKNOWN_LIBRARY;
}
