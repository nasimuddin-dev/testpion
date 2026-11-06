import { forwardRef, useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './ui';
import { hoverSelect } from '../lib/hover-select';

/**
 * The keys of a list of suggestions, the one way everywhere: ↑ / ↓ move, Enter or Tab takes the active one, Esc closes.
 * True when the key was the list's (the field then does nothing else with it).
 */
export function suggestKey(e: KeyboardEvent, o: { count: number; index: number; setIndex(i: number): void; take(i: number): void; close(): void; takes?: (i: number) => boolean }): boolean {
  if (!o.count) return false;
  const i = Math.min(o.index, o.count - 1);
  if (e.key === 'ArrowDown') return (e.preventDefault(), o.setIndex((i + 1) % o.count), true);
  if (e.key === 'ArrowUp') return (e.preventDefault(), o.setIndex((i - 1 + o.count) % o.count), true);
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.ctrlKey && !e.metaKey && (o.takes?.(i) ?? true)) return (e.preventDefault(), o.take(i), true);
  if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), o.close(), true);
  return false;
}

/** The list of suggestions under a field (a combobox's listbox): the active row in the selected colour, a click takes one. */
export function SuggestList({ id, rows, index, setIndex, take, className, label }: { id: string; rows: Array<{ key: string; content: ReactNode; title?: string }>; index: number; setIndex(i: number): void; take(i: number): void; className?: string; label?: string }) {
  const active = Math.min(index, rows.length - 1);
  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      className={cx('absolute left-0 top-full mt-1 z-40 min-w-full w-max max-w-[min(32rem,80vw)] max-h-64 overflow-auto rounded-md border border-line bg-bg shadow-xl py-1 text-xs', className)}
    >
      {rows.map((r, i) => (
        <div
          key={r.key}
          id={`${id}-${i}`}
          role="option"
          title={r.title}
          aria-selected={i === active}
          onMouseDown={(e) => (e.preventDefault(), take(i))}
          {...hoverSelect(() => setIndex(i))}
          className={cx('px-3 py-1 cursor-default truncate', i === active && 'bg-accent-soft')}
        >
          {r.content}
        </div>
      ))}
    </div>
  );
}

/**
 * A text field with a list of suggestions under it (a combobox): ↑ / ↓ move, Enter or Tab takes one, Esc closes the
 * list. `suggest` is asked for the rows of what is typed (only while the field has the focus).
 */
export const SuggestInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    value: string;
    onChange(v: string): void;
    suggest(v: string): string[];
    /** How a suggestion is drawn (default: the text, monospaced). */
    renderSuggestion?(s: string): ReactNode;
    listClassName?: string;
  }
>(function SuggestInput({ value, onChange, suggest, renderSuggestion, className, listClassName, onKeyDown, onFocus, onBlur, ...rest }, ref) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const listId = useId();
  const rows = open ? suggest(value) : [];
  const shown = rows.length > 0;
  const take = (s: string) => {
    onChange(s);
    setIndex(0);
  };
  return (
    <span className="relative inline-flex flex-1 min-w-0">
      <input
        ref={ref}
        {...rest}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${listId}-${Math.min(index, rows.length - 1)}` : undefined}
        className={cx('field w-full', className)}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setIndex(0);
        }}
        onFocus={(e) => (setOpen(true), onFocus?.(e))}
        onBlur={(e) => (setOpen(false), onBlur?.(e))}
        onKeyDown={(e) => {
          if (shown) {
            if (suggestKey(e, { count: rows.length, index, setIndex, take: (i) => take(rows[i]!), close: () => setOpen(false), takes: (i) => rows[i] !== value })) return;
          } else if (e.key === 'ArrowDown') return (e.preventDefault(), setOpen(true));
          onKeyDown?.(e);
        }}
      />
      {shown && (
        <SuggestList
          id={listId}
          className={listClassName}
          rows={rows.map((s) => ({ key: s, content: renderSuggestion ? renderSuggestion(s) : <span className="mono text-fg">{s}</span> }))}
          index={index}
          setIndex={setIndex}
          take={(i) => take(rows[i]!)}
        />
      )}
    </span>
  );
});
