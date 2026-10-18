import { KIND_INFO, MENU_GROUPS } from '@testpion/shared';
import { baseKind, fullCtx, nodeMenuGroups, type NodeKind } from './node-menu';

/**
 * The docs' table of every node menu (docs/getting-started/finding-your-way.md, "Menus"): generated from the same
 * function that builds the menus, so the page cannot drift from the app (tests/unit/menus-doc.test.ts compares them).
 */
export const DOC_NODES: ReadonlyArray<[NodeKind, string]> = [
  ['collection', 'Collection'],
  ['category', 'Protocol group (REST, SOAP …) of a collection'],
  ['folder', 'Folder of a collection'],
  ['request', 'Request (HTTP, SOAP, GraphQL)'],
  ['folder:grpc-call', 'Folder of gRPC calls or connections'],
  ['grpc-call', 'Saved gRPC call'],
  ['ws-connection', 'Saved WebSocket / MQTT / Kafka connection'],
  ['favorites', 'Favorites section'],
  ['section:mcp-server', 'MCP servers section'],
  ['folder:mcp-server', 'Folder of MCP servers'],
  ['mcp-server', 'MCP server'],
  ['section:spec', 'API definitions section'],
  ['folder:spec', 'Folder of API definitions'],
  ['spec', 'API definition'],
  ['section:dataset', 'Datasets section'],
  ['folder:dataset', 'Folder of datasets'],
  ['dataset', 'Dataset'],
  ['section:collection', 'The sidebar’s blank area'],
  ['prompt', 'Saved prompt (AI Lab)'],
  ['load-test', 'Saved load test'],
  ['evaluation', 'Saved evaluation'],
  ['monitor', 'Monitor'],
  ['folder:monitor', 'Folder of a list (monitors, prompts, load tests, evaluations)'],
  ['section:test', 'Tests section (and its blank area)'],
  ['folder:test', 'Folder of test files'],
  ['test', 'Test file'],
  ['run', 'Run'],
  ['history', 'History entry'],
  ['trace', 'Trace'],
  ['environment', 'Environment'],
  ['provider', 'AI provider'],
];

/** One cell: a group's items, a submenu with ▸, the key that runs an item after it. */
const cell = (items: Array<{ label: string; items?: unknown; shortcut?: string }>) => items.map((i) => `${i.items ? `${i.label} ▸` : i.label}${i.shortcut ? ` <kbd>${i.shortcut}</kbd>` : ''}`).join(', ') || '';

/** The Markdown table: one row per node, one column per group (in MENU_GROUPS order); "New …" stands for the kind's new items. */
export function nodeMenuTable(): string {
  const head = `| Node | ${MENU_GROUPS.join(' | ')} |`;
  const sep = `|${'---|'.repeat(MENU_GROUPS.length + 1)}`;
  const rows = DOC_NODES.map(([kind, name]) => {
    if (!KIND_INFO[baseKind(kind)]) throw new Error(`No kind for ${kind}`);
    const groups = nodeMenuGroups(kind, fullCtx(kind));
    return `| ${name} | ${groups.map((g) => cell(g.items).replace(/\|/g, '\\|')).join(' | ')} |`;
  });
  return [head, sep, ...rows].join('\n');
}
