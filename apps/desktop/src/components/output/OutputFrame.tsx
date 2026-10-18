import type { ReactNode } from 'react';
import { cx } from '../ui';
import { OutputDownload } from './OutputDownload';
import type { OutputSpec } from './output-core';

/**
 * The right end of an output's bar: the surface's own actions first, then Copy, Download and ▾, always last, always the
 * same size. A panel that has a tab strip puts this in the strip's `right` slot; a panel without one uses OutputHeader.
 */
export function OutputActions({ spec, children, className }: { spec: OutputSpec; children?: ReactNode; className?: string }) {
  // no `@container` here: inline-size containment sizes the box as if it were empty, so a shrink-0 bar collapsed to its
  // padding and the control overflowed out of sight (clipped by the pane) in every tab strip
  return (
    <div className={cx('ml-auto flex items-center gap-1 shrink-0 min-w-0 pl-2', className)} data-output-actions>
      {children}
      <OutputDownload spec={spec} />
    </div>
  );
}

/**
 * The header bar of an output panel (a log, a result, a matrix): its title and view tools on the left, OutputActions at
 * the right end. `overflow-clip` (not hidden): a clipped box can't be scrolled by focus or a caret, so the bar never
 * shifts sideways and cuts its first button.
 */
export function OutputHeader({ spec, title, left, actions, className }: { spec: OutputSpec; title?: ReactNode; left?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0 min-w-0 overflow-clip whitespace-nowrap', className)} data-output-header>
      {title !== undefined && <span className="font-medium truncate min-w-0">{title}</span>}
      {left}
      <OutputActions spec={spec}>{actions}</OutputActions>
    </div>
  );
}
