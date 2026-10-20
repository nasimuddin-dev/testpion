import { ChevronDown, ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, MoreHorizontal, Plus } from 'lucide-react';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { promptText } from '../store';
import { cx, Menu, rowActionClass, type MenuItem } from './ui';
import { LABEL } from '../lib/vocabulary';
import { buildNodeMenu, type NodeKind, type NodeMenuCtx } from '../lib/node-menu';
import { transferActions } from '../lib/transfer';
import { copyText } from '../lib/clipboard';
import { itemRefUrl } from '@testpion/shared';
import { gitActions } from '../lib/git-items';

/*
 * The parts every sidebar tree is made of (the explorer, monitors, load tests, saved prompts …), so they all look
 * and behave the same: a header with + and ⋯, folder rows, the ⋯ and + buttons of a row, and the folder menus.
 */

// the icons every row draws, made once: a tree of thousands of rows re-renders the same elements, which React skips
export const MORE_ICON = <MoreHorizontal size={14} />;
export const OPEN_ICON = <ChevronDown size={13} className="text-muted shrink-0" />;
export const CLOSED_ICON = <ChevronRight size={13} className="text-muted shrink-0" />;
export const FOLDER_ICON = <Folder size={13} className="text-muted shrink-0" />;

/**
 * The ⋯ button of a row: opens its menu (a right-click on the row opens the same one). `items` may be a function: the
 * menu is then built only while it is open (a tree of thousands of rows holds no menus).
 */
export function RowMenu({ label, items, open, onOpenChange, header }: { label: string; items: MenuItem[] | (() => MenuItem[]); open?: boolean; onOpenChange?(open: boolean): void; header?: boolean }) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = (v: boolean) => {
    if (open === undefined) setOwn(v);
    onOpenChange?.(v);
  };
  return (
    <Menu
      width={230}
      open={isOpen}
      onOpenChange={setOpen}
      items={isOpen ? (typeof items === 'function' ? items() : items) : []}
      trigger={
        <button aria-label={`More actions for ${label}`} className={rowActionClass(header)} onClick={(e) => e.stopPropagation()}>
          {MORE_ICON}
        </button>
      }
    />
  );
}

/** A count beside a title or folder name. */
export const CountPill = memo(function CountPill({ n }: { n: number }) {
  return <span className="text-[0.7rem] px-1.5 rounded-full bg-panel2 text-muted tabular-nums shrink-0">{n}</span>;
});

