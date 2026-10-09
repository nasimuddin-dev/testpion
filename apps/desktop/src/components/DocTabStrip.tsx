import { ArrowRightToLine, ChevronDown, ChevronLeft, ChevronRight, ListX, Pencil, Pin, SquareX, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx, Menu, type MenuItem } from './ui';
import { InlineRename } from './TreeParts';

/**
 * One tab of a document strip: a request, a test file, a monitor. The strip draws it from this model alone; what
 * selecting, closing and renaming do belongs to the host.
 */
export interface DocTab<D = unknown> {
  /** Unique in the strip; drawn as data-tab-id. */
  id: string;
  title: string;
  /** Shown before the title: a method or protocol (GET, GQL, HTTP), or any node (a status dot). */
  badge?: ReactNode;
  badgeClass?: string;
  /** A count after the title (runs, results). */
  count?: ReactNode;
  dirty?: boolean;
  /** false: a fixed tab (Flow, Runs, Editor): no ✕, no menu, never closed by "Close other / all". */
  closable?: boolean;
  /** Pinned tabs come first, are narrower and stay open on "Close other / all". */
  pinned?: boolean;
  /** How the tab is renamed: in place (the strip edits the title, then onRename gets the name) or by the host's own dialog (onRename gets no name). */
  rename?: 'inline' | 'dialog';
  /** The tooltip; the title (plus "unsaved changes") without it. */
  tooltip?: string;
  /** Whatever the host needs back in its callbacks. */
  data?: D;
}

export interface DocTabStripProps<D = unknown> {
  tabs: DocTab<D>[];
  activeId?: string;
  /** The tablist's aria-label ("Open requests", "Open monitors", "Open test files"). */
  label: string;
  onSelect(tab: DocTab<D>): void;
  /** Close these tabs (one from ✕, middle-click or "Close tab"; several from "Close other / all / to the right"). */
  onClose(ids: string[], tabs: DocTab<D>[]): void;
  /** Rename: with the new name after an in-place edit; without one when the tab renames in the host's dialog. */
  onRename?(tab: DocTab<D>, name?: string): unknown;
  /** The host's items at the top of a tab's right-click menu (Pin, Duplicate, Run now …). */
  extraItems?(tab: DocTab<D>): MenuItem[];
  /** Drawn right after the last tab (the "+" New tab menu). */
  afterTabs?: ReactNode;
  /** Drawn at the right end (Save / Run buttons, layout switch). */
  actions?: ReactNode;
  /** Draw the "All open tabs" count menu when more than one tab is open (default: yes). */
  countMenu?: boolean;
  className?: string;
}

const TAB_W = 190;

/**
 * The tab bar of every document view (request editors, test files, monitors): the same tabs, scrolling, ✕,
 * middle-click, double-click or F2 to rename, and the same right-click menu everywhere (Rename, Close tab, Close
 * other tabs, Close tabs to the right, Close all tabs, plus what the host adds on top).
 */
