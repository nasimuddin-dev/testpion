/**
 * The tree of a collection without its weight: ids, names, methods and URLs, the folder structure, favourites, what
 * has examples or folder logic. The window's explorer, breadcrumbs and pickers need no more than this (the full
 * collection, with bodies, headers and scripts, is read on its own when something opens or edits it), and a workspace
 * of thousands of requests then lists in a fraction of the bytes.
 */
import type { Collection, CollectionFolder, CollectionNode, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';

export interface TreeFolder {
  kind: 'folder';
  id: string;
  name: string;
  items: TreeNode[];
  /** The folder has scripts, variables or auth of its own. */
  logic?: true;
}

export interface TreeHttpRequest {
  kind: 'http';
  id: string;
  name: string;
  favorite?: boolean;
  /** The request's method and URL, flat (not under `request`: a big workspace lists thousands of them). */
  method: string;
  url: string;
  /** A SOAP request (an XML envelope or a SOAPAction header): the explorer's SOAP category. */
  soap?: true;
  /** The saved responses, name and status only. */
  examples?: Array<{ id: string; name: string; status: number }>;
}

export interface TreeGraphQLRequest {
  kind: 'graphql';
  id: string;
  name: string;
  favorite?: boolean;
  endpoint: string;
}

export type TreeNode = TreeFolder | TreeHttpRequest | TreeGraphQLRequest;

/** A collection as the tree sees it; `slim` says it is not the whole collection (never save one). */
export interface CollectionTree {
  schemaVersion: string;
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  problem?: string;
  /** How many collection variables there are (the full list is not here). */
  variableCount: number;
  items: TreeNode[];
  slim: true;
}

const isSoap = (r: SavedHttpRequest['request']): boolean => {
  const header = r.headers?.some((h) => h.key.toLowerCase() === 'soapaction' || (h.key.toLowerCase() === 'content-type' && /application\/soap\+xml/i.test(h.value)));
  const body = !!r.body && 'content' in r.body && typeof r.body.content === 'string' && /<(\w+:)?Envelope[\s>]/.test(r.body.content);
  return !!header || body;
};

export function treeNode(n: CollectionNode): TreeNode {
  if (n.kind === 'folder') {
    const f = n as CollectionFolder;
    const out: TreeFolder = { kind: 'folder', id: f.id, name: f.name, items: (f.items ?? []).map(treeNode) };
    if (f.preRequestScript || f.testScript || f.variables?.length || f.auth) out.logic = true;
    return out;
  }
  if (n.kind === 'graphql') {
    const g = n as SavedGraphQLRequest;
    const out: TreeGraphQLRequest = { kind: 'graphql', id: g.id, name: g.name, endpoint: g.request?.endpoint ?? '' };
    if (g.favorite) out.favorite = true;
    return out;
  }
  const h = n as SavedHttpRequest;
  const out: TreeHttpRequest = { kind: 'http', id: h.id, name: h.name, method: h.request?.method ?? 'GET', url: h.request?.url ?? '' };
  if (h.favorite) out.favorite = true;
  if (h.request && isSoap(h.request)) out.soap = true;
  if (h.examples?.length) out.examples = h.examples.map((e) => ({ id: e.id, name: e.name, status: e.status }));
  return out;
}

export function collectionTreeOf(c: Collection & { problem?: string }): CollectionTree {
  const out: CollectionTree = {
    schemaVersion: c.schemaVersion,
    id: c.id,
    name: c.name,
    version: c.version ?? 0,
    updatedAt: c.updatedAt ?? '',
    variableCount: c.variables?.length ?? 0,
    items: (c.items ?? []).map(treeNode),
    slim: true,
  };
  if (c.problem) out.problem = c.problem;
  return out;
}
