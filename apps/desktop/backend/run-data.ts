import { readDataset, type CollectionNode, type DatasetRecord } from '@testpion/core';

/** What resolving a database URL's {{variables}} needs from the backend: a context for the chosen environment. */
export interface RunDataContextSource {
  context(o: { environment?: string }): { vars: { resolve(s: string): string }; dispose(): Promise<void> | void };
}

/**
 * The rows of a runner's data source. A database URL may use {{variables}} (a secret variable for the password),
 * resolved in the run's environment; a file path is used as it is.
 */
export async function readRunData(be: RunDataContextSource, path: string, query?: string, environment?: string): Promise<DatasetRecord[]> {
  let source = path;
  if (/\{\{/.test(path) && /^(\{\{|postgres|mysql|mariadb)/i.test(path.trim())) {
    const ctx = be.context({ environment });
    try {
      source = ctx.vars.resolve(path);
    } finally {
      await ctx.dispose();
    }
  }
  const rows: DatasetRecord[] = [];
  for await (const r of readDataset({ path: source, query, limit: 100_000 })) rows.push(r);
  return rows;
}

/** The name of an item (request or folder) of a collection, found anywhere in its tree (a run of one folder is named after it). */
export function findNodeName(nodes: CollectionNode[], id: string): string | undefined {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    if (n.kind === 'folder') {
      const r = findNodeName(n.items, id);
      if (r) return r;
    }
  }
  return undefined;
}
