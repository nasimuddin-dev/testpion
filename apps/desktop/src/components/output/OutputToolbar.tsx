import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cx, Tooltip } from '../ui';

/**
 * The ⓘ of an output bar: a hint shown on hover and focus, the one way in every output (the JSON tree's toolbar, the
 * Problems panel). Not a button: it does nothing when pressed, so it is announced as what it is, an image named by
 * its hint; `tabIndex` lets the keyboard reach it.
 */
export function OutputHint({ hint, className }: { hint: string; className?: string }) {
  return (
    <Tooltip content={hint}>
      <span role="img" aria-label={hint} tabIndex={0} className={cx('inline-flex items-center justify-center rounded-md h-6 w-6 text-muted hover:text-fg focus-visible:text-fg outline-none', className)} data-output-hint>
        <Info size={13} />
      </span>
    </Tooltip>
  );
}

/**
 * The tool row inside an output view (the JSON tree's Expand / Collapse / filter): view tools as icon buttons on the
 * left, the filter with a real basis (it is never squeezed to its minimum next to long text), the match count
 * truncated with the full text in its tooltip, and the hint behind an ⓘ. `overflow-x-clip`: focus and the caret can't
 * scroll it sideways, so its first button is never cut.
 */
export function OutputToolbar({
  tools,
  filter,
  status,
  statusTitle,
  statusTone,
  hint,
  right,
  className,
}: {
  tools?: ReactNode;
  filter?: ReactNode;
  status?: ReactNode;
  statusTitle?: string;
  statusTone?: 'bad';
  hint?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 py-1 text-xs text-muted shrink-0 min-w-0 overflow-x-clip whitespace-nowrap', className)} data-output-toolbar>
      {tools && <div className="flex items-center gap-0.5 shrink-0">{tools}</div>}
      {filter && <div className="flex flex-[1_1_14rem] min-w-40 max-w-96">{filter}</div>}
      {status !== undefined && status !== null && status !== false && (
        <span data-filter-count className={cx('min-w-0 truncate max-w-[40%]', statusTone === 'bad' && 'text-bad')} title={statusTitle}>
          {status}
        </span>
      )}
      <div className="ml-auto flex items-center gap-0.5 shrink-0">
        {right}
        {hint && <OutputHint hint={hint} />}
      </div>
    </div>
  );
}
