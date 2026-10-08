import { CodeBlock } from './CodeBlock';
import { cx } from './ui';

/**
 * An item's parts in two or three versions side by side (a request's line, params, headers, auth, body, scripts …):
 * one table for Git's changes (before / now) and conflicts (before / mine / theirs). Parts that differ are marked;
 * a version that does not exist says why (deleted, new).
 */
export interface PartsColumn {
  key: string;
  label: string;
  /** Shown when the item does not exist in this version. */
  missing?: string;
  /** Mark the column as the one chosen (conflicts). */
  chosen?: boolean;
  /** Whether a differing part is highlighted in this column (not the common ancestor). */
  highlight?: boolean;
}

export interface PartsRow {
  part: string;
  values: Record<string, string | undefined>;
  differs: boolean;
}

export function PartsTable({ columns, rows, emptyText = 'No part differs.' }: { columns: PartsColumn[]; rows: PartsRow[]; emptyText?: string }) {
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="text-xs text-muted text-left">
          <th className="p-1.5 w-28 font-medium">Part</th>
          {columns.map((c) => (
            <th key={c.key} className="p-1.5 font-medium border-l border-line/60">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.part} className="border-t border-line/60" data-part={r.part}>
            <td className="align-top p-1.5 text-xs font-medium break-words">{r.part}</td>
            {columns.map((c) => {
              const v = r.values[c.key];
              return (
                <td key={c.key} className={cx('align-top p-1.5 border-l border-line/60', r.differs && c.highlight && 'bg-warn/10', c.chosen && 'ring-1 ring-inset ring-accent/60')}>
                  {v === undefined ? (
                    <span className="text-xs text-muted italic">{c.missing ?? '—'}</span>
                  ) : v ? (
                    <CodeBlock className="text-xs mono whitespace-pre-wrap break-all max-h-40 overflow-auto" text={v} />
                  ) : (
                    <span className="text-xs text-muted">(empty)</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <td colSpan={columns.length + 1} className="p-2 text-xs text-muted">
              {emptyText}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
