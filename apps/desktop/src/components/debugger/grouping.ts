import type { Exchange } from './model';

/**
 * Group by domain / application / connection in the grid (FG-17). The groups' header lines are rows of the same virtual
 * list (the list stays virtualised: one fixed row height, only the visible rows are drawn). One pass over the sorted rows;
 * a group keeps the order its first row came in, and its rows keep the sort.
 */
export type GroupBy = 'none' | 'domain' | 'application' | 'connection';

export const GROUP_LABEL: Record<GroupBy, string> = { none: 'None', domain: 'Domain', application: 'Application', connection: 'Connection' };

export interface GroupHeader {
  group: true;
  key: string;
  label: string;
  count: number;
  bytes: number;
  errors: number;
  collapsed: boolean;
}
export type GridItem = Exchange | GroupHeader;
export const isGroup = (i: GridItem): i is GroupHeader => (i as GroupHeader).group === true;

const keyOf = (e: Exchange, by: GroupBy): { key: string; label: string } => {
  switch (by) {
    case 'domain':
      return { key: e.host, label: e.host };
    case 'application':
      return { key: e.application ?? '', label: e.application ?? 'Unknown program' };
    default: {
      const key = e.connectionId ?? `port:${e.clientPort}`;
      return { key, label: `Connection ${e.connectionId ? e.connectionId.slice(-6) : `:${e.clientPort}`}${e.application ? ` · ${e.application}` : ''}` };
    }
  }
};

/** The rows with a header line before each group; a collapsed group is its header alone. `order` is every row in the order shown (collapsed or not). */
export function groupRows(rows: readonly Exchange[], by: GroupBy, collapsed: ReadonlySet<string>): { items: GridItem[]; order: Exchange[]; groups: number } {
  if (by === 'none') return { items: rows as Exchange[], order: rows as Exchange[], groups: 0 };
  const groups = new Map<string, { header: GroupHeader; rows: Exchange[] }>();
  for (const e of rows) {
    const { key, label } = keyOf(e, by);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { header: { group: true, key, label, count: 0, bytes: 0, errors: 0, collapsed: collapsed.has(key) }, rows: [] }));
    g.header.count++;
    g.header.bytes += e.responseBodyBytes;
    if (e.error || (e.status ?? 0) >= 400) g.header.errors++;
    g.rows.push(e);
  }
  const items: GridItem[] = [];
  const order: Exchange[] = [];
  for (const g of groups.values()) {
    items.push(g.header);
    for (const e of g.rows) {
      order.push(e);
      if (!g.header.collapsed) items.push(e);
    }
  }
  return { items, order, groups: groups.size };
}

/** The key of the group a row is in (to open a collapsed group that holds the selected row). */
export const groupKeyOf = (e: Exchange, by: GroupBy): string | undefined => (by === 'none' ? undefined : keyOf(e, by).key);
