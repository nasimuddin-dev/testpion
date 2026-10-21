/**
 * The query engine (AI-12): runs a validated SearchQuery (query-spec.ts) against the stores — History, runs, the
 * results inside runs, traces — deterministically and read-only. It is the one engine behind the filter chips of the
 * Ask dialog, `testpion search`, the MCP `search_ask` / `search_query` tools and the `nl-search` task's translation: a
 * model writes a query, this file is what answers it, so the answer never depends on what a model thinks the data holds.
 *
 * Each source is scanned newest first with a cap (the newest 5 000 History entries, 1 000 runs, the results of the
 * newest 100 runs, 2 000 traces and the files of at most 300 of them); a cap that cut the scan is reported, never silent.
 */
import { join } from 'node:path';
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { TestResult } from '../model/types.js';
import { historyOk, type RunMeta } from '../storage/metastore.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readResultsFile } from '../runner/runner.js';
import { flakyTests } from '../runner/test-history.js';
import { parseSearchQuery, parseWhen, parseWithin, searchField, SOURCE_LABEL, type SearchCondition, type SearchQuery, type SearchSource } from './query-spec.js';

const SEARCH_SCAN = { history: 5000, runs: 1000, resultRuns: 100, results: 30_000, traces: 2000, traceFiles: 300 } as const;

/** One hit: what it is, when, and the ItemRef that opens it. */
export interface SearchRow {
  source: SearchSource;
  id: string;
  title: string;
  subtitle: string;
  /** ISO time. */
  at: string;
  failed: boolean;
  durationMs?: number;
  ref: ItemRef;
}

export interface SearchOutcome {
  query: SearchQuery;
  rows: SearchRow[];
  /** How many of the entries scanned matched (more than `rows` when the limit cut the list). */
  matched: number;
  /** Per source: entries looked at and matches. */
  perSource: Partial<Record<SearchSource, { scanned: number; matched: number }>>;
  /** Sources whose scan stopped at a cap: older entries were not looked at. */
  capped: SearchSource[];
  notes: string[];
  ms: number;
}

/** What the conditions are checked against: text-like facts are lists of strings, numbers and booleans stand alone. */
type Facts = Partial<Record<string, string[] | number | boolean>>;

const lower = (v: string[] | undefined) => (v ?? []).map((s) => s.toLowerCase());

function holds(c: SearchCondition, facts: Facts, now: number): boolean {
  const v = facts[c.field];
  const def = searchField(c.field)!;
  if (def.type === 'bool') return v === c.value;
  if (def.type === 'time') {
    if (typeof v !== 'number') return false;
    if (c.op === 'within') return v >= now - parseWithin(String(c.value))! && v <= now + 60_000;
    const t = parseWhen(String(c.value))!;
    // "until 2026-10-12" includes that whole day
    return c.op === 'gte' ? v >= t : v <= (String(c.value).length === 10 ? t + 86_399_999 : t);
  }
  if (def.type === 'number') {
    if (typeof v !== 'number') return false;
    const n = c.value as number | Array<number>;
    switch (c.op) {
      case 'eq':
        return v === n;
      case 'ne':
        return v !== n;
      case 'gt':
        return v > (n as number);
      case 'gte':
        return v >= (n as number);
      case 'lt':
        return v < (n as number);
      case 'lte':
        return v <= (n as number);
      case 'in':
        return (n as number[]).includes(v);
      default:
        return false;
    }
  }
  const have = lower(Array.isArray(v) ? v : undefined);
  const want = (x: unknown) => String(x).toLowerCase();
  switch (c.op) {
    case 'eq':
      return have.includes(want(c.value));
    case 'ne':
      return !have.includes(want(c.value));
    case 'in':
      return (c.value as Array<string | number>).some((x) => have.includes(want(x)));
    case 'contains':
      return have.some((h) => h.includes(want(c.value)));
    case 'not_contains':
      return !have.some((h) => h.includes(want(c.value)));
    default:
      return false;
  }
}

/** The fields whose facts cost a file read: checked last, only for entries that pass the rest. */
const LAZY = new Set(['error', 'span']);

