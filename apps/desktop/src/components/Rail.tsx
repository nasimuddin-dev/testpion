import { ArrowDown, ArrowUp, EyeOff, Eye, MoreHorizontal, RotateCcw, Rows3, Settings } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { modKey } from '../api';
import { useGit } from '../lib/git';
import { keyLabel, useBindings } from '../lib/keybindings';
import { railShortcut, type RailId } from '../lib/rail';
import { changeRail, goToRail, railIdOf, railItem, resetRail, useRail } from '../lib/use-rail';
import { isRequestView, useApp, type ViewId } from '../store';
import { cx, Menu, Tooltip, type MenuItem } from './ui';

/** A small count on a rail icon (the Git view's commits to pull): one look for every rail item that needs one. */
function RailCount({ n }: { n: number }) {
  return (
    <span data-rail-count="" className="absolute top-0 right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-white text-[0.6rem] font-bold leading-4 text-center pointer-events-none">
      {n > 99 ? '99+' : n}
    </span>
  );
}

const ITEM = 'group relative w-full flex flex-col items-center gap-0.5 py-1 [@media(max-height:680px)]:py-0.5 rounded-xl text-[0.72rem] font-medium transition-colors duration-150';
const ICON =
  'grid place-items-center h-8 w-12 rounded-lg transition-[background-color,color,transform] duration-150 group-active:scale-90 [&>svg]:h-[22px] [&>svg]:w-[22px] [@media(max-height:680px)]:[&>svg]:h-5 [@media(max-height:680px)]:[&>svg]:w-5';

/** One rail button: icon, short label, the active mark; the tooltip names it with its shortcut. */
function RailButton({
  label,
  icon,
  tooltip,
  active,
  count,
  onClick,
  onContextMenu,
  menu,
  extra,
}: {
  label: string;
  icon: ReactNode;
  tooltip: string;
  active: boolean;
  count?: number;
  onClick(): void;
  onContextMenu?(e: React.MouseEvent): void;
  menu?: ReactNode;
  extra?: Record<string, string>;
}) {
  return (
    <div className="relative">
      <Tooltip content={tooltip} side="right">
        <button
          onClick={onClick}
          onContextMenu={onContextMenu}
          aria-current={active ? 'page' : undefined}
          aria-label={label}
          className={cx(ITEM, active ? 'text-fg' : 'text-muted hover:text-fg')}
          {...extra}
        >
          {active && <span aria-hidden className="absolute -left-1.5 top-2 h-6 w-[3px] rounded-r-full bg-[image:var(--brand-gradient)]" />}
          <span className={cx(ICON, active ? 'bg-accent-soft text-accent shadow-sm ring-1 ring-accent/15' : 'group-hover:bg-hover')}>
            {icon}
            {!!count && <RailCount n={count} />}
          </span>
          <span className="w-full truncate px-0.5 text-center leading-tight [@media(max-height:680px)]:hidden">{label}</span>
        </button>
      </Tooltip>
      {menu}
    </div>
  );
}

/**
 * The rail: the views the person chose (5 by default), More… for the rest, Settings at the bottom. Right-click an item
 * to hide it, move it, or show a view from More…; a view opened from More… shows on the rail while it is open.
 */
