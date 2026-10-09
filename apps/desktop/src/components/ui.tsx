import { cloneElement, forwardRef, isValidElement, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode, type SelectHTMLAttributes } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ChevronRight, ChevronsRight, Loader2, MoreHorizontal, X } from 'lucide-react';
import { iconForLabel, textOf } from './action-icons';

// icons drawn in every tab and menu row, made once (React skips an element it has already rendered)
const TAB_CLOSE_ICON = <X size={12} />;
const SUBMENU_ICON = <ChevronRight size={13} className="text-muted shrink-0" />;

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'default' | 'ghost' | 'danger' | 'soft';

/**
 * A button. Without an `icon` it shows the one its label names (Save, Delete, Run, Import …, see action-icons.tsx), so
 * the same action has the same picture everywhere; `icon={null}` keeps a button text-only.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }>(
  ({ variant = 'default', size = 'md', loading, icon, className, children, disabled, ...p }, ref) => {
    const shown = icon !== undefined ? icon : iconForLabel(textOf(children), variant, { size: size === 'sm' ? 12 : 13, fallback: false });
    return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[0.97]',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-sm',
        size === 'lg' && 'h-9 px-4 text-sm',
        variant === 'primary' && 'bg-[image:var(--brand-gradient)] border-transparent text-white shadow-[var(--glow)] hover:brightness-110 hover:shadow-[var(--glow),var(--elev-md)]',
        variant === 'default' && 'bg-bg border-line-strong shadow-sm hover:bg-hover hover:border-line-strong',
        variant === 'soft' && 'bg-accent-soft border-transparent text-accent hover:bg-accent/20',
        variant === 'ghost' && 'border-transparent text-muted hover:text-fg hover:bg-hover',
        variant === 'danger' && 'bg-bad border-bad text-white shadow-sm hover:brightness-110',
        className,
      )}
      {...p}
    >
      {loading ? <Loader2 size={14} className="spin" /> : shown}
      {children}
    </button>
    );
  },
);
Button.displayName = 'Button';

/**
 * A text link that acts (All history, New, Bulk edit, Beautify …): the accent colour, underlined on hover, and the
 * icon its label names like every Button. `icon={null}` keeps it text-only.
 */
export function LinkButton({ icon, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }) {
  const shown = icon !== undefined ? icon : iconForLabel(textOf(children), undefined, { size: 12, fallback: false });
  return (
    <button type="button" className={cx('inline-flex items-center gap-1 text-accent hover:underline', className)} {...p}>
      {shown}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ tooltip */
export const TooltipProvider = TooltipPrimitive.Provider;

/** Hover/focus tooltip. Renders the child alone when there's no content. */
export function Tooltip({ content, children, side = 'bottom' }: { content?: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[80] rounded-md bg-fg text-bg px-2 py-1 text-xs font-medium shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; tooltipSide?: 'top' | 'bottom' | 'left' | 'right' }>(
  ({ label, children, className, active, tooltipSide, title: _title, ...p }, ref) => (
    <Tooltip content={label} side={tooltipSide}>
      <button
        ref={ref}
        aria-label={label}
        className={cx(
          'inline-flex items-center justify-center rounded-md h-8 w-8 text-muted transition-colors duration-150 hover:text-fg hover:bg-hover active:scale-95 disabled:opacity-40 disabled:pointer-events-none',
          active && 'bg-hover text-fg',
          className,
        )}
        {...p}
      >
        {children}
      </button>
    </Tooltip>
  ),
);
IconButton.displayName = 'IconButton';

/** The small + / ⋯ buttons on explorer rows: one look everywhere. Header rows (sections, collections) keep them faintly visible; item rows show them on hover. */
export const rowActionClass = (header = false) =>
  cx(
    'grid place-items-center h-6 w-6 shrink-0 rounded-md text-muted transition-opacity hover:text-fg hover:bg-panel2 focus:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-panel2 data-[state=open]:text-fg',
    header ? 'opacity-60 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
  );

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cx('field', className)} {...p} />);
Input.displayName = 'Input';

/**
 * The one multi-line text field: it grows with its text, from `rows` (or its min-height) up to `maxRows` lines, then
 * scrolls, so nothing typed or pasted is hidden; it measures again when its width changes (a resized panel wraps the
 * text differently). `autoGrow={false}` keeps a fixed size (a box that fills its area, like a paste box).
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean; maxRows?: number }>(
  ({ className, autoGrow = true, maxRows = 16, rows, ...p }, fwd) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(fwd, () => ref.current!);
    const fit = useCallback(() => {
      const el = ref.current;
      if (!el || !autoGrow) return;
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 20;
      const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      el.style.height = 'auto';
      const want = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const max = line * maxRows + chrome;
      const min = line * (rows ?? 1) + chrome;
      el.style.height = `${Math.max(min, Math.min(want, max))}px`;
      el.style.overflowY = want > max ? 'auto' : 'hidden';
    }, [autoGrow, maxRows, rows]);
    useLayoutEffect(fit, [fit, p.value]);
    useEffect(() => {
      const el = ref.current;
      if (!el || !autoGrow) return;
      let width = el.clientWidth;
      const ro = new ResizeObserver(() => {
        if (el.clientWidth !== width) (width = el.clientWidth), fit();
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [autoGrow, fit]);
    return <textarea ref={ref} rows={rows} className={cx('field', autoGrow && 'resize-none', className)} onInput={autoGrow ? fit : undefined} {...p} />;
  },
);
Textarea.displayName = 'Textarea';

/** Native select (keyboard- and screen-reader-friendly), styled to match the inputs. */
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx('field', className)} {...p}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1.5 text-xs', className)}>
      <span className="text-fg/80 font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted leading-snug">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none text-sm">
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full shadow-sm transition-colors duration-200 data-[state=checked]:bg-accent data-[state=unchecked]:bg-line-strong"
      >
        <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-200 data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5" />
      </SwitchPrimitive.Root>
      {label}
    </label>
  );
}

