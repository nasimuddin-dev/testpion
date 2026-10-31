/**
 * What needs attention in a workspace, most severe first: workspace files that can't be read, failing monitors,
 * certificates that expire soon, the latest run if it failed (failures and errors told apart), saved requests whose
 * latest response failed, flaky tests. Names and counts only. The app's Problems panel (WF-03), Home's "Needs
 * attention", `what_needs_attention` and `testpion problems` are this one list.
 */
import type { ItemRef } from '@testpion/shared';
import type { WorkspaceStore } from './workspace.js';
import { listCertificates } from './certificates.js';
import { listMonitors, lastMonitorResult } from '../runner/monitors.js';
import { flakyTests } from '../runner/test-history.js';
import { listSavedEvaluations } from '../runner/saved-evaluations.js';
import { collectionRequests } from '../runner/collection-run.js';
import { ragTrendFindings } from '../runner/rag-trend.js';
import { missingSecrets } from './missing-secrets.js';
import type { SecretReader } from '../vars/variables.js';

export interface AttentionItem {
  kind: 'monitor' | 'certificate' | 'flaky' | 'request' | 'run' | 'file';
  severity: 'high' | 'medium' | 'low';
  /** What the list groups it under. */
  group: 'Workspace files' | 'Secrets' | 'Monitors' | 'Runs' | 'Requests' | 'Certificates' | 'Flaky tests' | 'RAG metrics';
  /** A check that did not hold (failure), something that could not run or be read (error), or a warning. */
  type: 'failure' | 'error' | 'warning';
  /** When it happened (ISO), when known. */
  at?: string;
  /** One line for people. */
  message: string;
  /**
   * What it is about, as an ItemRef (@testpion/shared): a monitor (with its failing run), a certificate's host, a run,
   * a request (collection id + request id), a flaky test's id. The app opens it with `openRef`.
   */
  ref: ItemRef & { monitorId?: string; host?: string; testId?: string; collectionId?: string; requestId?: string; runId?: string };
}

/** The Problems-list items for secret variables whose value is not on this computer (a clone, a new machine, CI): their values are never in the files. */
export function secretsAttention(store: WorkspaceStore, secrets: SecretReader): AttentionItem[] {
  const out: AttentionItem[] = [];
  const miss = missingSecrets(store, secrets);
  const envs = store.listEnvironments();
  for (const name of new Set(miss.items.map((i) => i.environment ?? ''))) {
    const keys = miss.items.filter((i) => (i.environment ?? '') === name).map((i) => i.key);
    const env = name ? envs.find((e) => e.name === name) : undefined;
    out.push({
      kind: 'file',
      severity: 'medium',
      group: 'Secrets',
      type: 'warning',
      message: `${name ? `Environment "${name}" has` : 'The globals have'} ${keys.length === 1 ? 'a secret' : `${keys.length} secrets`} with no value on this computer: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ' …' : ''}`,
      ref: env ? { kind: 'environment', environmentId: env.id } : { kind: 'environment', scope: 'globals' },
    });
  }
  return out;
}

/** How many points the pass rate must fall between two runs of an evaluation to be listed. */
const DROP_POINTS = 10;

/** Evaluations (not bots with sources: their trend is above) whose latest finished run passed clearly less than the one before it. */
function evaluationDrops(store: WorkspaceStore): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const e of listSavedEvaluations(store).slice(0, 60)) {
    if (e.type === 'rag') continue;
    const runs = store.meta
      .listRuns({ query: e.name, limit: 12 })
      .items.filter((r) => r.name === e.name && r.total - r.skipped > 0)
      .slice(0, 2);
    if (runs.length < 2) continue;
    const [now, before] = runs as [(typeof runs)[number], (typeof runs)[number]];
    const rate = (r: typeof now) => r.passed / (r.total - r.skipped);
    const drop = Math.round((rate(before) - rate(now)) * 100);
    if (drop < DROP_POINTS) continue;
    out.push({
      kind: 'run',
      severity: drop >= 30 ? 'high' : 'medium',
      group: 'Runs',
      type: 'warning',
      at: now.startedAt,
      message: `Evaluation "${e.name}" passed ${now.passed} of ${now.total - now.skipped}, down from ${before.passed} of ${before.total - before.skipped} the run before`,
      ref: { kind: 'run', runId: now.id },
    });
  }
  return out;
}

