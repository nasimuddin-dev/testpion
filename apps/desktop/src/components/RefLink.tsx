import {
  Activity,
  Disc3,
  BookOpen,
  Bookmark,
  Boxes,
  Braces,
  Bug,
  Copy,
  ExternalLink,
  FileCode,
  FileDiff,
  FlaskConical,
  Folder,
  FolderTree,
  HeartPulse,
  History,
  KeyRound,
  Lock,
  Network,
  PanelLeft,
  Plug,
  Radio,
  Server,
  ShieldCheck,
  Sparkles,
  SquareArrowOutUpRight,
  Table,
  Waypoints,
  Workflow,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ITEM_KIND_LABEL, toItemRef, type ItemRef } from '@testpion/shared';
import { copyRefLink, openRef, refLabel, revealInSidebar } from '../lib/open-ref';
import { LABEL } from '../lib/vocabulary';
import { Menu, cx, type MenuItem } from './ui';

/** The icon of each kind of item (a saved item by its library: a gRPC call, a connection …), the same wherever it is named. */
export function refIcon(ref: ItemRef, size = 12): ReactNode {
  const p = { size, 'aria-hidden': true } as const;
  switch (ref.kind) {
    case 'request':
      return <Network {...p} />;
    case 'collection':
      return <FolderTree {...p} />;
    case 'folder':
      return <Folder {...p} />;
    case 'saved':
      return ref.library === 'grpc' ? (
        <Waypoints {...p} />
      ) : ref.library === 'websocket' ? (
        <Radio {...p} />
      ) : ref.library === 'ai-prompts' || ref.library === 'evaluations' ? (
        <Sparkles {...p} />
      ) : (
        <Bookmark {...p} />
      );
    case 'monitor':
      return <HeartPulse {...p} />;
    case 'environment':
      return <KeyRound {...p} />;
    case 'variable':
      return <Braces {...p} />;
    case 'test':
      return <ShieldCheck {...p} />;
    case 'flow':
      return <Workflow {...p} />;
    case 'test-case':
      return <FlaskConical {...p} />;
    case 'run':
      return <Boxes {...p} />;
    case 'history':
      return <History {...p} />;
    case 'trace':
      return <Activity {...p} />;
    case 'capture':
      return <Disc3 {...p} />;
    case 'exchange':
      return <Bug {...p} />;
    case 'mcp-server':
      return <Plug {...p} />;
    case 'provider':
      return <Sparkles {...p} />;
    case 'spec':
      return <FileCode {...p} />;
    case 'dataset':
      return <Table {...p} />;
    case 'mock':
      return <Server {...p} />;
    case 'certificate':
      return <Lock {...p} />;
    case 'git-file':
      return <FileDiff {...p} />;
    case 'doc':
      return <BookOpen {...p} />;
  }
}

/** The right-click menu of a named item, the same everywhere: Open · Open in new tab · Reveal in sidebar · Copy link. */
export function refMenu(ref: ItemRef): MenuItem[] {
  const items: MenuItem[] = [{ label: 'Open', icon: <ExternalLink size={14} />, onSelect: () => void openRef(ref) }];
  if (ref.kind !== 'doc') items.push({ label: 'Open in new tab', icon: <SquareArrowOutUpRight size={14} />, onSelect: () => void openRef(ref, { newTab: true }) });
  // a request is shown in the explorer as it opens (the explorer follows the editor)
  // the item's row in the Collections explorer, without opening it (WF-11: the same as a tab's and a breadcrumb's)
  if (ref.kind === 'request' || ref.kind === 'folder' || ref.kind === 'collection' || (ref.kind === 'saved' && (ref.library === 'grpc' || ref.library === 'websocket')))
    items.push({ label: LABEL.revealInSidebar, icon: <PanelLeft size={14} />, onSelect: () => revealInSidebar(ref) });
  if (ref.kind === 'history') items.push({ label: 'Open in its editor', icon: <ExternalLink size={14} />, onSelect: () => void openRef(ref, { edit: true }) });
  items.push({ label: 'Copy link', icon: <Copy size={14} />, separator: true, onSelect: () => void copyRefLink(ref) });
  return items;
}

/**
 * The one inline link that names an item and opens it (WF-02): its icon and name, a click opens it through `openRef`
 * (a gone item says so, with what to open instead), right-click has Open · Open in new tab · Reveal in sidebar · Copy
 * link. Used wherever an item is mentioned in text: run results, the Console, traces, the Git list, toasts, attention
 * items. `children` (or `label`) overrides the name the window knows; `edit` opens a history entry in its editor.
 */
export function RefLink({
  to,
  label,
  children,
  className,
  icon = true,
  edit,
  title,
}: {
  to: ItemRef;
  label?: string;
  children?: ReactNode;
  className?: string;
  icon?: boolean;
  edit?: boolean;
  title?: string;
}) {
  const [menu, setMenu] = useState(false);
  const ref = toItemRef(to);
  if (!ref) return <span className={className}>{children ?? label ?? 'Unknown item'}</span>;
  const open = () => void openRef(ref, edit ? { edit: true } : {});
  return (
    <Menu
      width={210}
      align="start"
      open={menu}
      onOpenChange={setMenu}
      items={refMenu(ref)}
      trigger={
        <button
          type="button"
          data-ref-link={ref.kind}
          title={title ?? `Open ${ITEM_KIND_LABEL[ref.kind].toLowerCase()} (right-click for more)`}
          className={cx('inline-flex items-center gap-1 min-w-0 max-w-full text-accent hover:underline text-left', className)}
          // a click opens it; the menu is the right-click (the Menu would take the press)
          onPointerDown={(e) => e.button === 0 && e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            open();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              open();
            } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              setMenu(true);
            } else if (e.key === 'ArrowDown') e.preventDefault();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu(true);
          }}
        >
          {icon && <span className="shrink-0 opacity-80">{refIcon(ref)}</span>}
          <span className="truncate">{children ?? label ?? refLabel(ref)}</span>
        </button>
      }
    />
  );
}

/**
 * The items something belongs to, as one line of links (WF-16): a console entry's saved request, History entry, run and
 * trace; a trace's request, History entry and run. A History entry also offers "Open as request": what was sent, in its
 * editor. The same line wherever an entry names what it came from.
 */
export function RelatedRefs({ refs, exclude, className }: { refs?: ItemRef[]; exclude?: ItemRef['kind'][]; className?: string }) {
  const shown = (refs ?? []).map((r) => toItemRef(r)).filter((r): r is ItemRef => !!r && !exclude?.includes(r.kind));
  if (!shown.length) return null;
  const history = shown.find((r) => r.kind === 'history');
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs', className)} data-related-refs>
      {shown.map((r) => (
        <RefLink key={`${r.kind}:${JSON.stringify(r)}`} to={r} className="max-w-64" />
      ))}
      {history && (
        <RefLink to={history} edit icon={false} title="Open what was sent in its editor">
          Open as request
        </RefLink>
      )}
    </div>
  );
}
