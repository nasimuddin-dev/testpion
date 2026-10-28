import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { caseColumns, casesToJsonl, cellText, cellValue, datasetRecords, MAX_TABLE_ROWS, type CaseRow, type DatasetTextFormat } from '@testpion/shared';
import { promptText } from '../../store';
import { Button, cx, Empty, IconButton, VirtualList } from '../ui';

const ROW = 30;
const COL_MIN = 160;

/**
 * The test cases of an evaluation as a table (AU-10): one row per case, one column per field, cells you type in. The rows are
 * drawn through a VirtualList, so thousands of cases cost what fifty do. Every change is written back as JSONL (the text
 * the evaluation keeps), so the table and "Edit as text" are two views of the same cases. A column named in the prompt as
 * {{name}}, or the expected answer, is marked.
 */
export function CaseTable({
  text,
  format,
  expectedField,
  vars,
  onChange,
  onPaste,
  onExample,
}: {
  text: string;
  format: DatasetTextFormat;
  expectedField: string;
  /** The {{variables}} of the prompt: their columns are marked. */
  vars: string[];
  /** The cases as JSONL. */
  onChange(jsonl: string): void;
  /** Open the paste dialog (the empty state offers it). */
  onPaste(): void;
  /** Put the example cases in (the empty state offers it). */
  onExample(): void;
}) {
  const [rows, setRows] = useState<CaseRow[]>(() => datasetRecords(text, format));
  const [extra, setExtra] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  // the text this table last wrote: when the text changes to anything else (a file loaded, "Edit as text"), the rows are read again
  const written = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (text === written.current) return;
    written.current = undefined;
    setRows(datasetRecords(text, format));
  }, [text, format]);
  const cols = useMemo(() => {
    const own = caseColumns(rows);
    return [...own, ...extra.filter((c) => !own.includes(c))];
  }, [rows, extra]);
  const shown = cols.length ? cols : ['input'];
  const emit = useCallback(
    (next: CaseRow[]) => {
      setRows(next);
      const t = casesToJsonl(next);
      written.current = t;
      onChange(t);
    },
    [onChange],
  );
  const setCell = (i: number, c: string, v: string) => emit(rows.map((r, j) => (j === i ? { ...r, [c]: cellValue(v, r[c]) } : r)));
  const addRow = () => {
    setRows((rs) => [...rs, {}]);
    requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('[data-case-row]:last-child input')?.focus());
  };
  const tooMany = rows.length >= MAX_TABLE_ROWS;
  const grid = { gridTemplateColumns: `44px repeat(${shown.length}, minmax(${COL_MIN}px, 1fr)) 32px` };
  const minWidth = 44 + shown.length * COL_MIN + 32;

  if (!rows.length && !cols.length)
    return (
      <Empty
        title="No test cases yet"
        actions={[
          { label: 'Add a case', icon: <Plus size={13} />, onClick: () => emit([{ input: '', expected: '' }]) },
          { label: 'Paste cases…', onClick: onPaste },
          { label: 'Use the example cases', onClick: onExample },
        ]}
      >
        A test case is one input for the prompt and, if you have one, the answer you expect. Five to twenty cases are enough to start.
      </Empty>
    );

  return (
    <div ref={root} className="h-full flex flex-col min-h-0 overflow-x-auto" data-case-table data-case-count={rows.length}>
      <div className="flex flex-col h-full min-h-0" style={{ minWidth }}>
        <div className="grid items-center border-b border-line bg-panel text-xs font-medium shrink-0" style={grid} role="row">
          <span className="px-2 text-muted">#</span>
          {shown.map((c) => (
            <span key={c} className={cx('px-2 py-1.5 truncate', vars.includes(c) || c === expectedField ? 'text-accent' : 'text-muted')} title={vars.includes(c) ? `Filled into {{${c}}} in the prompt` : c === expectedField ? 'The answer you expect' : undefined} role="columnheader">
              {c}
            </span>
          ))}
          <span />
        </div>
        <div className="flex-1 min-h-0">
          <VirtualList
            name="CaseTable"
            className="h-full"
            label="Test cases"
            items={rows}
            rowHeight={ROW}
            keyOf={(_r, i) => i}
            render={(r, i) => (
              <div className="grid items-center border-b border-line/60 hover:bg-hover/50 h-full" style={grid} data-case-row data-case={i + 1}>
                <span className="px-2 text-xs text-muted tabular-nums">{i + 1}</span>
                {shown.map((c) => (
                  <input
                    key={c}
                    className="mono text-xs h-7 min-w-0 px-2 bg-transparent border-0 outline-none focus:bg-accent-soft focus:ring-1 focus:ring-accent/50 rounded-sm truncate"
                    value={cellText(r[c])}
                    onChange={(e) => setCell(i, c, e.target.value)}
                    onKeyDown={(e) => {
                      // Enter in the last row adds a case below it
                      if (e.key === 'Enter' && i === rows.length - 1 && !tooMany) {
                        e.preventDefault();
                        addRow();
                      }
                    }}
                    aria-label={`${c}, case ${i + 1}`}
                    data-case-cell={c}
                  />
                ))}
                <IconButton label={`Delete case ${i + 1}`} size="sm" onClick={() => emit(rows.filter((_x, j) => j !== i))}>
                  <Trash2 />
                </IconButton>
              </div>
            )}
          />
        </div>
        <div className="flex items-center gap-2 px-2 py-1.5 border-t border-line text-xs text-muted shrink-0">
          <Button size="sm" icon={<Plus size={12} />} onClick={addRow} disabled={tooMany} reason={`A table holds up to ${MAX_TABLE_ROWS} cases: edit the rest as text`} data-case-add>
            Add case
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const name = (await promptText('Add a column', { message: 'Column name (it is filled into {{name}} in the prompt)', okLabel: 'Add' }))?.trim();
              if (name && !cols.includes(name)) setExtra((x) => [...x, name]);
            }}
          >
            Add column
          </Button>
          <span className="ml-auto">Enter in the last row adds a case</span>
        </div>
      </div>
    </div>
  );
}
