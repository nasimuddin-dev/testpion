/**
 * What needs attention in a workspace, most severe first: workspace files that can't be read, failing monitors,
 * certificates that expire soon, the latest run if it failed (failures and errors told apart), saved requests whose
 * latest response failed, flaky tests. Names and counts only. The app's Problems panel (WF-03), Home's "Needs
 * attention", `what_needs_attention` and `testpion problems` are this one list.
 */
import { decodeJwt, type ItemRef } from '@testpion/shared';
import type { WorkspaceStore } from './workspace.js';
import { listCertificates } from './certificates.js';
import { listDeprecations } from './deprecations.js';
import { deprecatedOperationCalls } from '../openapi/deprecated-calls.js';
import { ownersOf, workspaceCodeowners } from '../git/owners.js';
import { toRepoPath } from '../git/git.js';
import { itemInfo } from './item-info.js';
import { mockPathOf } from '../mock/mock-server.js';
import { listMonitors, lastMonitorResult } from '../runner/monitors.js';
import { flakyTests } from '../runner/test-history.js';
import { listSavedEvaluations } from '../runner/saved-evaluations.js';
import { collectionRequests } from '../runner/collection-run.js';
import { ragTrendFindings } from '../runner/rag-trend.js';
import { CONVENTIONS_FILE, conventionFindings } from './conventions.js';
import { missingSecrets } from './missing-secrets.js';
import { secretKeys } from './secrets.js';
import type { SecretReader } from '../vars/variables.js';

