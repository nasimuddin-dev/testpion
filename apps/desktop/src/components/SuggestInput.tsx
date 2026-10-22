import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './ui';
import { hoverSelect } from '../lib/hover-select';

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
            const i = Math.min(index, rows.length - 1);
            if (e.key === 'ArrowDown') return (e.preventDefault(), setIndex((i + 1) % rows.length));
            if (e.key === 'ArrowUp') return (e.preventDefault(), setIndex((i - 1 + rows.length) % rows.length));
            if ((e.key === 'Enter' || e.key === 'Tab') && rows[i] !== value) return (e.preventDefault(), take(rows[i]!));
            if (e.key === 'Escape') return (e.preventDefault(), e.stopPropagation(), setOpen(false));
          } else if (e.key === 'ArrowDown') return (e.preventDefault(), setOpen(true));
          onKeyDown?.(e);
        }}
      />
      {shown && (
        <div
          id={listId}
          role="listbox"
          className={cx('absolute left-0 top-full mt-1 z-40 min-w-full w-max max-w-[min(32rem,80vw)] max-h-64 overflow-auto rounded-md border border-line bg-bg shadow-xl py-1 text-xs', listClassName)}
        >
          {rows.map((s, i) => (
            <div
              key={s}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === Math.min(index, rows.length - 1)}
              onMouseDown={(e) => (e.preventDefault(), take(s))}
              {...hoverSelect(() => setIndex(i))}
              className={cx('px-3 py-1 cursor-default truncate', i === Math.min(index, rows.length - 1) && 'bg-accent-soft')}
            >
              {renderSuggestion ? renderSuggestion(s) : <span className="mono text-fg">{s}</span>}
            </div>
          ))}
        </div>
      )}
    </span>
  );
});
