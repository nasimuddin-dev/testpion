/**
 * The monitors as a status page: every monitor with its state now, its uptime over the period and a block per day, as
 * one self-contained HTML page to host (GitHub Pages, an intranet, a shared drive), as Markdown for a wiki, or as JSON for
 * a program. Only names, counts and timings: no request bodies, headers or variable values. No script in the page.
 */
import { ENGINE_VERSION } from '../version.js';
import { environmentLabel } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import { quietUntil } from '../runner/monitor-quiet.js';
import { listMonitorDefinitions, listMonitors, monitorDaily, monitorOwners, monitorResults, monitorStatus, pausedFor, type Monitor, type MonitorDay, type MonitorResult } from '../runner/monitors.js';
import { findSavedEvaluation } from '../runner/saved-evaluations.js';

export interface MonitorStatusRow {
  id: string;
  name: string;
  /** What it runs: the collection's name, the test file, or the evaluation. */
  target: string;
  /** The environment it runs in, with its group (a tenant): "Acme ▸ Staging". */
  environment?: string;
  group?: string;
  /** How often, or "paused" / "paused until 14:30 (deploy)". */
  schedule: string;
  paused: boolean;
  /** up (last run passed), down (it failed), unknown (never ran). A paused monitor keeps its last state. */
  state: 'up' | 'down' | 'unknown';
  last?: Pick<MonitorResult, 'status' | 'startedAt' | 'p95Ms' | 'passed' | 'total' | 'reason'>;
  /** Share of the period's runs that passed, 0-100 with one decimal; absent when nothing ran. */
  uptime?: number;
  runs: number;
  daily: MonitorDay[];
}

export interface MonitorsStatus {
  workspace: string;
  /** The page of one tenant (an environment group): only its monitors. */
  group?: string;
  /** The page of one team (a CODEOWNERS owner): only the monitors whose collection or test file it owns. */
  owner?: string;
  generatedAt: string;
  days: number;
  /** operational: every monitor that ran is up; degraded: some are down; down: every one that ran is down; none: no monitor ran. */
  overall: 'operational' | 'degraded' | 'down' | 'none';
  up: number;
  down: number;
  paused: number;
  monitors: MonitorStatusRow[];
}

function targetOf(store: WorkspaceStore, m: Monitor): string {
  if (m.testFile) return m.testFile;
  if (m.evaluation) {
    try {
      return `evaluation ${findSavedEvaluation(store, m.evaluation).name}`;
    } catch {
      return `evaluation ${m.evaluation}`;
    }
  }
  if (!m.collectionId) return 'nothing';
  try {
    return store.getCollection(m.collectionId).name;
  } catch {
    return m.collectionId;
  }
}

