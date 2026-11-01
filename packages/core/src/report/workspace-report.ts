import type { WorkspaceStore } from '../storage/workspace.js';
import type { ActivityDay } from '../storage/metastore.js';
import { collectionRequests } from '../runner/collection-run.js';
import { listMonitors, monitorDaily, monitorResults } from '../runner/monitors.js';
import { ENGINE_VERSION } from '../version.js';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const ms = (v?: number) => (v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

/** Stacked columns per day (ok at the base, failed above), static SVG. */
function dayColumns(days: ActivityDay[], ok: (d: ActivityDay) => number, bad: (d: ActivityDay) => number, label: string): string {
  const W = 560;
  const H = 150;
  const pad = { l: 34, r: 6, t: 8, b: 22 };
  const max = Math.max(2, ...days.map((d) => ok(d) + bad(d)));
  const slot = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(2, Math.min(18, slot * 0.7));
  const base = H - pad.b;
  const h = (v: number) => (v / max) * (base - pad.t);
  const cols = days
    .map((d, i) => {
      const cx = pad.l + slot * i + slot / 2;
      const okH = h(ok(d));
      const badH = h(bad(d));
      const tick = i === 0 || i === days.length - 1 || i === Math.floor((days.length - 1) / 2) ? `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(d.day.slice(5))}</text>` : '';
      return (
        `<g><title>${esc(d.day)}: ${ok(d)} ok, ${bad(d)} failed</title>` +
        (okH ? `<rect x="${cx - bw / 2}" y="${base - okH}" width="${bw}" height="${okH}" rx="2" fill="var(--ok)"/>` : '') +
        (badH ? `<rect x="${cx - bw / 2}" y="${base - okH - badH - (okH ? 2 : 0)}" width="${bw}" height="${badH}" rx="2" fill="var(--bad)"/>` : '') +
        `${tick}</g>`
      );
    })
    .join('');
  const grid = [0, Math.round(max / 2), max].map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${base - h(t)}" y2="${base - h(t)}"/><text x="${pad.l - 6}" y="${base - h(t) + 3}" text-anchor="end">${t}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${cols}</svg>`;
}

/**
 * The workspace at a glance as one static HTML file to share (no scripts, works offline): activity per day,
 * each collection's request health, monitors with their latest results, and the latest runs.
 * Only names, counts, statuses and timings: no request bodies, headers or variable values.
 */
export function workspaceReportHtml(store: WorkspaceStore, opts: { days?: number; tzOffsetMin?: number; attention?: Array<{ severity: 'high' | 'medium' | 'low'; message: string; owners?: string[] }> } = {}): string {
  const ws = store.workspace;
  const a = store.meta.activity({ days: opts.days ?? 14, tzOffsetMin: opts.tzOffsetMin });
  const sum = (f: (d: ActivityDay) => number) => a.days.reduce((x, d) => x + f(d), 0);
  const requests = sum((d) => d.requests);
  const failed = sum((d) => d.failedRequests);
  const tests = sum((d) => d.tests);
  const failedTests = sum((d) => d.failedTests);
  const runsCount = sum((d) => d.runs);

  // collections: requests, with checks, sent, failing now
  const cols = store
    .listCollections()
    .filter((c) => !(c as { problem?: string }).problem)
    .map((c) => {
      const reqs = collectionRequests(c);
      const stats = new Map(store.meta.requestStats(c.id).map((s) => [s.requestId, s]));
      const sent = reqs.filter((r) => stats.has(r.id));
      const failing = sent.filter((r) => !stats.get(r.id)!.lastOk);
      const checks = reqs.filter((r) => r.node.assertions?.length || r.node.testScript?.trim()).length;
      return { name: c.name, requests: reqs.length, checks, sent: sent.length, failing: failing.map((r) => [...r.path, r.name].join(' / ')) };
    });
  const monitors = listMonitors(store).map((m) => {
    const recent = monitorResults(store, m.id, 20);
    const daily = monitorDaily(store, m.id, 30, opts.tzOffsetMin);
    const dayRuns = daily.reduce((x, d) => x + d.runs, 0);
    const dayPassed = daily.reduce((x, d) => x + d.passed, 0);
    const group = m.environment ? store.getEnvironment(m.environment)?.group?.trim() : undefined;
    return { name: m.name, enabled: m.enabled, group, last: recent[0], passed: recent.filter((r) => r.status === 'passed').length, total: recent.length, strip: [...recent].reverse(), daily, uptime: dayRuns ? pct(dayPassed, dayRuns) : '—' };
  });
  const runs = store.meta.listRuns({ limit: 10 }).items;

  const card = (label: string, value: string, sub: string, tone = '') => `<div class="card"><span class="muted">${esc(label)}</span><b class="${tone}">${esc(value)}</b><span class="muted">${esc(sub)}</span></div>`;
  const out: string[] = [];
  out.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ws.name)} — TestPion workspace report</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--card:#f6f8fa;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--card:#161b22;--accent:#58a6ff}}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.card b{display:block;font-size:22px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.chart h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}.chart svg{width:100%;height:auto;font-size:10px}.chart svg text{fill:var(--muted)}.chart svg line{stroke:var(--line)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}td.n{text-align:right;font-variant-numeric:tabular-nums}