export async function workspaceAttention(store: WorkspaceStore, opts: { certDays?: number; flakyRuns?: number; secrets?: SecretReader } = {}): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];
  if (opts.secrets) out.push(...secretsAttention(store, opts.secrets));
  // files that can't be read: nothing in them works until they are fixed
  for (const e of store.listEnvironments())
    if (e.problem) out.push({ kind: 'file', severity: 'high', group: 'Workspace files', type: 'error', message: `Environment "${e.name}" can't be read: ${e.problem}`, ref: { kind: 'environment', environmentId: e.id } });
  const collections = store.listCollections(); // once: the failing requests below walk the same list
  for (const c of collections)
    if ((c as { problem?: string }).problem) out.push({ kind: 'file', severity: 'high', group: 'Workspace files', type: 'error', message: `Collection "${c.name}" can't be read: ${(c as { problem?: string }).problem}`, ref: { kind: 'collection', collectionId: c.id } });
  for (const m of listMonitors(store)) {
    if (!m.enabled) continue;
    const r = lastMonitorResult(store, m.id);
    if (!r || r.status === 'passed') continue;
    const why = r.status === 'error' ? `could not run: ${r.error ?? 'error'}` : r.reason && !(r.failed + r.errors) ? r.reason : `${r.failed + r.errors} of ${r.total} requests failed`;
    out.push({ kind: 'monitor', severity: 'high', group: 'Monitors', type: r.status === 'error' || (r.errors > 0 && !r.failed) ? 'error' : 'failure', at: r.startedAt, message: `Monitor "${m.name}" is failing: ${why}`, ref: { kind: 'monitor', monitorId: m.id, ...(r.runId ? { runId: r.runId } : {}) } });
  }
  const certDays = opts.certDays ?? 30;
  for (const c of listCertificates(store)) {
    if (c.daysLeft === undefined || c.daysLeft >= certDays) continue;
    out.push({
      kind: 'certificate',
      severity: c.daysLeft < 7 ? 'high' : 'medium',
      group: 'Certificates',
      type: c.daysLeft < 0 ? 'error' : 'warning',
      message: c.daysLeft < 0 ? `The certificate of ${c.host} has expired` : `The certificate of ${c.host} expires in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`,
      ref: { kind: 'certificate', host: c.host },
    });
  }
  const latest = store.meta.listRuns({ limit: 1 }).items[0];
  if (latest && latest.failed + latest.errors > 0)
    out.push({
      kind: 'run',
      severity: 'medium',
      group: 'Runs',
      // a check that did not hold is a failure; a request that could not be sent or a script that threw is an error
      type: latest.errors > 0 && !latest.failed ? 'error' : 'failure',
      at: latest.startedAt,
      message: `The latest run "${latest.name}": ${[latest.failed ? `${latest.failed} failed` : '', latest.errors ? `${latest.errors} error${latest.errors === 1 ? '' : 's'} (network, TLS, timeout or script)` : ''].filter(Boolean).join(', ')}`,
      ref: { kind: 'run', runId: latest.id },
    });
  for (const c of collections) {
    if ((c as { problem?: string }).problem) continue;
    const names = new Map(collectionRequests(c).map((r) => [r.id, [...r.path, r.name].join(' / ')]));
    const failing = store.meta.requestStats(c.id).filter((s) => !s.lastOk && names.has(s.requestId));
    for (const s of failing.slice(0, 5))
      out.push({
        kind: 'request',
        severity: 'low',
        group: 'Requests',
        type: typeof s.lastStatus === 'number' ? 'failure' : 'error',
        message: `${c.name} › ${names.get(s.requestId)}: the latest response was ${s.lastStatus ?? 'an error'}`,
        ref: { kind: 'request', collectionId: c.id, requestId: s.requestId },
      });
  }
  for (const t of (await flakyTests(store, { runs: opts.flakyRuns ?? 30 })).slice(0, 5))
    out.push({
      kind: 'flaky',
      severity: 'low',
      group: 'Flaky tests',
      type: 'warning',
      message: `"${t.name}" is flaky: its result changed ${t.flips} times in ${t.runs} runs${t.retried ? `, ${t.retried} passed after a retry` : ''}`,
      ref: { kind: 'test-case', testId: t.id },
    });
  // a RAG metric that fell against the runs before it (cached means only: this list never scans big runs)
  try {
    for (const { evaluation, finding: f } of await ragTrendFindings(store))
      out.push({ kind: 'run', severity: 'medium', group: 'RAG metrics', type: 'warning', message: `${evaluation}: ${f.text}`, ref: { kind: 'run', runId: f.runId } });
  } catch {
    /* a trend is a courtesy: the rest of the list stands */
  }
  // a prompt or agent evaluation whose latest run passed clearly fewer cases than the run before it (a model switch, a prompt edit, a flaky check)
  try {
    out.push(...evaluationDrops(store));
  } catch {
    /* a courtesy: the rest of the list stands */
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