/** The data of the status page (what `json` returns). */
export function monitorsStatus(store: WorkspaceStore, o: { days?: number; tzOffsetMin?: number; now?: number; /** Only the monitors of this environment group (a tenant's own status page). */ group?: string; /** Only these monitors (monitorsStatusByOwner decides by CODEOWNERS); the page then names the `owner`. */ only?: (m: Monitor) => boolean; owner?: string } = {}): MonitorsStatus {
  const now = o.now ?? Date.now();
  const days = Math.min(Math.max(Math.floor(o.days ?? 30) || 30, 1), 90);
  const want = o.group?.trim().toLowerCase();
  const monitors = listMonitors(store)
    .filter((m) => (!want || (m.environment ? store.getEnvironment(m.environment)?.group?.trim().toLowerCase() : '') === want) && (!o.only || o.only(m)))
    .map((m): MonitorStatusRow => {
      const st = monitorStatus(store, m, now);
      const last = monitorResults(store, m.id, 1)[0];
      const daily = monitorDaily(store, m.id, days, o.tzOffsetMin, now);
      const runs = daily.reduce((x, d) => x + d.runs, 0);
      const passed = daily.reduce((x, d) => x + d.passed, 0);
      return {
        id: m.id,
        name: m.name,
        target: targetOf(store, m),
        // the environment's own name and its group apart (a tenant's `environment` may be its label "Acme ▸ Staging")
        ...(m.environment ? { environment: store.getEnvironment(m.environment)?.name ?? m.environment, ...(store.getEnvironment(m.environment)?.group ? { group: store.getEnvironment(m.environment)!.group } : {}) } : {}),
        schedule: st.schedule,
        // in its maintenance window: shown like a pause, with until when (its schedule text says so)
        paused: !m.enabled || pausedFor(m, now) || quietUntil(m.quiet, now, m.timezone) !== undefined,
        state: !last ? 'unknown' : last.status === 'passed' ? 'up' : 'down',
        ...(last ? { last: { status: last.status, startedAt: last.startedAt, p95Ms: last.p95Ms, passed: last.passed, total: last.total, reason: last.reason } } : {}),
        ...(runs ? { uptime: Math.round((passed / runs) * 1000) / 10 } : {}),
        runs,
        daily,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const up = monitors.filter((m) => m.state === 'up').length;
  const down = monitors.filter((m) => m.state === 'down').length;
  const overall = !up && !down ? 'none' : !down ? 'operational' : !up ? 'down' : 'degraded';
  return { workspace: store.workspace.name, ...(o.group?.trim() ? { group: o.group.trim() } : {}), ...(o.owner?.trim() ? { owner: o.owner.trim() } : {}), generatedAt: new Date(now).toISOString(), days, overall, up, down, paused: monitors.filter((m) => m.paused).length, monitors };
}

/** A team's own status page: the monitors whose collection or test file the owner owns in CODEOWNERS (the @ optional, case not mattering). */
export async function monitorsStatusByOwner(store: WorkspaceStore, owner: string, o: { days?: number; tzOffsetMin?: number; now?: number; group?: string } = {}): Promise<MonitorsStatus> {
  const want = owner.trim().replace(/^@/, '').toLowerCase();
  const defs = listMonitorDefinitions(store);
  const owned = new Set<string>();
  for (const m of defs) if ((await monitorOwners(store, m)).some((x) => x.replace(/^@/, '').toLowerCase() === want)) owned.add(m.id);
  return monitorsStatus(store, { ...o, owner, only: (m) => owned.has(m.tenant?.of ?? m.id) });
}

/** "Shop API · Acme" for a tenant's page, "Shop API · @org/payments" for a team's, else the workspace's name. */
const titleOf = (s: MonitorsStatus) => [s.workspace, s.group, s.owner].filter(Boolean).join(' · ');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (n?: number) => (n === undefined ? '—' : `${n}%`);
const when = (iso: string) => iso.replace('T', ' ').slice(0, 16);
const OVERALL_TEXT: Record<MonitorsStatus['overall'], string> = { operational: 'All systems operational', degraded: 'Some monitors are failing', down: 'Every monitor is failing', none: 'No monitor has run yet' };
const STATE_TEXT: Record<MonitorStatusRow['state'], string> = { up: 'Up', down: 'Down', unknown: 'No run yet' };

/** One block per day: green when every run passed, amber at 90% or more, red below, grey when nothing ran. */
function dayBlocks(daily: MonitorDay[]): string {
  return daily
    .map((d) => {
      const cls = d.runs === 0 ? 'none' : d.uptime === 100 ? 'ok' : (d.uptime ?? 0) >= 90 ? 'warn' : 'bad';
      const title = d.runs === 0 ? `${d.date}: no runs` : `${d.date}: ${d.passed} of ${d.runs} passed (${d.uptime}%)${d.maxP95Ms !== undefined ? `, slowest p95 ${d.maxP95Ms} ms` : ''}`;
      return `<i class="${cls}" title="${esc(title)}"></i>`;
    })
    .join('');
}

function lastLine(m: MonitorStatusRow): string {
  if (!m.last) return '';
  return ` · last run ${esc(when(m.last.startedAt))}: ${m.last.status}${m.last.p95Ms !== undefined ? `, p95 ${m.last.p95Ms} ms` : ''}${m.last.reason ? ` (${esc(m.last.reason)})` : ''}`;
}

/** The status page: one HTML file, no script, light and dark with the viewer's system. */
export function monitorsStatusHtml(s: MonitorsStatus): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // several tenants on one page: a heading per environment group (the ungrouped monitors first, under no heading); one group: no headings
  const groups = [...new Set(s.monitors.map((m) => m.group?.trim() || ''))];
  const sectioned = groups.length > 1 && !s.group;
  const ordered = sectioned ? [...s.monitors].sort((a, b) => (a.group?.trim() || '').localeCompare(b.group?.trim() || '') || a.name.localeCompare(b.name)) : s.monitors;
  const rows = ordered
    .map(
      (m, i) => `${sectioned && m.group?.trim() && m.group.trim() !== (ordered[i - 1]?.group?.trim() || '') ? `<h2 class="tenant">${esc(m.group.trim())}</h2>` : ''}<section class="mon ${m.state}${m.paused ? ' paused' : ''}">
<div class="head"><span class="dot"></span><h2>${esc(m.name)}</h2><span class="muted">${esc(m.target)}${m.environment ? ` · ${esc(environmentLabel({ name: m.environment, group: m.group }))}` : ''}</span><span class="state">${m.paused ? esc(m.schedule) : STATE_TEXT[m.state]}</span></div>
<div class="days" aria-label="Uptime by day">${dayBlocks(m.daily)}</div>
<div class="muted small">${s.days} days: ${esc(pct(m.uptime))} of ${plural(m.runs, 'run')} passed${m.paused ? '' : ` · ${esc(m.schedule)}`}${lastLine(m)}</div>
</section>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titleOf(s))} — status</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--none:#d0d7de;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--none:#30363d;--card:#161b22}}
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:32px 24px;max-width:860px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2.tenant{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:22px 0 2px}.muted{color:var(--muted)}.small{font-size:13px}
.overall{display:flex;align-items:center;gap:10px;padding:14px 16px;border-radius:10px;margin:20px 0;font-weight:600;color:#fff;background:var(--ok)}
.overall.degraded{background:var(--warn)}.overall.down{background:var(--bad)}.overall.none{background:var(--muted)}
.mon{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;background:var(--card)}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.head h2{font-size:16px;margin:0}.head .state{margin-left:auto;font-size:13px;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;background:var(--none);flex:none}.up .dot{background:var(--ok)}.down .dot{background:var(--bad)}
.up .state{color:var(--ok)}.down .state{color:var(--bad)}.paused .state{color:var(--muted);font-weight:500}.paused{opacity:.75}
.days{display:flex;gap:3px;margin:10px 0 6px}.days i{flex:1;height:26px;border-radius:3px;background:var(--none);min-width:3px}.days i.ok{background:var(--ok)}.days i.warn{background:var(--warn)}.days i.bad{background:var(--bad)}
footer{margin-top:28px;font-size:12px;color:var(--muted)}
</style></head><body>
<h1>${esc(titleOf(s))}</h1>
<div class="muted">Status of ${plural(s.monitors.length, 'monitor')} · last ${s.days} days · ${esc(when(s.generatedAt))} UTC</div>
<div class="overall ${s.overall}">${OVERALL_TEXT[s.overall]}${s.down ? ` · ${s.down} down` : ''}${s.paused ? ` · ${s.paused} paused` : ''}</div>
${rows || (s.owner ? `<p class="muted">No monitor runs what ${esc(s.owner)} owns.</p>` : s.group ? `<p class="muted">No monitor runs in an environment of ${esc(s.group)}.</p>` : '<p class="muted">No monitors. Add one in TestPion (Monitors) or with <code>testpion monitor add</code>.</p>')}
<footer>Made by TestPion ${esc(ENGINE_VERSION)} from the monitors' runs on this computer. Days follow the clock of the computer that made the page.</footer>
</body></html>
`;
}

/** The status as Markdown (a wiki page, a README section). */
export function monitorsStatusMarkdown(s: MonitorsStatus): string {
  const lines = [`# ${titleOf(s)} — status`, '', `${OVERALL_TEXT[s.overall]} · ${s.monitors.length} monitor${s.monitors.length === 1 ? '' : 's'} · last ${s.days} days · ${when(s.generatedAt)} UTC`, ''];
  if (s.monitors.length) {
    lines.push('| Monitor | Environment | State | Uptime | Runs | Schedule | Last run |', '|---|---|---|---|---|---|---|');
    for (const m of s.monitors) {
      const state = m.paused ? m.schedule : m.state === 'up' ? '🟢 Up' : m.state === 'down' ? '🔴 Down' : '⚪ No run yet';
      lines.push(`| ${m.name} | ${m.environment ? environmentLabel({ name: m.environment, group: m.group }) : '—'} | ${state} | ${pct(m.uptime)} | ${m.runs} | ${m.paused ? '—' : m.schedule} | ${m.last ? `${when(m.last.startedAt)} ${m.last.status}${m.last.reason ? ` (${m.last.reason})` : ''}` : '—'} |`);
    }
  } else lines.push('No monitors.');
  return lines.join('\n') + '\n';
}
