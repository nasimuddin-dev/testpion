import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Pin, PinOff } from 'lucide-react';
import { usePersisted } from '../lib/sticky';
import { cx, IconButton } from './ui';

/** What a panel's content can do with the panel it is in (a snippet inserted from the overlay closes it). */
export interface PinnablePanelApi {
  /** Close the overlay (unpinned); nothing when pinned. */
  close(): void;
  pinned: boolean;
  /** Shown: pinned, or unpinned and slid open. */
  open: boolean;
}

const Ctx = createContext<PinnablePanelApi>({ close: () => undefined, pinned: true, open: true });
/** The panel a component is in (see PinnablePanel); outside one, a pinned panel whose close does nothing. */
export const usePinnablePanel = () => useContext(Ctx);

const HOVER_OPEN_MS = 300;
const LEAVE_CLOSE_MS = 400;
const MIN_WIDTH = 160;

/** A floating menu, popover or dialog (portaled out of the panel) is part of what the panel is doing. */
const inPopup = (el: EventTarget | null) => el instanceof Element && !!el.closest('[data-radix-popper-content-wrapper], [role=menu], [role=dialog], [role=listbox][data-radix-select-viewport]');
const popupOpen = () => !!document.querySelector('[data-radix-popper-content-wrapper] [role=menu], [role=dialog]');

/**
 * A side panel that can be pinned or unpinned, as in Visual Studio. Pinned: docked beside the content, resizable, a pin
 * button in its header. Unpinned: a slim vertical tab on its edge; hovering the tab (300 ms) or clicking it slides the
 * panel over the content (no layout shift); it closes when the pointer leaves it (400 ms), on Esc, on a click outside, or
 * when its content calls close() (usePinnablePanel, or children as a function). Pinned state and width persist per `id`;
 * with nothing stored the panel starts unpinned when its host (the parent element) is narrower than `autoUnpinBelow`.
 * The parent lays the content and the panel out in a row (flex); the panel goes before the content for side="left".
 */
