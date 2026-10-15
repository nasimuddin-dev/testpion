/**
 * A flow run as a timeline: each step's bar from its start to its end, the wait before it (after the step that held
 * it up), parallel lanes (steps that overlapped), the critical path (the chain of steps, each held up by the one
 * before it, that decided when the run ended), the total time and the slowest steps. Pure: the engine computes it from
 * a run's results (core `flowRunTimeline`), the app draws it with `timelineSvg`, and `timelineHtml` makes the same
 * picture a self-contained HTML file (no network) to share.
 */
import { formatMs } from './format.js';

/** A step of a run, as the timeline needs it. */
export interface TimelineStepInput {
  id: string;
  name: string;
  /** ISO time or epoch ms. */
  startedAt: string | number;
  durationMs: number;
  status: string;
  /** The steps it waits for (dependsOn). */
  dependsOn?: string[];
  /** A finally step: it waits for every other step of the file. */
  finally?: boolean;
  type?: string;
}

export interface TimelineBar {
  id: string;
  name: string;
  status: string;
  type?: string;
  /** Ms from the start of the run. */
  start: number;
  end: number;
  durationMs: number;
  /** The row of the overlap view: steps in different lanes ran at the same time. */
  lane: number;
  /** On the critical path. */
  critical: boolean;
  /** Time between the end of the step that held it up (or the start of the run) and its start. */
  waitMs: number;
  /** The step that held it up: the dependency that ended last (a finally step: the last other step), else the step that freed its worker. */
  blockedBy?: string;
  finally?: boolean;
}

export interface FlowTimeline {
  /** ISO time of the first step's start. */
  startedAt?: string;
  totalMs: number;
  bars: TimelineBar[];
  /** How many lanes: the most steps that ran at once. */
  lanes: number;
  /** Step ids, first to last. */
  criticalPath: string[];
  /** Time on the critical path spent running steps (the rest is waiting). */
  criticalBusyMs: number;
  /** Time no step ran (gaps between the steps of the critical path). */
  waitMs: number;
  slowest: Array<{ id: string; name: string; durationMs: number; status: string }>;
}

const EPS = 2;
const toMs = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t));

