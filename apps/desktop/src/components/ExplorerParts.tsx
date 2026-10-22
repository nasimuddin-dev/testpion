import { Plus } from 'lucide-react';
import { memo, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { baseKind, type ItemRef } from '@testpion/shared';
import { deleteWithUndo } from '../lib/undo-delete';
import { useApp } from '../store';
import type { NodeKind, NodeMenuCtx } from '../lib/node-menu';
import { treeKey, useTreeOpen } from '../lib/tree-state';
import { restoreFolder } from './FolderList';
import { TreeRowShell } from './TreeRowShell';
import type { GitTarget } from './GitMark';
import { CLOSED_ICON, CountPill, FOLDER_ICON, OPEN_ICON, askFolderName, focusRow, moveToFolderItem } from './TreeParts';
import { DEFAULT_FOLDER, DEFAULT_FOLDER_WHY, folderNamesOf, groupByFolder, keptFolders } from '../lib/folders';
import { Button } from './ui';
import { sameProps } from '../lib/same-node';
import { useIsOpenItem } from './open-request-id';

/*
 * The explorer's sections (Favorites, MCP servers, API definitions, Datasets): each header is the section's node, each
 * folder a `folder:<kind>` node, each row its kind's node, all on the one row (TreeRowShell) with the one menu
 * (lib/node-menu.ts). Open/closed state is the workspace's tree state (`explorer` record).
 */

/** Which sections and folders of the explorer are open (lib/tree-state, the `explorer` record). */
export function useOpenSections() {
  const [open, setOpen] = useTreeOpen('explorer');
  const toggle = (id: string, def: boolean) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? def) }));
  const set = (keys: readonly string[], to: boolean) => setOpen((o) => (keys.every((k) => o[k] === to) ? o : { ...o, ...Object.fromEntries(keys.map((k) => [k, to])) }));
  return { isOpen: (id: string, def = true) => open[id] ?? def, toggle, set };
}
export type OpenSections = ReturnType<typeof useOpenSections>;

/** The key of a section's folder in the explorer's tree state. */
export const folderKey = (section: string, name: string) => treeKey(section, 'folder', name);

/** A collapsible section: its header is the section's node (+ New …, New folder, Expand all, Collapse all, its tools). */
export function Section({
  id,
  kind,
  title,
  icon,
  count,
  children,
  def = true,
  sections,
  forceOpen,
  menu,
}: {
  id: string;
  kind: NodeKind;
  title: string;
  icon: ReactNode;
  count?: number;
  children: ReactNode;
  def?: boolean;
  sections: OpenSections;
  forceOpen?: boolean;
  menu: () => NodeMenuCtx;
}) {
  const open = forceOpen || sections.isOpen(id, def);
  return (
    // a tree of its own for screen readers: the header is its first item, what it holds a group under it
    <div className="border-b border-line/60" data-tree-section={id} role="tree" aria-label={title}>
      <div className="sticky top-0 bg-panel z-10">
        <TreeRowShell kind={kind} nodeId={`section:${id}`} label={title} header expanded={open} onClick={() => sections.toggle(id, def)} ctx={menu} className="mx-0.5 pl-1">
          {open ? OPEN_ICON : CLOSED_ICON}
          <span className="text-muted shrink-0">{icon}</span>
          <span className="text-xs font-semibold truncate">{title}</span>
          {count !== undefined && count > 0 && <CountPill n={count} />}
        </TreeRowShell>
      </div>
      {open && (
        <div className="pb-2" role="group">
          {children}
        </div>
      )}
    </div>
  );
}

/** Renaming a row in place: whether it is being renamed, and how to start and finish. */
export interface RowRename {
  editing: boolean;
  start(): void;
  done(name?: string): void;
}

/** What an ItemRow draws, with its handlers made stable (see ItemRow). */
interface ItemRowViewProps {
  kind: NodeKind;
  nodeId: string;
  icon?: ReactNode;
  label: string;
  sub?: ReactNode;
  active: boolean;
  indent?: boolean;
  onClick(): void;
  ctx: () => NodeMenuCtx;
  renaming: boolean;
  done(name?: string): void;
  drag?: ItemRef[];
  git?: GitTarget;
}

