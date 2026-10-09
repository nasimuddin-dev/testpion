import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LibraryItem, RunSummary } from '../model/types.js';
import type { ExecServices } from './execute.js';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { recordRun } from './run-records.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { collectionRequests, runCollection } from './collection-run.js';
import { collectionRealtimeTests } from './collection-realtime.js';
import { readResultsFile, type RunEvent } from './runner.js';

/**
 * Monitors: a collection (or some of its folders / requests) run on a schedule, like Postman monitors.
 * Definitions are saved items of the workspace (library/monitors.json, so they're shared and exported);
 * results are local run state (runs/monitors/<id>.jsonl, never exported). Any host can run the
 * scheduler: the desktop app while it's open, `testpion monitor start` on a server, or cron with
 * `testpion monitor run --due`.
 */
export interface MonitorData {
  collectionId: string;
  /** Folder and/or request ids; empty runs the whole collection. */
  selection?: string[];
  environment?: string;
  /** Minutes between runs (1 minute to 1 week). */
  everyMinutes: number;
  enabled: boolean;
  iterations?: number;
  /** Stop a run at the first failure. */
  bail?: boolean;
  /**
   * Called when the monitor starts failing or recovers: a Slack / Teams / Discord incoming webhook or any
   * URL (POST JSON with `text`, `content` and the details). May be a {{variable}} of the environment.
   */
  webhook?: string;
  /** Fail a run whose requests' p95 response time is over this many ms (even when every check passed). */
  maxP95Ms?: number;
  /** Fail a run when the TLS certificate of a host it calls expires in fewer than this many days. */
  minCertDays?: number;
}

/** Whether a result changes the monitor's state (first failure, or passing again after failing). */
export function monitorStateChanged(result: MonitorResult, previous?: MonitorResult): boolean {
  const bad = result.status !== 'passed';
  const wasBad = previous ? previous.status !== 'passed' : false;
  return bad !== wasBad;
}

/**
 * Tell the monitor's webhook that it started failing or recovered. Never throws (a failing webhook must
 * not break the schedule); returns what happened for logs.
 */