/** A tab strip. A tab with `onClose` has a × (and middle-click closes it), like the request tabs; `title` names it in full. */
export function Tabs<T extends string>({ tabs, value, onChange, className, right }: { tabs: Array<{ id: NoInfer<T>; label: ReactNode; badge?: ReactNode; title?: string; onClose?(): void }>; value: T; onChange(v: NoInfer<T>): void; className?: string; right?: ReactNode }) {
  // tabs that don't fit (a narrow pane, side by side) stay reachable: » lists them, the wheel scrolls, the chosen one is in view
  const listRef = useRef<HTMLDivElement>(null);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      // the usual case, every tab fits: one comparison, no rectangle per tab (and no re-render)
      if (el.scrollWidth <= el.clientWidth + 1) return setHiddenTabs((cur) => (cur.length ? [] : cur));
      const box = el.getBoundingClientRect();
      const next = [...el.querySelectorAll<HTMLElement>('[role=tab]')].filter((b) => { const r = b.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1; }).map((b) => b.dataset.tabId ?? '');
      setHiddenTabs((cur) => (cur.length === next.length && cur.every((x, i) => x === next[i]) ? cur : next));
    };
    // the observer measures once as it starts, and again whenever the strip's size changes
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => (ro.disconnect(), el.removeEventListener('scroll', measure));
  }, [tabs.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(value)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <div className={cx('flex items-center border-b border-line min-h-10 shrink-0 min-w-0', className)}>
    <div
      ref={listRef}
      role="tablist"
      onWheel={(e) => {
        if (e.deltaY && listRef.current && listRef.current.scrollWidth > listRef.current.clientWidth) listRef.current.scrollLeft += e.deltaY;
      }}
      className={cx('flex items-center gap-1 px-2 min-h-10 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', hiddenTabs.length > 0 && '[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]')}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          data-tab-id={t.id}
          aria-selected={value === t.id}
          title={t.title}
          onClick={() => onChange(t.id)}
          onAuxClick={(e) => {
            if (e.button === 1 && t.onClose) (e.preventDefault(), t.onClose());
          }}
          className={cx(
            'group relative px-2.5 h-10 text-sm whitespace-nowrap flex items-center gap-1.5 transition-colors duration-150',
            'after:absolute after:left-2 after:right-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors after:duration-200',
            value === t.id ? 'text-fg font-medium after:bg-[image:var(--brand-gradient)]' : 'text-muted hover:text-fg after:bg-transparent hover:after:bg-line-strong',
          )}
        >
          {t.label}
          {t.badge !== undefined && t.badge !== null && t.badge !== 0 && (
            <span className={cx('text-[0.7rem] leading-4 px-1.5 rounded-full tabular-nums', value === t.id ? 'bg-accent-soft text-accent' : 'bg-panel2 text-muted')}>{t.badge}</span>
          )}
          {t.onClose && (
            <span
              role="button"
              aria-label={`Close ${t.title ?? (typeof t.label === 'string' ? t.label : t.id)}`}
              className={cx('shrink-0 rounded p-0.5 -mr-1 hover:text-fg hover:bg-hover', value === t.id ? 'opacity-60' : 'opacity-0 group-hover:opacity-100')}
              onClick={(e) => (e.stopPropagation(), t.onClose!())}
            >
              {TAB_CLOSE_ICON}
            </span>
          )}
        </button>
      ))}
    </div>
      {hiddenTabs.length > 0 && (
        <Menu
          align="end"
          width={220}
          items={tabs.map((t) => ({ label: `${value === t.id ? '✓ ' : ''}${typeof t.label === 'string' ? t.label : t.id}${t.badge ? ` (${t.badge})` : ''}`, onSelect: () => onChange(t.id) }))}
          trigger={
            <button aria-label={`All tabs (${hiddenTabs.length} not shown)`} title={`${hiddenTabs.length} more`} className="shrink-0 mx-1 h-7 px-1.5 rounded-md text-xs text-muted hover:text-fg hover:bg-hover data-[state=open]:bg-hover inline-flex items-center gap-0.5">
              <ChevronsRight size={14} />
              {hiddenTabs.length}
            </button>
          }
        />
      )}
      {right && <div className="ml-auto flex items-center gap-1 pl-2 pr-2 shrink-0">{right}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'ok' | 'bad' | 'warn' | 'accent' | 'judge'; title?: string }) {
  const tones = {
    default: 'bg-panel2 text-muted border-line',
    ok: 'text-ok border-ok/25 bg-ok/10',
    bad: 'text-bad border-bad/25 bg-bad/10',
    warn: 'text-warn border-warn/25 bg-warn/10',
    accent: 'text-accent border-accent/25 bg-accent/10',
    judge: 'text-judge border-judge/25 bg-judge/10',
  };
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2 text-[0.72rem] leading-5 border font-medium whitespace-nowrap tabular-nums', tones[tone])}>
      {children}
    </span>
  );
}

