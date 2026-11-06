import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { cronProblem, describeCron, environmentLabel, environmentRef, environmentsOfGroup, matchEnvironment, nextCronTime, parseCron } from '@testpion/shared';
import { ownershipOf } from '../git/owners.js';
import { atomicWrite } from '../storage/fsutil.js';
import { appendBoundedLine } from '../util/jsonl-append.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { LibraryItem, RunSummary } from '../model/types.js';
import type { ExecServices } from './execute.js';
import { ApsError } from '../errors.js';
import { assertUrlAllowed } from '../net/policy.js';
import { allowProductionFor, productionAllowed } from '../net/production-guard.js';
import { shortId } from '../util/ids.js';
import { recordRun } from './run-records.js';
import { MONITOR_RUN_PREFIX } from './result-source.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { collectionRequests, runCollection } from './collection-run.js';
import { collectionRealtimeTests } from './collection-realtime.js';
import { readResultsFile, runTests, type RunEvent } from './runner.js';
import { isSuiteFile, loadSuite, loadTestsFromFile, streamTests } from './loader.js';
import { findSavedEvaluation } from './saved-evaluations.js';
import { runMonitorEvaluation, type MonitorRagInfo } from './monitor-rag.js';
import { runMonitorPromptEvaluation } from './monitor-prompt.js';
import { resolveMetric } from '../eval/rag/metric-registry.js';
import { netFetch } from '../net/proxy.js';
import { prefetchEnvironmentSecrets } from '../vars/external-secrets.js';
import { quietProblem, quietText, quietUntil, type QuietWindow } from './monitor-quiet.js';

/**
 * Monitors: a collection (or some of its folders / requests) run on a schedule, like Postman monitors.
 * Definitions are saved items of the workspace (library/monitors.json, so they're shared and exported);
 * results are local run state (runs/monitors/<id>.jsonl, never exported). Any host can run the
 * scheduler: the desktop app while it's open, `testpion monitor start` on a server, or cron with
 * `testpion monitor run --due`.
 */
interface MonitorData {
  /** The collection it runs (or `testFile`: exactly one of the two). */
  collectionId?: string;
  /** Folder and/or request ids; empty runs the whole collection. */
  selection?: string[];
  /** A test file or flow (or a suite) under tests/, e.g. orders/new-order.yaml, run with the test runner instead of a collection. */
  testFile?: string;
  /**
   * Or a saved RAG evaluation: its questions go to the RAG system and are scored. The run fails when a gate fails (the
   * mean of a metric below its minimum), or, without gates, when a sample fails; the reason names the metric
   * ("faithfulness mean 0.78 < 0.8").
   */
  evaluation?: string;
  /** With an evaluation: only the first n dataset records. */
  limit?: number;
  /** With an evaluation: metric name → the lowest mean it may have (the same names as `testpion rag run --min`). */
  gates?: Record<string, number>;
  /** With an evaluation: the share (0 to 1) of samples that get the judged metrics; the free metrics always run. */
  judgeSample?: number;
  /** With an evaluation: stop judging for the day at this much (USD, from the AI usage ledger); the rest is n/a. */
  judgeBudgetUsdPerDay?: number;
  /** With an evaluation: score `limit` records chosen by the UTC date, so a month of nightly runs covers the dataset (a night can be reproduced from its date). */
  rotate?: boolean;
  /** With an evaluation: stop judging in one run at this much (USD); the rest is n/a ("budget"), not a failed gate. */
  maxCostUsd?: number;
  /** With an evaluation: fail when a metric dropped against this run: `previous` (the last run of this monitor), `best` (of the last 30), or a run id. */
  baseline?: string;
  /** With a baseline: the smallest drop that fails (default 0.05), judged by the paired comparison. */
  maxDrop?: number;
  environment?: string;
  /**
   * Every environment of this group (a tenant each: Acme ▸ Staging, Acme ▸ Production) instead of one `environment`: the
   * list, the scheduler and the status page see one monitor per environment (id `<id>@<environmentId>`, name
   * "Checkout · Acme ▸ Staging"), each with its own results and schedule, from this one definition.
   */
  environmentGroup?: string;
  /** Minutes between runs (1 minute to 1 week). With `cron`, not used (kept for older versions). */
  everyMinutes: number;
  /**
   * At set times instead of every N minutes: a cron expression in the local time of the computer that runs it
   * ("0 9 * * 1-5": 09:00 on weekdays). A run missed while nothing ran the schedule runs once when it starts again.
   */
  cron?: string;
  /** A maintenance window that comes back (monitor-quiet.ts): no scheduled run inside it. */
  quiet?: QuietWindow;
  enabled: boolean;
  /** Paused for a while (a deploy, a maintenance window): no run until this time (ISO), then the schedule goes on by itself. */
  pausedUntil?: string;
  /** Why it waits, shown with the monitor while it does. */
  pauseReason?: string;
  iterations?: number;
  /** Stop a run at the first failure. */
  bail?: boolean;
  /**
   * Called when the monitor starts failing or recovers: a Slack / Teams / Discord incoming webhook or any
   * URL (POST JSON with `text`, `content` and the details). May be a {{variable}} of the environment.
   */
  webhook?: string;
  /** Post the alert only at this many failures in a row (1, the default: at the first); recovery is told when an alert went out. A blip stays quiet. */
  alertAfter?: number;
  /** Fail a run whose requests' p95 response time is over this many ms (even when every check passed). */
  maxP95Ms?: number;
  /** Fail a run when the TLS certificate of a host it calls expires in fewer than this many days. */
  minCertDays?: number;
  /**
   * Its environment is marked as production and the person allowed data-changing requests there when saving it (the
   * app asked; the CLI took --allow-production). Hosts derive it when saving, never from what a caller sends.
   */
  allowProduction?: boolean;
  /** On a grouped definition: the production environments (ids) of its group that this consent was given for, one by one. */
  allowProductionFor?: string[];
  /** On a grouped definition: the tenants (environment ids) that wait on their own, until a time or until resumed. */
  pausedTenants?: Record<string, { until?: string; reason?: string }>;
}

