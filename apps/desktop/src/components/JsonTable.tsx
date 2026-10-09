import { ArrowDown, ArrowUp, BarChart3, Copy, DatabaseZap, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { plural } from '../lib/format';
import { Button, cx, Input, Segmented, Select } from './ui';
import { ChartCard } from './charts';
import { promptText, toastError, useApp } from '../store';
import { call } from '../api';
import { copyText } from '../lib/clipboard';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The array of objects to show as a table: the body itself, or the largest array of objects inside it
 * up to three objects deep (`items`, `data.users`, GraphQL's `data.continent.countries`), with its path.
 * Undefined when there is none.
 */
export function tableRowsOf(json: unknown): { rows: Row[]; path: string } | undefined {
  const ok = (a: unknown): a is Row[] => Array.isArray(a) && a.length > 0 && a.slice(0, 20).filter(isRow).length >= Math.min(a.length, 20) * 0.8;
  if (ok(json)) return { rows: json.filter(isRow), path: '$' };
  if (!isRow(json)) return undefined;
  let best: { rows: Row[]; path: string } | undefined;
  // breadth first, so on equal sizes the shallower list wins
  let level: Array<[Row, string]> = [[json, '$']];
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: Array<[Row, string]> = [];
    for (const [obj, prefix] of level)
      for (const [k, v] of Object.entries(obj)) {
        if (ok(v)) {
          if (!best || v.length > best.rows.length) best = { rows: v.filter(isRow), path: `${prefix}.${k}` };
        } else if (isRow(v)) next.push([v, `${prefix}.${k}`]);
      }
    level = next.slice(0, 50);
  }
  return best;
}

const LIMIT = 500;
/** Rows as CSV (RFC 4180 quoting), every row that matches the filter, in the shown order. */
function rowsToCsv(rows: Row[], columns: string[]): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(q).join(','), ...rows.map((r) => columns.map((c) => q(cell(r[c]))).join(','))].join('\r\n') + '\r\n';
}

