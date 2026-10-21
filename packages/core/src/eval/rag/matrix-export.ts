/**
 * The metrics matrix as a file (planning/rag-testing.md §4f): CSV (one row per sample, a score column and a pass column per
 * metric), JSON (the columns, the rows, the aggregates, the failure classes, the per-tag means) and a self-contained HTML
 * report. Also the variant × metric pivot: the mean of every metric for several runs side by side. Pure functions over
 * `MetricMatrix`; the output surface `rag.matrix` and the CLI `rag matrix` both call them.
 */
import { toCsv } from '@testpion/shared';
import type { MetricMatrix } from './metric-matrix.js';
import { ragasColumnName } from './ragas-io.js';

interface ExportOptions {
  /** `ragas`: the score columns are named the way Ragas names them in its result table. */
  names?: 'testpion' | 'ragas';
  title?: string;
}

export function ragMatrixCsv(m: MetricMatrix, o: ExportOptions = {}): string {
  const names = m.columns.map((c) => (o.names === 'ragas' && !c.external ? ragasColumnName(c.metric) : c.key));
  const head = ['id', 'question', 'tags', 'status', 'failure', ...m.columns.flatMap((_c, i) => [names[i]!, `${names[i]}_passed`])];
  const rows = m.rows.map((r) => [
    r.id,
    r.question ?? '',
    (r.tags ?? []).join(';'),
    r.status,
    r.failure?.class ?? '',
    ...r.cells.flatMap((c) => (c?.score !== undefined ? [c.score, c.passed === undefined ? '' : c.passed ? 'true' : 'false'] : [c?.na ? 'n/a' : '', ''])),
  ]);
  return toCsv([head, ...rows]);
}