/** The header of a sidebar list: title, count, + (new) and ⋯ (also on right-click). */
export function TreeHeader({
  title,
  icon,
  count,
  addLabel,
  onAdd,
  addItems,
  menu = [],
}: {
  title: string;
  icon?: ReactNode;
  count?: number;
  addLabel?: string;
  onAdd?(): void;
  /** The + opens these (kinds of new item) instead of calling onAdd; the ⋯ menu lists them too. */
  addItems?: MenuItem[];
  menu?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const adds: MenuItem[] = addItems ?? (onAdd ? [{ label: addLabel ?? 'New', icon: <Plus size={14} />, onSelect: onAdd }] : []);
  const items: MenuItem[] = [...adds, ...menu.map((m, i) => (i === 0 && adds.length > 1 ? { ...m, separator: true } : m))];
  return (
    <div
      className={cx('group flex items-center gap-0.5 h-9 pl-3 pr-1 shrink-0', open && 'bg-hover')}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      {icon && <span className="text-muted shrink-0 mr-1">{icon}</span>}
      <span className="text-[0.82rem] font-semibold truncate">{title}</span>
      {count !== undefined && count > 0 && (
        <span className="ml-1.5">
          <CountPill n={count} />
        </span>
      )}
      <span className="flex-1" />
      {items.length > 0 && <RowMenu label={title} items={items} open={open} onOpenChange={setOpen} header />}
    </div>
  );
}

/** Ask for a new folder's name. */
export const askFolderName = async () => (await promptText('New folder', { message: 'Folder name', okLabel: 'Create' }))?.trim() || undefined;

const SHORT_METHOD: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT' };

/**
 * THE badge: the type label in front of every row of every tree, list and tab (GET, POST, GQL, gRPC, WS, MCP, AI, API,
 * CSV …): one pill of one width everywhere, so names line up and the space between the label and the name is the same
 * on every row. Long labels are cut to five letters; the full word is the tooltip. Colours come from KIND_COLOR (a
 * kind) or `method-<METHOD>` (an HTTP method).
 */
export const TreeBadge = memo(function TreeBadge({ label, className }: { label: string; className?: string }) {
  const text = SHORT_METHOD[label.toUpperCase()] ?? label.slice(0, 5);
  return (
    <span className={cx('mono method-badge text-[0.64rem] font-bold w-[2.375rem] shrink-0 text-center', className)} title={label}>
      {text}
    </span>
  );
});

/**
 * The colour of each kind of item in badges and icons (styles.css: one `--k-*` token per kind, dark and light): the
 * one place the tree files take a kind's colour from.
 */
export const KIND_COLOR = {
  graphql: 'kind-graphql',
  grpc: 'kind-grpc',
  websocket: 'kind-ws',
  soap: 'kind-soap',
  api: 'kind-api',
  script: 'kind-script',
  mcp: 'kind-mcp',
  agent: 'kind-agent',
  ai: 'kind-ai',
  dataset: 'kind-dataset',
} as const;

/** "Move to folder" in an item's menu: each folder, a new one, or the top level. */
export function moveToFolderItem({ folders, current, move }: { folders: string[]; current?: string; move(folder: string | undefined): unknown }): MenuItem {
  const others = folders.filter((f) => f !== current);
  return {
    label: LABEL.moveToFolder,
    icon: <FolderInput size={14} />,
    onSelect: () => undefined,
    items: [
      ...others.map((f) => ({ label: f, icon: <Folder size={14} />, onSelect: () => void move(f) })),
      {
        label: LABEL.newFolder,
        icon: <FolderPlus size={14} />,
        separator: others.length > 0,
        onSelect: async () => {
          const name = await askFolderName();
          if (name) await move(name);
        },
      },
      ...(current ? [{ label: 'Move to top level', icon: <FolderOpen size={14} />, onSelect: () => void move(undefined) }] : []),
    ],
  };
}

/**
 * A name edited in place (rename in a tree, a list or a tab): the text is selected, Enter or clicking away saves,
 * Esc cancels. A blank name (or what `validate` refuses) is not saved: the field shows why, and clicking away
 * cancels. Keys stay in the field, so tree shortcuts (F2, Delete, arrows) don't fire while typing.
 */
export function InlineRename({ value, onCommit, onCancel, validate, label = 'Name', className }: { value: string; onCommit(name: string): void; onCancel(): void; validate?(name: string): string | undefined; label?: string; className?: string }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    // after a menu closes (Rename in a ⋯ menu) its focus handling may run late and take the focus: take it back
    const grab = () => {
      const a = document.activeElement as HTMLElement | null;
      // never from another field the user went to: only from nothing, or a button / menu that just closed
      const typing = a && a !== ref.current && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
      if (ref.current && a !== ref.current && !typing) {
        ref.current.focus();
        ref.current.select();
      }
    };
    const id = requestAnimationFrame(grab);
    const timers = [60, 200, 450, 900].map((ms) => setTimeout(grab, ms));
    return () => (cancelAnimationFrame(id), timers.forEach(clearTimeout));
  }, []);
  // a click anywhere else ends the rename, even if the field lost the focus to something else
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.blur(), finishRef.current();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  const check = (t: string) => (!t.trim() ? 'A name is required' : validate?.(t.trim()));
  const finish = (save: boolean) => {
    if (done.current) return;
    const t = text.trim();
    const problem = check(text);
    if (save && problem) return setError(problem);
    done.current = true;
    if (save && t !== value) onCommit(t);
    else onCancel();
  };
  // what clicking away does, with the latest text
  const finishRef = useRef(() => {});
  finishRef.current = () => (check(text) ? finish(false) : finish(true));
  return (
    <span className={cx('relative flex-1 min-w-0', className)}>
      <input
        ref={ref}
        aria-label={label}
        aria-invalid={!!error}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(check(e.target.value));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        // clicking away saves a valid name and drops an invalid one
        onBlur={() => (check(text) ? finish(false) : finish(true))}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => (e.preventDefault(), e.stopPropagation())}
        className={cx('w-full h-6 px-1.5 -ml-1.5 rounded-md bg-field text-fg text-sm border outline-none focus:ring-2', error ? 'border-bad focus:ring-bad/30' : 'border-accent focus:ring-accent/30')}
      />
      {error && <span role="alert" className="absolute left-0 top-full mt-1 z-20 rounded-md bg-bad text-white text-xs px-2 py-0.5 shadow whitespace-nowrap">{error}</span>}
    </span>
  );
}