const cell = (v: unknown) => (v === null ? 'null' : v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A JSON array of objects as a table: a column per key, click a header to sort, filter any cell. `columnTypes` adds the kind of value under each column name. */
export function JsonTable({ rows, path, columnTypes }: { rows: Row[]; path: string; columnTypes?: Record<string, string> }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>();
  const [filter, setFilter] = useState('');
  // columns in first-seen order across the first 200 rows
  const columns = useMemo(() => [...new Set(rows.slice(0, 200).flatMap((r) => Object.keys(r)))], [rows]);
  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    let out = f ? rows.filter((r) => columns.some((c) => cell(r[c]).toLowerCase().includes(f))) : rows;
    if (sort) {
      const { key, dir } = sort;
      out = [...out].sort((a, b) => {
        const x = a[key];
        const y = b[key];
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return cell(x).localeCompare(cell(y), undefined, { numeric: true }) * dir;
      });
    }
    return out;
  }, [rows, columns, filter, sort]);
  // chart: a label column and a numeric column (the first of each kind by default)
  const [view, setView] = useState<'table' | 'chart'>('table');
  const numeric = useMemo(() => columns.filter((c) => rows.slice(0, 50).some((r) => typeof r[c] === 'number') && rows.slice(0, 50).every((r) => r[c] === undefined || r[c] === null || typeof r[c] === 'number')), [columns, rows]);
  const labels = useMemo(() => columns.filter((c) => !numeric.includes(c) && rows.slice(0, 50).every((r) => r[c] === undefined || r[c] === null || typeof r[c] !== 'object')), [columns, numeric, rows]);
  const [labelCol, setLabelCol] = useState<string>();
  const [valueCol, setValueCol] = useState<string>();
  const label = labelCol && columns.includes(labelCol) ? labelCol : (labels[0] ?? numeric[0]);
  // by default the numeric column that varies most (a constant column makes a flat chart)
  const varied = useMemo(() => [...numeric].sort((a, b) => new Set(rows.slice(0, 100).map((r) => r[b])).size - new Set(rows.slice(0, 100).map((r) => r[a])).size), [numeric, rows]);
  const value = valueCol && numeric.includes(valueCol) ? valueCol : varied.find((c) => c !== label) ?? varied[0];
  const toggle = (key: string) => setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : undefined));
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line">
        <Input className="h-7 min-h-7 text-sm max-w-64" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="text-xs text-muted">
          {plural(shown.length, 'row')}
          {shown.length !== rows.length ? ` of ${rows.length}` : ''} · {plural(columns.length, 'column')} · <span className="mono">{path}</span>
        </span>
        {numeric.length > 0 && (
          <span className="ml-2">
            <Segmented
              label="Show as"
              size="xs"
              value={view}
              onChange={setView}
              options={[
                { value: 'table', label: 'Table', icon: <Table2 size={12} /> },
                { value: 'chart', label: 'Chart', icon: <BarChart3 size={12} /> },
              ]}
            />
          </span>
        )}
        <Button
          size="sm"
          className="ml-auto"
          icon={<Copy size={12} />}
          title="Copy the rows shown (all of them, not only the first 500) as CSV"
          onClick={() =>
            void copyText(rowsToCsv(shown, columns), `${plural(shown.length, 'row')} as CSV`)
          }
        >
          Copy CSV
        </Button>
        <Button
          size="sm"
          icon={<DatabaseZap size={12} />}
          title="Save the rows shown as a CSV in the workspace's datasets folder, to drive collection runs and tests"
          onClick={async () => {
            const name = await promptText('Save as dataset', { message: 'File name in the datasets folder', value: path === '$' ? 'response' : path.split('.').pop()!, okLabel: 'Save' });
            if (!name) return;
            try {
              const r = await call<{ name: string }>('datasets.saveCsv', { name, text: rowsToCsv(shown, columns) });
              useApp.getState().toast(`Saved ${plural(shown.length, 'row')} to datasets/${r.name}. Pick it in the Collection Runner.`, 'success');
            } catch (e) {
              toastError(e);
            }
          }}
        >
          Save as dataset
        </Button>
      </div>
      {view === 'chart' && value ? (
        <div className="flex-1 min-h-0 overflow-auto p-3">
          <div className="flex items-center gap-2 mb-3 text-xs">
            <span className="text-muted">Bars of</span>
            <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Value column" value={value} onChange={(e) => setValueCol(e.target.value)}>
              {numeric.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
            <span className="text-muted">labelled by</span>
            <Select className="h-7 min-h-7 py-0 text-xs" aria-label="Label column" value={label} onChange={(e) => setLabelCol(e.target.value)}>
              {[...labels, ...numeric].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
            <span className="text-muted">· sort and filter apply · first 100 rows</span>
          </div>
          <RowBars rows={shown.slice(0, 100)} label={label!} value={value} />
        </div>
      ) : (
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="text-xs border-collapse min-w-full">
          <thead className="sticky top-0 bg-panel z-10">
            <tr>
              {columns.map((c) => (
                <th key={c} className="text-left font-medium text-muted border-b border-r border-line px-2 py-1 whitespace-nowrap">
                  <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => toggle(c)} aria-label={`Sort by ${c}`} data-column={c} data-column-type={columnTypes?.[c]}>
                    {c}
                    {columnTypes?.[c] && <span className="font-normal text-[0.68rem] text-muted/80">{columnTypes[c]}</span>}
                    {sort?.key === c && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="mono">
            {shown.slice(0, LIMIT).map((r, i) => (
              <tr key={i} className="hover:bg-hover/60">
                {columns.map((c) => {
                  const v = r[c];
                  return (
                    <td key={c} title={cell(v)} className={cx('border-b border-r border-line/60 px-2 py-1 max-w-80 truncate', typeof v === 'number' && 'text-right tabular-nums', v === null || v === undefined ? 'text-muted' : typeof v === 'boolean' && 'text-accent')}>
                      {cell(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > LIMIT && <p className="text-xs text-muted p-2">Showing the first {LIMIT} rows; filter to narrow them down.</p>}
      </div>
      )}
    </div>
  );
}

/** One horizontal bar per row (one hue: it is magnitude), the label left, the value right; negative values run left of the axis. */
function RowBars({ rows, label, value }: { rows: Row[]; label: string; value: string }) {
  const nums = rows.map((r) => (typeof r[value] === 'number' ? (r[value] as number) : 0));
  const max = Math.max(0, ...nums);
  const min = Math.min(0, ...nums);
  const span = max - min || 1;
  const zero = (-min / span) * 100;
  return (
    <ChartCard title={`${value} by ${label}`}>
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => {
          const v = nums[i]!;
          const w = (Math.abs(v) / span) * 100;
          return (
            <div key={i} className="flex items-center gap-2 text-xs" title={`${cell(r[label])}: ${cell(r[value])}`}>
              <span className="w-40 shrink-0 truncate text-muted">{cell(r[label])}</span>
              <span className="relative flex-1 h-3.5">
                <span className="absolute inset-y-0 rounded-sm bg-accent" style={{ left: `${v < 0 ? zero - w : zero}%`, width: `${Math.max(w, v ? 0.5 : 0)}%` }} />
                {min < 0 && <span className="absolute inset-y-[-2px] w-px bg-line" style={{ left: `${zero}%` }} />}
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums text-fg">{r[value] === null || r[value] === undefined ? '—' : cell(r[value])}</span>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}
