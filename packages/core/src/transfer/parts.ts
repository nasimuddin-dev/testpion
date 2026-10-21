/**
 * Folder and request export: a part of a collection travels as a collection of its own. The picked folders and requests
 * keep their place in the tree under the folders that hold them, and those folders keep their own settings (headers,
 * auth, variables, scripts), so a request behaves the same after the import; everything else of the collection is left
 * out. The bundle item is a new collection (its id and name say which part), so importing it next to the original never
 * clashes: it is "Keep both" by construction.
 *
 * A part is named by the ref id `<collection id>#<id>[,<id>…]` (ids of folders and requests in that collection).
 */
import { ApsError } from '../errors.js';
import type { Collection, CollectionNode } from '../model/types.js';
import { slugify } from '../util/ids.js';

const PART_MARK = '#';

/** The ref id of a part of a collection. */
export const partId = (collectionId: string, nodeIds: readonly string[]): string => `${collectionId}${PART_MARK}${nodeIds.join(',')}`;

/** A ref id taken apart: the collection and the picked nodes (undefined: the whole collection). */
export function splitPartId(id: string): { collectionId: string; nodeIds: string[] } | undefined {
  const at = id.indexOf(PART_MARK);
  if (at <= 0) return undefined;
  const nodeIds = id
    .slice(at + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return nodeIds.length ? { collectionId: id.slice(0, at), nodeIds } : undefined;
}

/** The collection id a ref id belongs to (the id itself when it is a whole collection). */
export const collectionIdOfRef = (id: string): string => splitPartId(id)?.collectionId ?? id;

/** Keep the picked nodes (a picked folder with everything in it) and the folders on the way to them. */
function keep(nodes: readonly CollectionNode[], want: Set<string>, found: Set<string>, names: string[]): CollectionNode[] {
  const out: CollectionNode[] = [];
  for (const n of nodes) {
    if (want.has(n.id)) {
      found.add(n.id);
      names.push(n.name);
      out.push(n);
    } else if (n.kind === 'folder') {
      const inner = keep(n.items, want, found, names);
      if (inner.length) out.push({ ...n, items: inner });
    }
  }
  return out;
}

interface PartialCollection {
  collection: Collection;
  /** Names of the picked folders and requests, in tree order. */
  names: string[];
}

/** The collection reduced to the picked folders and requests; throws, naming the ids it does not have. */
export function partialCollection(c: Collection, nodeIds: readonly string[]): PartialCollection {
  const want = new Set(nodeIds);
  const found = new Set<string>();
  const names: string[] = [];
  const items = keep(c.items, want, found, names);
  const lost = [...want].filter((x) => !found.has(x));
  if (lost.length) throw new ApsError('ValidationError', `No folder or request ${lost.slice(0, 3).map((x) => `"${x.slice(0, 60)}"`).join(', ')} in collection "${c.name}"`, { suggestions: ['Use the id or the name of a folder or request (`testpion requests <collection>` lists them)'] });
  const tag = names.length === 1 ? names[0]! : `${names[0]} and ${names.length - 1} more`;
  const id = `${slugify(c.id)}-${slugify(names.length === 1 ? names[0]! : `${names[0]}-plus-${names.length - 1}`)}`.slice(0, 120);
  return { collection: { ...c, id, name: `${c.name} / ${tag}`.slice(0, 200), items }, names };
}

/**
 * The ids of folders and requests a person typed (ids or names, any case) resolved inside a collection. A name that two
 * nodes share is refused so a part never silently takes the wrong one.
 */
export function resolveNodeIds(c: Collection, asked: readonly string[]): string[] {
  const all: CollectionNode[] = [];
  const walk = (ns: readonly CollectionNode[]) => {
    for (const n of ns) {
      all.push(n);
      if (n.kind === 'folder') walk(n.items);
    }
  };
  walk(c.items);
  return asked.map((a) => {
    const byId = all.find((n) => n.id === a);
    if (byId) return byId.id;
    const named = all.filter((n) => n.name.toLowerCase() === a.toLowerCase());
    if (named.length === 1) return named[0]!.id;
    throw new ApsError('ValidationError', named.length ? `Several folders or requests are called "${a.slice(0, 60)}" in "${c.name}": use the id` : `No folder or request "${a.slice(0, 60)}" in "${c.name}"`, {
      suggestions: ['Use the id of the folder or request'],
    });
  });
}
