import type { Collection, CollectionNode } from '../model/types.js';

/**
 * Tidy up a collection (the collection's Tidy up, `testpion tidy`, `collection_tidy`): what piles up in big or imported
 * collections. Duplicate requests (the same method, URL and body), hosts typed into URLs instead of a {{variable}},
 * empty folders, and collection variables nothing uses. Each finding says how to fix it; removeDuplicates and
 * removeEmptyFolders do the safe ones.
 */
export type TidyKind = 'duplicate' | 'hard-coded-host' | 'empty-folder' | 'unused-variable';

export interface TidyFinding {
  kind: TidyKind;
  message: string;
  /** Requests or folders it is about (ids), the first one the one to keep for duplicates. */
  ids: string[];
  /** Folder path and name of each. */
  where: string[];
  /** For a hard-coded host: the host, and how many requests type it. */
  host?: string;
  /** For an unused variable: its name. */
  variable?: string;
}

type Saved = Exclude<CollectionNode, { kind: 'folder' }>;

function flat(nodes: CollectionNode[], path: string[] = [], out: Array<{ node: Saved; path: string }> = [], folders: Array<{ id: string; path: string; empty: boolean }> = []) {
  for (const n of nodes) {
    if (n.kind === 'folder') {
      folders.push({ id: n.id, path: [...path, n.name].join(' / '), empty: !hasRequests(n.items) });
      flat(n.items, [...path, n.name], out, folders);
    } else out.push({ node: n, path: [...path, n.name].join(' / ') });
  }
  return { requests: out, folders };
}

const hasRequests = (nodes: CollectionNode[]): boolean => nodes.some((n) => n.kind !== 'folder' || hasRequests(n.items));

/** What makes two requests the same: method, URL (query order ignored) and body. */
function signature(n: Saved): string | undefined {
  if (n.kind === 'http') {
    const r = n.request;
    const [base, query = ''] = r.url.trim().split('?', 2) as [string, string?];
    const params = [...query.split('&').filter(Boolean), ...(r.params ?? []).filter((p) => p.enabled !== false).map((p) => `${p.key}=${p.value}`)].sort().join('&');
    const b = r.body;
    const body = !b || b.type === 'none' ? '' : 'content' in b ? b.content.replace(/\s+/g, '') : 'fields' in b ? JSON.stringify(b.fields.map((f) => [f.key, f.value])) : '';
    return `${r.method.toUpperCase()} ${base.replace(/\/+$/, '').toLowerCase()}?${params} ${body}`;
  }
  if (n.kind === 'graphql') return `GQL ${n.request.endpoint} ${n.request.query.replace(/\s+/g, ' ')} ${JSON.stringify(n.request.variables ?? '')}`;
  return undefined;
}

export function tidyCollection(c: Collection): TidyFinding[] {
  const { requests, folders } = flat(c.items);
  const findings: TidyFinding[] = [];

  // duplicates
  const bySig = new Map<string, Array<{ node: Saved; path: string }>>();
  for (const r of requests) {
    const sig = signature(r.node);
    if (!sig) continue;
    bySig.set(sig, [...(bySig.get(sig) ?? []), r]);
  }
  for (const group of bySig.values())
    if (group.length > 1)
      findings.push({
        kind: 'duplicate',
        message: `${group.length} requests send the same ${group[0]!.node.kind === 'http' ? `${group[0]!.node.request.method} ${group[0]!.node.request.url}` : 'GraphQL operation'}`,
        ids: group.map((g) => g.node.id),
        where: group.map((g) => g.path),
      });

  // hosts typed into URLs
  const byHost = new Map<string, Array<{ node: Saved; path: string }>>();
  for (const r of requests) {
    const url = r.node.kind === 'http' ? r.node.request.url : r.node.kind === 'graphql' ? r.node.request.endpoint : '';
    const m = /^(https?:\/\/[^/{}?#\s]+)/i.exec(url.trim());
    if (m) byHost.set(m[1]!.toLowerCase(), [...(byHost.get(m[1]!.toLowerCase()) ?? []), r]);
  }
  for (const [host, list] of byHost)
    findings.push({
      kind: 'hard-coded-host',
      message: `${list.length} request${list.length === 1 ? ' types' : 's type'} ${host} into the URL: a {{variable}} lets each environment point it elsewhere`,
      ids: list.map((l) => l.node.id),
      where: list.map((l) => l.path),
      host,
    });

  // empty folders (only the outermost of nested empty ones)
  const empty = folders.filter((f) => f.empty);
  for (const f of empty)
    if (!empty.some((o) => o !== f && f.path.startsWith(`${o.path} / `))) findings.push({ kind: 'empty-folder', message: `${f.path} has no requests`, ids: [f.id], where: [f.path] });

  // collection variables nothing in the collection reads
  const text = JSON.stringify({ items: c.items, auth: c.auth, pre: c.preRequestScript, test: c.testScript, vars: (c.variables ?? []).map((v) => v.value) });
  for (const v of c.variables ?? []) {
    const name = v.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const used = new RegExp(`\\{\\{\\s*${name}[\\s}.]|(variables|collectionVariables|environment)\\.get\\(\\s*['"\`]${name}['"\`]`).test(text);
    if (!used) findings.push({ kind: 'unused-variable', message: `{{${v.key}}} is not used by any request or script of the collection`, ids: [], where: [], variable: v.key });
  }
  return findings;
}

/** Remove the copies of duplicate requests (keeping the first of each) and empty folders. */
export function applyTidy(c: Collection, o: { removeDuplicates?: boolean; removeEmptyFolders?: boolean; removeUnusedVariables?: boolean }): { collection: Collection; removed: number } {
  const findings = tidyCollection(c);
  const drop = new Set<string>();
  if (o.removeDuplicates) for (const f of findings) if (f.kind === 'duplicate') for (const id of f.ids.slice(1)) drop.add(id);
  if (o.removeEmptyFolders) for (const f of findings) if (f.kind === 'empty-folder') drop.add(f.ids[0]!);
  const unused = new Set(o.removeUnusedVariables ? findings.filter((f) => f.kind === 'unused-variable').map((f) => f.variable!) : []);
  const prune = (nodes: CollectionNode[]): CollectionNode[] => nodes.filter((n) => !drop.has(n.id)).map((n) => (n.kind === 'folder' ? { ...n, items: prune(n.items) } : n));
  return { collection: { ...c, items: prune(c.items), variables: (c.variables ?? []).filter((v) => !unused.has(v.key)) }, removed: drop.size + unused.size };
}
