import type { CollectionNode } from '../types';

/** Whether a tree node belongs in the current text/favorites view. */
export function matchesCollectionNode(node: CollectionNode, filter = '', favoritesOnly = false): boolean {
  return matchIndex([node], filter, favoritesOnly)(node);
}

/** Whether each node (and folder) of a collection matches a filter: one pass per (nodes, query, favorites only). */
interface MatchIndex {
  query: string;
  favoritesOnly: boolean;
  hit: WeakMap<CollectionNode, boolean>;
}
const matchCache = new WeakMap<CollectionNode[], MatchIndex>();

/**
 * The matcher of a collection's nodes for a filter: whether every node (and, bottom-up, every folder: any child) matches,
 * computed once per (items array, query, favorites only) and cached per array (node lists are immutable: every change
 * makes new arrays). The tree asked this of each node up to five times per keystroke (the rows, the category scope, the
 * collection's "anything to show" check, the "nothing matches" note), lower-casing names each time.
 */
export function matchIndex(nodes: CollectionNode[], filter = '', favoritesOnly = false): (node: CollectionNode) => boolean {
  const query = filter.trim().toLowerCase();
  let index = matchCache.get(nodes);
  if (!index || index.query !== query || index.favoritesOnly !== favoritesOnly) {
    const hit = new WeakMap<CollectionNode, boolean>();
    const walk = (list: CollectionNode[]): boolean => {
      let any = false;
      for (const n of list) {
        let ok: boolean;
        if (n.kind === 'folder') {
          const inside = walk(n.items);
          ok = favoritesOnly ? inside : !query || n.name.toLowerCase().includes(query) || inside;
        } else {
          const text = !query || n.name.toLowerCase().includes(query) || (n.kind === 'http' && n.request.url.toLowerCase().includes(query));
          ok = text && (!favoritesOnly || !!n.favorite);
        }
        hit.set(n, ok);
        any ||= ok;
      }
      return any;
    };
    walk(nodes);
    index = { query, favoritesOnly, hit };
    matchCache.set(nodes, index);
  }
  const { hit } = index;
  return (node) => hit.get(node) ?? false;
}

/** What a saved request is, for the explorer's categories (gRPC and WebSocket items live in libraries). */
export type RequestCategory = 'rest' | 'soap' | 'graphql' | 'grpc' | 'websocket';

/** SOAP is an HTTP request with an XML envelope or a SOAPAction header. */
export function requestCategory(node: CollectionNode): 'rest' | 'soap' | 'graphql' | undefined {
  if (node.kind === 'folder') return undefined;
  if (node.kind === 'graphql') return 'graphql';
  // an outline (col.tree) says so itself: it has no headers or body to look at
  if ((node as { soap?: true }).soap) return 'soap';
  const r = node.request;
  const soapHeader = r.headers?.some((h) => h.key.toLowerCase() === 'soapaction' || (h.key.toLowerCase() === 'content-type' && /application\/soap\+xml/i.test(h.value)));
  const soapBody = r.body && 'content' in r.body && /<(\w+:)?Envelope[\s>]/.test(r.body.content);
  return soapHeader || soapBody ? 'soap' : 'rest';
}

type CollectionCategory = 'rest' | 'soap' | 'graphql';
const countsCache = new WeakMap<CollectionNode[], Record<CollectionCategory, number>>();

/**
 * How many requests of each category these nodes hold (through their folders), in one pass. Node lists
 * are immutable (every change makes new arrays), so the result is cached per list: the sidebar asks
 * for every collection and folder on each render.
 */
export function categoryCounts(nodes: CollectionNode[]): Record<CollectionCategory, number> {
  let counts = countsCache.get(nodes);
  if (!counts) {
    counts = { rest: 0, soap: 0, graphql: 0 };
    for (const n of nodes) {
      if (n.kind === 'folder') {
        const inner = categoryCounts(n.items);
        counts.rest += inner.rest;
        counts.soap += inner.soap;
        counts.graphql += inner.graphql;
      } else counts[requestCategory(n)!]++;
    }
    countsCache.set(nodes, counts);
  }
  return counts;
}

/** Whether these nodes hold a request of this category (anywhere in their folders). */
export function hasCategory(nodes: CollectionNode[], cat: RequestCategory): boolean {
  return countCategory(nodes, cat) > 0;
}

/** Requests of this category in these nodes. */
export function countCategory(nodes: CollectionNode[], cat: RequestCategory): number {
  return cat === 'grpc' || cat === 'websocket' ? 0 : categoryCounts(nodes)[cat];
}

/** Folders with no requests at all (they show under the collection's first category). */
export function isEmptyFolder(node: CollectionNode): boolean {
  return node.kind === 'folder' && node.items.every(isEmptyFolder);
}