const ItemRowView = memo(function ItemRowView({ kind, nodeId, icon, label, sub, active, indent, onClick, ctx, renaming, done, drag, git }: ItemRowViewProps) {
  return (
    <TreeRowShell kind={kind} nodeId={nodeId} label={label} depth={indent ? 2 : 1} active={active} onClick={onClick} onOpen={onClick} ctx={ctx} drag={drag} git={git} rename={renaming ? { value: label, done } : undefined} className={indent ? 'pl-10' : 'pl-6'}>
      {icon && <span className="text-muted shrink-0">{icon}</span>}
      <span className="truncate flex-1">{label}</span>
      {sub && <span className="text-xs text-muted truncate max-w-[45%]">{sub}</span>}
    </TreeRowShell>
  );
}, sameProps);

/**
 * A row of a section (an MCP server, an API definition, a dataset, a favorite): its kind's node. The section builds its rows
 * with fresh handlers on every render; the row hands the node stable ones that call the latest (through a ref), and the node is
 * memoized on what it draws, so a section that re-renders (a filter keystroke, a reveal on a tab switch) re-draws only the
 * rows whose label, icon, highlight or such changed.
 */
export function ItemRow(props: {
  kind: NodeKind;
  nodeId: string;
  icon?: ReactNode;
  label: string;
  sub?: ReactNode;
  active?: boolean;
  /** Highlighted while this is the item the window shows: the row asks for itself, so a switch of tab does not re-render every row of the explorer. */
  activeId?: string;
  indent?: boolean;
  onClick(): void;
  ctx: () => NodeMenuCtx;
  rename?: RowRename;
  drag?: ItemRef[];
  /** What the row is, for its change mark. */
  git?: GitTarget;
}) {
  const open = useIsOpenItem(props.activeId);
  const latest = useRef(props);
  latest.current = props;
  const handlers = useMemo(() => ({ onClick: () => latest.current.onClick(), ctx: () => latest.current.ctx(), done: (name?: string) => latest.current.rename?.done(name) }), []);
  const { kind, nodeId, icon, label, sub, indent, drag, git } = props;
  return <ItemRowView kind={kind} nodeId={nodeId} icon={icon} label={label} sub={sub} active={props.active ?? open} indent={indent} renaming={!!props.rename?.editing} drag={drag} git={git} {...handlers} />;
}

/** Folders of a section's items: the folder names (kept even when empty), and which folder each item is in. */
export interface FolderOps {
  folders: string[];
  /** Change the folder names (new, rename, remove). */
  setFolders(fn: (folders: string[]) => string[]): Promise<void>;
  /** Change which folder items are in: (item id, its folder) → its new folder. */
  assign(fn: (id: string, folder: string | undefined) => string | undefined): Promise<void>;
}

/** All folder names of a section: General (built in, first), the kept ones and the ones its items are in. */
export const folderNames = (ops: FolderOps, items: Array<{ folder?: string }>) => folderNamesOf(ops.folders, items);

export async function newFolderIn(ops: FolderOps) {
  const name = await askFolderName();
  if (name) await ops.setFolders((fs) => (fs.includes(name) ? fs : [...fs, name]));
}

async function renameFolderIn(ops: FolderOps, name: string, next: string) {
  if (next === DEFAULT_FOLDER) {
    useApp.getState().toast(`The folder ${DEFAULT_FOLDER} exists: every list has it`, 'info');
    return;
  }
  await ops.assign((_, folder) => (folder === name ? next : folder));
  await ops.setFolders((fs) => fs.map((x) => (x === name ? next : x)));
}

/** Delete a folder at once, with Undo: its items move to General (they lose their folder), and come back into it. */
function deleteFolderIn(ops: FolderOps, name: string, itemNoun: string) {
  return deleteWithUndo({
    kind: 'folder',
    name,
    note: `Its ${itemNoun}s moved to ${DEFAULT_FOLDER}`,
    run: async () => {
      const was = new Set<string>();
      const at = ops.folders.indexOf(name);
      await ops.assign((id, folder) => (folder === name ? (was.add(id), undefined) : folder));
      await ops.setFolders((fs) => fs.filter((x) => x !== name));
      return async () => {
        await ops.setFolders((fs) => restoreFolder(fs, name, at));
        await ops.assign((id, folder) => (was.has(id) && !folder ? name : folder));
      };
    },
  });
}

