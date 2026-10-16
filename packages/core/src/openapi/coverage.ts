import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry, TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import { readResultsFile } from '../runner/runner.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { findOperation, loadOpenApi, type OpenApiDoc } from './contract.js';

/**
 * API coverage: which operations of an OpenAPI document (and which of their documented response
 * codes) were exercised by test runs or request history, and which were not. Used by
 * `testpion coverage`, the `api_coverage` MCP tool and the app's API coverage dialog.
 */

/** One request that was sent (from a test result or the history). */
export interface ApiObservation {
  method: string;
  url: string;
  status?: number;
  /** Test or request name, shown as an example of what covers an operation. */
  name?: string;
  source?: 'test' | 'history';
}

export interface OperationCoverage {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  deprecated: boolean;
  /** Requests that matched this operation. */
  calls: number;
  /** Observed status code → count. */
  statuses: Record<string, number>;
  /** Response codes documented for the operation (`default` left out), e.g. `200`, `404`, `4XX`. */
  documentedStatuses: string[];
  testedStatuses: string[];
  untestedStatuses: string[];
  /** Observed codes the document doesn't describe (and no `default` response covers). */
  undocumentedStatuses: string[];
  covered: boolean;
  /** Up to three names of tests or requests that hit the operation. */
  examples: string[];
}

export interface ApiCoverageReport {
  schemaVersion: '1';
  title?: string;
  version?: string;
  summary: {
    operations: number;
    covered: number;
    /** Covered operations, in percent (0–100, one decimal). */
    operationPct: number;
    documentedStatuses: number;
    testedStatuses: number;
    statusPct: number;
    observations: number;
    unmatched: number;
  };
  operations: OperationCoverage[];
  /** Requests that no operation describes (most frequent first, at most 50). */
  unmatched: Array<{ method: string; path: string; count: number; statuses: number[] }>;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 100);

/** Does an observed status match a documented response key (`200`, `2XX`, `2xx`)? */
function statusMatches(key: string, status: number): boolean {
  if (/^\d{3}$/.test(key)) return Number(key) === status;
  if (/^[1-5]xx$/i.test(key)) return Math.floor(status / 100) === Number(key[0]);
  return false;
}

export interface ApiCoverageOptions {
  /**
   * Only count requests under this URL (e.g. `{{baseUrl}}` resolved); it's removed before matching.
   * Without it every observation is matched on its path, and requests to other APIs show as unmatched.
   */
  baseUrl?: string;
  /** Leave deprecated operations out of the totals (they're still listed). */
  excludeDeprecated?: boolean;
}

export function apiCoverage(doc: OpenApiDoc, observations: Iterable<ApiObservation>, opts: ApiCoverageOptions = {}): ApiCoverageReport {
  const ops = new Map<string, OperationCoverage & { hasDefault: boolean }>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) {
      const op = item?.[m] as Record<string, unknown> | undefined;
      if (!op || typeof op !== 'object') continue;
      const responses = Object.keys((op.responses as Record<string, unknown>) ?? {});
      ops.set(`${m} ${path}`, {
        method: m.toUpperCase(),
        path,
        operationId: op.operationId as string | undefined,
        summary: op.summary as string | undefined,
        tags: Array.isArray(op.tags) ? (op.tags as string[]) : [],
        deprecated: op.deprecated === true,
        calls: 0,
        statuses: {},
        documentedStatuses: responses.filter((r) => r !== 'default'),
        testedStatuses: [],
        untestedStatuses: [],
        undocumentedStatuses: [],
        covered: false,
        examples: [],
        hasDefault: responses.includes('default'),
      });
    }
  }

  const base = opts.baseUrl?.replace(/\/+$/, '');
  const unmatched = new Map<string, { method: string; path: string; count: number; statuses: Set<number> }>();
  let observed = 0;
  for (const o of observations) {
    let url = o.url;
    if (base) {
      if (!url.startsWith(base)) continue;
      url = url.slice(base.length) || '/';
    }
    observed++;
    const hit = findOperation(doc, o.method, url);
    const entry = hit && ops.get(`${hit.method} ${hit.path}`);
    if (!entry) {
      let path = url;
      try {
        path = new URL(url, 'http://base.invalid').pathname;
      } catch {
        /* keep the raw value */
      }
      const key = `${o.method.toUpperCase()} ${path}`;
      const u = unmatched.get(key) ?? { method: o.method.toUpperCase(), path, count: 0, statuses: new Set<number>() };
      u.count++;
      if (o.status) u.statuses.add(o.status);
      unmatched.set(key, u);
      continue;
    }
    entry.calls++;
    if (o.status) entry.statuses[o.status] = (entry.statuses[o.status] ?? 0) + 1;
    if (o.name && entry.examples.length < 3 && !entry.examples.includes(o.name)) entry.examples.push(o.name);
  }

  let documented = 0;
  let tested = 0;
  let covered = 0;
  let counted = 0;
  const operations: OperationCoverage[] = [];
  for (const { hasDefault, ...e } of ops.values()) {
    const seen = Object.keys(e.statuses).map(Number);
    e.testedStatuses = e.documentedStatuses.filter((k) => seen.some((s) => statusMatches(k, s)));
    e.untestedStatuses = e.documentedStatuses.filter((k) => !e.testedStatuses.includes(k));
    e.undocumentedStatuses = hasDefault ? [] : seen.filter((s) => !e.documentedStatuses.some((k) => statusMatches(k, s))).map(String);
    e.covered = e.calls > 0;
    operations.push(e);
    if (opts.excludeDeprecated && e.deprecated) continue;
    counted++;
    if (e.covered) covered++;
    documented += e.documentedStatuses.length;
    tested += e.testedStatuses.length;
  }

  const info = (doc.info ?? {}) as { title?: string; version?: string };
  const unmatchedList = [...unmatched.values()].sort((a, b) => b.count - a.count).slice(0, 50).map((u) => ({ ...u, statuses: [...u.statuses].sort() }));
  return {
    schemaVersion: '1',
    title: info.title,
    version: info.version,
    summary: {
      operations: counted,
      covered,
      operationPct: pct(covered, counted),
      documentedStatuses: documented,
      testedStatuses: tested,
      statusPct: pct(tested, documented),
      observations: observed,
      unmatched: [...unmatched.values()].reduce((a, u) => a + u.count, 0),
    },
    operations,
    unmatched: unmatchedList,
  };
}