export function Sidebar() {
  const view = useApp((s) => s.view);
  const explorerOpen = useApp((s) => s.explorerOpen);
  const rail = useRail();
  const bindings = useBindings();
  const [menuFor, setMenuFor] = useState<RailId>();
  // the team pushed commits this branch does not have yet (the backend fetches in the background): a count on Git
  const behind = useGit().status?.behind ?? 0;
  const counts: Partial<Record<RailId, { n: number; title: string }>> = behind > 0 ? { git: { n: behind, title: `${behind} new commit${behind === 1 ? '' : 's'} on the remote to pull` } } : {};
  const here = railIdOf(view);
  const inRequests = isRequestView(view);
  // a view opened from More… (or a link, Ctrl+K) shows on the rail while it is open: you always see where you are
  const transient = view !== 'settings' && rail.more.includes(here) ? here : undefined;
  const shownHere = [...rail.visible, ...(transient ? [transient] : [])];
  const hiddenCount = rail.more.filter((id) => id !== transient).reduce((n, id) => n + (counts[id]?.n ?? 0), 0);

  const itemMenu = (id: RailId): MenuItem[] => {
    const shown = rail.visible.includes(id);
    const i = rail.visible.indexOf(id);
    return [
      shown
        ? {
            label: 'Hide from the rail',
            icon: <EyeOff size={14} />,
            disabled: rail.visible.length < 2,
            title: rail.visible.length < 2 ? 'The rail keeps one view at least' : undefined,
            onSelect: () => void changeRail(id, 'hide'),
          }
        : { label: 'Keep on the rail', icon: <Eye size={14} />, onSelect: () => void changeRail(id, 'show') },
      ...(shown
        ? [
            { label: 'Move up', icon: <ArrowUp size={14} />, disabled: i <= 0, onSelect: () => void changeRail(id, 'up') },
            { label: 'Move down', icon: <ArrowDown size={14} />, disabled: i >= rail.visible.length - 1, onSelect: () => void changeRail(id, 'down') },
          ]
        : []),
      ...moreItems(true),
    ];
  };
  /** Show a view from More… on the rail, show everything, or go back to the default rail. */
  const moreItems = (separator: boolean): MenuItem[] => [
    {
      label: 'Show on the rail',
      icon: <Eye size={14} />,
      separator,
      onSelect: () => undefined,
      items: rail.more.map((id) => ({ label: railItem(id)?.label ?? id, icon: railItem(id)?.icon, onSelect: () => void changeRail(id, 'show') })),
      disabled: !rail.more.length,
    },
    { label: 'Show every view', icon: <Rows3 size={14} />, disabled: !rail.more.length, onSelect: () => void resetRail(true) },
    { label: 'Reset the rail', icon: <RotateCcw size={14} />, onSelect: () => void resetRail() },
  ];

  const button = (id: RailId) => {
    const it = railItem(id);
    if (!it) return null;
    const shortcut = railShortcut(rail.visible, id, modKey);
    const active = here === id && view !== 'settings';
    const tooltip =
      id === 'collections' && inRequests
        ? `${explorerOpen ? 'Hide' : 'Show'} the Collections sidebar  ·  ${keyLabel('toggle-explorer', bindings)}`
        : [shortcut ? `${it.hint ?? it.label}  ·  ${shortcut}` : (it.hint ?? it.label), counts[id]?.title, id === transient ? 'Opened from More…: right-click to keep it on the rail' : undefined]
            .filter(Boolean)
            .join('  ·  ');
    return (
      <RailButton
        key={id}
        label={it.label}
        icon={it.icon}
        tooltip={tooltip}
        active={active}
        count={counts[id]?.n}
        extra={id === transient ? { 'data-rail-transient': '' } : undefined}
        // Collections, clicked while there, shows or hides the explorer (like VS Code's activity bar)
        onClick={() => (id === 'collections' && inRequests ? useApp.getState().toggleExplorer() : goToRail(id))}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuFor(id);
        }}
        menu={
          menuFor === id && (
            <Menu open onOpenChange={(o) => !o && setMenuFor(undefined)} align="start" width={220} items={itemMenu(id)} trigger={<span aria-hidden className="absolute right-0 top-1/2 w-0 h-0" />} />
          )
        }
      />
    );
  };

  return (
    <nav
      aria-label="Main navigation"
      className="w-[84px] [@media(max-height:680px)]:w-[64px] shrink-0 border-r border-line bg-chrome flex flex-col items-stretch gap-0.5 px-1.5 py-2 overflow-y-auto overflow-x-hidden [scrollbar-width:none]"
    >
      {shownHere.map((id, i) => {
        const prev = shownHere[i - 1];
        const divider = prev !== undefined && (id === transient || railItem(prev)?.group !== railItem(id)?.group);
        return (
          <div key={id}>
            {divider && <div className="mx-3 my-1 [@media(max-height:680px)]:my-0.5 border-t border-line/70" />}
            {button(id)}
          </div>
        );
      })}
      {rail.more.filter((id) => id !== transient).length > 0 && (
        <div className="relative">
          <Menu
            align="start"
            width={230}
            items={[
              ...rail.more.filter((id) => id !== transient).map((id) => ({ label: railItem(id)?.label ?? id, icon: railItem(id)?.icon, title: railItem(id)?.hint, onSelect: () => goToRail(id) })),
              ...moreItems(true),
            ]}
            trigger={
              <button
                aria-label="More views"
                title={`More views: ${rail.more.map((id) => railItem(id)?.label ?? id).join(', ')}. Right-click a rail item to choose what it shows.`}
                className={cx(ITEM, 'text-muted hover:text-fg')}
              >
                <span className={cx(ICON, 'group-hover:bg-hover relative')}>
                  <MoreHorizontal size={18} />
                  {hiddenCount > 0 && <RailCount n={hiddenCount} />}
                </span>
                <span className="w-full truncate px-0.5 text-center leading-tight [@media(max-height:680px)]:hidden">More…</span>
              </button>
            }
          />
        </div>
      )}
      <div className="mt-auto pt-2">
        <RailButton
          label="Settings"
          icon={<Settings size={18} />}
          tooltip={`Settings  ·  ${keyLabel('settings', bindings)}`}
          active={view === 'settings'}
          onClick={() => useApp.getState().setView('settings' as ViewId)}
        />
      </div>
    </nav>
  );
}