/** Whether a result changes the monitor's state (first failure, or passing again after failing). */
export function monitorStateChanged(result: MonitorResult, previous?: MonitorResult): boolean {
  const bad = result.status !== 'passed';
  const wasBad = previous ? previous.status !== 'passed' : false;
  return bad !== wasBad;
}

/** How many failures in a row a monitor waits for before it alerts (1 to 10; 1 when unset). */
export const alertAfterOf = (m: Pick<Monitor, 'alertAfter'>): number => Math.min(10, Math.max(1, Math.floor(m.alertAfter ?? 1) || 1));

/**
 * Whether this result is the moment to alert: `failing` at the run that makes `alertAfter` failures in a row (a shorter streak
 * stays quiet), `recovered` at the first pass after such a streak (a pass after a shorter one told nobody, so says nothing).
 * `recent` is the results before this one, newest first (at least `alertAfter` of them to decide).
 */
export function monitorAlert(m: Pick<Monitor, 'alertAfter'>, result: MonitorResult, recent: MonitorResult[]): 'failing' | 'recovered' | undefined {
  const n = alertAfterOf(m);
  let streak = 0;
  for (const r of recent) {
    if (r.status === 'passed') break;
    streak++;
  }
  if (result.status !== 'passed') return streak + 1 === n ? 'failing' : undefined;
  return streak >= n ? 'recovered' : undefined;
}

/** The owners (CODEOWNERS) of what a monitor runs: its collection's file or its test file; none without CODEOWNERS. */
export async function monitorOwners(store: WorkspaceStore, m: Monitor): Promise<string[]> {
  try {
    const file = m.testFile ? `tests/${m.testFile}` : m.collectionId ? store.collectionFileOf(m.collectionId) : undefined;
    return file ? (await ownershipOf(store.root, file)).owners : [];
  } catch {
    return [];
  }
}

