import { ChevronDown, ChevronRight, FilePlus2, Play, Workflow } from 'lucide-react';
import { useApp } from '../store';
import type { ItemRef } from '@testpion/shared';
import { Empty, IconButton, rowActionClass } from '../components/ui';
import { KindBadge, TEST_KINDS } from '../components/TreeParts';
import { TreeRowShell } from '../components/TreeRowShell';
import type { NodeKind, NodeMenuCtx } from '../lib/node-menu';

export function TestFileBadge({ path }: { path: string }) {
  if (/\.suite\.ya?ml$/i.test(path)) return <KindBadge text="SUITE" cls="text-judge" />;
  const kind = TEST_KINDS[path.split('/')[0]!.toLowerCase()];
  if (kind && path.includes('/')) return <KindBadge text={kind[0]} cls={kind[1]} />;
  return <KindBadge text={/\.json$/i.test(path) ? 'JSON' : /\.csv$/i.test(path) ? 'CSV' : 'YAML'} cls="text-muted" />;
}

/** A row of the test file tree, like the collection tree's: folder (chevron) or file, ▶ run and ⋯ (also on right-click). */
/** F2 renames a file: its path, in a dialog (a path can move it to another folder, which an in-place name can't). */
export function TestTreeRow({
  kind,
  nodeId,
  depth,
  label,
  icon,
  expanded,
  active,
  onClick,
  onRun,
  ctx,
  dragRef,
}: {
  kind: NodeKind;
  nodeId: string;
  depth: number;
  label: string;
  icon: React.ReactNode;
  expanded?: boolean;
  active?: boolean;
  onClick(): void;
  onRun?(): void;
  ctx: () => NodeMenuCtx;
  /** What a drag of the row carries (a test file: dropped on a flow canvas, it becomes a sub-flow step). */
  dragRef?: ItemRef;
}) {
  return (
    <TreeRowShell
      kind={kind}
      nodeId={nodeId}
      label={label}
      active={active}
      expanded={expanded}
      onClick={onClick}
      onOpen={expanded === undefined ? onClick : undefined}
      ctx={ctx}
      drag={dragRef ? [dragRef] : undefined}
      style={{ paddingLeft: (expanded === undefined ? 22 : 6) + depth * 12 }}
      title={`${label} · F2 renames · Delete deletes`}
      actions={
        onRun && (
          <IconButton label={`Run ${label}`} className={rowActionClass()} onClick={onRun}>
            <Play size={12} />
          </IconButton>
        )
      }
    >
      {expanded !== undefined && (expanded ? <ChevronDown size={13} className="text-muted shrink-0 -mr-1" /> : <ChevronRight size={13} className="text-muted shrink-0 -mr-1" />)}
      {icon}
      <span className="truncate">{label}</span>
    </TreeRowShell>
  );
}

/** The Tests view before any test file: what a test is, and the ways to get one. */
export function NoTestFiles({ onNew }: { onNew(): void }) {
  return (
    <Empty
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
