import { cx } from './ui';

/** The one-letter mark used for a change everywhere (Git view, explorer rows, status bar). */
const CHANGE_MARK: Record<string, { letter: string; tone: 'ok' | 'bad' | 'warn' | 'accent'; label: string }> = {
  added: { letter: 'A', tone: 'ok', label: 'Added' },
  untracked: { letter: 'A', tone: 'ok', label: 'Added' },
  removed: { letter: 'D', tone: 'bad', label: 'Deleted' },
  deleted: { letter: 'D', tone: 'bad', label: 'Deleted' },
  changed: { letter: 'M', tone: 'warn', label: 'Changed' },
  modified: { letter: 'M', tone: 'warn', label: 'Changed' },
  renamed: { letter: 'R', tone: 'accent', label: 'Renamed' },
  conflicted: { letter: '!', tone: 'bad', label: 'Conflict' },
};

/**
 * A git change mark (A / M / D / R / !), the same in the Git view, the explorer and anywhere else. A folder or a section
 * header that holds changes shows how many (`count`) in place of the letter.
 */
export function ChangeMark({ change, count, className }: { change: string; count?: number; className?: string }) {
  const m = CHANGE_MARK[change] ?? CHANGE_MARK.changed!;
  const counted = count !== undefined && m.letter === 'M';
  return (
    <span
      title={counted ? `${count} changed inside` : m.label}
      data-change-mark={m.letter}
      data-change-count={counted ? count : undefined}
      className={cx('inline-grid place-items-center h-4 rounded text-3xs font-bold shrink-0', counted ? 'min-w-4 px-1 bg-warn/15' : 'w-4', className)}
      style={{ color: `var(--${m.tone})` }}
    >
      {counted ? count : m.letter}
    </span>
  );
}