/** The metric means, the sample and the regressions of a RAG monitor run, as lines under the alert's text. */
function ragLines(r: MonitorResult): string {
  if (!r.rag) return '';
  const x = r.rag;
  const lines = [x.sample ? `Sample: ${x.sample}` : '', x.means.length ? `Metrics: ${x.means.join('; ')}` : '', x.regressions?.length ? `Regressions: ${x.regressions.join('; ')}` : '', x.budget ?? '', x.judgeCostUsd ? `Judging cost: $${x.judgeCostUsd.toFixed(4)}` : ''].filter(Boolean);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/**
 * Tell the monitor's webhook that it started failing or recovered. Never throws (a failing webhook must
 * not break the schedule); returns what happened for logs.
 */
export async function notifyMonitorWebhook(url: string, monitor: Pick<Monitor, 'id' | 'name'> & { owners?: string[] }, result: MonitorResult, opts: { signal?: AbortSignal } = {}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const bad = result.status !== 'passed';
  // several teams: the owners of what the monitor runs (CODEOWNERS) come first, so a shared channel pages the right people
  const who = monitor.owners?.length ? `${monitor.owners.join(' ')} ` : '';
  const text = who + (bad
    ? `🔴 Monitor "${monitor.name}" ${result.status === 'error' ? `could not run: ${result.error ?? 'error'}` : result.reason && !(result.failed + result.errors) ? (result.reason.startsWith('p95') ? 'is too slow' : 'needs attention') : `failed: ${result.failed + result.errors} of ${result.total} requests`}`
    : `🟢 Monitor "${monitor.name}" passes again (${result.passed} of ${result.total} requests)`);
  const why = bad && result.reason ? ` (${result.reason})` : '';
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('the webhook must be an http(s) URL');
    await assertUrlAllowed(url); // a server must not let a webhook reach its internal network (169.254.169.254 …)
    const res = await netFetch(url, {
      method: 'POST',
      redirect: 'error', // a redirect would leave the address that was checked
      headers: { 'content-type': 'application/json' },
      // Slack and Teams show `text`, Discord shows `content`; the rest is for any other receiver
      body: JSON.stringify({ text: text + why + ragLines(result), content: text + why + ragLines(result), rag: result.rag, reason: result.reason, p95Ms: result.p95Ms, monitor: { id: monitor.id, name: monitor.name }, status: result.status, total: result.total, passed: result.passed, failed: result.failed, errors: result.errors, p50Ms: result.p50Ms, startedAt: result.startedAt, runId: result.runId, error: result.error }),
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
  /** On a monitor made from a grouped definition: which definition and which environment (listMonitors). */
  tenant?: { of: string; environment: string; environmentId?: string };
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
  /** A RAG evaluation: the sample, the budget, the cost, the baseline and the metric means (what the alert quotes). */
  rag?: MonitorRagInfo;
  /** What started it. */
  trigger: 'schedule' | 'manual';
}

/** A problem with a monitor definition; the message says what to change (no response-oriented hints). */
const invalid = (message: string) => new ApsError('ValidationError', message, { suggestions: [] });

const MONITORS_LIBRARY = 'monitors';
const MIN_EVERY_MINUTES = 1;
const MAX_EVERY_MINUTES = 7 * 24 * 60;
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

/**
 * How often, as `--every` / `every` take it: an interval (15m, 1h, 1d, minutes) or a cron schedule at set times
 * ("0 9 * * 1-5", "@daily"), in the local time of the computer that runs it.
 */
export function parseSchedule(text: string | number): Pick<Monitor, 'everyMinutes' | 'cron'> {
  const t = String(text).trim();
  if (/^@\w+$/.test(t) || t.split(/\s+/).length === 5) {
    const problem = cronProblem(t);
    if (problem) throw invalid(`The schedule "${t}": ${problem}`);
    return { everyMinutes: 60, cron: t };
  }
  return { everyMinutes: parseEvery(t) };
}

export function formatEvery(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'daily' : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'hourly' : `every ${minutes / 60} hours`;
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

/** The definitions as saved: a grouped one (`environmentGroup`) is one item here and several monitors in listMonitors. */
export function listMonitorDefinitions(store: WorkspaceStore): Monitor[] {
  return store.getLibrary<MonitorData>(MONITORS_LIBRARY).items.map((i) => ({ ...i.data, id: i.id, name: i.name, folder: i.folder }));
}

const TENANT_SEP = '@';

/** The monitors a definition stands for: itself, or one per environment of its group (a tenant each); none when the group is empty. */
export function monitorTenants(store: WorkspaceStore, m: Monitor): Monitor[] {
  if (!m.environmentGroup || m.tenant) return [m];
  const envs = store.listEnvironments().filter((e) => !e.problem);
  // each tenant by its environment's id: two tenants may both have a "Staging", and a bare name would then name neither
  return environmentsOfGroup(envs, m.environmentGroup).map((e) => ({
    ...m,
    id: `${m.id}${TENANT_SEP}${e.id}`,
    name: `${m.name} · ${environmentLabel(e)}`,
    environment: environmentRef(envs, e),
    tenant: { of: m.id, environment: environmentRef(envs, e), environmentId: e.id },
    // a pause of this tenant alone (see pauseMonitor)
    ...tenantPause(m, e.id),
    // consent given for this environment alone (see saveMonitor)
    allowProduction: !!m.allowProduction || !!m.allowProductionFor?.includes(e.id),
  }));
}

/** A tenant's own pause over its definition's: the later time wins; a definition that is off stays off. */
function tenantPause(m: Monitor, envId: string): Partial<Pick<Monitor, 'enabled' | 'pausedUntil' | 'pauseReason'>> {
  const own = m.pausedTenants?.[envId];
  if (!own || !m.enabled) return {};
  if (!own.until) return { enabled: false, pausedUntil: undefined, pauseReason: own.reason };
  return m.pausedUntil && Date.parse(m.pausedUntil) >= Date.parse(own.until) ? {} : { pausedUntil: own.until, pauseReason: own.reason };
}

/** Every monitor that runs: a grouped definition appears once per environment of its group (see monitorTenants). */
export function listMonitors(store: WorkspaceStore): Monitor[] {
  return listMonitorDefinitions(store).flatMap((m) => monitorTenants(store, m));
}

/** By id or name: a tenant's (`<id>@<environmentId>`, "Checkout · Acme ▸ Staging") or a definition's (then grouped: see monitorTenants). */
export function findMonitor(store: WorkspaceStore, ref: string): Monitor {
  const defs = listMonitorDefinitions(store);
  const all = defs.flatMap((m) => (m.environmentGroup ? monitorTenants(store, m) : []));
  const r = ref.toLowerCase();
  const m = all.find((x) => x.id === ref) ?? defs.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === r) ?? defs.find((x) => x.name.toLowerCase() === r);
  if (!m) throw invalid(`No monitor "${ref}". Monitors: ${defs.map((x) => x.name).join(', ') || 'none'}`);
  return m;
}

/** Check a monitor definition against the workspace (collection, selection, environment, interval). */
export function validateMonitor(store: WorkspaceStore, m: Pick<Monitor, 'name'> & MonitorData): void {
  if (!m.name?.trim()) throw invalid('A monitor needs a name');
  if (m.quiet !== undefined) {
    const problem = quietProblem(m.quiet);
    if (problem) throw invalid(problem);
    if (!nextCronTime(m.quiet.cron, Date.now())) throw invalid(`The maintenance window "${m.quiet.cron}" never comes (no such date)`);
  }
  if (m.cron !== undefined) {
    const problem = cronProblem(m.cron);
    if (problem) throw invalid(`The schedule "${m.cron}": ${problem}`);
    // 31 February: a schedule that never comes is refused, not saved as a monitor that never runs
    if (!nextCronTime(m.cron, Date.now())) throw invalid(`The schedule "${m.cron}" never comes (no such date)`);
  } else if (!(m.everyMinutes >= MIN_EVERY_MINUTES && m.everyMinutes <= MAX_EVERY_MINUTES)) throw invalid('A monitor runs every 1 minute to 7 days');
  const file = m.testFile?.trim();
  const targets = [file, m.collectionId, m.evaluation?.trim()].filter(Boolean).length;
  if (targets > 1) throw invalid('A monitor runs one of a collection, a test file or a RAG evaluation, not both: clear the others');
  if (!targets) throw invalid('A monitor needs what to run: a collection, a test file under tests/, or a saved RAG evaluation');
  if (m.evaluation?.trim()) {
    const ev = findSavedEvaluation(store, m.evaluation.trim());
    if (m.selection?.length) throw invalid('Folders and requests are picked in a collection; an evaluation runs as a whole');
    if (ev.type !== 'rag') {
      // a prompt or agent evaluation: cases pass or fail; what is judged by a sample, a budget or metric gates belongs to a bot with sources
      const ragOnly = (['gates', 'judgeSample', 'judgeBudgetUsdPerDay', 'rotate', 'maxCostUsd'] as const).filter((k) => m[k] !== undefined && !(k === 'gates' && !Object.keys(m.gates ?? {}).length));
      if (ragOnly.length) throw invalid(`${ragOnly.join(', ')} ${ragOnly.length === 1 ? 'is' : 'are'} for a bot with sources: "${ev.name}" is a prompt or agent evaluation`);
      if (m.limit !== undefined && !(Number.isInteger(m.limit) && m.limit >= 1)) throw invalid('The limit is a number of cases (1 or more)');
      if (m.maxDrop !== undefined && !(m.maxDrop > 0 && m.maxDrop <= 1)) throw invalid('The largest drop allowed is more than 0 and at most 1 (0.1 fails a pass rate that fell by 10 points)');
      if (m.baseline !== undefined && m.baseline !== 'previous') throw invalid('A prompt or agent evaluation can be compared with the previous run only (baseline: previous)');
      return;
    }
    if (m.judgeSample !== undefined && !(m.judgeSample > 0 && m.judgeSample <= 1)) throw invalid('The judged share is more than 0 and at most 1 (0.2 judges one sample in five)');
    if (m.judgeBudgetUsdPerDay !== undefined && !(m.judgeBudgetUsdPerDay >= 0)) throw invalid('The daily judge budget is an amount in USD (0 or more)');
    if (m.limit !== undefined && !(Number.isInteger(m.limit) && m.limit >= 1)) throw invalid('The limit is a number of records (1 or more)');
    if (m.rotate && m.limit === undefined) throw invalid('A rotating sample needs the number of records to score each run (the limit)');
    if (m.maxCostUsd !== undefined && !(m.maxCostUsd >= 0)) throw invalid('The cost limit of a run is an amount in USD (0 or more)');
    if (m.maxDrop !== undefined && !(m.maxDrop > 0 && m.maxDrop <= 1)) throw invalid('The largest drop allowed is more than 0 and at most 1 (0.05 fails a metric that fell by 5 points)');
    if (m.baseline !== undefined && !m.baseline.trim()) throw invalid('The baseline is previous, best or a run id');
    for (const k of Object.keys(m.gates ?? {})) if (!resolveMetric(k)) throw invalid(`"${k}" is not a metric name (testpion rag metrics lists them)`);
  } else if (file) {
    if (m.selection?.length) throw invalid('Folders and requests are picked in a collection; a test file runs as a whole');
    monitorTestPath(store, file);
  } else {
    const collection = store.getCollection(m.collectionId!);
    if (!collectionRequests(collection, m.selection).length && !collectionRealtimeTests(store, collection, m.selection).length) throw invalid(`Nothing to run: the selection has no requests in "${collection.name}"`);
  }
  if (m.environment && !store.getEnvironment(m.environment)) throw invalid(`No environment "${m.environment}"`);
  if (m.environmentGroup && !environmentsOfGroup(store.listEnvironments(), m.environmentGroup).length) throw invalid(`No environment is in the group "${m.environmentGroup}"`);
  if (m.webhook && !/^https?:\/\//i.test(m.webhook.trim()) && !/^\{\{[^}]+\}\}/.test(m.webhook.trim())) throw invalid('The alert webhook must be an http(s) URL or a {{variable}}');
  if (m.maxP95Ms !== undefined && !(m.maxP95Ms > 0)) throw invalid('The response time limit must be a positive number of milliseconds');
  if (m.minCertDays !== undefined && !(Number.isInteger(m.minCertDays) && m.minCertDays >= 1 && m.minCertDays <= 365)) throw invalid('The certificate warning must be 1 to 365 days');
}

/** The test file a monitor runs, inside tests/ with forward slashes (no tests/ prefix). */
export function monitorTestFile(file: string): string {
  return file.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^tests\//, '');
}

/** The absolute path of a monitor's test file; throws when it is outside tests/ or missing. */
function monitorTestPath(store: WorkspaceStore, file: string): string {
  const rel = monitorTestFile(file);
  if (!/\.(ya?ml|json)$/i.test(rel)) throw invalid(`"${file}" is not a test file (.yaml, .yml or .json under tests/)`);
  let abs: string;
  try {
    abs = store.safePath(rel, store.path('tests'));
  } catch {
    throw invalid(`"${file}" is outside tests/`);
  }
  if (!existsSync(abs)) throw invalid(`No test file tests/${rel}`);
  return abs;
}

/**
 * The production consent a monitor is saved with. `given`: the person just allowed it (the app asked, the CLI took
 * --allow-production). Otherwise the consent given before stays for the same production environment, and nothing else:
 * one environment (`allowProduction`), or, for a grouped definition, each production environment of the group by id
 * (`allowProductionFor`), so consent for one tenant's production never covers another's.
 */
export function monitorConsent(store: WorkspaceStore, m: Pick<Monitor, 'environment' | 'environmentGroup'>, before: Monitor | undefined, given: boolean): Pick<Monitor, 'allowProduction' | 'allowProductionFor'> {
  const envs = store.listEnvironments().filter((e) => !e.problem);
  if (m.environmentGroup?.trim()) {
    const production = environmentsOfGroup(envs, m.environmentGroup).filter((e) => e.isProduction).map((e) => e.id);
    const kept = before?.environmentGroup?.trim().toLowerCase() === m.environmentGroup.trim().toLowerCase() ? (before.allowProductionFor ?? []) : [];
    const ids = given ? production : production.filter((id) => kept.includes(id));
    return { allowProduction: undefined, allowProductionFor: ids.length ? ids : undefined };
  }
  const env = m.environment ? matchEnvironment(envs, m.environment) : undefined;
  const same = !!before?.allowProduction && !before.environmentGroup && !!before.environment && matchEnvironment(envs, before.environment)?.id === env?.id;
  return { allowProduction: (!!env?.isProduction && (given || same)) || undefined, allowProductionFor: undefined };
}

/** The production environments a monitor would run in that have no consent yet (what a host asks about before saving it). */
export function monitorConsentPending(store: WorkspaceStore, m: Pick<Monitor, 'environment' | 'environmentGroup'>, before: Monitor | undefined): string[] {
  const envs = store.listEnvironments().filter((e) => !e.problem);
  const kept = monitorConsent(store, m, before, false);
  if (m.environmentGroup?.trim()) return environmentsOfGroup(envs, m.environmentGroup).filter((e) => e.isProduction && !kept.allowProductionFor?.includes(e.id)).map((e) => environmentRef(envs, e));
  const env = m.environment ? matchEnvironment(envs, m.environment) : undefined;
  return env?.isProduction && !kept.allowProduction ? [environmentRef(envs, env)] : [];
}

/** Add or replace a monitor (by id). */
export function saveMonitor(store: WorkspaceStore, m: Monitor): Monitor {
  // a tenant of a grouped definition saved (edited in the app): the definition is what changes
  // (its own pause and consent are the definition's `pausedTenants` / `allowProductionFor`: what the row shows of them is not written back)
  if (m.tenant || (typeof m.id === 'string' && m.id.includes(TENANT_SEP))) {
    const of = m.tenant?.of ?? m.id.slice(0, m.id.indexOf(TENANT_SEP));
    const def = listMonitorDefinitions(store).find((d) => d.id === of);
    const row = def ? monitorTenants(store, def).find((t) => t.id === m.id) : undefined;
    // the row's name is "<definition> · <environment>": only that ending is the row's own, the rest is what the person typed
    const ending = def && row ? row.name.slice(def.name.length) : '';
    const name = ending && m.name.endsWith(ending) ? m.name.slice(0, -ending.length) : m.tenant && !def ? m.name.replace(/ · [^·]*$/, '') : m.name;
    m = { ...m, id: of, name, tenant: undefined, ...(def ? { enabled: def.enabled, pausedUntil: def.pausedUntil, pauseReason: def.pauseReason, allowProduction: def.allowProduction } : {}) };
  }
  if (m.environmentGroup?.trim()) m = { ...m, environmentGroup: m.environmentGroup.trim(), environment: undefined };
  else m = { ...m, environmentGroup: undefined, allowProductionFor: undefined, pausedTenants: undefined };
  if (m.pausedTenants && !Object.keys(m.pausedTenants).length) m = { ...m, pausedTenants: undefined };
  if (m.allowProductionFor && !m.allowProductionFor.length) m = { ...m, allowProductionFor: undefined };
  // one target: an empty collection or file is no target
  if (m.testFile !== undefined) m = { ...m, testFile: m.testFile.trim() ? monitorTestFile(m.testFile) : undefined };
  if (!m.collectionId) m = { ...m, collectionId: undefined };
  if (m.evaluation !== undefined) m = { ...m, evaluation: m.evaluation.trim() || undefined };
  validateMonitor(store, m);
  const lib = store.getLibrary<MonitorData>(MONITORS_LIBRARY);
  const { id, name, folder, tenant: _tenant, ...data } = m;
  const item: LibraryItem<MonitorData> = { id, name: name.trim(), folder, data, updatedAt: new Date().toISOString() };
  const items = lib.items.some((i) => i.id === id) ? lib.items.map((i) => (i.id === id ? item : i)) : [...lib.items, item];
  store.saveLibrary(MONITORS_LIBRARY, { folders: lib.folders, items });
  return m;
}

export function deleteMonitor(store: WorkspaceStore, id: string): void {
  // a tenant's id deletes the definition it comes from (there is no monitor of its own to delete)
  if (id.includes(TENANT_SEP)) id = id.slice(0, id.indexOf(TENANT_SEP));
  const lib = store.getLibrary<MonitorData>(MONITORS_LIBRARY);
  store.saveLibrary(MONITORS_LIBRARY, { folders: lib.folders, items: lib.items.filter((i) => i.id !== id) });
}

const resultsFile = (store: WorkspaceStore, id: string) => store.path('runs', 'monitors', `${id.replace(/[^\w.-]/g, '_')}.jsonl`);

/*
 * A monitor's results file parsed once per change of it (newest first) and kept: the list, the status, the daily uptime
 * and the scheduler's tick each ask for it several times a minute, and the file holds up to a thousand lines.
 */
const parsedResults = new Map<string, { mtimeMs: number; size: number; results: MonitorResult[] }>(); // bounded: PARSED_RESULTS_MAX
const PARSED_RESULTS_MAX = 500;

/** Results of a monitor, newest first. */
export function monitorResults(store: WorkspaceStore, id: string, limit = 50): MonitorResult[] {
  const f = resultsFile(store, id);
  const st = statSync(f, { throwIfNoEntry: false });
  if (!st) {
    parsedResults.delete(f);
    return [];
  }
  const hit = parsedResults.get(f);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return limit >= hit.results.length ? hit.results : hit.results.slice(0, limit);
  // newest are last: parsed from the end
  const lines = readFileSync(f, 'utf8').split('\n');
  const results: MonitorResult[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue;
    try {
      results.push(JSON.parse(lines[i]!) as MonitorResult);
    } catch {
      /* a partly written last line */
    }
  }
  if (parsedResults.size >= PARSED_RESULTS_MAX) parsedResults.clear();
  parsedResults.set(f, { mtimeMs: st.mtimeMs, size: st.size, results });
  return limit >= results.length ? results : results.slice(0, limit);
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
  // bounded: compacted to the newest results when the file grows past twice the limit (atomically: a crash while compacting keeps the old file)
  appendBoundedLine(resultsFile(store, r.monitorId), JSON.stringify(r), KEEP_RESULTS, (f, text) => atomicWrite(f, text));
}

/**
 * When a monitor should run next: `everyMinutes` after its last run, or now if it never ran. On a cron schedule: the
 * first time of the schedule after its last run (one missed while nothing ran it is due now, once); never run, the
 * time of the schedule that is due now or next (a scheduler looks every 30 seconds).
 */
export function nextRunAt(m: Monitor, last: MonitorResult | undefined, now = Date.now()): number {
  const ran = last ? Date.parse(last.startedAt) : NaN;
  if (m.cron) {
    try {
      // never run: a time of the schedule in the last 10 minutes is due (`monitor run --due` from a system cron every 5 minutes finds it)
      const after = Number.isFinite(ran) && ran <= now ? ran : now - 10 * 60_000;
      const s = parseCron(m.cron);
      let t = nextCronTime(s, after);
      // a time inside the maintenance window is skipped, not run when the window ends: the next one after its end
      for (let i = 0, end: number | undefined; t && m.quiet && (end = quietUntil(m.quiet, t.getTime())) !== undefined && i < 50; i++) t = nextCronTime(s, end - 1);
      return t?.getTime() ?? Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY; // a schedule that cannot be read never runs (validateMonitor refuses to save one)
    }
  }
  if (!last) return now;
  // the clock was set back (an NTP correction, a restored VM): a last run in the future would make the monitor wait for hours; it is due now, and its new result carries the right time
  if (ran > now) return now;
  return ran + m.everyMinutes * 60_000;
}

/** How often a monitor runs, in words: "every 15 minutes", "at 09:00 on weekdays", and its maintenance window. */
export function monitorScheduleText(m: Pick<Monitor, 'everyMinutes' | 'cron' | 'quiet'>): string {
  let when: string;
  if (!m.cron) when = formatEvery(m.everyMinutes);
  else
    try {
      when = describeCron(m.cron);
    } catch {
      when = `on the schedule "${m.cron}" (cannot be read)`;
    }
  return m.quiet ? `${when} · ${quietText(m.quiet)}` : when;
}

export function isDue(m: Monitor, last: MonitorResult | undefined, now = Date.now()): boolean {
  return m.enabled && !pausedFor(m, now) && quietUntil(m.quiet, now) === undefined && nextRunAt(m, last, now) <= now;
}

/** Whether a timed pause is still on (an expired one is over: the schedule went on by itself). */
export function pausedFor(m: Pick<Monitor, 'pausedUntil'>, now = Date.now()): boolean {
  const t = m.pausedUntil ? Date.parse(m.pausedUntil) : NaN;
  return Number.isFinite(t) && t > now;
}

/** "paused until 14:30 (deploy)": the time in the local clock, with the date when it is not today. */
export function pausedText(m: Pick<Monitor, 'pausedUntil' | 'pauseReason'>, now = Date.now()): string {
  const d = new Date(m.pausedUntil!);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const when = sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `paused until ${when}${m.pauseReason ? ` (${m.pauseReason})` : ''}`;
}

/** "30m", "2h", "1d" (or minutes) to minutes; 1 minute to 30 days. */
export function parsePauseFor(text: string | number): number {
  const t = String(text).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)?$/.exec(t);
  if (!m) throw new ApsError('ValidationError', `"${text}" is not a duration: use 30m, 2h or 1d`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'm';
  const minutes = Math.round(unit.startsWith('h') ? n * 60 : unit.startsWith('d') ? n * 1440 : n);
  if (minutes < 1 || minutes > 30 * 1440) throw new ApsError('ValidationError', 'A pause is 1 minute to 30 days');
  return minutes;
}

/**
 * Pause a monitor for a while (`minutes`, or until a time), with why: it runs again by itself when the time comes.
 * Without a time: paused until resumed (`enabled: false`).
 */
export function pauseMonitor(store: WorkspaceStore, id: string, o: { minutes?: number; until?: string; reason?: string } = {}, now = Date.now()): Monitor {
  const m = findMonitor(store, id);
  const reason = o.reason?.trim() || undefined;
  const forever = o.until === undefined && o.minutes === undefined;
  const until = forever ? NaN : o.until !== undefined ? Date.parse(o.until) : now + o.minutes! * 60_000;
  if (!forever && !Number.isFinite(until)) throw new ApsError('ValidationError', `"${o.until}" is not a time`);
  if (!forever && until <= now) throw new ApsError('ValidationError', 'The time to pause until is in the past');
  const iso = forever ? undefined : new Date(until).toISOString();
  // one tenant of a grouped definition waits on its own: the others keep their schedule
  if (m.tenant) return tenantPaused(store, m, { until: iso, reason });
  if (forever) return saveMonitor(store, { ...m, enabled: false, pausedUntil: undefined, pauseReason: reason });
  return saveMonitor(store, { ...m, enabled: true, pausedUntil: iso, pauseReason: reason });
}

/** Set or end (no `pause`) the pause of one tenant; returns the tenant as it is listed now. */
function tenantPaused(store: WorkspaceStore, tenant: Monitor, pause?: { until?: string; reason?: string }): Monitor {
  const def = listMonitorDefinitions(store).find((d) => d.id === tenant.tenant!.of)!;
  const envId = tenant.tenant!.environmentId ?? tenant.id.slice(tenant.id.indexOf(TENANT_SEP) + 1);
  const { [envId]: _was, ...others } = def.pausedTenants ?? {};
  saveMonitor(store, { ...def, pausedTenants: pause ? { ...others, [envId]: pause } : others });
  return findMonitor(store, tenant.id);
}

/** The schedule goes on now: a pause of either kind ends. */
export function resumeMonitor(store: WorkspaceStore, id: string): Monitor {
  const m = findMonitor(store, id);
  // a tenant resumed: its own pause ends; with none of its own, it waits because its definition does, and that one resumes
  if (m.tenant) {
    const def = listMonitorDefinitions(store).find((d) => d.id === m.tenant!.of)!;
    if (def.pausedTenants?.[m.tenant.environmentId ?? '']) return tenantPaused(store, m);
    saveMonitor(store, { ...def, enabled: true, pausedUntil: undefined, pauseReason: undefined });
    return findMonitor(store, m.id);
  }
  // the monitor itself resumed: every tenant of it too (a tenant paused on its own was paused with the rest)
  return saveMonitor(store, { ...m, enabled: true, pausedUntil: undefined, pauseReason: undefined, pausedTenants: undefined });
}

/** A monitor with its schedule text, last result and next run (what list commands and MCP show). */
export function monitorStatus(store: WorkspaceStore, m: Monitor, now = Date.now()) {
  const last = lastMonitorResult(store, m.id);
  const quiet = quietUntil(m.quiet, now);
  return {
    ...m,
    schedule: !m.enabled ? 'paused' : pausedFor(m, now) ? pausedText(m) : quiet !== undefined ? `in its maintenance window until ${new Date(quiet).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${m.quiet!.reason ? ` (${m.quiet!.reason})` : ''}` : monitorScheduleText(m),
    paused: !m.enabled || pausedFor(m, now),
    ...(quiet !== undefined ? { quietUntil: new Date(quiet).toISOString() } : {}),
    lastResult: last,
    nextRunAt: m.enabled ? ((t) => (Number.isFinite(t) ? new Date(t).toISOString() : undefined))(Math.max(nextRunAt(m, last, now), pausedFor(m, now) ? Date.parse(m.pausedUntil!) : now, quiet ?? now, now)) : undefined,
    due: isDue(m, last, now),
  };
}

interface ExecuteMonitorOptions {
  store: WorkspaceStore;
  monitor: Monitor;
  /** Engine services for the monitor's environment and collection (the host creates them, e.g. createEngineContext). */
  context(opts: { environment?: string; collectionId?: string }): { services: ExecServices; dispose(): Promise<void> };
  trigger?: MonitorResult['trigger'];
  /** How the environment's secret manager references are read (the CLI trusts the workspace it was pointed at). */
  secretReads?: { trustAll?: boolean };
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
  // its environment's secret manager references (op://, vault:// …) are read first: a scheduled run names no environment
  // in a command or a call, so nothing else reads them, and an unread one would go out as an empty credential
  if (o.monitor.environment) await prefetchEnvironmentSecrets(o.store, o.monitor.environment, o.secretReads).catch(() => undefined);
  // saved with consent, it may change its production environment (on its schedule too); otherwise the caller's consent counts
  return allowProductionFor(!!o.monitor.allowProduction || productionAllowed(), () => runMonitorOnce(o));
}

async function runMonitorOnce(o: ExecuteMonitorOptions): Promise<MonitorResult> {
  const { store, monitor } = o;
  const firstRunId = shortId('run-');
  const startedAt = new Date().toISOString();
  const base = { monitorId: monitor.id, runId: firstRunId, startedAt, trigger: o.trigger ?? 'manual' } as const;
  let summary: RunSummary;
  let runId = firstRunId;
  /** The evaluation monitors record their own run (and say which gates failed). */
  let gateReasons: string[] = [];
  let gated = false;
  let rag: MonitorRagInfo | undefined;
  // a prompt or agent evaluation is run as cases (pass or fail); a bot with sources is scored by metrics (see monitor-rag.ts)
  let promptEvaluation = false;
  try {
    // (inside the try: an evaluation that was deleted or renamed is a result "error", not a throw on every tick)
    promptEvaluation = !!monitor.evaluation && findSavedEvaluation(store, monitor.evaluation).type !== 'rag';
    if (monitor.evaluation && promptEvaluation) {
      const r = await runMonitorPromptEvaluation(o);
      summary = r.summary;
      runId = r.runId;
      gateReasons = r.gateReasons;
    } else if (monitor.evaluation) {
      const r = await runMonitorEvaluation(o);
      summary = r.summary;
      runId = r.runId;
      gateReasons = r.gateReasons;
      gated = r.gated;
      rag = r.rag;
    } else if (monitor.testFile) summary = await runMonitorTestFile(o, runId);
    else {
      const collection = store.getCollection(monitor.collectionId ?? '');
      const dir = store.runDir(runId);
      mkdirSync(dir, { recursive: true });
      const ctx = o.context({ environment: monitor.environment, collectionId: collection.id });
      try {
        summary = await runCollection({
          name: `${MONITOR_RUN_PREFIX}${monitor.name}`,
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
          ...(o.onTrace ? { onTrace: (t: Parameters<WorkspaceStore['saveTrace']>[0]) => o.onTrace!(t, runId) } : { onTraceBatch: (batch: Array<{ trace: Parameters<WorkspaceStore['saveTrace']>[0] }>) => store.saveTraces(batch.map((b) => ({ trace: b.trace, kind: 'test', runId }))) }),
          environment: monitor.environment,
          onEvent: o.onEvent,
        });
      } finally {
        await ctx.dispose();
      }
    }
    if (!monitor.evaluation) await recordRun(store, summary, store.runDir(runId), { reports: ['json', 'html'] });
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
    ...gateReasons,
    rag?.budget ? `note: ${rag.budget}` : '',
    slow ? `p95 ${Math.round(p95!)} ms is over the ${monitor.maxP95Ms} ms limit` : '',
    certSoon ? (cert!.daysLeft < 0 ? `the certificate of ${cert!.host} has expired` : `the certificate of ${cert!.host} expires in ${cert!.daysLeft} day${cert!.daysLeft === 1 ? '' : 's'} (warning at ${monitor.minCertDays})`) : '',
  ].filter(Boolean);
  const r: MonitorResult = {
    ...base,
    durationMs: summary.durationMs,
    runId,
    // an evaluation with gates is judged by its gates (a sample that scores low is what a metric is for); the system not answering always fails
    status: (monitor.evaluation && !promptEvaluation && (gated || Object.keys(monitor.gates ?? {}).length || monitor.baseline) ? summary.errors || gateReasons.length || summary.cancelled : summary.failed || summary.errors || summary.cancelled || gateReasons.length) || slow || certSoon ? 'failed' : 'passed',
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    errors: summary.errors,
    p50Ms: summary.latency?.p50,
    p95Ms: p95,
    ...(cert ? { certDaysLeft: cert.daysLeft } : {}),
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    ...(rag ? { rag } : {}),
  };
  recordResult(store, r);
  return r;
}

/**
 * The environment a monitor runs in: its own, or (a monitor on a suite that names none) the suite's `environment:`.
 * What a host checks before a run (unknown, production) must be this one, not only the monitor's own.
 */
export async function monitorRunEnvironment(store: WorkspaceStore, monitor: Pick<Monitor, 'environment' | 'testFile'>): Promise<string | undefined> {
  if (monitor.environment || !monitor.testFile) return monitor.environment;
  const abs = monitorTestPath(store, monitor.testFile);
  return isSuiteFile(abs) && existsSync(abs) ? (await loadSuite(abs)).environment : undefined;
}

/** A monitor's test file (or suite) run with the test runner, like `testpion test`: steps in order, traces of failures. */
async function runMonitorTestFile(o: ExecuteMonitorOptions, runId: string): Promise<RunSummary> {
  const { store, monitor } = o;
  const abs = monitorTestPath(store, monitor.testFile!);
  const suite = isSuiteFile(abs) ? await loadSuite(abs) : undefined;
  const dir = store.runDir(runId);
  mkdirSync(dir, { recursive: true });
  const environment = monitor.environment ?? suite?.environment;
  if (!monitor.environment && environment) await prefetchEnvironmentSecrets(store, environment, o.secretReads).catch(() => undefined);
  // a suite's setup and teardown files run here as they do under `testpion test`
  const listed = async (files?: string[]) => {
    const out = [];
    for (const f of files ?? []) for await (const t of loadTestsFromFile(isAbsolute(f) ? f : resolve(dirname(abs), f))) out.push(t);
    return out;
  };
  const ctx = o.context({ environment });
  try {
    return await runTests({
      name: `${MONITOR_RUN_PREFIX}${monitor.name}`,
      runId,
      tests: suite ? streamTests(suite.tests, dirname(abs), suite.tags?.length ? { tags: suite.tags } : undefined) : loadTestsFromFile(abs),
      ...(suite?.setup?.length ? { setup: await listed(suite.setup) } : {}),
      ...(suite?.teardown?.length ? { teardown: await listed(suite.teardown) } : {}),
      concurrency: suite?.concurrency ?? 1,
      ...(suite?.timeoutMs !== undefined ? { timeoutMs: suite.timeoutMs } : {}),
      ...(suite?.retries !== undefined ? { retries: suite.retries } : {}),
      services: ctx.services,
      signal: o.signal,
      bail: monitor.bail,
      resultsFile: join(dir, 'results.jsonl'),
      traceMode: 'failures',
      ...(o.onTrace ? { onTrace: (t: Parameters<WorkspaceStore['saveTrace']>[0]) => o.onTrace!(t, runId) } : { onTraceBatch: (batch: Array<{ trace: Parameters<WorkspaceStore['saveTrace']>[0] }>) => store.saveTraces(batch.map((b) => ({ trace: b.trace, kind: 'test', runId }))) }),
      environment,
      onEvent: o.onEvent,
    });
  } finally {
    await ctx.dispose();
  }
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

interface MonitorSchedulerOptions {
  /** Resolve {{variables}} in a monitor's webhook URL (with its environment). */
  resolve?: (m: Monitor, text: string) => string;
  /** After a webhook call (for logs). */
  onWebhook?: (m: Monitor, r: { ok: boolean; status?: number; error?: string }) => void;
  /** Current monitors (read on every tick, so edits apply without a restart). */
  list(): Monitor[];
  last(id: string): MonitorResult | undefined;
  /** The owners of what a monitor runs (CODEOWNERS), named first in its alert. Default: none. */
  owners?(m: Monitor): Promise<string[]>;
  /** The latest results of a monitor, newest first (`alertAfter` of them): a monitor that alerts after n failures in a row needs them. Default: the last one. */
  recent?(id: string, limit: number): MonitorResult[];
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
          // the results before this run, read before it: the run records its own result, which is not one of them
          const before = m.webhook ? (this.o.recent ? this.o.recent(m.id, alertAfterOf(m)) : previous ? [previous] : []) : [];
          const r = await this.o.run(m);
          ran++;
          this.o.onResult?.(m, r, previous);
          if (m.webhook && monitorAlert(m, r, before.filter((x) => x.runId !== r.runId))) {
            const url = this.o.resolve ? this.o.resolve(m, m.webhook) : m.webhook;
            const sent = await notifyMonitorWebhook(url, { ...m, owners: this.o.owners ? await this.o.owners(m) : [] }, r);
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