export interface AttentionItem {
  kind: 'monitor' | 'certificate' | 'flaky' | 'request' | 'run' | 'file' | 'token' | 'deprecation' | 'convention';
  severity: 'high' | 'medium' | 'low';
  /** What the list groups it under. */
  group: 'Workspace files' | 'Secrets' | 'Monitors' | 'Runs' | 'Requests' | 'Certificates' | 'Endpoints going away' | 'Flaky tests' | 'RAG metrics' | 'Team conventions';
  /** A check that did not hold (failure), something that could not run or be read (error), or a warning. */
  type: 'failure' | 'error' | 'warning';
  /** When it happened (ISO), when known. */
  at?: string;
  /** One line for people. */
  message: string;
  /** The owners of the file that holds it (the repository's CODEOWNERS), when a rule names it: the team the problem is for. */
  owners?: string[];
  /** The tenant (an environment group) it is about: the group of the environment its monitor runs in, or of the environment itself. */
  tenant?: string;
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

/** A token that expires within this many days is listed (an expired one always is). */
export const TOKEN_DAYS = 3;

const looksLikeJwt = (v: string) => /^(Bearer\s+)?eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/.test(v.trim());

/** "in 5 hours", "in 2 days", "3 days ago". */
function relativeDays(sec: number): string {
  const abs = Math.abs(sec);
  const n = abs >= 86_400 ? Math.round(abs / 86_400) : abs >= 3600 ? Math.round(abs / 3600) : Math.max(1, Math.round(abs / 60));
  const unit = abs >= 86_400 ? 'day' : abs >= 3600 ? 'hour' : 'minute';
  const words = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return sec < 0 ? `${words} ago` : `in ${words}`;
}

/**
 * Variables that hold a JSON Web Token which has expired or expires within `days` (TOKEN_DAYS): a request with such a token
 * fails with 401 for a reason nothing else names. Plain values come from the files; secret ones from the secret store when
 * a reader is given. Only the variable's name is said, never the token.
 */
export function tokensAttention(store: Pick<WorkspaceStore, 'id' | 'listEnvironments' | 'workspace'>, secrets?: SecretReader, days = TOKEN_DAYS, now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  const look = (value: string | undefined, key: string, where: string, ref: AttentionItem['ref']) => {
    if (!value || !looksLikeJwt(value)) return;
    let exp: number | undefined;
    try {
      exp = decodeJwt(value, now).expiresInSec;
    } catch {
      return;
    }
    if (exp === undefined || exp > days * 86_400) return;
    const expired = exp <= 0;
    out.push({
      kind: 'token',
      severity: expired ? 'high' : 'medium',
      group: 'Secrets',
      type: expired ? 'error' : 'warning',
      message: expired ? `The token in {{${key}}} (${where}) expired ${relativeDays(exp)}: requests that use it get 401 until it is renewed` : `The token in {{${key}}} (${where}) expires ${relativeDays(exp)}`,
      ref,
    });
  };
  for (const env of store.listEnvironments())
    for (const v of env.variables) {
      if (v.enabled === false) continue;
      const value = v.secret ? secrets?.get(secretKeys.envVar(env.id, v.key)) : v.value;
      look(value, v.key, env.name, { kind: 'variable', key: v.key, environmentId: env.id });
    }
  for (const v of store.workspace.variables) {
    if (v.enabled === false) continue;
    const value = (v as { secret?: boolean }).secret ? secrets?.get(secretKeys.workspaceVar(store.id, v.key)) : v.value;
    look(value, v.key, 'globals', { kind: 'variable', key: v.key });
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

/** Whether an owner name names a team or person of an item (`@org/payments`, `payments`, a mail address): case-insensitive, the `@` optional. */
export function sameOwner(a: string, b: string): boolean {
  const norm = (x: string) => x.trim().replace(/^@/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** The problems of one team: those whose owners (CODEOWNERS) include the name; none has owners when the repository has no CODEOWNERS. */
export function problemsOwnedBy<T extends { owners?: string[] }>(items: T[], owner: string): T[] {
  return items.filter((i) => i.owners?.some((o) => sameOwner(o, owner)));
}

/**
 * The problems of one tenant (an environment group): those about a monitor that runs in one of its environments, or about
 * one of its environments (a token, a secret, a convention). Problems that name no environment (a request, a run, a
 * certificate) belong to no tenant and are left out.
 */
/** The tenant of a problem: the environment group of the monitor's environment, or of the environment it names; none for the rest. */
export function tenantOf(store: WorkspaceStore, items: Array<{ ref: ItemRef & { monitorId?: string; environmentId?: string } }>): Array<string | undefined> {
  const envs = store.listEnvironments();
  const groupOfEnv = (idOrName?: string) => (idOrName ? envs.find((e) => e.id === idOrName || e.name === idOrName)?.group?.trim() || undefined : undefined);
  const monitorEnv = new Map(listMonitors(store).map((m) => [m.id, m.environment] as const));
  return items.map((i) => (i.ref.kind === 'monitor' && i.ref.monitorId ? groupOfEnv(monitorEnv.get(i.ref.monitorId)) : i.ref.kind === 'environment' && i.ref.environmentId ? groupOfEnv(i.ref.environmentId) : undefined));
}

export function problemsOfGroup<T extends { ref: ItemRef & { monitorId?: string; environmentId?: string } }>(store: WorkspaceStore, items: T[], group: string): T[] {
  const want = group.trim().toLowerCase();
  if (!want) return items;
  const tenants = tenantOf(store, items);
  return items.filter((_, i) => (tenants[i] ?? '').toLowerCase() === want);
}

export async function workspaceAttention(store: WorkspaceStore, opts: { certDays?: number; flakyRuns?: number; tokenDays?: number; secrets?: SecretReader; /** Read secret values for the token check only (the app: its missing secrets are a banner of their own). */ tokenSecrets?: SecretReader } = {}): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];
  if (opts.secrets) out.push(...secretsAttention(store, opts.secrets));
  out.push(...tokensAttention(store, opts.tokenSecrets ?? opts.secrets, opts.tokenDays));
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
  // endpoints whose responses said they are going away (Deprecation / Sunset headers): the saved request that calls them, else the latest history entry
  for (const d of listDeprecations(store)) {
    let path: string;
    try {
      path = new URL(d.url).pathname.replace(/\/+$/, '') || '/';
    } catch {
      continue;
    }
    const saved = collections.flatMap((c) => collectionRequests(c).filter((r) => r.node.kind === 'http' && r.node.request.method.toUpperCase() === d.method && (mockPathOf(r.node.request.url).path.replace(/\/+$/, '') || '/') === path).map((r) => ({ c, r })))[0];
    const history = saved ? undefined : store.meta.listHistory({ limit: 200 }).items.find((h) => h.kind === 'http' && (h.method ?? '').toUpperCase() === d.method && typeof h.url === 'string' && h.url.split('?')[0] === d.url);
    if (!saved && !history) continue;
    const soon = d.sunsetInDays !== undefined && d.sunsetInDays < 30;
    const when = d.sunset ? (d.sunsetInDays! < 0 ? `its sunset (${d.sunset}) has passed` : `sunset ${d.sunset} (in ${d.sunsetInDays} day${d.sunsetInDays === 1 ? '' : 's'})`) : typeof d.deprecation === 'string' ? `deprecated since ${d.deprecation}` : d.warning ? `the server warns: ${d.warning}` : 'deprecated';
    out.push({
      kind: 'deprecation',
      severity: soon ? 'high' : 'medium',
      group: 'Endpoints going away',
      type: 'warning',
      at: d.lastSeen,
      message: `${saved ? `${saved.c.name} › ${saved.r.name}` : `${d.method} ${d.url}`} calls an endpoint that is going away: ${when}${d.link ? ` (see ${d.link})` : ''}`,
      ref: saved ? { kind: 'request', collectionId: saved.c.id, requestId: saved.r.id } : { kind: 'history', historyId: history!.id },
    });
  }
  // and the saved requests that call an operation an API definition marks deprecated, before any response says so
  for (const d of deprecatedOperationCalls(store))
    out.push({
      kind: 'deprecation',
      severity: 'medium',
      group: 'Endpoints going away',
      type: 'warning',
      message: `${d.collectionName} › ${d.requestName} calls ${d.method} ${d.path}, which the API definition ${d.spec} marks deprecated${d.summary ? ` (${d.summary})` : ''}`,
      ref: { kind: 'request', collectionId: d.collectionId, requestId: d.requestId },
    });
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
  // the team's conventions (conventions.yaml): what breaks them, as warnings; a file that cannot be read is one error
  try {
    for (const f of await conventionFindings(store)) out.push({ kind: 'convention', severity: 'low', group: 'Team conventions', type: 'warning', message: f.message, ref: f.ref });
  } catch (e) {
    out.push({ kind: 'convention', severity: 'medium', group: 'Team conventions', type: 'error', message: `${CONVENTIONS_FILE} can't be read: ${(e as Error).message}`, ref: { kind: 'environment', scope: 'workspace' } });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  // several tenants: the environment group a problem is about, so the Problems panel and `problems --group` read per tenant
  try {
    tenantOf(store, out).forEach((t, i) => t && (out[i]!.tenant = t));
  } catch {
    /* a courtesy: the rest of the list stands */
  }
  // several teams in one workspace: a problem names the owners of the file it is about (CODEOWNERS), so a shared list reads per team
  const co = await workspaceCodeowners(store.root).catch(() => undefined);
  if (co)
    for (const item of out) {
      let file: string | undefined;
      try {
        file = itemInfo(store, item.ref).file;
      } catch {
        file = undefined;
      }
      const owners = file ? ownersOf(co.rules, toRepoPath(co.repo, store.root, file)) : [];
      if (owners.length) {
        item.owners = owners;
        item.message = `${owners.join(' ')}: ${item.message}`;
      }
    }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
