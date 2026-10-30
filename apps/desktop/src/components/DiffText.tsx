import { useEffect, useMemo, useRef } from 'react';
import { diffRowOfLine } from '../lib/diff-line';
import { cx } from './ui';

/**
 * A unified diff, its added and removed lines coloured: the one way the app shows a diff (Git, an answer against the
 * previous one, one model's answer against another's). `line` (1-based, of the new version: a link to a file at a line) is
 * highlighted and scrolled into view; a line the diff doesn't show lands on its nearest hunk.
 */
export function DiffText({ text, line, same }: { text: string; line?: number; /** What to say when there is no difference (default: the file wording). */ same?: string }) {
  const target = useMemo(() => (line && line > 0 ? diffRowOfLine(text, line) : undefined), [text, line]);
  const targetRef = useRef<HTMLDivElement>(null);
  useEffect(() => targetRef.current?.scrollIntoView({ block: 'center' }), [target]);
  if (!text.trim()) return <div className="p-3 text-sm text-muted">{same ?? 'No text difference (a binary file, or a rename).'}</div>;
  return (
    <pre className="p-3 text-xs mono whitespace-pre overflow-auto leading-relaxed" aria-label="Diff">
      {text.split('\n').map((row, i) => (
        <div
          key={i}
          ref={target?.row === i ? targetRef : undefined}
          data-diff-target={target?.row === i ? (target.exact ? 'line' : 'hunk') : undefined}
          className={cx(
            row.startsWith('+') && !row.startsWith('+++') && 'text-ok bg-ok/10',
            row.startsWith('-') && !row.startsWith('---') && 'text-bad bg-bad/10',
            row.startsWith('@@') && 'text-muted',
            /^(diff|index|---|\+\+\+) /.test(row) && 'text-muted',
            target?.row === i && 'outline outline-1 outline-accent bg-accent/15',
          )}
        >
          {row || ' '}
        </div>
      ))}
    </pre>
  );
}
