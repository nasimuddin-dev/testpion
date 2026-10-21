import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * Chips that filter a list by one of a few values (the kinds in the Git view): any number can be on, none means all. One control,
 * the same look wherever a list is filtered this way; a chip shows how many rows it would show, and one with no rows is off.
 * `single` makes it a choice of one (the request health views of a collection); `allChip={false}` leaves out the All chip
 * when "none" is not a state of its own (the fields a Find and replace looks in).
 */
export function FilterChips<T extends string>({
  value,
  options,
  onChange,
  label,
  single,
  allChip = true,
  className,
}: {
  /** The chips that are on; empty: everything shows. */
  value: readonly T[];
  options: Array<{ value: T; label: ReactNode; count?: number; icon?: ReactNode; title?: string; disabled?: boolean }>;
  onChange(next: T[]): void;
  label: string;
  /** Exactly one chip is on: choosing another replaces it. */
  single?: boolean;
  /** The All chip (default on). */
  allChip?: boolean;
  /** The padding around the chips (default: the Git view's). */
  className?: string;
}) {
  const toggle = (v: T) => onChange(single ? [v] : value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div role="group" aria-label={label} className={cx('flex flex-wrap items-center gap-1', className ?? 'px-3 pb-2')} data-filter-chips="">
      {allChip && (
        <button
          type="button"
          aria-pressed={value.length === 0}
          onClick={() => onChange([])}
          className={cx('rounded-full border px-2.5 py-0.5 text-xs', value.length === 0 ? 'border-accent/40 bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:text-fg')}
        >
          All
        </button>
      )}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value.includes(o.value)}
          title={o.title}
          disabled={o.disabled}
          data-chip={o.value}
          onClick={() => toggle(o.value)}
          className={cx(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
            value.includes(o.value) ? 'border-accent/40 bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:text-fg',
            o.disabled && 'opacity-50',
          )}
        >
          {o.icon}
          {o.label}
          {o.count !== undefined && <span className="tabular-nums opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