/** The timeline of a run's steps (the results of one flow file, any order). */
export function flowTimeline(steps: TimelineStepInput[]): FlowTimeline {
  const valid = steps.filter((s) => Number.isFinite(toMs(s.startedAt)));
  if (!valid.length) return { totalMs: 0, bars: [], lanes: 0, criticalPath: [], criticalBusyMs: 0, waitMs: 0, slowest: [] };
  const t0 = Math.min(...valid.map((s) => toMs(s.startedAt)));
  const bars: TimelineBar[] = valid
    .map((s) => {
      const start = toMs(s.startedAt) - t0;
      const d = Math.max(0, s.durationMs || 0);
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        ...(s.type ? { type: s.type } : {}),
        start,
        end: start + d,
        durationMs: d,
        lane: 0,
        critical: false,
        waitMs: 0,
        ...(s.finally ? { finally: true } : {}),
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const byId = new Map(bars.map((b) => [b.id, b]));
  const input = new Map(valid.map((s) => [s.id, s]));

  // lanes: each bar in the first lane free at its start
  const laneEnds: number[] = [];
  for (const b of bars) {
    let lane = laneEnds.findIndex((end) => end <= b.start + 0.5);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = Math.max(b.end, b.start + 0.001);
    b.lane = lane;
  }

  // what held each step up
  for (const b of bars) {
    const s = input.get(b.id)!;
    let blocker: TimelineBar | undefined;
    const pick = (c: TimelineBar | undefined) => {
      if (c && c !== b && c.end <= b.start + EPS && (!blocker || c.end > blocker.end)) blocker = c;
    };
    if (s.finally) for (const o of bars) !o.finally && pick(o);
    else if (s.dependsOn?.length) for (const d of s.dependsOn) pick(byId.get(d));
    // no dependency (or none that ran): it waited for a worker, when it started after the run began
    if (!blocker && b.start > EPS) for (const o of bars) pick(o);
    if (blocker) b.blockedBy = blocker.id;
    b.waitMs = Math.max(0, Math.round(b.start - (blocker?.end ?? 0)));
  }

  // the critical path: from the step that ended last, back through what held each one up
  const ran = bars.filter((b) => b.status !== 'skipped');
  const last = (ran.length ? ran : bars).reduce((a, b) => (b.end > a.end || (b.end === a.end && b.start > a.start) ? b : a));
  const path: TimelineBar[] = [];
  const seen = new Set<string>();
  for (let cur: TimelineBar | undefined = last; cur && !seen.has(cur.id); cur = cur.blockedBy ? byId.get(cur.blockedBy) : undefined) {
    seen.add(cur.id);
    cur.critical = true;
    path.unshift(cur);
  }
  const totalMs = Math.round(Math.max(...bars.map((b) => b.end)));
  const criticalBusyMs = Math.round(path.reduce((n, b) => n + b.durationMs, 0));
  return {
    startedAt: new Date(t0).toISOString(),
    totalMs,
    bars,
    lanes: laneEnds.length,
    criticalPath: path.map((b) => b.id),
    criticalBusyMs,
    waitMs: Math.max(0, Math.round(path.reduce((n, b) => n + b.waitMs, 0))),
    slowest: [...bars]
      .filter((b) => b.durationMs > 0)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((b) => ({ id: b.id, name: b.name, durationMs: Math.round(b.durationMs), status: b.status })),
  };
}

/* ------------------------------------------------------------------ rendering */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A round step for the time axis (1, 2 or 5 × 10^n ms) giving about `n` ticks. */
function tickStep(total: number, n = 6): number {
  const raw = Math.max(1, total / n);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw;
}

const STATUS_FILL: Record<string, string> = { passed: 'var(--tl-ok)', failed: 'var(--tl-bad)', error: 'var(--tl-bad)', skipped: 'var(--tl-skip)' };

/**
 * The timeline as an SVG (one row per step, in the order they started): the wait before a step as a dashed line from
 * the step that held it up, the bar coloured by status, the critical path outlined, a lane mark (L1, L2 …) when steps
 * overlapped, the time axis on top, a tooltip (<title>) per bar. Colours are CSS variables (--tl-*: see TIMELINE_CSS)
 * so the app's theme and the HTML file draw it the same way. Each bar's group has data-step-id.
 */
export function timelineSvg(t: FlowTimeline, o: { width?: number } = {}): string {
  const W = Math.max(480, o.width ?? 960);
  const label = 210;
  const right = 70;
  const row = 24;
  const top = 34;
  const plot = W - label - right;
  const total = Math.max(1, t.totalMs);
  const x = (ms: number) => label + (ms / total) * plot;
  const H = top + t.bars.length * row + 12;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="tl" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Run timeline: ${t.bars.length} steps, ${esc(formatMs(t.totalMs))}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="12">`,
  );
  // axis
  const step = tickStep(total);
  for (let ms = 0; ms <= total + 0.5; ms += step) {
    const xx = x(ms).toFixed(1);
    out.push(`<line x1="${xx}" y1="${top - 6}" x2="${xx}" y2="${H - 8}" stroke="var(--tl-grid)" stroke-width="1"/>`);
    out.push(`<text x="${xx}" y="${top - 12}" text-anchor="middle" fill="var(--tl-muted)" font-size="11">${esc(formatMs(ms))}</text>`);
  }
  t.bars.forEach((b, i) => {
    const y = top + i * row;
    const bx = x(b.start);
    const bw = Math.max(2, x(b.end) - bx);
    const fill = STATUS_FILL[b.status] ?? 'var(--tl-accent)';
    const name = b.name.length > 30 ? `${b.name.slice(0, 29)}…` : b.name;
    const tip = [
      `${b.name} (${b.id})`,
      `${b.status} · ${formatMs(b.durationMs)}`,
      `starts at ${formatMs(b.start)}, ends at ${formatMs(b.end)}`,
      b.waitMs ? `waited ${formatMs(b.waitMs)}${b.blockedBy ? ` after ${b.blockedBy}` : ''}` : b.blockedBy ? `right after ${b.blockedBy}` : '',
      b.critical ? 'on the critical path' : '',
      b.finally ? 'finally step' : '',
    ]
      .filter(Boolean)
      .join('\n');
    out.push(`<g class="tl-step${b.critical ? ' tl-critical' : ''}" data-step-id="${esc(b.id)}" data-status="${esc(b.status)}"${b.critical ? ' data-critical="true"' : ''}>`);
    out.push(`<title>${esc(tip)}</title>`);
    if (i % 2) out.push(`<rect x="0" y="${y}" width="${W}" height="${row}" fill="var(--tl-stripe)"/>`);
    out.push(`<text x="8" y="${y + row / 2 + 4}" fill="var(--tl-fg)"${b.critical ? ' font-weight="600"' : ''}>${esc(name)}</text>`);
    if (t.lanes > 1) out.push(`<text x="${label - 8}" y="${y + row / 2 + 4}" text-anchor="end" fill="var(--tl-muted)" font-size="10">L${b.lane + 1}</text>`);
    if (b.waitMs > 0) {
      const wx = x(b.start - b.waitMs);
      out.push(`<line x1="${wx.toFixed(1)}" y1="${y + row / 2}" x2="${bx.toFixed(1)}" y2="${y + row / 2}" stroke="var(--tl-muted)" stroke-width="1.5" stroke-dasharray="3 3"/>`);
    }
    out.push(
      `<rect x="${bx.toFixed(1)}" y="${y + 5}" width="${bw.toFixed(1)}" height="${row - 10}" rx="3" fill="${fill}"${b.status === 'skipped' ? ' fill-opacity="0.6"' : ''}${b.critical ? ' stroke="var(--tl-critical)" stroke-width="2"' : ''}/>`,
    );
    out.push(`<text x="${(bx + bw + 5).toFixed(1)}" y="${y + row / 2 + 4}" fill="var(--tl-muted)" font-size="11">${esc(formatMs(b.durationMs))}</text>`);
    out.push('</g>');
  });
  out.push('</svg>');
  return out.join('');
}

/** The timeline's colours: light and dark (the app sets them from its theme tokens; the HTML file carries these). */
export const TIMELINE_CSS = `
:root{--tl-bg:#fff;--tl-fg:#1f2230;--tl-muted:#6b6f80;--tl-grid:#e6e8ef;--tl-stripe:rgba(120,130,160,.06);--tl-ok:#2e9e5b;--tl-bad:#d9483b;--tl-skip:#b8bccb;--tl-accent:#2f7bff;--tl-critical:#8b5cff;--tl-line:#e2e4ec}
@media (prefers-color-scheme: dark){:root{--tl-bg:#171a26;--tl-fg:#eceef6;--tl-muted:#a2a7bb;--tl-grid:#2a2e3e;--tl-stripe:rgba(255,255,255,.03);--tl-ok:#3fbf73;--tl-bad:#f0645a;--tl-skip:#5b6075;--tl-accent:#5e9bff;--tl-critical:#b18cff;--tl-line:#2c3040}}
`;

/** The timeline as a self-contained HTML page (inline CSS and SVG, no scripts, no network): what `Save as HTML` writes. */
export function timelineHtml(t: FlowTimeline, meta: { title: string; file?: string; runId?: string; environment?: string; status?: string; generatedAt?: string }): string {
  const crit = t.criticalPath.map((id) => t.bars.find((b) => b.id === id)).filter((b): b is TimelineBar => !!b);
  const facts = [
    ['Total', formatMs(t.totalMs)],
    ['Steps', String(t.bars.length)],
    ['Critical path', `${crit.length} step${crit.length === 1 ? '' : 's'} · ${formatMs(t.criticalBusyMs)} running${t.waitMs ? ` + ${formatMs(t.waitMs)} waiting` : ''}`],
    ['Most at once', String(t.lanes)],
    ...(meta.status ? [['Status', meta.status]] : []),
    ...(meta.environment ? [['Environment', meta.environment]] : []),
    ...(meta.runId ? [['Run', meta.runId]] : []),
    ...(t.startedAt ? [['Started', t.startedAt]] : []),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)}</title>
<style>${TIMELINE_CSS}
body{margin:0;padding:24px 16px;background:var(--tl-bg);color:var(--tl-fg);font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--tl-muted);margin:0 0 16px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0}.facts div{border:1px solid var(--tl-line);border-radius:8px;padding:6px 10px}.facts dt{font-size:11px;color:var(--tl-muted)}.facts dd{margin:0;font-weight:600}
.card{border:1px solid var(--tl-line);border-radius:10px;padding:8px;overflow-x:auto}.tl{min-width:640px;display:block}
h2{font-size:15px;margin:20px 0 8px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--tl-line)}th{color:var(--tl-muted);font-weight:500;font-size:12px}td.n{text-align:right;font-variant-numeric:tabular-nums}
.legend{color:var(--tl-muted);font-size:12px;margin:8px 0 0}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}
</style></head><body><main>
<h1>${esc(meta.title)}</h1>
<p class="sub">${esc([meta.file ? `tests/${meta.file}` : '', meta.generatedAt ? `generated ${meta.generatedAt}` : ''].filter(Boolean).join(' · '))}</p>
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k!)}</dt><dd>${esc(v!)}</dd></div>`).join('')}</dl>
<div class="card">${timelineSvg(t)}</div>
<p class="legend"><span class="sw" style="background:var(--tl-ok)"></span>passed<span class="sw" style="background:var(--tl-bad)"></span>failed<span class="sw" style="background:var(--tl-skip)"></span>skipped<span class="sw" style="border:2px solid var(--tl-critical)"></span>critical path · dashed: waiting · L1, L2: steps that ran at the same time</p>
<h2>Critical path</h2>
<table><thead><tr><th>Step</th><th>Status</th><th class="n">Waited</th><th class="n">Took</th><th class="n">Ends at</th></tr></thead><tbody>
${crit.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.status)}</td><td class="n">${esc(formatMs(b.waitMs))}</td><td class="n">${esc(formatMs(b.durationMs))}</td><td class="n">${esc(formatMs(b.end))}</td></tr>`).join('\n')}
</tbody></table>
<h2>Slowest steps</h2>
<table><thead><tr><th>Step</th><th>Status</th><th class="n">Took</th></tr></thead><tbody>
${t.slowest.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.status)}</td><td class="n">${esc(formatMs(b.durationMs))}</td></tr>`).join('\n')}
</tbody></table>
</main></body></html>
`;
}