/** "Move to folder ▸" of an item: each folder (General included), or a new one. Moving to General stores no folder. */
export function moveToFolderSubmenu(ops: FolderOps, all: Array<{ folder?: string }>, itemId: string, current: string | undefined) {
  return moveToFolderItem({
    folders: folderNames(ops, all),
    current,
    move: async (to) => {
      if (to && to !== DEFAULT_FOLDER && !ops.folders.includes(to)) await ops.setFolders((fs) => keptFolders([...fs, to]));
      await ops.assign((id, folder) => (id === itemId ? to : folder));
    },
  }).items!;
}

/** A section's items in their folders (each folder a `folder:<kind>` node); the ones in none are in General (first, always there). */
export function FolderedRows<T extends { id: string; folder?: string }>({
  section,
  kind,
  items,
  ops,
  sections,
  filtering,
  itemNoun,
  create,
  row,
}: {
  section: string;
  kind: `folder:${string}`;
  items: T[];
  ops: FolderOps;
  sections: OpenSections;
  filtering: boolean;
  itemNoun: string;
  /** The "New … here" items of a folder. */
  create?(folder: string): NodeMenuCtx['create'];
  /** One item's row: always inside a folder (its `indent` is true). */
  row(item: T): ReactNode;
}) {
  const [renaming, setRenaming] = useState<string>();
  // what a folder row calls, through one ref that is always current: the rows are memoized
  const host = useRef<FolderHost>(null!);
  host.current = { ops, sections, itemNoun, create, setRenaming };
  // the items of each folder, grouped once (not one pass over the items per folder)
  const { names, byFolder } = useMemo(
    () => groupByFolder(items, ops.folders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ops.folders, items],
  );
  return (
    <>
      {names.map((name) => {
        const inside = byFolder.get(name) ?? [];
        if (filtering && !inside.length) return null;
        const key = folderKey(section, name);
        const isOpen = filtering || sections.isOpen(key, true);
        return (
          <div key={key}>
            <SectionFolderRow kind={kind as NodeKind} section={section} name={name} count={inside.length} open={isOpen} renaming={renaming === name} host={host} />
            {isOpen && <div role="group">{inside.length ? inside.map((i) => row(i)) : <p className="pl-10 py-1 text-xs text-muted">Empty folder</p>}</div>}
          </div>
        );
      })}
    </>
  );
}

/** What a section's folder rows need from their section (through a ref that is always current). */
interface FolderHost {
  ops: FolderOps;
  sections: OpenSections;
  itemNoun: string;
  create?(folder: string): NodeMenuCtx['create'];
  setRenaming(name: string | undefined): void;
}

/** A folder of a section: its chevron, name and count; renamed in place. Memoized: only its own props re-render it. */
const SectionFolderRow = memo(function SectionFolderRow({ kind, section, name, count, open, renaming, host }: { kind: NodeKind; section: string; name: string; count: number; open: boolean; renaming: boolean; host: RefObject<FolderHost> }) {
  const h = () => host.current;
  const key = folderKey(section, name);
  return (
    <TreeRowShell
      kind={kind}
      nodeId={key}
      label={name}
      depth={1}
      expanded={open}
      git={{ folder: baseKind(kind), name }}
      onClick={() => h().sections.toggle(key, true)}
      className="pl-5"
      rename={
        renaming
          ? {
              value: name,
              label: 'Folder name',
              done: (to) => {
                h().setRenaming(undefined);
                if (to && to !== name) void renameFolderIn(h().ops, name, to);
                focusRow(folderKey(section, to || name));
              },
            }
          : undefined
      }
      ctx={() => ({
        name,
        create: h().create?.(name),
        on: {
          expandAll: () => h().sections.set([key], true),
          collapseAll: () => h().sections.set([key], false),
          rename: () => h().setRenaming(name),
          delete: () => void deleteFolderIn(h().ops, name, h().itemNoun),
        },
        // General is built in: it always exists
        disabled: name === DEFAULT_FOLDER ? { rename: DEFAULT_FOLDER_WHY, delete: DEFAULT_FOLDER_WHY } : undefined,
      })}
    >
      {open ? OPEN_ICON : CLOSED_ICON}
      {FOLDER_ICON}
      <span className="truncate flex-1">{name}</span>
      <CountPill n={count} />
    </TreeRowShell>
  );
});

/** What a section is for, and a button to start, when it's empty. */
export function EmptyHint({ text, action, onAction }: { text: string; action: string; onAction(): void }) {
  return (
    <div className="px-6 py-1.5 flex flex-col items-start gap-1.5">
      <p className="text-xs text-muted leading-snug">{text}</p>
      <Button size="sm" icon={<Plus size={12} />} onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