interface Scan {
  q: SearchQuery;
  now: number;
  rows: Array<SearchRow & { sortTime: number }>;
  perSource: SearchOutcome['perSource'];
  capped: Set<SearchSource>;
  notes: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The oldest time any match can have (a `since` or a `within`), so a newest-first scan stops there. */
function oldestWanted(q: SearchQuery, now: number): number {
  let t = -Infinity;
  for (const c of q.where) if (c.field === 'time') t = Math.max(t, c.op === 'within' ? now - parseWithin(String(c.value))! : c.op === 'gte' ? parseWhen(String(c.value))! : -Infinity);
  return t;
}

function add(s: Scan, source: SearchSource, facts: Facts, row: Omit<SearchRow, 'source'>, sortTime: number, lazy?: () => Facts | undefined): void {
  const stat = (s.perSource[source] ??= { scanned: 0, matched: 0 });
  stat.scanned++;
  // only a source that reads a file for them (traces) has lazy facts: elsewhere `error` is an ordinary, already known fact
  const slow = lazy ? s.q.where.filter((c) => LAZY.has(c.field)) : [];
  if (!s.q.where.every((c) => slow.includes(c) || holds(c, facts, s.now))) return;
  if (slow.length) {
    const more = lazy?.();
    if (!more || !slow.every((c) => holds(c, more, s.now))) return;
  }
  stat.matched++;
  s.rows.push({ source, ...row, sortTime });
}

/** `add` for a source whose lazy facts cost an asynchronous file read: the event loop runs between the reads. */
async function addAsync(s: Scan, source: SearchSource, facts: Facts, row: Omit<SearchRow, 'source'>, sortTime: number, lazy: () => Promise<Facts | undefined>): Promise<void> {
  const stat = (s.perSource[source] ??= { scanned: 0, matched: 0 });
  stat.scanned++;
  const slow = s.q.where.filter((c) => LAZY.has(c.field));
  if (!s.q.where.every((c) => slow.includes(c) || holds(c, facts, s.now))) return;
  if (slow.length) {
    const more = await lazy();
    if (!more || !slow.every((c) => holds(c, more, s.now))) return;
  }
  stat.matched++;
  s.rows.push({ source, ...row, sortTime });
}

function scanHistory(store: WorkspaceStore, s: Scan): void {
  const { q } = s;
  const kinds = q.where.filter((c) => c.field === 'kind' && c.op === 'eq');
  const failedOnly = q.where.some((c) => c.field === 'failed' && c.value === true);
  const names = new Map<string, string>();
  if (q.where.some((c) => c.field === 'collection'))
    try {
      for (const c of store.listCollections()) names.set(c.id, c.name);
    } catch {
      /* a collection that does not load has no name to match */
    }
  const oldest = oldestWanted(q, s.now);
  for (let offset = 0; offset < SEARCH_SCAN.history; offset += 500) {
    const page = store.meta.listHistory({
      brief: true,
      limit: 500,
      offset,
      ...(kinds.length === 1 ? { kind: String(kinds[0]!.value).toLowerCase() } : {}),
      ...(failedOnly ? { failed: true } : {}),
    }).items;
    for (const h of page) {
      const at = Date.parse(h.timestamp);
      if (at < oldest) return;
      const status = typeof h.status === 'number' ? h.status : Number.isFinite(Number(h.status)) && h.status !== '' && h.status !== undefined ? Number(h.status) : undefined;
      const failed = !historyOk(h.status);
      const collection = h.collectionId ? [h.collectionId, ...(names.has(h.collectionId) ? [names.get(h.collectionId)!] : [])] : [];
      add(
        s,
        'history',
        {
          text: [h.name, h.url ?? '', h.method ?? '', h.kind, h.status === undefined ? '' : String(h.status)],
          time: at,
          name: [h.name],
          kind: [h.kind],
          method: h.method ? [h.method] : [],
          url: [h.url ?? ''],
          status,
          failed,
          duration: h.durationMs,
          size: h.size,
          collection,
        },
        {
          id: h.id,
          title: h.name || `${h.method ?? ''} ${h.url ?? ''}`.trim() || h.id,
          subtitle: `${h.method ?? h.kind}${h.url ? ` ${h.url}` : ''}${h.status !== undefined ? ` · ${h.status}` : ''}`,
          at: h.timestamp,
          failed,
          ...(h.durationMs !== undefined ? { durationMs: h.durationMs } : {}),
          ref: { kind: 'history', historyId: h.id },
        },
        at,
      );
    }
    if (page.length < 500) return;
  }
  s.capped.add('history');
}

const runFailures = (r: RunMeta) => r.failed + r.errors;

function scanRuns(store: WorkspaceStore, s: Scan): void {
  const oldest = oldestWanted(s.q, s.now);
  for (let offset = 0; offset < SEARCH_SCAN.runs; offset += 200) {
    const page = store.meta.listRuns({ limit: 200, offset }).items;
    for (const r of page) {
      const at = Date.parse(r.startedAt);
      if (at < oldest) return;
      add(
        s,
        'runs',
        {
          text: [r.name, r.environment ?? ''],
          time: at,
          name: [r.name],
          failed: runFailures(r) > 0,
          duration: r.durationMs,
          environment: r.environment ? [r.environment] : [],
          failures: runFailures(r),
        },
        {
          id: r.id,
          title: r.name,
          subtitle: `${r.passed}/${r.total} passed${runFailures(r) ? ` · ${runFailures(r)} failed` : ''}${r.environment ? ` · ${r.environment}` : ''}`,
          at: r.startedAt,
          failed: runFailures(r) > 0,
          durationMs: r.durationMs,
          ref: { kind: 'run', runId: r.id },
        },
        at,
      );
    }
    if (page.length < 200) return;
  }
  s.capped.add('runs');
}

const failedChecks = (r: TestResult) => (r.checks ?? []).filter((c) => !c.passed);

async function scanResults(store: WorkspaceStore, s: Scan): Promise<void> {
  const { q } = s;
  const oldest = oldestWanted(q, s.now);
  const flakyIds = q.where.some((c) => c.field === 'flaky') ? new Set((await flakyTests(store, { runs: 30 })).map((f) => f.id)) : new Set<string>();
  // a run whose environment fails the query holds no match: its file is not read
  const envConditions = q.where.filter((c) => c.field === 'environment');
  let runsRead = 0;
  let seen = 0;
  for (let offset = 0; ; offset += 100) {
    const page = store.meta.listRuns({ limit: 100, offset }).items;
    for (const run of page) {
      const runAt = Date.parse(run.startedAt);
      if (runAt < oldest) return;
      const env = run.environment ? [run.environment] : [];
      if (!envConditions.every((c) => holds(c, { environment: env }, s.now))) continue;
      if (runsRead >= SEARCH_SCAN.resultRuns || seen >= SEARCH_SCAN.results) {
        s.capped.add('results');
        return;
      }
      runsRead++;
      for await (const r of await readResultsFile(join(store.runDir(run.id), 'results.jsonl'))) {
        if (++seen > SEARCH_SCAN.results) {
          s.capped.add('results');
          return;
        }
        const failed = r.status === 'failed' || r.status === 'error';
        const bad = failedChecks(r);
        const at = Date.parse(r.startedAt) || runAt;
        add(
          s,
          'results',
          {
            text: [r.name, r.file ?? '', r.error?.message ?? '', ...bad.map((c) => c.name)],
            time: at,
            name: [r.name],
            failed,
            duration: r.durationMs,
            environment: env,
            file: r.file ? [r.file] : [],
            error: [...(r.error ? [r.error.message] : []), ...bad.map((c) => c.message)],
            assertion: bad.flatMap((c) => [c.name, c.message]),
            flaky: flakyIds.has(r.id),
            attempts: r.attempts,
          },
          {
            id: `${run.id}:${r.id}`,
            title: r.name,
            subtitle: `${run.name} · ${r.status}${bad.length ? ` · ${bad.length} check${bad.length === 1 ? '' : 's'} failed` : ''}`,
            at: iso(at),
            failed,
            durationMs: r.durationMs,
            ref: { kind: 'run', runId: run.id, resultId: r.id },
          },
          at,
        );
      }
    }
    if (page.length < 100) return;
  }
}

async function scanTraces(store: WorkspaceStore, s: Scan): Promise<void> {
  const { q } = s;
  const kinds = q.where.filter((c) => c.field === 'kind' && c.op === 'eq');
  const failedOnly = q.where.some((c) => c.field === 'failed' && c.value === true);
  const oldest = oldestWanted(q, s.now);
  let loads = 0;
  for (let offset = 0; offset < SEARCH_SCAN.traces; offset += 200) {
    const page = store.meta.listTraces({ limit: 200, offset, ...(kinds.length === 1 ? { kind: String(kinds[0]!.value).toLowerCase() } : {}), ...(failedOnly ? { failed: true } : {}) }).items;
    for (const t of page) {
      if (t.startTime < oldest) return;
      const failed = t.status !== 'ok';
      await addAsync(
        s,
        'traces',
        { text: [t.name, t.kind, t.status], time: t.startTime, name: [t.name], kind: [t.kind], failed, duration: t.durationMs, spans: t.spanCount },
        {
          id: t.id,
          title: t.name,
          subtitle: `${t.kind} · ${t.status} · ${t.spanCount} span${t.spanCount === 1 ? '' : 's'}`,
          at: iso(t.startTime),
          failed,
          durationMs: t.durationMs,
          ref: { kind: 'trace', traceId: t.id },
        },
        t.startTime,
        async () => {
          if (loads >= SEARCH_SCAN.traceFiles) {
            s.capped.add('traces');
            return undefined;
          }
          loads++;
          try {
            // read without blocking the process: up to 300 files, each its own turn of the event loop
            const spans = (await store.loadTraceAsync(t.id))?.spans ?? [];
            return { span: spans.map((x) => x.name), error: spans.flatMap((x) => (x.error ? [x.error] : [])) };
          } catch {
            return undefined;
          }
        },
      );
    }
    if (page.length < 200) return;
  }
  s.capped.add('traces');
}

/** Run a query (already validated: `parseSearchQuery`) against the workspace's stores. Reads only. */
export async function runSearchQuery(store: WorkspaceStore, query: SearchQuery, o: { now?: number } = {}): Promise<SearchOutcome> {
  const started = Date.now();
  // the engine does not trust its caller: a query that was not validated is validated now
  const checked = parseSearchQuery(query);
  if (!checked.query) throw new ApsError('ValidationError', `Invalid search query: ${checked.problems.join('; ')}`, { details: { problems: checked.problems } });
  const q = checked.query;
  const s: Scan = { q, now: o.now ?? Date.now(), rows: [], perSource: {}, capped: new Set(), notes: [] };
  for (const source of q.sources) {
    if (source === 'history') scanHistory(store, s);
    else if (source === 'runs') scanRuns(store, s);
    else if (source === 'results') await scanResults(store, s);
    else await scanTraces(store, s);
  }
  const dir = q.sort.dir === 'asc' ? 1 : -1;
  const key = (r: SearchRow & { sortTime: number }) => (q.sort.by === 'duration' ? r.durationMs : r.sortTime);
  s.rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // an entry with no duration is last whichever way the list runs
    if (ka === undefined || kb === undefined) return ka === kb ? 0 : ka === undefined ? 1 : -1;
    return (ka - kb) * dir;
  });
  const matched = s.rows.length;
  for (const c of s.capped)
    s.notes.push(
      `${SOURCE_LABEL[c]}: only the newest ${c === 'history' ? SEARCH_SCAN.history : c === 'runs' ? SEARCH_SCAN.runs : c === 'traces' ? `${SEARCH_SCAN.traceFiles} traces' files (of ${SEARCH_SCAN.traces})` : `${SEARCH_SCAN.resultRuns} runs`} were searched.`,
    );
  return {
    query: q,
    rows: s.rows.slice(0, q.limit).map(({ sortTime: _t, ...row }) => row),
    matched,
    perSource: s.perSource,
    capped: [...s.capped],
    notes: s.notes,
    ms: Date.now() - started,
  };
}