/** Observations from test results (HTTP tests record their method, final URL and status). */
export function* observationsFromResults(results: Iterable<TestResult>): Generator<ApiObservation> {
  for (const r of results) {
    const m = r.metadata as { method?: string; url?: string; status?: number } | undefined;
    if (r.type !== 'http' || !m?.method || !m.url) continue;
    yield { method: m.method, url: m.url, status: typeof m.status === 'number' ? m.status : undefined, name: r.name, source: 'test' };
  }
}

/** Observations from the request history (HTTP entries with a numeric status). */
export function* observationsFromHistory(entries: Iterable<HistoryEntry>): Generator<ApiObservation> {
  for (const h of entries) {
    if (h.kind !== 'http' || !h.method || !h.url) continue;
    yield { method: h.method, url: h.url, status: typeof h.status === 'number' ? h.status : undefined, name: h.name, source: 'history' };
  }
}

/** A readable report for pull requests and humans reviewing what an agent tested. */
export function apiCoverageMarkdown(r: ApiCoverageReport): string {
  const s = r.summary;
  const lines = [
    `# API coverage${r.title ? `: ${r.title}` : ''}${r.version ? ` ${r.version}` : ''}`,
    '',
    `- **Operations:** ${s.covered} of ${s.operations} covered (${s.operationPct}%)`,
    `- **Documented responses:** ${s.testedStatuses} of ${s.documentedStatuses} seen (${s.statusPct}%)`,
    `- **Requests analysed:** ${s.observations}${s.unmatched ? ` (${s.unmatched} not in the document)` : ''}`,
    '',
    '| | Operation | Calls | Responses seen | Not seen |',
    '|---|---|---|---|---|',
  ];
  const esc = (t: string) => t.replace(/\|/g, '\\|');
  for (const o of r.operations) {
    const mark = o.covered ? (o.untestedStatuses.length ? '◐' : '✓') : '✗';
    const name = `\`${o.method} ${esc(o.path)}\`${o.deprecated ? ' _(deprecated)_' : ''}${o.summary ? ` ${esc(o.summary)}` : ''}`;
    const seen = Object.entries(o.statuses)
      .map(([k, n]) => `${k}${o.undocumentedStatuses.includes(k) ? ' ⚠' : ''} ×${n}`)
      .join(', ');
    lines.push(`| ${mark} | ${name} | ${o.calls} | ${seen || '–'} | ${o.untestedStatuses.join(', ') || '–'} |`);
  }
  if (r.unmatched.length) {
    lines.push('', '## Requests not in the document', '');
    for (const u of r.unmatched) lines.push(`- \`${u.method} ${esc(u.path)}\` ×${u.count}${u.statuses.length ? ` (${u.statuses.join(', ')})` : ''}`);
  }
  lines.push('', '✓ covered · ◐ covered, some documented responses not seen · ✗ not called · ⚠ response not documented');
  return lines.join('\n') + '\n';
}

/** Where a workspace coverage report took its requests from. */
export interface CoverageSources {
  runs: Array<{ id: string; name: string; startedAt: string }>;
  historyEntries: number;
}

/**
 * Coverage of an OpenAPI document by a workspace's test runs and/or request history.
 * `runs`: run ids, or 'latest' (the default when history isn't asked for either).
 */
export async function workspaceApiCoverage(
  store: WorkspaceStore,
  specText: string,
  opts: ApiCoverageOptions & { runs?: string[] | 'latest'; history?: number } = {},
): Promise<{ report: ApiCoverageReport; sources: CoverageSources }> {
  const doc = loadOpenApi(specText);
  const sources: CoverageSources = { runs: [], historyEntries: 0 };
  const observations: ApiObservation[] = [];
  const runIds = opts.runs === 'latest' || (opts.runs === undefined && !opts.history) ? store.meta.listRuns({ limit: 1 }).items.map((r) => r.id) : (opts.runs ?? []);
  for (const id of runIds) {
    const meta = store.meta.listRuns({ limit: 500 }).items.find((r) => r.id === id);
    const file = join(meta?.dir ?? store.runDir(id), 'results.jsonl');
    if (!existsSync(file)) throw new ApsError('ConfigurationError', `Run "${id}" has no results in this workspace`);
    const results: TestResult[] = [];
    for await (const r of await readResultsFile(file)) results.push(r);
    observations.push(...observationsFromResults(results));
    sources.runs.push({ id, name: meta?.name ?? id, startedAt: meta?.startedAt ?? '' });
  }
  if (opts.history) {
    const entries = store.meta.listHistory({ limit: opts.history, requests: true }).items;
    sources.historyEntries = entries.length;
    observations.push(...observationsFromHistory(entries));
  }
  return { report: apiCoverage(doc, observations, opts), sources };
}
