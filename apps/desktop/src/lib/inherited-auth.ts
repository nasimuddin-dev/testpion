import { useEffect, useState } from 'react';
import { call } from '../api';
import type { AuthConfig, Collection, CollectionNode } from '../types';
import { useCollectionTree } from './collections-store';

/** The auth a request gets from its folders and its collection, and where it comes from. */
export interface InheritedAuth {
  auth: AuthConfig;
  /** `folder "Admin"` or `collection "Pets API"`. */
  from: string;
}

const own = (a: AuthConfig | undefined): a is AuthConfig => !!a && a.type !== 'inherit';

/** The nearest folder (from the request's own up) or the collection that has an auth of its own. */
export function inheritedAuthOf(c: Collection, requestId: string): InheritedAuth | undefined {
  const chain: Array<Extract<CollectionNode, { kind: 'folder' }>> = [];
  const walk = (nodes: CollectionNode[], trail: typeof chain): boolean => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        if (walk(n.items, [...trail, n])) return true;
      } else if (n.id === requestId) {
        chain.push(...trail);
        return true;
      }
    }
    return false;
  };
  walk(c.items, []);
  for (const f of [...chain].reverse()) if (own(f.auth)) return { auth: f.auth, from: `folder "${f.name}"` };
  if (own(c.auth)) return { auth: c.auth, from: `collection "${c.name}"` };
  return undefined;
}

/**
 * What a request with "Inherit" really gets: its folders' and its collection's auth, read from the saved collection and
 * kept current when it changes. Undefined for a request outside a collection, or when nothing up the chain has one.
 */
export function useInheritedAuth(collectionId: string | undefined, requestId: string | undefined, enabled = true): InheritedAuth | undefined {
  // the outline changes whenever the collection is saved: read it again then
  const outline = useCollectionTree().find((c) => c.id === collectionId);
  const [found, setFound] = useState<InheritedAuth>();
  useEffect(() => {
    if (!enabled || !collectionId || !requestId || !outline) return setFound(undefined);
    let live = true;
    void call<Collection>('col.get', { id: collectionId }).then(
      (c) => live && setFound(inheritedAuthOf(c, requestId)),
      () => live && setFound(undefined),
    );
    return () => void (live = false);
  }, [enabled, collectionId, requestId, outline]);
  return found;
}
