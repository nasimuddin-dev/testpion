/**
 * The sources of an output that are lists of what the workspace recorded — History, traces, a monitor's runs, the runs
 * list — and the workspace's changes. Small enough to build whole (at most a few thousand rows), so each is one text;
 * the secrets they could hold were masked when they were recorded, and what is written here goes through the redactor
 * once more (URLs, HAR, OTLP attributes).
 */
import { toCsv, type OutputFormatId, type OutputSource } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { describeGitChanges, changesMarkdown } from '../git/semantic.js';
import { gitDiff, gitStatus } from '../git/git.js';
import { listMonitors, monitorResults } from '../runner/monitors.js';
import { workspaceReportHtml } from '../report/workspace-report.js';
import { workspaceAttention } from '../storage/attention.js';
import { buildMetricMatrix } from '../eval/rag/metric-matrix.js';
import { ragMatrixCsv, ragMatrixHtml, ragMatrixJson } from '../eval/rag/matrix-export.js';
import { historyToHar } from '../storage/history-har.js';
import { tracesToOtlp } from '../trace/otlp.js';
import type { OutputDeps } from './types.js';

/** The most rows a list source writes (the same cap the History export always had). */
const MAX_ROWS = 2000;
const cap = (n: number | undefined, dflt: number) => Math.max(1, Math.min(Math.floor(n ?? dflt) || dflt, MAX_ROWS));

type DataSource = Extract<OutputSource, { kind: 'history' | 'traces' | 'monitor-runs' | 'runs-overview' | 'git-diff' | 'workspace-report' | 'rag-matrix' }>;

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** The text of a list source in a format. */
export async function dataSource(deps: OutputDeps, src: DataSource, format: OutputFormatId): Promise<string> {
  const { store, redactor } = deps;
  switch (src.kind) {
    case 'history': {
      const q = { query: src.query || undefined, kind: src.historyKind || undefined, failed: src.failed || undefined, limit: cap(src.limit, 500) };
      if (format === 'har') return json(historyToHar(store, store.meta.listHistory(q).items, redactor));
      const items = store.meta.listHistory({ ...q, brief: true }).items;
      const rows = items.map((h) => ({
        time: h.timestamp,
        kind: h.kind,
        name: h.name,
        method: h.method ?? '',
        url: h.url ? redactor.redactUrl(h.url) : '',
        status: h.status ?? '',
        durationMs: h.durationMs ?? '',
        size: h.size ?? '',
      }));
      return format === 'csv' ? toCsv([['time', 'kind', 'name', 'method', 'url', 'status', 'durationMs', 'size'], ...rows.map((r) => Object.values(r))]) : json(rows);
    }
    case 'traces': {
      const ids = src.ids?.length
        ? src.ids.slice(0, MAX_ROWS)
        : store.meta.listTraces({ query: src.query || undefined, kind: src.traceKind || undefined, failed: src.failed || undefined, limit: cap(src.limit, 100) }).items.map((t) => t.id);
      const traces = ids.map((id) => store.loadTrace(id)).filter((t): t is NonNullable<typeof t> => !!t);
      return json(tracesToOtlp(traces, { redactor, resource: { 'testpion.workspace': store.workspace.name } }));
    }
    case 'monitor-runs': {
      const want = String(src.monitor ?? '').toLowerCase();
      const m = listMonitors(store).find((x) => x.id.toLowerCase() === want || x.name.toLowerCase() === want);
      if (!m)
        throw new ApsError('ConfigurationError', `No monitor "${String(src.monitor)}"`, {
          suggestions: [
            `Monitors: ${
              listMonitors(store)
                .map((x) => x.name)
                .join(', ') || 'none'
            }`,
          ],
        });
      const results = monitorResults(store, m.id, cap(src.limit, 100));
      if (format === 'json') return json(results);
      return toCsv([
        ['startedAt', 'status', 'durationMs', 'total', 'passed', 'failed', 'errors', 'p50Ms', 'p95Ms', 'certDaysLeft', 'reason', 'error'],
        ...results.map((r) => [r.startedAt, r.status, r.durationMs, r.total, r.passed, r.failed, r.errors, r.p50Ms ?? '', r.p95Ms ?? '', r.certDaysLeft ?? '', r.reason ?? '', r.error ?? '']),
      ]);
    }
    case 'runs-overview': {
      const runs = store.meta.listRuns({ query: src.query || undefined, limit: cap(src.limit, 200) }).items;
      const rows = runs.map((r) => ({
        id: r.id,
        name: r.name,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        errors: r.errors,
        environment: r.environment ?? '',
      }));
      return format === 'csv' ? toCsv([['id', 'name', 'startedAt', 'durationMs', 'total', 'passed', 'failed', 'skipped', 'errors', 'environment'], ...rows.map((r) => Object.values(r))]) : json(rows);
    }
    case 'rag-matrix': {
      const m = await buildMetricMatrix(deps.results(src.runId), { runId: src.runId, all: true, thresholds: src.thresholds });
      if (!m.total) throw new ApsError('ConfigurationError', `Run ${src.runId} has no RAG results`, { suggestions: ['`testpion rag run` records one; the id is in its output.'] });
      const o = { names: src.names };
      return format === 'csv' ? ragMatrixCsv(m, o) : format === 'html' ? ragMatrixHtml(m, o) : ragMatrixJson(m, o);
    }
    case 'workspace-report':
      return workspaceReportHtml(store, { days: Math.min(Math.max(Math.floor(src.days ?? 14) || 14, 1), 90), tzOffsetMin: src.tzOffsetMin, attention: await workspaceAttention(store) });
    case 'git-diff': {
      if (format === 'md') return changesMarkdown(await describeGitChanges(store.root, (await gitStatus(store.root)).files));
      const where = src.path || '.';
      // what is staged, then what is not yet: together, every change to the files
      return (await gitDiff(store.root, where, true)) + (await gitDiff(store.root, where, false));
    }
  }
}