export function PinnablePanel({
  id,
  title,
  side = 'right',
  defaultWidth = 280,
  autoUnpinBelow = 700,
  actions,
  revealKey,
  onShownChange,
  className,
  children,
}: {
  id: string;
  title: string;
  side?: 'left' | 'right';
  defaultWidth?: number;
  autoUnpinBelow?: number;
  /** Buttons in the header, before the pin (e.g. the Debugger dock's close). */
  actions?: ReactNode;
  /** When this changes while unpinned, the panel slides open (the Debugger's tool rail choosing another panel). */
  revealKey?: unknown;
  /** Told when the panel shows or hides (pinned counts as shown). */
  onShownChange?(shown: boolean): void;
  className?: string;
  children: ReactNode | ((api: PinnablePanelApi) => ReactNode);
}) {
  const [stored, setStored] = usePersisted<boolean | null>(`aps.pinnable.${id}.pinned`, null, { parse: (v) => (v === '1' ? true : v === '0' ? false : undefined), stringify: (v) => (v ? '1' : '0') });
  const [width, setWidth] = usePersisted<number>(`aps.pinnable.${id}.width`, defaultWidth, { parse: (v) => (Number(v) >= MIN_WIDTH ? Number(v) : undefined), stringify: String });
  const [dragWidth, setDragWidth] = useState<number>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState<number>();
  useLayoutEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host) return;
    const measure = () => setHostWidth(host.clientWidth || undefined);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const pinned = stored ?? (hostWidth === undefined || hostWidth >= autoUnpinBelow);
  const [open, setOpen] = useState(false);
  const shown = pinned || open;
  const shownChange = useRef(onShownChange);
  shownChange.current = onShownChange;
  useEffect(() => shownChange.current?.(shown), [shown]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clearTimer = () => (clearTimeout(timer.current), (timer.current = undefined));
  useEffect(() => clearTimer, []);
  const close = useCallback((focusTab = true) => {
    clearTimeout(timer.current);
    setOpen((was) => {
      // focus goes back to the tab, but only when it was inside the panel (a click elsewhere keeps its own focus)
      if (was && focusTab && panelRef.current?.contains(document.activeElement)) setTimeout(() => tabRef.current?.focus(), 0);
      return false;
    });
  }, []);
  const openNow = () => (clearTimer(), setOpen(true));

  // pinning shows it docked; unpinning slides it away
  const setPinned = (p: boolean) => {
    setStored(p);
    setOpen(false);
    if (!p) setTimeout(() => tabRef.current?.focus(), 0);
  };

  // another panel chosen while unpinned: show it
  const lastReveal = useRef(revealKey);
  useEffect(() => {
    if (lastReveal.current === revealKey) return;
    lastReveal.current = revealKey;
    if (!pinned) setOpen(true);
  }, [revealKey, pinned]);

  // the overlay closes on Esc and on a click outside it
  useEffect(() => {
    if (pinned || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || popupOpen()) return;
      e.preventDefault();
      close();
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node) || inPopup(e.target)) return;
      close(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => (window.removeEventListener('keydown', onKey), document.removeEventListener('pointerdown', onDown, true));
  }, [pinned, open, close]);

  const onPanelLeave = () => {
    if (pinned) return;
    clearTimer();
    timer.current = setTimeout(() => {
      // kept while one of its menus is open or the keyboard is in it (as in Visual Studio)
      if (popupOpen() || panelRef.current?.contains(document.activeElement)) return;
      close(false);
    }, LEAVE_CLOSE_MS);
  };

  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    const max = Math.max(MIN_WIDTH, (wrapRef.current?.parentElement?.clientWidth ?? 1200) * 0.8);
    let last = start;
    const move = (ev: PointerEvent) => {
      const dx = side === 'right' ? startX - ev.clientX : ev.clientX - startX;
      last = Math.round(Math.min(max, Math.max(MIN_WIDTH, start + dx)));
      setDragWidth(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragWidth(undefined);
      setWidth(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const w = dragWidth ?? width;
  const api: PinnablePanelApi = { close: () => close(), pinned, open: shown };
  const right = side === 'right';
  return (
    <Ctx.Provider value={api}>
      <div
        ref={wrapRef}
        data-pinnable-panel={id}
        data-pinned={pinned}
        data-open={shown}
        className={cx('relative shrink-0 h-full min-h-0', !pinned && 'w-6', className)}
        style={pinned ? { width: w } : undefined}
      >
        {!pinned && (
          <button
            ref={tabRef}
            type="button"
            aria-expanded={open}
            aria-label={`${title} (unpinned panel)`}
            title={`${title}: hover or click to show`}
            onClick={() => (open ? close() : openNow())}
            onPointerEnter={() => {
              if (open) return;
              clearTimer();
              timer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS);
            }}
            onPointerLeave={() => !open && clearTimer()}
            className={cx(
              'h-full w-6 flex items-start justify-center pt-3 bg-panel/60 text-xs font-medium text-muted hover:text-fg hover:bg-hover transition-colors',
              right ? 'border-l border-line' : 'border-r border-line',
            )}
          >
            <span className="[writing-mode:vertical-rl] whitespace-nowrap select-none" style={right ? undefined : { transform: 'rotate(180deg)' }}>
              {title}
            </span>
          </button>
        )}
        <div
          ref={panelRef}
          role="region"
          aria-label={title}
          hidden={!shown}
          onPointerEnter={() => !pinned && clearTimer()}
          onPointerLeave={onPanelLeave}
          className={cx(
            'flex flex-col min-h-0 bg-bg',
            pinned
              ? cx('h-full w-full', right ? 'border-l border-line' : 'border-r border-line')
              : cx('absolute inset-y-0 z-40 shadow-2xl border-line animate-in fade-in-0 duration-150', right ? 'right-0 border-l slide-in-from-right-4' : 'left-0 border-r slide-in-from-left-4'),
          )}
          style={pinned ? undefined : { width: w }}
        >
          <div className="flex items-center gap-1 h-8 pl-3 pr-1 border-b border-line bg-panel/60 shrink-0">
            <span className="text-sm font-semibold truncate">{title}</span>
            <span className="ml-auto" />
            {actions}
            <IconButton
              label={pinned ? `Unpin ${title}: hide it at the edge, show it on hover` : `Pin ${title}: keep it docked`}
              data-pin-toggle
              className="h-6 w-6"
              onClick={() => setPinned(!pinned)}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </IconButton>
          </div>
          <div className="flex-1 min-h-0 flex flex-col">{typeof children === 'function' ? children(api) : children}</div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${title}`}
            onPointerDown={onResizeDown}
            className={cx('absolute inset-y-0 w-1.5 cursor-col-resize hover:bg-accent/60 active:bg-accent z-10', right ? '-left-0.5' : '-right-0.5')}
          />
        </div>
      </div>
    </Ctx.Provider>
  );
}