export function statusTone(status?: number | string): 'ok' | 'bad' | 'warn' | 'default' {
  if (typeof status === 'string' && /^\d{3}$/.test(status)) status = Number(status);
  if (typeof status === 'number') return status < 300 ? 'ok' : status < 400 ? 'warn' : 'bad';
  if (status === undefined || status === '') return 'default';
  if (/^(passed|ok|success|connected|closed|open|sent)$/i.test(status)) return 'ok';
  if (status === 'skipped' || status === 'running' || status === 'pending') return 'warn';
  // failed, error, NetworkError, TimeoutError, gRPC codes other than OK (UNAVAILABLE, NOT_FOUND …)
  return 'bad';
}

/** A first step an empty view offers; the first one is the primary button unless `primary: false`. */
export interface EmptyAction {
  label: ReactNode;
  icon?: ReactNode;
  onClick(): void;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}

/**
 * An empty view: what it is for, the first steps as buttons (`actions`, the first primary) or anything (`action`),
 * and `steps` (a numbered how-to) under them. One layout for every view.
 */
export function Empty({ icon, title, children, action, actions, steps }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; actions?: EmptyAction[]; steps?: ReactNode[] }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-center gap-2 p-8 text-muted fade-in">
      {icon && <div className="mb-2 grid place-items-center h-14 w-14 rounded-2xl bg-accent-soft text-accent ring-1 ring-accent/20 shadow-sm">{icon}</div>}
      <div className="text-fg font-semibold text-[1.05rem] tracking-tight">{title}</div>
      {children && <div className="text-sm max-w-md leading-relaxed text-pretty">{children}</div>}
      {actions && actions.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {actions.map((a, i) => (
            <Button key={i} size="sm" variant={(a.primary ?? i === 0) ? 'primary' : undefined} icon={a.icon} onClick={a.onClick} disabled={a.disabled} loading={a.loading} title={a.title}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {action && <div className="mt-2">{action}</div>}
      {steps && steps.length > 0 && (
        <ol className="mt-2 text-xs text-left list-decimal pl-5 space-y-0.5 max-w-md">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

const CALLOUT_TONE = { accent: 'border-accent/40 bg-accent/5', warn: 'border-warn/40 bg-warn/5', bad: 'border-bad/40 bg-bad/5', ok: 'border-ok/40 bg-ok/5' } as const;

/**
 * A tinted box with a border in its tone: a line that says the next step and offers it (the push after a commit, a key
 * to add), or, as a `block`, a titled notice with lines of its own (an error with its reasons, the conflicts to
 * resolve, the safeguards of a load test). One look everywhere. A block lays out as `rounded-md p-3 text-sm grid gap-2`;
 * `className` replaces that layout when a place needs another spacing or radius.
 */
export function Callout({
  tone = 'accent',
  block,
  as: Tag = 'div',
  className,
  children,
  action,
  ...rest
}: { tone?: 'accent' | 'warn' | 'bad' | 'ok'; block?: boolean; as?: 'div' | 'section'; className?: string; role?: string; 'aria-label'?: string; children: ReactNode; action?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  if (block)
    return (
      <Tag className={cx('border', CALLOUT_TONE[tone], className ?? 'rounded-md p-3 text-sm grid gap-2')} {...rest}>
        {children}
      </Tag>
    );
  return (
    <Tag className={cx('rounded-lg border px-3 py-2 text-sm flex items-center gap-3 flex-wrap', CALLOUT_TONE[tone], className)} {...rest}>
      <span className="min-w-0">{children}</span>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </Tag>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spin text-muted" />;
}

/** A dialog, or the same content inline in an editor tab (its actions then sit in a toolbar on top). */
export function ModalOrPanel({ inline, title, onClose, width, footer, children }: { inline?: boolean; title: ReactNode; onClose(): void; width?: number; footer?: ReactNode; children: ReactNode }) {
  if (!inline)
    return (
      <Modal title={title} onClose={onClose} width={width} footer={footer}>
        {children}
      </Modal>
    );
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-line shrink-0">
        <h2 className="font-semibold text-base mr-auto">{title}</h2>
        {footer}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="p-4 flex flex-col gap-3 max-w-3xl">{children}</div>
      </div>
    </div>
  );
}

/** Accessible dialog (focus trap, Escape, click outside) with an open animation. Mount it to show it. */
export function Modal({ title, onClose, children, footer, width = 560 }: { title: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px] animate-in fade-in-0 duration-200" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[9vh] z-50 -translate-x-1/2 bg-popover border border-line rounded-2xl shadow-lg max-h-[82vh] flex flex-col outline-none animate-in fade-in-0 zoom-in-[0.97] slide-in-from-top-2 duration-200"
          style={{ width, maxWidth: '94vw' }}
        >
          <div className="flex items-center justify-between gap-3 pl-5 pr-3 h-14 shrink-0">
            <DialogPrimitive.Title className="font-semibold text-[1.05rem] truncate">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <button aria-label="Close" className="inline-flex items-center justify-center rounded-md h-8 w-8 text-muted hover:text-fg hover:bg-hover transition-colors">
                <X size={16} />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="px-5 pb-5 pt-1 overflow-auto">{children}</div>
          {footer && <div className="px-5 py-3.5 border-t border-line bg-panel/60 rounded-b-2xl flex justify-end gap-2 shrink-0">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ------------------------------------------------------------------ menu */
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  danger?: boolean;
  shortcut?: string;
  disabled?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
  /** A tooltip (why the item is disabled, e.g. an environment whose file cannot be read). */
  title?: string;
  /** A submenu (e.g. Move to ▸ each collection); `onSelect` is then unused. */
  items?: MenuItem[];
}

/** F2 and Delete on a row run its menu's Rename and Delete items, the same as in a file tree. */
export function menuKeys(items: MenuItem[] | undefined) {
  return (e: React.KeyboardEvent) => {
    if (!items || (e.key !== 'F2' && e.key !== 'Delete')) return;
    // Delete deletes (it asks first); "Remove …" only when a row has no Delete (never "Remove from the collection")
    const usable = items.filter((i) => !i.disabled);
    const it = e.key === 'F2' ? usable.find((i) => /^Rename/.test(i.label)) : (usable.find((i) => i.label === 'Delete' || i.label.startsWith('Delete ')) ?? usable.find((i) => i.label.startsWith('Remove ') && !i.label.includes(' from ')));
    if (!it) return;
    e.preventDefault();
    it.onSelect();
  };
}

/**
 * Dropdown menu (keyboard navigable, animated). `trigger` must be a single focusable element.
 * Pass `open` / `onOpenChange` to control it, e.g. to open it from a right-click.
 */
export function Menu({
  trigger,
  items,
  align = 'end',
  width = 200,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  width?: number;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  // an item that opens a dialog (Import, Rename …) must keep the focus there: giving it back to the menu's
  // button as the menu closes would count as a click outside the dialog, which then closes at once
  const picked = useRef(false);
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = (v: boolean) => {
    setOwn(v);
    onOpenChange?.(v);
  };
  const buttonRef = useRef<HTMLElement>(null);
  // Closed, the menu is its button and nothing else. The menu machinery (portal, positioning, focus handling) is
  // mounted only while it is open: a tree of 500 requests has 500 of these menus, and mounting all of them made
  // every tab switch and every keystroke in the filter re-render them all.
  if (!isOpen && isValidElement(trigger)) {
    const t = trigger as ReactElement<Record<string, unknown>>;
    const props = t.props;
    const openIt = (e: ReactMouseEvent | ReactPointerEvent | ReactKeyboardEvent) => {
      if (e.defaultPrevented) return;
      // the same gestures as the menu itself: a main-button press, Enter, Space, or the down arrow
      if ('button' in e && (e.button !== 0 || (e as ReactPointerEvent).ctrlKey)) return;
      if ('key' in e && !['Enter', ' ', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      setOpen(true);
    };
    return cloneElement(t, {
      ref: buttonRef,
      'aria-haspopup': 'menu',
      'aria-expanded': false,
      'data-state': 'closed',
      onPointerDown: (e: ReactPointerEvent) => {
        (props.onPointerDown as ((e: ReactPointerEvent) => void) | undefined)?.(e);
        if (e.pointerType !== 'touch') openIt(e);
      },
      onClick: (e: ReactMouseEvent) => {
        (props.onClick as ((e: ReactMouseEvent) => void) | undefined)?.(e);
        // touch (and a synthetic click, as in tests): open on the click
        if (e.detail === 0 || (e.nativeEvent as PointerEvent).pointerType === 'touch') openIt(e);
      },
      onKeyDown: (e: ReactKeyboardEvent) => {
        (props.onKeyDown as ((e: ReactKeyboardEvent) => void) | undefined)?.(e);
        openIt(e);
      },
    } as Record<string, unknown>);
  }
  return (
    <MenuPrimitive.Root
      modal={false}
      open={isOpen}
      onOpenChange={(v) => {
        setOpen(v);
        // the menu's own button is a new element after closing: give it the focus back (unless an item took it)
        if (!v && !picked.current) requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
      }}
    >
      <MenuPrimitive.Trigger asChild>{isValidElement(trigger) ? cloneElement(trigger as ReactElement<Record<string, unknown>>, { ref: buttonRef } as Record<string, unknown>) : trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          onCloseAutoFocus={(e) => {
            if (picked.current) e.preventDefault();
            picked.current = false;
          }}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('[role=menuitem]')) picked.current = true;
          }}
          onKeyDownCapture={(e) => {
            if (e.key === 'Enter' || e.key === ' ') picked.current = true;
          }}
          // the menu is rendered elsewhere in the page, but React passes its events up to the component that owns it
          // (a tab, a tree row): a click on "Close all tabs" was also a click on the tab, which then opened again, and
          // Enter / Delete on an item reached the row's keys. What happens in a menu stays in the menu.
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onAuxClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          align={align}
          sideOffset={4}
          style={{ minWidth: width }}
          className="z-[70] rounded-xl border border-line bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150"
        >
          <MenuItems items={items} />
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/**
 * Run a menu item's action once the menu has closed. Radix calls `onSelect` inside `flushSync`, so a heavy action
 * (Expand all over thousands of rows) rendered synchronously while the menu was still open and blocked the click;
 * after a macrotask the menu is gone, its focus handled, and the action renders like any other click.
 */
function runSelected(onSelect: (() => void) | undefined) {
  if (onSelect) setTimeout(onSelect, 0);
}

const MENU_ROW = cx('flex items-center gap-2.5 rounded-md px-2 h-8 text-sm cursor-default select-none outline-none transition-colors', 'data-[highlighted]:bg-hover data-[state=open]:bg-hover data-[disabled]:opacity-50 data-[disabled]:pointer-events-none');

/** A menu's rows (and submenus, opened on hover or →). */
function MenuItems({ items: given }: { items: MenuItem[] }) {
  // a row without an icon of its own gets the one its label names, like buttons do
  const items = given.map((it) => (it.icon === undefined ? { ...it, icon: iconForLabel(it.label, it.danger ? 'danger' : undefined, { size: 14, fallback: false }) } : it));
  const icons = items.some((x) => x.icon);
  return (
    <>
      {items.map((it, i) => {
        const content = (
          <>
            {/* every row keeps the icon column so labels line up */}
            {(it.icon || icons) && <span className={cx('shrink-0 grid place-items-center w-4', it.danger ? 'text-bad' : 'text-muted')}>{it.icon}</span>}
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="text-xs text-muted">{it.shortcut}</span>}
          </>
        );
        return (
          <div key={`${i}-${it.label}`} title={it.title}>
            {it.separator && i > 0 && <MenuPrimitive.Separator className="my-1 h-px bg-line" />}
            {it.items ? (
              <MenuPrimitive.Sub>
                <MenuPrimitive.SubTrigger disabled={it.disabled || !it.items.length} className={cx(MENU_ROW, 'text-fg')}>
                  {content}
                  {SUBMENU_ICON}
                </MenuPrimitive.SubTrigger>
                <MenuPrimitive.Portal>
                  <MenuPrimitive.SubContent sideOffset={6} className="z-[71] min-w-[200px] max-w-[320px] max-h-[60vh] overflow-auto rounded-xl border border-line bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 duration-150">
                    <MenuItems items={it.items} />
                  </MenuPrimitive.SubContent>
                </MenuPrimitive.Portal>
              </MenuPrimitive.Sub>
            ) : (
              <MenuPrimitive.Item disabled={it.disabled} onSelect={() => runSelected(it.onSelect)} className={cx(MENU_ROW, it.danger ? 'text-bad data-[highlighted]:bg-bad/10' : 'text-fg')}>
                {content}
              </MenuPrimitive.Item>
            )}
          </div>
        );
      })}
    </>
  );
}

/** A side panel that can be pinned (docked) or unpinned (a tab on the edge that slides the panel over the content): one for every docked side panel. */
export { PinnablePanel, usePinnablePanel, type PinnablePanelApi } from './PinnablePanel';

/** Resizable two-pane split. Size is persisted per `id`. `sidebar` gives the first pane the sidebar surface. */
export function Split({ id, direction = 'horizontal', initial = 50, min = 15, sidebar, collapsed, collapsedSecond, children }: { id: string; direction?: 'horizontal' | 'vertical'; initial?: number; min?: number; sidebar?: boolean; /** Leave the first pane out (the request editors' old sidebars, replaced by the Collections sidebar): it isn't rendered at all. */ collapsed?: boolean; /** Hide the second pane (the first takes the room). */ collapsedSecond?: boolean; children: [ReactNode, ReactNode] }) {
  const [pct, setPct] = useState(() => Number(localStorage.getItem(`aps.split.${id}`)) || initial);
  // another id (the same panes in another layout): its own remembered size, the panes stay mounted
  const [shownId, setShownId] = useState(id);
  if (shownId !== id) {
    setShownId(id);
    setPct(Number(localStorage.getItem(`aps.split.${id}`)) || initial);
  }
  const ref = useRef<HTMLDivElement>(null);
  const onDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = ref.current!;
      const rect = el.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const p = direction === 'horizontal' ? ((ev.clientX - rect.left) / rect.width) * 100 : ((ev.clientY - rect.top) / rect.height) * 100;
        setPct(Math.min(100 - min, Math.max(min, p)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setPct((p) => {
          localStorage.setItem(`aps.split.${id}`, String(p));
          return p;
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [direction, id, min],
  );
  const h = direction === 'horizontal';
  return (
    <div ref={ref} className={cx('flex min-h-0 min-w-0 h-full w-full', h ? 'flex-row' : 'flex-col')}>
      {/* a collapsed pane costs nothing: it held a whole collection tree, re-rendered on every change */}
      {!collapsed && (
        <div className={cx('min-h-0 min-w-0 overflow-hidden flex flex-col', sidebar && 'bg-panel')} style={{ flexBasis: collapsedSecond ? '100%' : `${pct}%` }}>
          {children[0]}
        </div>
      )}
      <div
        role="separator"
        aria-orientation={h ? 'vertical' : 'horizontal'}
        onPointerDown={onDown}
        hidden={collapsed || collapsedSecond}
        className={cx(
          'relative shrink-0 bg-line transition-colors duration-150 hover:bg-accent active:bg-accent',
          h ? 'w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1 before:-right-1' : 'h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1 before:-bottom-1',
        )}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden flex flex-col" style={{ display: collapsedSecond ? 'none' : undefined }}>
        {children[1]}
      </div>
    </div>
  );
}

/** The element that scrolls `el` (its nearest ancestor with overflow auto or scroll). */
function scrollingAncestor(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/**
 * Fixed-row-height virtual list: renders only visible rows, so 1M rows cost the same as 50. With `scrollParent` it has
 * no scroll box of its own: it scrolls with the element around it (a tree in a sidebar with other sections above and
 * below it). `keyOf` keeps a row's component when rows above it come and go; `scrollKey` scrolls to `scrollToIndex`
 * again even when the index is the same.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  render,
  className,
  overscan = 8,
  scrollToIndex,
  scrollKey,
  onEndReached,
  keyOf,
  scrollParent = false,
}: {
  items: T[];
  rowHeight: number;
  render(item: T, index: number): ReactNode;
  className?: string;
  overscan?: number;
  scrollToIndex?: number;
  scrollKey?: unknown;
  onEndReached?(): void;
  keyOf?(item: T, index: number): string | number;
  scrollParent?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pendingScrollTop = useRef(0);
  /** With scrollParent: the element that scrolls, and where the list starts in it. */
  const outer = useRef<{ box: HTMLElement; measure(): void } | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!scrollParent) {
      const ro = new ResizeObserver(() => setHeight(el.clientHeight));
      ro.observe(el);
      setHeight(el.clientHeight);
      return () => ro.disconnect();
    }
    const box = scrollingAncestor(el);
    if (!box) return;
    // the part of the list on screen: from where the box's view starts (relative to the list's top) for the box's height
    const measure = () => {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      setScrollTop(-top);
      setHeight(box.clientHeight);
    };
    outer.current = { box, measure };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    const onScroll = () => {
      if (scrollFrame.current !== undefined) return;
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = undefined;
        measure();
      });
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      box.removeEventListener('scroll', onScroll);
      outer.current = undefined;
    };
  }, [scrollParent]);
  // what is above the list may have grown or shrunk with it (a section opened): measure again when the rows change
  useEffect(() => outer.current?.measure(), [items]);
  useEffect(() => {
    if (scrollToIndex === undefined || !ref.current) return;
    const el = ref.current;
    if (outer.current) {
      const { box } = outer.current;
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + scrollToIndex * rowHeight;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - rowHeight) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
      return;
    }
    const top = scrollToIndex * rowHeight;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - rowHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  }, [scrollToIndex, rowHeight, scrollKey]);
  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
  }, []);
  const start = Math.min(items.length, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.max(start, Math.min(items.length, Math.ceil((scrollTop + height) / rowHeight) + overscan));
  useEffect(() => {
    if (onEndReached && end >= items.length - 5 && items.length) onEndReached();
  }, [end, items.length, onEndReached]);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++)
    rows.push(
      <div key={keyOf ? keyOf(items[i]!, i) : i} style={{ position: 'absolute', top: i * rowHeight, height: rowHeight, left: 0, right: 0 }}>
        {render(items[i]!, i)}
      </div>,
    );
  if (scrollParent) return <div ref={ref} className={cx('relative', className)} style={{ height: items.length * rowHeight }}>{rows}</div>;
  return (
    <div
      ref={ref}
      className={cx('overflow-auto relative', className)}
      onScroll={(e) => {
        pendingScrollTop.current = e.currentTarget.scrollTop;
        // Scrolling can emit far more events than frames. Coalescing updates
        // keeps large lists responsive while preserving the same visible rows.
        if (scrollFrame.current !== undefined) return;
        scrollFrame.current = requestAnimationFrame(() => {
          scrollFrame.current = undefined;
          setScrollTop(pendingScrollTop.current);
        });
      }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}

/**
 * A choice among a few options shown side by side (7 / 14 / 30 days, Table / Chart, Mine / Theirs): one control, the
 * same look everywhere. Each option may carry an icon.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'sm',
}: {
  value: T | undefined;
  options: Array<{ value: NoInfer<T>; label: ReactNode; icon?: ReactNode; title?: string }>;
  onChange(v: NoInfer<T>): void;
  label: string;
  size?: 'xs' | 'sm';
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex rounded-lg border border-line p-0.5 font-normal shrink-0', size === 'xs' ? 'text-[11px]' : 'text-xs')}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={cx('inline-flex items-center gap-1 rounded-md', size === 'xs' ? 'px-2 py-0.5' : 'px-2.5 py-1', value === o.value ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-fg')}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="text-[0.7rem] leading-none px-1.5 py-1 rounded-md border border-line border-b-2 bg-panel text-muted font-sans font-medium">{children}</kbd>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between h-10 px-3 text-[0.72rem] uppercase tracking-[0.08em] text-muted font-semibold shrink-0">
      <span>{children}</span>
      {right}
    </div>
  );
}

/** The ⋯ button that opens a menu of more actions (in a page header, a card, a toolbar). */
export function MoreMenu({ label = 'More actions', items, width = 230 }: { label?: string; items: MenuItem[]; width?: number }) {
  return (
    <Menu
      width={width}
      items={items}
      trigger={
        <IconButton label={label} className="h-8 w-8 data-[state=open]:bg-hover data-[state=open]:text-fg">
          <MoreHorizontal size={16} />
        </IconButton>
      }
    />
  );
}

/** The header of a detail page (a monitor, a load test, a run …): icon, title, a line under it, the main actions and a ⋯ menu for the rest. */
export function PageHeader({ icon, title, subtitle, actions, menu, menuLabel }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; menu?: MenuItem[]; menuLabel?: string }) {
  return (
    <div className="flex items-start gap-3 flex-wrap">
      {icon && <div className="grid place-items-center h-9 w-9 rounded-lg bg-accent-soft text-accent shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold truncate leading-tight">{title}</h2>
        {subtitle && <div className="text-sm text-muted truncate mt-0.5">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {actions}
        {menu && menu.length > 0 && <MoreMenu label={menuLabel} items={menu} />}
      </div>
    </div>
  );
}

/** An even grid of Metric cards (equal widths, wraps cleanly) instead of ragged flex rows. */
export function MetricGrid({ children, className, compact }: { children: ReactNode; className?: string; compact?: boolean }) {
  return <div className={cx('grid gap-2', compact ? 'grid-cols-[repeat(auto-fit,minmax(118px,1fr))] [&>div]:px-3 [&>div]:py-2 [&>div>div:nth-child(2)]:text-base' : 'grid-cols-[repeat(auto-fit,minmax(150px,1fr))]', className)}>{children}</div>;
}

export function Metric({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'ok' | 'bad' | 'warn'; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-bg shadow-sm px-4 py-3 min-w-0">
      <div className="text-xs text-muted font-medium truncate" title={label}>{label}</div>
      <div className={cx('text-xl font-semibold tabular-nums tracking-tight mt-0.5 truncate', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</div>
      {sub && <div className="text-[0.72rem] text-muted">{sub}</div>}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