.warn{color:var(--warn)}.strip{display:inline-flex;gap:1px;vertical-align:middle}.strip i{display:inline-block;width:4px;height:12px;border-radius:1px}.strip.days{gap:2px}.strip.days i{width:6px}
</style></head><body>
<h1>${esc(ws.name)}</h1>
<div class="muted">Workspace report · last ${a.days.length} days · ${esc(new Date().toLocaleString())} · TestPion ${ENGINE_VERSION}</div>
<div class="cards">`);
  out.push(card('Requests sent', String(requests), failed ? `${failed} failed` : requests ? 'none failed' : 'nothing sent'));
  out.push(card('Request success', pct(requests - failed, requests), '2xx/3xx, OK and tool results', !requests ? '' : failed / requests > 0.05 ? 'bad' : 'ok'));
  out.push(card('Median response', ms(a.medianMs), 'all requests of the period'));
  out.push(card('Tests passed', pct(tests - failedTests, tests), runsCount ? `${tests} tests in ${runsCount} runs` : 'no test runs', !tests ? '' : failedTests ? 'bad' : 'ok'));
  out.push(`</div>`);
  // what needs attention (from workspaceAttention, computed by the caller): before the charts
  if (opts.attention?.length) {
    out.push(`<h2>Needs attention</h2><table>`);
    for (const a of opts.attention.slice(0, 20)) out.push(`<tr><td class="${a.severity === 'high' ? 'bad' : a.severity === 'medium' ? 'warn' : 'muted'}" style="width:70px">${a.severity}</td><td>${esc(a.message)}</td></tr>`);
    out.push(`</table>`);
  }
  // several teams: the problems per owner (CODEOWNERS), so each team sees its share at a glance
  const byTeam = new Map<string, { high: number; medium: number; low: number }>();
  for (const a of opts.attention ?? []) for (const o of a.owners ?? []) byTeam.set(o, { ...(byTeam.get(o) ?? { high: 0, medium: 0, low: 0 }), [a.severity]: (byTeam.get(o)?.[a.severity] ?? 0) + 1 });
  if (byTeam.size) {
    out.push(`<h2>By team</h2><table><tr><th>Team</th><th>High</th><th>Medium</th><th>Low</th></tr>`);
    for (const [team, n] of [...byTeam].sort((x, y) => y[1].high - x[1].high || y[1].medium - x[1].medium || x[0].localeCompare(y[0]))) out.push(`<tr><td>${esc(team)}</td><td class="n ${n.high ? 'bad' : ''}">${n.high}</td><td class="n ${n.medium ? 'warn' : ''}">${n.medium}</td><td class="n">${n.low}</td></tr>`);
    out.push(`</table>`);
  }
  // several tenants: the monitors per environment group, with how many are failing now
  const byTenant = new Map<string, { monitors: number; down: number }>();
  for (const m of monitors) if (m.group) byTenant.set(m.group, { monitors: (byTenant.get(m.group)?.monitors ?? 0) + 1, down: (byTenant.get(m.group)?.down ?? 0) + (m.enabled && m.last && m.last.status !== 'passed' ? 1 : 0) });
  if (byTenant.size) {
    out.push(`<h2>By tenant</h2><table><tr><th>Tenant</th><th>Monitors</th><th>Failing now</th></tr>`);
    for (const [tenant, n] of [...byTenant].sort((x, y) => y[1].down - x[1].down || x[0].localeCompare(y[0]))) out.push(`<tr><td>${esc(tenant)}</td><td class="n">${n.monitors}</td><td class="n ${n.down ? 'bad' : 'ok'}">${n.down}</td></tr>`);
    out.push(`</table>`);
  }
  out.push(`<div class="charts">`);
  out.push(`<section class="chart"><h3>Requests per day</h3>${dayColumns(a.days, (d) => d.requests - d.failedRequests, (d) => d.failedRequests, 'Requests per day')}</section>`);
  out.push(`<section class="chart"><h3>Tests per day</h3>${dayColumns(a.days, (d) => d.tests - d.failedTests, (d) => d.failedTests, 'Tests per day')}</section>`);
  out.push(`</div>`);

  out.push(`<h2>Collections</h2><table><tr><th>Collection</th><th>Requests</th><th>With checks</th><th>Sent from the app</th><th>Failing now</th></tr>`);
  for (const c of cols)
    out.push(
      `<tr><td>${esc(c.name)}</td><td class="n">${c.requests}</td><td class="n">${pct(c.checks, c.requests)}</td><td class="n">${c.sent}</td><td class="${c.failing.length ? 'bad' : ''}">${c.failing.length ? esc(c.failing.slice(0, 5).join(', ')) + (c.failing.length > 5 ? ` and ${c.failing.length - 5} more` : '') : c.sent ? '<span class="ok">none</span>' : '<span class="muted">—</span>'}</td></tr>`,
    );
  if (!cols.length) out.push(`<tr><td colspan="5" class="muted">No collections</td></tr>`);
  out.push(`</table>`);

  if (monitors.length) {
    out.push(`<h2>Monitors</h2><table><tr><th>Monitor</th><th>Latest</th><th>Last ${Math.max(...monitors.map((m) => m.total), 1)} runs</th><th>Passed</th><th>Uptime by day, 30 days</th><th>Uptime</th></tr>`);
    for (const m of monitors) {
      const strip = m.strip.map((r) => `<i style="background:${r.status === 'passed' ? 'var(--ok)' : 'var(--bad)'}" title="${esc(r.startedAt)}: ${esc(r.status)}"></i>`).join('');
      const latest = !m.enabled ? '<span class="muted">paused</span>' : !m.last ? '<span class="muted">not run yet</span>' : `<span class="${m.last.status === 'passed' ? 'ok' : 'bad'}">${esc(m.last.reason ?? m.last.status)}</span> <span class="muted">${esc(new Date(m.last.startedAt).toLocaleString())}</span>`;
      // one block per day: all passed, 90% or more, less, or no runs
      const days = m.daily.map((d) => `<i style="background:${!d.runs ? 'var(--line)' : d.uptime === 100 ? 'var(--ok)' : (d.uptime ?? 0) >= 90 ? 'var(--warn)' : 'var(--bad)'}" title="${esc(d.date)}: ${d.runs ? `${d.passed}/${d.runs} runs passed` : 'no runs'}"></i>`).join('');
      out.push(`<tr><td>${esc(m.name)}</td><td>${latest}</td><td><span class="strip">${strip}</span></td><td class="n">${m.total ? pct(m.passed, m.total) : '—'}</td><td><span class="strip days">${days}</span></td><td class="n">${m.uptime}</td></tr>`);
    }
    out.push(`</table>`);
  }

  out.push(`<h2>Latest runs</h2><table><tr><th>Run</th><th>When</th><th>Passed</th><th>Duration</th></tr>`);
  for (const r of runs) out.push(`<tr><td>${esc(r.name)}</td><td>${esc(new Date(r.startedAt).toLocaleString())}</td><td class="n ${r.failed + r.errors ? 'bad' : 'ok'}">${r.passed}/${r.total}</td><td class="n">${ms(r.durationMs)}</td></tr>`);
  if (!runs.length) out.push(`<tr><td colspan="4" class="muted">No runs yet</td></tr>`);
  out.push(`</table>`);

  const slow = a.slowest.filter((s) => s.count > 0);
  if (slow.length) {
    out.push(`<h2>Slowest requests</h2><table><tr><th>Request</th><th>Type</th><th>Average</th><th>Times sent</th></tr>`);
    for (const s of slow) out.push(`<tr><td>${esc(s.name)}</td><td>${esc(s.kind)}</td><td class="n">${ms(s.durationMs)}</td><td class="n">${s.count}</td></tr>`);
    out.push(`</table>`);
  }
  out.push(`<p class="muted">Made with TestPion. Names, counts, statuses and timings only: no request bodies, headers or variable values.</p></body></html>\n`);
  return out.join('\n');
}