export function ragMatrixJson(m: MetricMatrix, o: ExportOptions = {}): string {
  const names = m.columns.map((c) => (o.names === 'ragas' && !c.external ? ragasColumnName(c.metric) : c.key));
  return (
    JSON.stringify(
      {
        ...(m.runId ? { runId: m.runId } : {}),
        total: m.total,
        columns: m.columns.map((c, i) => ({ ...c, name: names[i] })),
        aggregates: m.aggregates,
        failures: m.failures,
        byTag: m.byTag,
        rows: m.rows.map((r) => ({ ...r, cells: Object.fromEntries(r.cells.map((c, i) => [names[i], c])) })),
      },
      null,
      2,
    ) + '\n'
  );
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (v: number | undefined) => (v === undefined ? '' : `${Math.round(v * 100)}%`);

export function ragMatrixHtml(m: MetricMatrix, o: ExportOptions = {}): string {
  const title = o.title ?? (m.runId ? `RAG metrics · ${m.runId}` : 'RAG metrics');
  const names = m.columns.map((c, i) => (o.names === 'ragas' && !c.external ? ragasColumnName(c.metric) : c.key) || String(i));
  const head = m.columns.map((_c, i) => `<th>${esc(names[i])}</th>`).join('');
  const agg = m.columns
    .map((c, i) => {
      const a = m.aggregates.find((x) => x.key === c.key);
      return `<td>${a?.mean === undefined ? '–' : `<b>${a.mean}</b>`}${a?.ci ? `<br><small>${a.ci[0]}–${a.ci[1]}</small>` : ''}${a?.passRate !== undefined ? `<br><small>${pct(a.passRate)} pass</small>` : ''}${a?.naCount ? `<br><small>${a.naCount} n/a</small>` : ''}${c.threshold !== undefined ? `<br><small>${c.direction === 'lower' ? '≤' : '≥'} ${c.threshold}</small>` : ''}</td>`;
    })
    .join('');
  const body = m.rows
    .map(
      (r) =>
        `<tr><td class="q">${esc(r.question ?? r.name)}${r.tags?.length ? `<br><small>${esc(r.tags.join(', '))}</small>` : ''}</td><td>${esc(r.failure?.class ?? (r.status === 'passed' ? '' : r.status))}</td>${r.cells
          .map((c) => (c?.score !== undefined ? `<td class="${c.passed === undefined ? '' : c.passed ? 'ok' : 'bad'}">${c.score}</td>` : `<td class="na">${esc(c?.na ? 'n/a' : c?.failed ? '!' : '')}</td>`))
          .join('')}</tr>`,
    )
    .join('\n');
  const tags = m.byTag.length
    ? `<h2>By tag</h2><table><thead><tr><th>tag</th><th>n</th>${head}</tr></thead><tbody>${m.byTag.map((t) => `<tr><td>${esc(t.tag)}</td><td>${t.n}</td>${t.means.map((v) => `<td>${v ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '';
  const fails = m.failures.length ? `<p>${m.failures.map((f) => `${esc(f.label)}: ${f.count}`).join(' · ')}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font:14px system-ui,sans-serif;margin:24px;color:#1b1f24;background:#fff}h1{font-size:20px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:right;vertical-align:top}th{background:#f6f8fa;position:sticky;top:0}td.q{text-align:left;max-width:360px}small{color:#57606a}.ok{background:#dafbe1}.bad{background:#ffebe9}.na{color:#8c959f;background:#f6f8fa}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}th{background:#161b22}th,td{border-color:#30363d}small{color:#8b949e}.ok{background:#12351f}.bad{background:#4d1f1c}.na{background:#161b22;color:#6e7681}}
</style></head><body><h1>${esc(title)}</h1><p>${m.total} samples · ${m.columns.length} metrics</p>${fails}
<table><thead><tr><th>sample</th><th>why it failed</th>${head}</tr></thead><tbody><tr><td class="q"><b>mean</b></td><td></td>${agg}</tr>
${body}</tbody></table>${tags}</body></html>
`;
}

/* ------------------------------------------------------------------ the variant × metric pivot */

interface PivotRun {
  runId: string;
  label: string;
  matrix: Pick<MetricMatrix, 'columns' | 'aggregates'>;
}

export interface MetricPivot {
  /** One row per metric column (by key, over all the runs). */
  metrics: Array<{ key: string; label: string; metric: string; group: string; direction: 'higher' | 'lower' }>;
  variants: Array<{ runId: string; label: string }>;
  /** cells[metric][variant]: the mean and its interval, or null when the run did not have the metric. */
  cells: Array<Array<{ mean: number; ci?: [number, number]; passRate?: number; n: number } | null>>;
  /** The best variant per metric (by direction); undefined when fewer than two have it or they tie. */
  best: Array<number | undefined>;
}

export function pivotRuns(runs: PivotRun[]): MetricPivot {
  const metrics: MetricPivot['metrics'] = [];
  const seen = new Set<string>();
  for (const r of runs)
    for (const c of r.matrix.columns)
      if (!seen.has(c.key)) {
        seen.add(c.key);
        metrics.push({ key: c.key, label: c.label, metric: c.metric, group: c.group, direction: c.direction });
      }
  const cells = metrics.map((mt) =>
    runs.map((r) => {
      const a = r.matrix.aggregates.find((x) => x.key === mt.key);
      return a && a.mean !== undefined ? { mean: a.mean, ...(a.ci ? { ci: a.ci } : {}), ...(a.passRate !== undefined ? { passRate: a.passRate } : {}), n: a.n } : null;
    }),
  );
  const best = cells.map((row, i) => {
    const have = row.map((c, v) => (c ? { v, mean: c.mean } : undefined)).filter((x): x is { v: number; mean: number } => !!x);
    if (have.length < 2) return undefined;
    const lower = metrics[i]!.direction === 'lower';
    have.sort((a, b) => (lower ? a.mean - b.mean : b.mean - a.mean));
    return have[0]!.mean === have[1]!.mean ? undefined : have[0]!.v;
  });
  return { metrics, variants: runs.map((r) => ({ runId: r.runId, label: r.label })), cells, best };
}