export async function notifyMonitorWebhook(url: string, monitor: Pick<Monitor, 'id' | 'name'>, result: MonitorResult, opts: { signal?: AbortSignal } = {}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const bad = result.status !== 'passed';
  const text = bad
    ? `🔴 Monitor "${monitor.name}" ${result.status === 'error' ? `could not run: ${result.error ?? 'error'}` : result.reason && !(result.failed + result.errors) ? (result.reason.startsWith('p95') ? 'is too slow' : 'needs attention') : `failed: ${result.failed + result.errors} of ${result.total} requests`}`
    : `🟢 Monitor "${monitor.name}" passes again (${result.passed} of ${result.total} requests)`;
  const why = bad && result.reason ? ` (${result.reason})` : '';
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('the webhook must be an http(s) URL');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Slack and Teams show `text`, Discord shows `content`; the rest is for any other receiver
      body: JSON.stringify({ text: text + why, content: text + why, reason: result.reason, p95Ms: result.p95Ms, monitor: { id: monitor.id, name: monitor.name }, status: result.status, total: result.total, passed: result.passed, failed: result.failed, errors: result.errors, p50Ms: result.p50Ms, startedAt: result.startedAt, runId: result.runId, error: result.error }),
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface Monitor extends MonitorData {
  id: string;
  name: string;
  folder?: string;
}

export interface MonitorResult {
  monitorId: string;
  runId: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'error';
  total: number;
  passed: number;
  failed: number;
  errors: number;
  /** Median response time of the run's requests. */
  p50Ms?: number;
  /** 95th percentile response time of the run's requests. */
  p95Ms?: number;
  /** Days left on the certificate that expires first among the run's HTTPS hosts (monitors with a certificate warning). */
  certDaysLeft?: number;
  /** Why a run whose checks passed still failed (e.g. too slow). */
  reason?: string;
  /** Why the run could not run (status "error"). */
  error?: string;
  /** What started it. */
  trigger: 'schedule' | 'manual';
}

/** A problem with a monitor definition; the message says what to change (no response-oriented hints). */
const invalid = (message: string) => new ApsError('ValidationError', message, { suggestions: [] });

export const MONITORS_LIBRARY = 'monitors';
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
const KEEP_RESULTS = 500;

/** Parse "5m", "1h", "30", "1d" (minutes when there's no unit). */
export function parseEvery(text: string | number): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?)?\s*$/i.exec(String(text));
  if (!m) throw invalid(`"${text}" is not an interval: use minutes, or a number with m, h or d (e.g. 15m, 1h, 1d)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm')[0]!.toLowerCase();
  const minutes = Math.round(unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n);
  if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) throw invalid('A monitor runs every 1 minute to 7 days');
  return minutes;
}

export function formatEvery(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'daily' : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'hourly' : `every ${minutes / 60} hours`;
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

export function listMonitors(store: WorkspaceStore): Monitor[] {
  return store.getLibrary<MonitorData>(MONITORS_LIBRARY).items.map((i) => ({ ...i.data, id: i.id, name: i.name, folder: i.folder }));
}

export function findMonitor(store: WorkspaceStore, ref: string): Monitor {
  const all = listMonitors(store);
  const r = ref.toLowerCase();
  const m = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === r);
  if (!m) throw invalid(`No monitor "${ref}". Monitors: ${all.map((x) => x.name).join(', ') || 'none'}`);
  return m;
}

/** Check a monitor definition against the workspace (collection, selection, environment, interval). */
export function validateMonitor(store: WorkspaceStore, m: Pick<Monitor, 'name'> & MonitorData): void {
  if (!m.name?.trim()) throw invalid('A monitor needs a name');
  if (!(m.everyMinutes >= MIN_EVERY_MINUTES && m.everyMinutes <= MAX_EVERY_MINUTES)) throw invalid('A monitor runs every 1 minute to 7 days');
  const collection = store.getCollection(m.collectionId);
  if (!collectionRequests(collection, m.selection).length && !collectionRealtimeTests(store, collection, m.selection).length) throw invalid(`Nothing to run: the selection has no requests in "${collection.name}"`);
  if (m.environment && !store.getEnvironment(m.environment)) throw invalid(`No environment "${m.environment}"`);
  if (m.webhook && !/^https?:\/\//i.test(m.webhook.trim()) && !/^\{\{[^}]+\}\}/.test(m.webhook.trim())) throw invalid('The alert webhook must be an http(s) URL or a {{variable}}');
  if (m.maxP95Ms !== undefined && !(m.maxP95Ms > 0)) throw invalid('The response time limit must be a positive number of milliseconds');
  if (m.minCertDays !== undefined && !(Number.isInteger(m.minCertDays) && m.minCertDays >= 1 && m.minCertDays <= 365)) throw invalid('The certificate warning must be 1 to 365 days');
}

/** Add or replace a monitor (by id). */
export function saveMonitor(store: WorkspaceStore, m: Monitor): Monitor {
  validateMonitor(store, m);
  const lib = store.getLibrary<MonitorData>(MONITORS_LIBRARY);
  const { id, name, folder, ...data } = m;
  const item: LibraryItem<MonitorData> = { id, name: name.trim(), folder, data, updatedAt: new Date().toISOString() };
  const items = lib.items.some((i) => i.id === id) ? lib.items.map((i) => (i.id === id ? item : i)) : [...lib.items, item];
  store.saveLibrary(MONITORS_LIBRARY, { folders: lib.folders, items });
  return m;
}

export function deleteMonitor(store: WorkspaceStore, id: string): void {
  const lib = store.getLibrary<MonitorData>(MONITORS_LIBRARY);
  store.saveLibrary(MONITORS_LIBRARY, { folders: lib.folders, items: lib.items.filter((i) => i.id !== id) });
}

const resultsFile = (store: WorkspaceStore, id: string) => store.path('runs', 'monitors', `${id.replace(/[^\w.-]/g, '_')}.jsonl`);

/** Results of a monitor, newest first. */
export function monitorResults(store: WorkspaceStore, id: string, limit = 50): MonitorResult[] {
  const f = resultsFile(store, id);
  if (!existsSync(f)) return [];
  // newest are last: parse from the end and stop at the limit (lists ask for one or a few)
  const lines = readFileSync(f, 'utf8').split('\n');
  const out: MonitorResult[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]!.trim()) continue;
    try {
      out.push(JSON.parse(lines[i]!) as MonitorResult);
    } catch {
      /* a partly written last line */
    }
  }
  return out;
}

/** One day of a monitor's runs (see monitorDaily). */
export interface MonitorDay {
  /** The day, YYYY-MM-DD. */
  date: string;
  runs: number;
  passed: number;
  /** Share of the day's runs that passed, 0-100 with one decimal (absent when nothing ran). */
  uptime?: number;
  /** The slowest p95 response time of the day's runs. */
  maxP95Ms?: number;
}

/**
 * Uptime per day over the last `days` days (oldest first, today last), like a status page. Days without runs are
 * included with `runs: 0`. Days follow the caller's calendar: `tzOffsetMin` is its Date#getTimezoneOffset (default:
 * this machine's zone), so a browser elsewhere sees its own days.
 */
export function monitorDaily(store: WorkspaceStore, id: string, days = 30, tzOffsetMin?: number, now = Date.now()): MonitorDay[] {
  const n = Math.min(Math.max(Math.floor(days) || 30, 1), 366);
  const offset = -(tzOffsetMin ?? new Date(now).getTimezoneOffset()) * 60_000;
  const key = (t: number) => new Date(t + offset).toISOString().slice(0, 10);
  const out: MonitorDay[] = [];
  const at = new Map<string, MonitorDay>();
  for (let i = n - 1; i >= 0; i--) {
    const d: MonitorDay = { date: key(now - i * 864e5), runs: 0, passed: 0 };
    if (!at.has(d.date)) (at.set(d.date, d), out.push(d));
  }
  for (const r of monitorResults(store, id, KEEP_RESULTS * 2)) {
    const d = at.get(key(Date.parse(r.startedAt)));
    if (!d) continue;
    d.runs++;
    if (r.status === 'passed') d.passed++;
    if (r.p95Ms !== undefined) d.maxP95Ms = Math.max(d.maxP95Ms ?? 0, r.p95Ms);
  }
  for (const d of out) if (d.runs) d.uptime = Math.round((d.passed / d.runs) * 1000) / 10;
  return out;
}

export function lastMonitorResult(store: WorkspaceStore, id: string): MonitorResult | undefined {
  return monitorResults(store, id, 1)[0];
}

function recordResult(store: WorkspaceStore, r: MonitorResult): void {
  const f = resultsFile(store, r.monitorId);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(r) + '\n');
  // keep the file bounded: rewrite the newest results when it grows past twice the limit
  const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length > KEEP_RESULTS * 2) writeFileSync(f, lines.slice(-KEEP_RESULTS).join('\n') + '\n');
}

/** When a monitor should run next: `everyMinutes` after its last run, or now if it never ran. */
export function nextRunAt(m: Monitor, last: MonitorResult | undefined, now = Date.now()): number {
  if (!last) return now;
  return Date.parse(last.startedAt) + m.everyMinutes * 60_000;
}

export function isDue(m: Monitor, last: MonitorResult | undefined, now = Date.now()): boolean {
  return m.enabled && nextRunAt(m, last, now) <= now;
}

/** A monitor with its schedule text, last result and next run (what list commands and MCP show). */
export function monitorStatus(store: WorkspaceStore, m: Monitor, now = Date.now()) {
  const last = lastMonitorResult(store, m.id);
  return {
    ...m,
    schedule: m.enabled ? formatEvery(m.everyMinutes) : 'paused',
    lastResult: last,
    nextRunAt: m.enabled ? new Date(Math.max(nextRunAt(m, last, now), now)).toISOString() : undefined,
    due: isDue(m, last, now),
  };
}

export interface ExecuteMonitorOptions {
  store: WorkspaceStore;
  monitor: Monitor;
  /** Engine services for the monitor's environment and collection (the host creates them, e.g. createEngineContext). */
  context(opts: { environment?: string; collectionId: string }): { services: ExecServices; dispose(): Promise<void> };
  trigger?: MonitorResult['trigger'];
  signal?: AbortSignal;
  onEvent?(e: RunEvent): void;
  onTrace?(trace: Parameters<WorkspaceStore['saveTrace']>[0], runId: string): void;
}

/**
 * Run a monitor once: the collection run is saved like any run (Runs list, reports), and a compact result
 * is appended to the monitor's results. A run that can't start (missing collection …) is recorded as
 * status "error" instead of throwing, so a scheduler keeps going.
 */
export async function executeMonitor(o: ExecuteMonitorOptions): Promise<MonitorResult> {
  const { store, monitor } = o;
  const runId = shortId('run-');
  const startedAt = new Date().toISOString();
  const base = { monitorId: monitor.id, runId, startedAt, trigger: o.trigger ?? 'manual' } as const;
  let summary: RunSummary;
  try {
    const collection = store.getCollection(monitor.collectionId);
    const dir = store.runDir(runId);
    mkdirSync(dir, { recursive: true });
    const ctx = o.context({ environment: monitor.environment, collectionId: collection.id });
    try {
      summary = await runCollection({
        name: `Monitor · ${monitor.name}`,
        runId,
        collection,
        selection: monitor.selection,
        realtime: collectionRealtimeTests(store, collection, monitor.selection),
        iterations: monitor.iterations,
        bail: monitor.bail,
        services: ctx.services,
        signal: o.signal,
        resultsFile: join(dir, 'results.jsonl'),
        traceMode: 'failures',
        onTrace: (t) => (o.onTrace ? o.onTrace(t, runId) : void store.saveTrace(t, 'test', runId)),
        traceBatch: o.onTrace ? undefined : (fn) => store.meta.batch(fn),
        environment: monitor.environment,
        onEvent: o.onEvent,
      });
    } finally {
      await ctx.dispose();
    }
    await recordRun(store, summary, dir, { reports: ['json', 'html'] });
  } catch (e) {
    const r: MonitorResult = { ...base, durationMs: Date.now() - Date.parse(startedAt), status: 'error', total: 0, passed: 0, failed: 0, errors: 0, error: e instanceof Error ? e.message : String(e) };
    recordResult(store, r);
    return r;
  }
  const p95 = summary.latency?.p95;
  // too slow: the checks passed, but the p95 response time is over the monitor's limit
  const slow = monitor.maxP95Ms !== undefined && summary.total > 0 && p95 !== undefined && p95 > monitor.maxP95Ms;
  // the certificate of a host it calls expires sooner than the monitor allows
  const cert = monitor.minCertDays !== undefined ? await soonestCertificate(join(store.runDir(runId), 'results.jsonl')) : undefined;
  const certSoon = !!cert && cert.daysLeft < monitor.minCertDays!;
  const reasons = [
    slow ? `p95 ${Math.round(p95!)} ms is over the ${monitor.maxP95Ms} ms limit` : '',
    certSoon ? (cert!.daysLeft < 0 ? `the certificate of ${cert!.host} has expired` : `the certificate of ${cert!.host} expires in ${cert!.daysLeft} day${cert!.daysLeft === 1 ? '' : 's'} (warning at ${monitor.minCertDays})`) : '',
  ].filter(Boolean);
  const r: MonitorResult = {
    ...base,
    durationMs: summary.durationMs,
    status: summary.failed || summary.errors || summary.cancelled || slow || certSoon ? 'failed' : 'passed',
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    errors: summary.errors,
    p50Ms: summary.latency?.p50,
    p95Ms: p95,
    ...(cert ? { certDaysLeft: cert.daysLeft } : {}),
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
  recordResult(store, r);
  return r;
}

/** The certificate that expires first among the HTTPS requests of a run (from each result's timing). */
async function soonestCertificate(file: string): Promise<{ host: string; daysLeft: number } | undefined> {
  let best: { host: string; daysLeft: number } | undefined;
  for await (const r of await readResultsFile(file)) {
    const m = r.metadata as { url?: string; timing?: { certificateDaysLeft?: number } } | undefined;
    const d = m?.timing?.certificateDaysLeft;
    if (d === undefined || (best && best.daysLeft <= d)) continue;
    let host = '?';
    try {
      host = new URL(m!.url!).host;
    } catch {
      /* keep ? */
    }
    best = { host, daysLeft: d };
  }
  return best;
}

export interface MonitorSchedulerOptions {
  /** Resolve {{variables}} in a monitor's webhook URL (with its environment). */
  resolve?: (m: Monitor, text: string) => string;
  /** After a webhook call (for logs). */
  onWebhook?: (m: Monitor, r: { ok: boolean; status?: number; error?: string }) => void;
  /** Current monitors (read on every tick, so edits apply without a restart). */
  list(): Monitor[];
  last(id: string): MonitorResult | undefined;
  run(m: Monitor): Promise<MonitorResult>;
  onResult?(m: Monitor, r: MonitorResult, previous: MonitorResult | undefined): void;
  onError?(m: Monitor, e: unknown): void;
  /** How often to look for due monitors. Default 30 s. */
  tickMs?: number;
}

/** Runs due monitors one at a time; a monitor never overlaps itself. Host-agnostic (timers only). */
export class MonitorScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(private readonly o: MonitorSchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 30_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return !!this.timer;
  }

  /** Run every monitor that is due now; returns how many ran. */
  async tick(now = Date.now()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let ran = 0;
    try {
      let monitors: Monitor[] = [];
      try {
        monitors = this.o.list();
      } catch {
        return 0;
      }
      for (const m of monitors) {
        const previous = this.o.last(m.id);
        if (!isDue(m, previous, now)) continue;
        try {
          const r = await this.o.run(m);
          ran++;
          this.o.onResult?.(m, r, previous);
          if (m.webhook && monitorStateChanged(r, previous)) {
            const url = this.o.resolve ? this.o.resolve(m, m.webhook) : m.webhook;
            const sent = await notifyMonitorWebhook(url, m, r);
            this.o.onWebhook?.(m, sent);
          }
        } catch (e) {
          this.o.onError?.(m, e);
        }
      }
    } finally {
      this.busy = false;
    }
    return ran;
  }
}
