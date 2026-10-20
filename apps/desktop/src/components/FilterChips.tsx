import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * Chips that filter a list by one of a few values (the kinds in the Git view): any number can be on, none means all. One control,
 * the same look wherever a list is filtered this way; a chip shows how many rows it would show.
 */
export function FilterChips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  /** The chips that are on; empty: everything shows. */
  value: readonly T[];
  options: Array<{ value: T; label: ReactNode; count?: number; icon?: ReactNode; title?: string }>;
  onChange(next: T[]): void;
  label: string;
}) {
  const toggle = (v: T) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 px-3 pb-2" data-filter-chips="">
      <button
        type="button"
        aria-pressed={value.length === 0}
        onClick={() => onChange([])}
        className={cx('rounded-full border px-2.5 py-0.5 text-xs', value.length === 0 ? 'border-accent/40 bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:text-fg')}
      >
        All
      </button>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value.includes(o.value)}
          title={o.title}
          data-chip={o.value}
          onClick={() => toggle(o.value)}
          className={cx(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
            value.includes(o.value) ? 'border-accent/40 bg-accent/15 text-accent font-medium' : 'border-line text-muted hover:text-fg',
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