export function DocTabStrip<D = unknown>({ tabs: given, activeId, label, onSelect, onClose, onRename, extraItems, afterTabs, actions, countMenu = true, className }: DocTabStripProps<D>) {
  const tabs = [...given.filter((t) => t.pinned), ...given.filter((t) => !t.pinned)];
  const [menuFor, setMenuFor] = useState<string>();
  /** The tab whose title is being edited in place (double-click, F2 or Rename in its menu). */
  const [editingTab, setEditingTab] = useState<string>();
  const startRename = (t: DocTab<D>) => {
    if (!t.rename || !onRename) return;
    if (t.rename === 'inline') {
      if (t.id !== activeId) onSelect(t);
      setEditingTab(t.id);
    } else void onRename(t);
  };
  const closable = (t: DocTab<D>) => t.closable !== false && !t.pinned;
  const close = (list: DocTab<D>[]) => {
    const open = list.filter(closable);
    if (open.length)
      onClose(
        open.map((t) => t.id),
        open,
      );
  };
  /** Every tab's menu, the same in every view; what a tab can't do is shown disabled, so every menu reads the same. */
  const menuItems = (t: DocTab<D>): MenuItem[] => {
    const i = tabs.indexOf(t);
    const others = tabs.filter((x) => x !== t && closable(x));
    const right = tabs.slice(i + 1).filter(closable);
    const all = tabs.filter(closable);
    return [
      ...(extraItems?.(t) ?? []),
      { label: 'Rename', icon: <Pencil size={13} />, shortcut: 'F2', disabled: !t.rename || !onRename, onSelect: () => startRename(t) },
      { label: 'Close tab', icon: <X size={13} />, separator: true, shortcut: 'Middle-click', disabled: !closable(t), onSelect: () => close([t]) },
      { label: 'Close other tabs', icon: <SquareX size={13} />, disabled: !others.length, onSelect: () => close(others) },
      { label: 'Close tabs to the right', icon: <ArrowRightToLine size={13} />, disabled: !right.length, onSelect: () => close(right) },
      { label: 'Close all tabs', icon: <ListX size={13} />, disabled: !all.length, onSelect: () => close(all) },
    ];
  };
  const stripRef = useRef<HTMLDivElement>(null);
  // the strip scrolls without a scrollbar: when it overflows, ‹ › buttons show that there is more, and the leftmost
  // tab is always whole (a tab cut at the left edge looked hidden behind the sidebar)
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
  }, []);
  /**
   * Scroll so that a tab starts exactly at the left edge: the one nearest to it (a tab more than half hidden gives way
   * to the next). The active tab stays whole: when aligning would push it off the right edge, it becomes the leftmost.
   */
  const snap = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || strip.scrollLeft <= 0) return;
    const s = strip.getBoundingClientRect();
    const els = [...strip.querySelectorAll<HTMLElement>('[role=tab]')];
    let first = els.find((t) => {
      const r = t.getBoundingClientRect();
      return r.right - s.left > r.width / 2;
    });
    if (!first) return;
    const active = els.find((t) => t.getAttribute('aria-selected') === 'true');
    if (active) {
      const a = active.getBoundingClientRect();
      const shift = first.getBoundingClientRect().left - s.left; // how far the content moves left (negative: right)
      if (a.right - shift > s.right + 1 && els.indexOf(active) >= els.indexOf(first)) first = active;
    }
    const delta = first.getBoundingClientRect().left - s.left;
    if (Math.abs(delta) > 1) strip.scrollLeft = Math.max(0, strip.scrollLeft + delta);
  }, []);
  const scrollByTabs = (dir: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollLeft += dir * Math.max(TAB_W, strip.clientWidth - TAB_W);
    snap();
    measure();
  };
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      measure();
      // after the wheel stops: no half tab at the left edge
      clearTimeout(timer);
      timer = setTimeout(snap, 120);
    };
    const onWheel = (e: WheelEvent) => {
      // a mouse wheel scrolls the strip sideways (it has no vertical direction to go)
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && strip.scrollWidth > strip.clientWidth) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    };
    strip.addEventListener('scroll', onScroll, { passive: true });
    strip.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => {
      clearTimeout(timer);
      strip.removeEventListener('scroll', onScroll);
      strip.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, [measure, snap]);
  // keep the active tab in view (scrolling only the strip: scrollIntoView could shift the whole window)
  useEffect(() => {
    const reveal = () => {
      const strip = stripRef.current;
      const el = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!strip || !el) return;
      // measured on screen: offsetLeft counts from the nearest positioned ancestor, not the strip, so it overshot and
      // left the active tab half hidden at the left edge
      const s = strip.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.left < s.left) strip.scrollLeft -= s.left - r.left;
      else if (r.right > s.right) strip.scrollLeft += Math.min(r.right - s.right, r.left - s.left);
      snap();
      measure();
    };
    reveal();
    // a tab just opened is drawn a moment later (its editor publishes it): look again then
    const id = requestAnimationFrame(reveal);
    const t = setTimeout(reveal, 150);
    return () => (cancelAnimationFrame(id), clearTimeout(t));
  }, [activeId, tabs.length, snap, measure]);
  return (
    <div className={cx('flex items-end h-9 border-b border-line bg-panel/40 shrink-0 min-w-0', className)}>
      {overflow.left && (
        <button
          aria-label="Earlier tabs"
          title="Earlier tabs"
          className="shrink-0 h-9 w-6 grid place-items-center text-muted hover:text-fg hover:bg-hover border-r border-line"
          onClick={() => scrollByTabs(-1)}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div ref={stripRef} role="tablist" aria-label={label} className="flex items-end min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = t.id === activeId;
          const fixed = t.closable === false;
          return (
            <div
              key={t.id}
              role="tab"
              data-tab-id={t.id}
              aria-selected={active}
              title={t.tooltip ?? (t.dirty ? `${t.title} (unsaved changes)` : t.title)}
              onClick={() => onSelect(t)}
              onDoubleClick={() => startRename(t)}
              tabIndex={active ? 0 : -1}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'F2') {
                  e.preventDefault();
                  startRename(t);
                }
              }}
              onAuxClick={(e) => e.button === 1 && closable(t) && close([t])}
              onContextMenu={(e) => {
                if (fixed) return;
                e.preventDefault();
                setMenuFor(t.id);
              }}
              style={{ width: t.pinned ? 120 : fixed ? undefined : TAB_W }}
              className={cx(
                'group relative flex items-center gap-1.5 h-9 px-3 border-r border-line text-sm cursor-pointer shrink-0',
                fixed && 'min-w-[96px]',
                active ? 'bg-bg text-fg after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-[image:var(--brand-gradient)]' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {t.pinned && <Pin size={11} className="shrink-0 text-muted" aria-label="Pinned" />}
              {t.badge !== undefined &&
                t.badge !== null &&
                (typeof t.badge === 'string' ? <span className={cx('mono method-badge text-[0.62rem] font-bold shrink-0', t.badgeClass)}>{t.badge}</span> : t.badge)}
              {editingTab === t.id ? (
                <InlineRename
                  value={t.title}
                  label="Tab name"
                  onCommit={(name) => {
                    setEditingTab(undefined);
                    void onRename?.(t, name);
                  }}
                  onCancel={() => setEditingTab(undefined)}
                />
              ) : (
                <span className="truncate flex-1 min-w-0">{t.title}</span>
              )}
              {t.count !== undefined && t.count !== null && t.count !== 0 && (
                <span className={cx('text-[0.7rem] leading-4 px-1.5 rounded-full tabular-nums shrink-0', active ? 'bg-accent-soft text-accent' : 'bg-panel2 text-muted')}>{t.count}</span>
              )}
              {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-label="Unsaved changes" />}
              {closable(t) && (
                <button
                  aria-label={`Close ${t.title}`}
                  className={cx('shrink-0 rounded p-0.5 hover:text-fg hover:bg-hover focus:opacity-100', active ? 'opacity-60' : 'opacity-0 group-hover:opacity-100')}
                  onClick={(e) => (e.stopPropagation(), close([t]))}
                >
                  <X size={12} />
                </button>
              )}
              {menuFor === t.id && (
                <Menu
                  open
                  onOpenChange={(o) => !o && setMenuFor(undefined)}
                  align="start"
                  width={210}
                  items={menuItems(t)}
                  trigger={<span aria-hidden className="absolute left-2 bottom-0 w-0 h-0" />}
                />
              )}
            </div>
          );
        })}
      </div>
      {overflow.right && (
        <button
          aria-label="Later tabs"
          title="Later tabs"
          className="shrink-0 h-9 w-6 grid place-items-center text-muted hover:text-fg hover:bg-hover border-l border-line"
          onClick={() => scrollByTabs(1)}
        >
          <ChevronRight size={14} />
        </button>
      )}
      {afterTabs}
      <span className="ml-auto" />
      {actions && <div className="flex items-center gap-1 pl-2 pr-1.5 mb-1 shrink-0">{actions}</div>}
      {countMenu && tabs.length > 1 && (
        <Menu
          align="end"
          width={300}
          items={tabs.map((t) => ({
            label: `${t.title}${t.dirty ? ' •' : ''}`,
            icon: typeof t.badge === 'string' ? <span className={cx('mono method-badge text-[0.6rem] font-bold w-11', t.badgeClass)}>{t.badge}</span> : t.badge,
            onSelect: () => onSelect(t),
          }))}
          trigger={
            <button
              aria-label="All open tabs"
              title="All open tabs"
              className="mr-1.5 mb-1 shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium text-muted border border-line bg-bg hover:text-fg hover:bg-hover data-[state=open]:text-fg data-[state=open]:bg-hover"
            >
              {tabs.length}
              <ChevronDown size={13} />
            </button>
          }
        />
      )}
    </div>
  );
}
