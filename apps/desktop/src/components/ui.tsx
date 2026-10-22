import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ChevronDown, Loader2, MoreHorizontal, X } from 'lucide-react';
import { iconForLabel, textOf } from './action-icons';
import { TabOverflow } from './TabOverflow';
import { cx } from '../lib/cx';
import { Menu, type MenuItem } from './Menu';

// icons drawn in every tab and menu row, made once (React skips an element it has already rendered)
const TAB_CLOSE_ICON = <X size={12} />;

export { cx };

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

/** The options of a `Select` for things that have an id and a name (collections, providers, environments …). */
export function NamedOptions({ items }: { items?: ReadonlyArray<{ id: string; name: string }> }) {
  return (
    <>
      {items?.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </>
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

export function Toggle({ checked, onChange, label, title, ...data }: { checked: boolean; onChange(v: boolean): void; label?: ReactNode; title?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <label className="inline-flex items-center gap-2.5 cursor-pointer select-none text-sm" title={title}>
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onChange}
        {...data}
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
  // tabs that don't fit (a narrow pane, side by side) stay reachable: the count button lists them, the wheel scrolls,
  // the chosen one is in view. A tab only partly in the box counts as not shown and is not drawn (data-overflow): a
  // strip never shows a cut-off name next to the count of the tabs it hides.
  const listRef = useRef<HTMLDivElement>(null);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      // the usual case, every tab fits: one comparison, no rectangle per tab (and no re-render)
      if (el.scrollWidth <= el.clientWidth + 1) return setHiddenTabs((cur) => (cur.length ? [] : cur));
      const box = el.getBoundingClientRect();
      const outside = [...el.querySelectorAll<HTMLElement>('[role=tab]')].filter((b) => { const r = b.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1; });
      // the chosen tab is never the one hidden: a pane that shrank around it scrolls it whole into view (then measures again)
      const active = outside.find((b) => b.dataset.tabId === valueRef.current);
      if (active && active.offsetWidth <= el.clientWidth) {
        const before = el.scrollLeft;
        active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (el.scrollLeft !== before) return;
      }
      const next = outside.map((b) => b.dataset.tabId ?? '');
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
      className="flex items-center gap-1 px-2 min-h-10 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          data-tab-id={t.id}
          data-overflow={hiddenTabs.includes(t.id) || undefined}
          aria-selected={value === t.id}
          title={t.title}
          onClick={() => onChange(t.id)}
          onAuxClick={(e) => {
            if (e.button === 1 && t.onClose) (e.preventDefault(), t.onClose());
          }}
          className={cx(
            'group relative px-2.5 h-10 text-sm whitespace-nowrap flex items-center gap-1.5 transition-colors duration-150 data-[overflow]:invisible',
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
        <TabOverflow
          className="mx-1"
          width={220}
          count={hiddenTabs.length}
          label={`All tabs (${hiddenTabs.length} not shown)`}
          items={tabs.map((t) => ({ id: t.id, label: `${typeof t.label === 'string' ? t.label : t.id}${t.badge ? ` (${t.badge})` : ''}`, active: value === t.id }))}
          onSelect={(id) => onChange(id as T)}
        />
      )}
      {/* an output's actions (OutputActions) may shrink down to its download control: they clip their own tools first */}
      {right && <div className="ml-auto flex items-center gap-1 pl-2 pr-2 shrink-0 [&:has(>[data-output-actions])]:shrink [&:has(>[data-output-actions])]:min-w-0">{right}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'default', title, className }: { children: ReactNode; tone?: 'default' | 'ok' | 'bad' | 'warn' | 'accent' | 'judge'; title?: string; className?: string }) {
  const tones = {
    default: 'bg-panel2 text-muted border-line',
    ok: 'text-ok border-ok/25 bg-ok/10',
    bad: 'text-bad border-bad/25 bg-bad/10',
    warn: 'text-warn border-warn/25 bg-warn/10',
    accent: 'text-accent border-accent/25 bg-accent-soft',
    judge: 'text-judge border-judge/25 bg-judge/10',
  };
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2 text-[0.72rem] leading-5 border font-medium whitespace-nowrap tabular-nums', tones[tone], className)}>
      {children}
    </span>
  );
}

export function statusTone(status?: number | string): 'ok' | 'bad' | 'warn' | 'default' {
  if (typeof status === 'string' && /^\d{3}$/.test(status)) status = Number(status);
  if (typeof status === 'number') return status < 300 ? 'ok' : status < 400 ? 'warn' : 'bad';
  if (status === undefined || status === '') return 'default';
  if (/^(passed|ok|success|connected|closed|open|sent|saved)$/i.test(status)) return 'ok';
  if (status === 'skipped' || status === 'running' || status === 'pending') return 'warn';
  // failed, error, NetworkError, TimeoutError, gRPC codes other than OK (UNAVAILABLE, NOT_FOUND …)
  return 'bad';
}

/** A first step an empty view offers; the first one is the primary button unless `primary: false`. */
export interface EmptyAction {
  label: ReactNode;
  icon?: ReactNode;
  /** What it does; or `items`: a menu of choices (New request ▸ HTTP, GraphQL …). */
  onClick?(): void;
  items?: MenuItem[];
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}

/**
 * An empty view: what it is for, the next step as buttons (`actions`, the first primary; one with `items` opens a menu),
 * and `steps` (a numbered how-to) under them. One layout and one API for every view (WF-18): no other kind of button.
 */
export function Empty({ icon, title, children, actions, steps }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: EmptyAction[]; steps?: ReactNode[] }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-center gap-2 p-8 text-muted fade-in">
      {icon && <div className="mb-2 grid place-items-center h-14 w-14 rounded-2xl bg-accent-soft text-accent ring-1 ring-accent/20 shadow-sm">{icon}</div>}
      <div className="text-fg font-semibold text-[1.05rem] tracking-tight">{title}</div>
      {children && <div className="text-sm max-w-md leading-relaxed text-pretty">{children}</div>}
      {actions && actions.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {actions.map((a, i) => {
            const button = (
              <Button key={i} size="sm" variant={(a.primary ?? i === 0) ? 'primary' : undefined} icon={a.icon} onClick={a.items ? undefined : a.onClick} disabled={a.disabled} loading={a.loading} title={a.title}>
                {a.label}
                {a.items && <ChevronDown size={13} />}
              </Button>
            );
            return a.items ? <Menu key={i} width={240} align="center" items={a.items} trigger={button} /> : button;
          })}
        </div>
      )}
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

/**
 * A wait, the one way everywhere (F1): the spinner and what is going on ("Loading the trace…", "Comparing…"), announced
 * to a screen reader (`role="status"`). Fills its pane, centred; `inline` sits in a line of a form or a dialog (what the
 * AI dialogs show while a run is on). Never an `Empty` with a title that ends in "…": an empty state is a place with
 * nothing in it, a wait is not.
 */
export function Busy({ children, inline, size = 14 }: { children: ReactNode; inline?: boolean; size?: number }) {
  if (inline)
    return (
      <div className="flex items-center gap-2 text-muted" role="status">
        <Spinner size={size} /> {children}
      </div>
    );
  return (
    <div className="h-full w-full grid place-items-center p-8 text-muted text-sm fade-in" role="status">
      <span className="inline-flex items-center gap-2">
        <Spinner size={size} /> {children}
      </span>
    </div>
  );
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
          {footer && <div className="px-5 py-3.5 border-t border-line bg-panel/60 rounded-b-2xl flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Why the main button of a dialog is disabled, as text in the footer next to it. A tooltip on a disabled button reaches
 * no keyboard and no screen reader, and a mouse waits for it: the reason is on screen instead (announced when it changes).
 */
export function FooterHint({ children }: { children?: ReactNode }) {
  return (
    <span role="status" aria-live="polite" className="min-w-0 self-center text-xs text-muted text-right" data-footer-hint="">
      {children}
    </span>
  );
}

export { Menu, menuKeys, type MenuItem } from './Menu';


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

// the virtual list lives in its own module; imported from here as before
export { VirtualList } from './VirtualList';

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
  disabled,
}: {
  value: T | undefined;
  options: Array<{ value: NoInfer<T>; label: ReactNode; icon?: ReactNode; title?: string; disabled?: boolean }>;
  onChange(v: NoInfer<T>): void;
  label: string;
  size?: 'xs' | 'sm';
  /** The whole control (e.g. while a connection is open); an option can be disabled on its own too. */
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={cx('inline-flex rounded-lg border border-line p-0.5 font-normal shrink-0', size === 'xs' ? 'text-[11px]' : 'text-xs')}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          disabled={disabled || o.disabled}
          className={cx(
            'inline-flex items-center gap-1 rounded-md disabled:opacity-40 disabled:pointer-events-none',
            size === 'xs' ? 'px-2 py-0.5' : 'px-2.5 py-1',
            value === o.value ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-fg',
          )}
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

/** An action of a toolbar that folds into the ⋯ menu when the toolbar is narrow (OverflowActions). */
export interface OverflowAction extends MenuItem {
  /** A toggle that is on (drawn pressed as a button). */
  pressed?: boolean;
  /** data-* attributes of its button (for tests and the docs' screenshots), e.g. { 'data-flow-minimap-toggle': '' }. */
  data?: Record<string, string>;
  /** The toolbar width (px) from which this action is a button (default: the component's `at`); narrower, it is a ⋯ menu item. */
  minWidth?: number;
}

/**
 * Toolbar actions that are buttons while the toolbar is wide and fold into one ⋯ menu as it narrows: the one overflow
 * pattern of the app (the response bar, the flow designer's toolbar). The toolbar is the element it is put in: its
 * width is measured, and each action is a button from its own `minWidth` (default `at`, in px) up.
 */
export function OverflowActions({ items, label = 'More actions', at = 768, variant, className }: { items: OverflowAction[]; label?: string; at?: number; variant?: Variant; className?: string }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const bar = probe.current?.parentElement;
    if (!bar) return;
    setWidth(bar.clientWidth);
    const ro = new ResizeObserver(() => setWidth(bar.clientWidth));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  // before the first measure (and when hidden): everything in the menu, so nothing overflows for a frame
  const fits = (a: OverflowAction) => width !== undefined && width >= (a.minWidth ?? at);
  const shown = items.filter(fits);
  const folded = items.filter((a) => !fits(a));
  return (
    <>
      <span ref={probe} hidden />
      {shown.length > 0 && (
        <div className={cx('flex items-center gap-1', className)} data-overflow-buttons>
          {shown.map((a) => (
            <Button key={a.label} size="sm" variant={variant} icon={a.icon} onClick={a.onSelect} title={a.title} disabled={a.disabled} aria-pressed={a.pressed} {...a.data}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {folded.length > 0 && (
        <div className={cx(!shown.length && className)} data-overflow-menu>
          <MoreMenu label={label} items={folded} />
        </div>
      )}
    </>
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

/**
 * One step of a guided tour, pointing at an element on screen (`anchor`; centred when there is none): a small card with
 * a title, a few words, "n of m", **Back**, **Next** (**Done** on the last), **Skip tour** and, optionally, an action
 * ("Show me"). The element gets a ring; the rest of the window stays usable. Keys: Esc skips, → / Enter next, ← back.
 * The card follows the element when the window scrolls or resizes, and takes the focus on each step.
 */
export function Coachmark({
  anchor,
  title,
  children,
  step,
  total,
  onNext,
  onBack,
  onSkip,
  action,
  done,
}: {
  anchor?: Element | null;
  title: string;
  children: ReactNode;
  /** 0-based. */
  step: number;
  total: number;
  onNext(): void;
  onBack?(): void;
  onSkip(): void;
  action?: { label: string; onClick(): void };
  /** The step is already done (shown as such). */
  done?: boolean;
}) {
  const [rect, setRect] = useState<DOMRect | undefined>(() => anchor?.getBoundingClientRect());
  const next = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!anchor) return setRect(undefined);
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRect(anchor.isConnected ? anchor.getBoundingClientRect() : undefined));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    ro?.observe(anchor);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor]);
  useEffect(() => next.current?.focus(), [step]);
  const last = step === total - 1;
  const W = 320;
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  // below the element when there is room, else above it; centred when there is no element
  const pos: CSSProperties = rect
    ? { left: Math.max(12, Math.min(vw - W - 12, rect.left + rect.width / 2 - W / 2)), ...(rect.bottom + 190 < vh ? { top: rect.bottom + 10 } : { bottom: Math.max(12, vh - rect.top + 10) }) }
    : { left: Math.max(12, vw / 2 - W / 2), top: Math.max(12, vh / 3) };
  const keys = (e: ReactKeyboardEvent) => {
    if (e.repeat) return e.preventDefault(); // a held key moves one step, not through the whole tour
    if (e.key === 'Escape') (e.preventDefault(), onSkip());
    else if (e.key === 'ArrowRight') (e.preventDefault(), onNext());
    else if (e.key === 'ArrowLeft' && onBack) (e.preventDefault(), onBack());
  };
  return createPortal(
    <>
      {rect && <div aria-hidden className="fixed z-[60] pointer-events-none rounded-lg ring-2 ring-accent ring-offset-2 ring-offset-bg transition-all" style={{ left: rect.left - 2, top: rect.top - 2, width: rect.width + 4, height: rect.height + 4 }} data-coachmark-ring />}
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="coachmark-title"
        aria-describedby="coachmark-text"
        data-coachmark={step}
        className="fixed z-[61] rounded-xl border border-line bg-panel shadow-xl p-4 flex flex-col gap-2 text-sm"
        style={{ width: W, ...pos }}
        onKeyDown={keys}
      >
        <div className="flex items-center gap-2">
          <span className="text-[0.7rem] font-medium text-muted tabular-nums">
            {step + 1} of {total}
          </span>
          {done && <span className="text-[0.7rem] text-ok">done</span>}
          <button type="button" className="ml-auto text-xs text-muted hover:text-fg" onClick={onSkip}>
            Skip tour
          </button>
        </div>
        <h3 id="coachmark-title" className="font-semibold">
          {title}
        </h3>
        <div id="coachmark-text" className="text-muted">
          {children}
        </div>
        <div className="flex items-center gap-2 mt-1">
          {action && (
            <Button size="sm" variant="ghost" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          <span className="ml-auto" />
          {onBack && step > 0 && (
            <Button size="sm" variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
          <Button ref={next} size="sm" variant="primary" onClick={onNext}>
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}