/**
 * Put the keyboard back on a row (rows carry data-rename-id = their node id): after an inline rename, after a delete
 * (the row next to the deleted one), after Undo (the restored row). The row may still be on its way (a list reloads
 * over RPC after an undo): it is looked for over the next second, and focused once it is there.
 */
export function focusRow(id: string, tries = 60): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  const look = (left: number) =>
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-rename-id="${CSS.escape(id)}"]`);
      if (row) row.focus();
      else if (left > 0) look(left - 1);
    });
  look(tries);
}

/**
 * The row the keyboard should land on once `row` is deleted: the next visible row of its tree, else the one before it
 * (the row's node id, for focusRow); called before the delete, while the row is still there.
 */
export function neighbourRowId(row: HTMLElement): string | undefined {
  const host = row.closest<HTMLElement>('[role="tree"]') ?? row.closest<HTMLElement>('[data-explorer-area], main') ?? document.body;
  const rows = [...host.querySelectorAll<HTMLElement>('[data-tree-row]')].filter((r) => r.offsetParent);
  const at = rows.indexOf(row);
  if (at < 0) return undefined;
  // the rows inside a deleted folder go with it: the first row after it that is not deeper than it
  const level = Number(row.getAttribute('aria-level') ?? 0);
  const next = rows.slice(at + 1).find((r) => Number(r.getAttribute('aria-level') ?? 0) <= level) ?? rows[at - 1];
  return next?.dataset.renameId;
}

/**
 * After a delete that `row` asked for: once the row is gone (the delete is an RPC: the list reloads after it), the
 * keyboard goes to its neighbour instead of nowhere (the window's body). Looks for a few seconds; a delete that did not
 * happen (an error, a dialog cancelled) leaves the focus alone.
 */
export function keepFocusAfterDelete(row: HTMLElement, neighbour = neighbourRowId(row)): void {
  if (!neighbour) return;
  let left = 180;
  const check = () => {
    if (!row.isConnected || !row.offsetParent) {
      // only when nothing else took the keyboard meanwhile (the user clicked elsewhere, a field opened)
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected) focusRow(neighbour);
      return;
    }
    if (left-- > 0) requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

/**
 * The keyboard in every tree and list (put it on the container's onKeyDown): ↑ ↓ move between rows, Home / End jump to
 * the first and last, → opens a closed folder and ← closes an open one. Rows are the elements with data-tree-row.
 */
export function treeKeys(e: React.KeyboardEvent<HTMLElement>): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-row]');
  if (!row || (e.target as HTMLElement).tagName === 'INPUT') return;
  // kept: React clears the event's currentTarget once the handler returns (Home / End look again a little later)
  const container = e.currentTarget;
  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-tree-row]')].filter((r) => r.offsetParent);
  const go = (next?: HTMLElement) => {
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  };
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
    // the keyboard's right-click: the focused row's menu (its ⋯ button), the same menu a right-click opens
    const host = row.closest<HTMLElement>('[data-node-id], [data-tree-section]') ?? row.parentElement;
    const button = host?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (button) {
      e.preventDefault();
      button.click();
    }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const all = rows();
    go(all[all.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]);
  } else if (e.key === 'Home' || e.key === 'End') {
    const pick = () => (e.key === 'Home' ? rows()[0] : rows().at(-1));
    const target = pick();
    go(target);
    // a long list draws only the rows on screen (VirtualList): scroll to its start or end, and once the rows there
    // are drawn, move to the first or last of them
    let box: HTMLElement | null = row.parentElement;
    while (box && box !== container.parentElement && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!box || box === container.parentElement) return;
    box.scrollTop = e.key === 'Home' ? 0 : box.scrollHeight;
    setTimeout(() => {
      const now = document.activeElement;
      if (now !== target && now !== document.body && target?.isConnected) return;
      const next = pick();
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
    }, 80);
  }
  else if ((e.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') || (e.key === 'ArrowLeft' && row.getAttribute('aria-expanded') === 'true')) {
    e.preventDefault();
    row.click();
  } else if (e.key.length === 1 && e.key !== '*' && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // typeahead: letters typed in a row jump to the next row whose name starts with them (as in a file tree)
    const now = e.timeStamp;
    typed = now - typedAt < 700 ? typed + e.key.toLowerCase() : e.key.toLowerCase();
    typedAt = now;
    const all = rows();
    const at = all.indexOf(row);
    const name = (r: HTMLElement) => (r.dataset.rowName ?? r.textContent ?? '').trim().toLowerCase();
    // the same letter again moves on to the next match; more letters refine the current one
    const start = typed.length > 1 ? at : at + 1;
    const next = [...all.slice(start), ...all.slice(0, start)].find((r) => name(r).startsWith(typed));
    go(next);
  }
}
/** What was typed in a tree (typeahead), and when (the event's time: no timer). */
let typed = '';
let typedAt = -Infinity;

/** What a test (or a test file, by its folder: rest/ → HTTP …) is, as TreeBadge text and colour: the Tests tree, its tabs and the flow diagram share it. */
export const TEST_KINDS: Record<string, [string, string]> = {
  rest: ['HTTP', 'text-ok'],
  http: ['HTTP', 'text-ok'],
  soap: ['SOAP', KIND_COLOR.soap],
  graphql: ['GQL', KIND_COLOR.graphql],
  grpc: ['gRPC', KIND_COLOR.grpc],
  websocket: ['WS', KIND_COLOR.websocket],
  mqtt: ['MQTT', KIND_COLOR.websocket],
  kafka: ['KFK', KIND_COLOR.websocket],
  mcp: ['MCP', KIND_COLOR.mcp],
  ai: ['AI', KIND_COLOR.ai],
  llm: ['AI', KIND_COLOR.ai],
  rag: ['RAG', KIND_COLOR.ai],
  agent: ['AGT', KIND_COLOR.agent],
  delay: ['WAIT', 'text-muted'],
  condition: ['IF', 'text-warn'],
  script: ['JS', KIND_COLOR.script],
  flow: ['FLOW', 'text-accent'],
  log: ['LOG', 'text-muted'],
  set: ['SET', KIND_COLOR.mcp],
  assert: ['CHK', 'text-ok'],
};

/**
 * The ⋯ menu of every tree and list node (lib/node-menu.ts builds it, in one group order everywhere). `ctx` is read
 * only when the menu opens, so a closed row holds no menu. A row's right-click opens the same menu (controlled `open`).
 */
export function NodeMenu({ kind, ctx, open, onOpenChange, header, label }: { kind: NodeKind; ctx: () => NodeMenuCtx; open?: boolean; onOpenChange?(open: boolean): void; header?: boolean; label?: string }) {
  return <RowMenu label={label ?? 'this item'} items={() => buildNodeMenu(kind, withRefDefaults(ctx(), kind))} open={open} onOpenChange={onOpenChange} header={header} />;
}

/**
 * What every node can do without the view's help: Copy link (its testpion:// link) for a node with an ItemRef, and
 * Export… / Import… (lib/transfer.ts) for the kinds that have them; a view's own handler wins.
 */
export function withRefDefaults(c: NodeMenuCtx, kind: NodeKind): NodeMenuCtx {
  const transfer = transferActions(kind, c);
  const ref = c.ref;
  const link = ref && !c.on.copyLink ? { copyLink: () => copyText(itemRefUrl(ref), 'the link') } : {};
  const git = ref ? gitActions(kind, c) : undefined;
  return { ...c, ...(git ? { repo: c.repo ?? git.repo, disabled: { ...git.disabled, ...c.disabled } } : {}), on: { ...transfer, ...link, ...git?.on, ...c.on } };
}
