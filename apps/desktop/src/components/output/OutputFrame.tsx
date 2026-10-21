import type { ReactNode } from 'react';
import { cx } from '../ui';
import { OutputDownload } from './OutputDownload';
import type { OutputSpec } from './output-core';

/**
 * The right end of an output's bar: the surface's own actions first, then Copy, Download and ▾, always last, always the
 * same size. A panel that has a tab strip puts this in the strip's `right` slot; a panel without one uses OutputHeader.
 */
export function OutputActions({
  spec,
  children,
  className,
  wrap,
}: {
  spec: OutputSpec;
  children?: ReactNode;
  className?: string;
  /** The tools wrap onto more lines instead of being clipped (a bar that wraps). */
  wrap?: boolean;
}) {
  // no `@container` here: inline-size containment sizes the box as if it were empty, so a shrink-0 bar collapsed to its
  // padding and the control overflowed out of sight (clipped by the pane) in every tab strip.
  // When the bar is too narrow (the smallest window, a side panel pinned) the surface's own tools give way, never the
  // control: they shrink and are clipped from their left end (justify-end), while Copy / Download / ▾ keep their size.
  // min-w-0: a flex box's min-content is the sum of its children's, tools included, so without it the bar could never
  // shrink at all. What gives way before it is the bar's start (OutputBarStart shrinks 100 times faster) and, in a tab
  // strip, the tab list (Tabs lets this slot shrink, the tabs move into »).
  const hasTools = children !== undefined && children !== null && children !== false;
  // With no tools of its own there is nothing in here that can give way, so the box must not shrink: a shrinking box
  // around an unshrinkable control only pushed the ▾ out of view (the History count row at the default sidebar width).
  return (
    <div className={cx('ml-auto flex items-center gap-1 min-w-0 pl-2', hasTools ? 'shrink' : 'shrink-0', className)} data-output-actions>
      {hasTools && (
        <div className={cx('flex items-center justify-end gap-1 min-w-0 shrink', wrap ? 'flex-wrap' : 'overflow-clip [overflow-clip-margin:4px]')} data-output-tools>
          {children}
        </div>
      )}
      <OutputDownload spec={spec} />
    </div>
  );
}

/**
 * The left part of an output's bar (its title, filters, view tools): it gives way first in a narrow pane (it shrinks 100
 * times faster than the actions and is clipped at its right end), so the down arrow at the bar's right end stays whole.
 * OutputHeader uses it; a panel with its own bar (the console, the log, the terminal) wraps its left part in it.
 */
export function OutputBarStart({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center gap-2 min-w-0 shrink-[100] overflow-clip [overflow-clip-margin:4px]', className)} data-output-header-start>
      {children}
    </div>
  );
}

/**
 * The header bar of an output panel (a log, a result, a matrix): its title and view tools on the left, OutputActions at
 * the right end. `overflow-clip` (not hidden): a clipped box can't be scrolled by focus or a caret, so the bar never
 * shifts sideways and cuts its first button.
 */
export function OutputHeader({ spec, title, left, actions, className }: { spec: OutputSpec; title?: ReactNode; left?: ReactNode; actions?: ReactNode; className?: string }) {
  // the title and the view tools give way first (clipped at their right end), then the surface's actions: the control
  // at the right end is the last thing standing in a narrow pane
  return (
    <div className={cx('flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0 min-w-0 overflow-clip whitespace-nowrap', className)} data-output-header>
      {(title !== undefined || left) && (
        <OutputBarStart>
          {title !== undefined && <span className="font-medium truncate min-w-0">{title}</span>}
          {left}
        </OutputBarStart>
      )}
      <OutputActions spec={spec}>{actions}</OutputActions>
    </div>
  );
}
