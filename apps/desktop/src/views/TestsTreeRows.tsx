import { ChevronDown, ChevronRight, FileCheck2, FilePlus2, Folder, Play, Workflow } from 'lucide-react';
import { memo, useMemo, type RefObject } from 'react';
import { useApp } from '../store';
import { Empty, IconButton, rowActionClass, VirtualList } from '../components/ui';
import { TEST_KINDS, TreeBadge } from '../components/TreeParts';
import { TreeRowShell } from '../components/TreeRowShell';
import type { NodeMenuCtx } from '../lib/node-menu';
import type { TreeOpen } from '../lib/tree-state';

/** A file or folder of the workspace's tests/ folder, as tests.tree answers. */
export interface TestNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TestNode[];
}

/** What a test file is (by its folder: rest/ → HTTP, ai/ → AI …; a suite; else its format), as the one badge. */
export function TestFileBadge({ path }: { path: string }) {
  if (/\.suite\.ya?ml$/i.test(path)) return <TreeBadge label="SUITE" className="text-judge" />;
  const kind = TEST_KINDS[path.split('/')[0]!.toLowerCase()];
  if (kind && path.includes('/')) return <TreeBadge label={kind[0]} className={kind[1]} />;
  return <TreeBadge label={/\.json$/i.test(path) ? 'JSON' : /\.csv$/i.test(path) ? 'CSV' : 'YAML'} className="text-muted" />;
}

/** What the rows of the test file tree call, through one ref the view keeps current (the rows are memoized). */
export interface TestsHost {
  openFile(path: string): void;
  run(paths: string[], name?: string): void;
  toggle(path: string): void;
  fileMenu(n: TestNode): NodeMenuCtx;
  folderMenu(n: TestNode): NodeMenuCtx;
  isTestFile(name: string): boolean;
  /** A file renamed in place (F2, Rename): its new name, in its folder; nothing when cancelled. */
  finishRename(n: TestNode, name?: string): void;
}

/** One row of the tree as drawn: a folder (open or closed) or a file, at its depth. */
interface Row {
  n: TestNode;
  depth: number;
  open?: boolean;
}

/** Below this many rows every row is drawn (a small tree); above it only the rows on screen and a margin. */
const DRAW_ALL = 300;
const OVERSCAN = 25;

/** The tree filtered by file or folder path (matching folders stay open; empty folders go). */
export function filterTestTree(nodes: TestNode[], tf: string): TestNode[] {
  if (!tf) return nodes;
  return nodes.flatMap((n) => {
    if (n.kind === 'dir') {
      const c = filterTestTree(n.children ?? [], tf);
      return c.length ? [{ ...n, children: c }] : [];
    }
    return n.path.toLowerCase().includes(tf) ? [n] : [];
  });
}

/**
 * The test file tree, flattened to the rows that show and drawn through a VirtualList (like the Collections tree): a
 * keystroke in the editor never touches it (its props are the tree, the filter and what is open), and a tree of a
 * thousand files draws only the rows on screen.
 */
export const TestFileTree = memo(function TestFileTree({ tree, filter, open, file, renaming, host }: { tree: TestNode[]; filter: string; open: TreeOpen; file?: string; renaming?: string; host: RefObject<TestsHost> }) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: TestNode[], depth: number) => {
      for (const n of nodes) {
        if (n.kind === 'dir') {
          // while filtering every folder shows open (the matches are inside)
          const isOpen = !!filter || (open[n.path] ?? true);
          out.push({ n, depth, open: isOpen });
          if (isOpen) walk(n.children ?? [], depth + 1);
        } else out.push({ n, depth });
      }
    };
    walk(filterTestTree(tree, filter), 0);
    return out;
  }, [tree, filter, open]);
  const rowHeight = 2 * useApp((s) => s.settings?.fontSize ?? 14);
  if (filter && !rows.length) return <p className="px-3 py-4 text-sm text-muted text-center">No test files match this filter.</p>;
  return (
    <div role="tree" aria-label="Test files" data-tree-rows={rows.length}>
      <VirtualList
        items={rows}
        rowHeight={rowHeight}
        keyOf={(r) => r.n.path}
        name="TestFileTree"
        scrollParent
        overscan={rows.length <= DRAW_ALL ? DRAW_ALL : OVERSCAN}
        render={(r) => <TestTreeRow n={r.n} depth={r.depth} expanded={r.open} active={file === r.n.path} renaming={renaming === r.n.path} host={host} />}
      />
    </div>
  );
});

/**
 * A row of the test file tree, like the collection tree's: folder (chevron) or file, ▶ run and ⋯ (also on right-click).
 * F2 renames a file in place (its name, in its folder; the tab's Rename takes a path, which can move it).
 */
export const TestTreeRow = memo(function TestTreeRow({ n, depth, expanded, active, renaming, host }: { n: TestNode; depth: number; expanded?: boolean; active?: boolean; renaming: boolean; host: RefObject<TestsHost> }) {
  const h = () => host.current;
  const dir = n.kind === 'dir';
  const runnable = dir || h().isTestFile(n.name);
  return (
    <TreeRowShell
      kind={dir ? 'folder:test' : 'test'}
      nodeId={dir ? `tests:dir:${n.path}` : `tests:${n.path}`}
      label={n.name}
      depth={depth}
      active={active}
      expanded={expanded}
      onClick={() => (dir ? h().toggle(n.path) : h().openFile(n.path))}
      onOpen={dir ? undefined : () => h().openFile(n.path)}
      ctx={() => (dir ? h().folderMenu(n) : h().fileMenu(n))}
      rename={renaming ? { value: n.name, label: 'File name', done: (name) => h().finishRename(n, name) } : undefined}
      drag={!dir && h().isTestFile(n.name) && !/\.suite\./.test(n.name) ? [{ kind: 'test', path: n.path }] : undefined}
      style={{ paddingLeft: (dir ? 6 : 22) + depth * 12 }}
      actions={
        runnable && (
          <IconButton label={`Run ${n.name}`} className={rowActionClass()} onClick={() => h().run([n.path], n.path)}>
            <Play size={12} />
          </IconButton>
        )
      }
    >
      {dir && (expanded ? <ChevronDown size={13} className="text-muted shrink-0 -mr-1" /> : <ChevronRight size={13} className="text-muted shrink-0 -mr-1" />)}
      {dir ? <Folder size={13} className="text-muted shrink-0" /> : <TestFileBadge path={n.path} />}
      <span className="truncate">{n.name}</span>
    </TreeRowShell>
  );
});

/** The Tests view before any test file: what a test is, and the ways to get one. */
export function NoTestFiles({ onNew }: { onNew(): void }) {
  return (
    <Empty
      icon={<FileCheck2 size={24} />}
      title="No test files"
      actions={[
        { label: 'New test file', icon: <FilePlus2 size={12} />, onClick: onNew },
        { label: 'Generate from an API definition', icon: <Workflow size={12} />, onClick: () => useApp.getState().openIntent('apidef', {}) },
      ]}
    >
      A test is a YAML file in tests/: a request (HTTP, GraphQL, gRPC, WebSocket, MCP or AI) and its checks, or a whole flow. Create one, generate a first suite from an API definition, or save one
      from a request tab, the MCP view or AI Lab.
    </Empty>
  );
}
