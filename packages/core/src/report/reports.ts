import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatUsd } from '@testpion/shared';
import type { RunSummary, TestResult } from '../model/types.js';
import { formatDuration } from '../util/stats.js';
import { endAndClose } from '../storage/fsutil.js';
import { runBreakdown, type RunBreakdown } from '../runner/breakdown.js';

export type ReportFormat = 'json' | 'junit' | 'html' | 'markdown';

const MAX_DETAILED = 5000;

function xml(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const html = xml;

function md(s: unknown, n = 120): string {
  const t = String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

async function writeAll(path: string, fn: (w: (s: string) => Promise<void>) => Promise<void>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const out: WriteStream = createWriteStream(path, 'utf8');
  const w = async (s: string) => {
    if (!out.write(s)) await new Promise<void>((r) => out.once('drain', () => r()));
  };
  await fn(w);
  await endAndClose(out);
}

function failureText(r: TestResult): string {
  const lines: string[] = [];
  if (r.error) lines.push(`${r.error.kind}: ${r.error.message}`, ...r.error.suggestions.map((s) => `  hint: ${s}`));
  for (const c of r.checks.filter((c) => !c.passed)) lines.push(`[${c.source}] ${c.name}: ${c.message}`);
  return lines.join('\n');
}

export async function writeJsonReport(path: string, summary: RunSummary, results: AsyncIterable<TestResult>): Promise<void> {
  await writeAll(path, async (w) => {
    await w(`{"schemaVersion":"1.0","summary":${JSON.stringify(summary)},"results":[`);
    let first = true;
    for await (const r of results) {
      await w((first ? '\n' : ',\n') + JSON.stringify(r));
      first = false;
    }
    await w('\n]}\n');
  });
}

export async function writeJUnitReport(path: string, summary: RunSummary, results: AsyncIterable<TestResult>): Promise<void> {
  await writeAll(path, async (w) => {
    await w('<?xml version="1.0" encoding="UTF-8"?>\n');
    await w(
      `<testsuites name="${xml(summary.name)}" tests="${summary.total}" failures="${summary.failed}" errors="${summary.errors}" skipped="${summary.skipped}" time="${(summary.durationMs / 1000).toFixed(3)}">\n`,
    );
    await w(
      `  <testsuite name="${xml(summary.name)}" tests="${summary.total}" failures="${summary.failed}" errors="${summary.errors}" skipped="${summary.skipped}" time="${(summary.durationMs / 1000).toFixed(3)}" timestamp="${xml(summary.startedAt)}">\n`,
    );
    for await (const r of results) {
      await w(`    <testcase name="${xml(r.name)}" classname="${xml(r.file ?? r.type)}" time="${(r.durationMs / 1000).toFixed(3)}">\n`);
      if (r.status === 'failed') await w(`      <failure message="${xml(r.checks.filter((c) => !c.passed).map((c) => c.message).join('; ').slice(0, 500))}">${xml(failureText(r))}</failure>\n`);
      else if (r.status === 'error') await w(`      <error message="${xml(r.error?.message ?? 'error')}" type="${xml(r.error?.kind ?? 'Error')}">${xml(failureText(r))}</error>\n`);
      else if (r.status === 'skipped') await w(`      <skipped message="${xml(r.metadata?.reason ?? '')}"/>\n`);
      const props: string[] = [];
      if (r.model) props.push(`model=${r.model}`);
      if (r.latencyMs !== undefined) props.push(`latencyMs=${r.latencyMs}`);
      if (r.tokens) props.push(`tokens=${r.tokens.totalTokens}`);
      if (r.costUsd !== undefined) props.push(`costUsd=${r.costUsd}`);
      if (props.length) await w(`      <system-out>${xml(props.join('\n'))}</system-out>\n`);
      await w('    </testcase>\n');
    }
    await w('  </testsuite>\n</testsuites>\n');
  });
}

function summaryLines(s: RunSummary): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Total tests', String(s.total)],
    ['Passed', String(s.passed)],
    ['Failed', String(s.failed)],
    ['Errors', String(s.errors)],
    ['Skipped', String(s.skipped)],
    ['Duration', formatDuration(s.durationMs)],
    ['Latency p50 / p95 / p99', `${s.latency.p50} / ${s.latency.p95} / ${s.latency.p99} ms`],
  ];
  if (s.tokens.totalTokens) rows.push(['Tokens (in / out / total)', `${s.tokens.inputTokens} / ${s.tokens.outputTokens} / ${s.tokens.totalTokens}`]);
  if (s.costUsd) rows.push(['Estimated cost', `${formatUsd(s.costUsd)} (estimate from configured prices)`]);
  if (s.environment) rows.push(['Environment', s.environment]);
  if (s.cancelled) rows.push(['Cancelled', 'yes']);
  return rows;
}

export async function writeMarkdownReport(path: string, summary: RunSummary, results: AsyncIterable<TestResult>): Promise<void> {
  await writeAll(path, async (w) => {
    const status = summary.failed + summary.errors === 0 ? '✅ Passed' : '❌ Failed';
    await w(`# ${summary.name} — ${status}\n\n_Run ${summary.runId} · ${summary.startedAt}_\n\n| Metric | Value |\n|---|---|\n`);
    for (const [k, v] of summaryLines(summary)) await w(`| ${k} | ${v} |\n`);
    if (Object.keys(summary.scores).length) {
      await w('\n## Evaluation scores\n\n| Evaluator | Mean score | Count |\n|---|---|---|\n');
      for (const [k, v] of Object.entries(summary.scores)) await w(`| ${k} | ${v.mean} | ${v.count} |\n`);
    }
    await w('\n## Results\n\n| Status | Test | Type | Model | Latency | Tokens | Cost | Details |\n|---|---|---|---|---|---|---|---|\n');
    const icon: Record<string, string> = { passed: '✅', failed: '❌', error: '⚠️', skipped: '⏭️' };
    const ai: TestResult[] = [];
    let n = 0;
    let omitted = 0;
    for await (const r of results) {
      if (n >= MAX_DETAILED && r.status === 'passed') {
        omitted++;
        continue;
      }
      n++;
      await w(
        `| ${icon[r.status]} | ${md(r.name, 80)} | ${r.type} | ${md(r.model ?? '', 40)} | ${r.latencyMs ?? ''} | ${r.tokens?.totalTokens ?? ''} | ${r.costUsd !== undefined ? '$' + r.costUsd : ''} | ${md(r.status === 'passed' ? '' : failureText(r), 160)} |\n`,
      );
      if (['llm', 'rag', 'agent'].includes(r.type) && ai.length < 200) ai.push(r);
    }
    if (omitted) await w(`\n_${omitted} further passing tests omitted — see the JSON report for all results._\n`);
    if (ai.length) {
      await w('\n## AI evaluation details\n\n> Scores marked **ai-judge** are model-generated judgements, not deterministic results.\n');
      for (const r of ai) {
        await w(`\n### ${md(r.name, 200)}\n\n- **Model:** ${r.model ?? 'n/a'}\n- **Latency:** ${r.latencyMs ?? 'n/a'} ms · **Tokens:** ${r.tokens?.totalTokens ?? 'n/a'} · **Cost:** ${r.costUsd !== undefined ? '$' + r.costUsd : 'n/a'}\n`);
        if (r.input) await w(`- **Input:** ${md(r.input, 400)}\n`);
        if (r.output) await w(`- **Output:** ${md(r.output, 400)}\n`);
        await w('\n| Evaluator | Source | Result | Score | Explanation |\n|---|---|---|---|---|\n');
        for (const c of r.checks) await w(`| ${md(c.name, 60)} | ${c.source} | ${c.passed ? 'pass' : 'fail'} | ${c.score ?? ''} | ${md(c.explanation ?? c.message, 200)} |\n`);
      }
    }
  });
}

/** Passed / failed / errors / skipped as one proportional bar (static HTML, no script). */
function resultBarHtml(s: RunSummary): string {
  const parts: Array<[string, number, string]> = [
    ['passed', s.passed, 'var(--ok)'],
    ['failed', s.failed, 'var(--bad)'],
    ['errors', s.errors, 'var(--bad)'],
    ['skipped', s.skipped, 'var(--warn)'],
  ];
  if (!s.total) return '';
  const pct = (n: number) => Math.round((n / s.total) * 1000) / 10;
  return (
    `<div class="bar" role="img" aria-label="${parts.map(([k, n]) => `${n} ${k}`).join(', ')}">` +
    parts
      .filter(([, n]) => n > 0)
      .map(([k, n, c]) => `<span style="flex:${n};background:${c}${k === 'errors' ? ';opacity:.7' : ''}" title="${n} ${k} (${pct(n)}%)"></span>`)
      .join('') +
    `</div><div class="legend">${parts
      .filter(([, n]) => n > 0)
      .map(([k, n, c]) => `<span><i style="background:${c}${k === 'errors' ? ';opacity:.7' : ''}"></i>${n} ${k} · ${pct(n)}%</span>`)
      .join('')}</div>`
  );
}

/** Response-time histogram (passed and failed per range), slowest tests and most failed checks, as static SVG and HTML. */
export function breakdownHtml(b: RunBreakdown): string {
  const out: string[] = [];
  if (b.timed) {
    const W = 560;
    const H = 170;
    const pad = { l: 36, r: 6, t: 8, b: 24 };
    const max = Math.max(2, ...b.histogram.map((x) => x.passed + x.failed));
    const slot = (W - pad.l - pad.r) / b.histogram.length;
    const bw = Math.min(56, slot * 0.72);
    const base = H - pad.b;
    const h = (v: number) => (v / max) * (base - pad.t);
    const bound = (ms: number) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`);
    const label = (x: (typeof b.histogram)[number]) => (x.toMs === undefined ? `≥ ${bound(x.fromMs)}` : x.fromMs === 0 ? `< ${bound(x.toMs)}` : `${bound(x.fromMs)}–${bound(x.toMs)}`);
    const bars = b.histogram
      .map((x, i) => {
        const cx = pad.l + slot * i + slot / 2;
        const okH = h(x.passed);
        const badH = h(x.failed);
        return (
          `<g><title>${html(label(x))}: ${x.passed} passed, ${x.failed} failed</title>` +
          `<rect x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${base - pad.t}" fill="transparent"/>` +
          (okH ? `<rect x="${cx - bw / 2}" y="${base - okH}" width="${bw}" height="${okH}" rx="2" fill="var(--ok)"/>` : '') +
          (badH ? `<rect x="${cx - bw / 2}" y="${base - okH - badH - (okH ? 2 : 0)}" width="${bw}" height="${badH}" rx="2" fill="var(--bad)"/>` : '') +
          `<text x="${cx}" y="${H - 8}" text-anchor="middle">${html(label(x))}</text></g>`
        );
      })
      .join('');
    const grid = [0, Math.round(max / 2), max].map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${base - h(t)}" y2="${base - h(t)}"/><text x="${pad.l - 6}" y="${base - h(t) + 3}" text-anchor="end">${t}</text>`).join('');
    out.push(
      `<section class="chart"><h3>Response time <span class="muted" style="text-transform:none;font-weight:400;margin-left:6px">tests per range</span></h3><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tests per response-time range">${grid}${bars}</svg><div class="legend"><span><i style="background:var(--ok)"></i>Passed</span><span><i style="background:var(--bad)"></i>Failed</span></div></section>`,
    );
  }
  if (b.phases) {
    // where the requests' time went: one bar per phase (connection set-up lighter), its share of the whole
    const p = b.phases;
    const phases = [
      ['DNS lookup', p.dnsMs, true],
      ['TCP connect', p.tcpMs, true],
      ['TLS handshake', p.tlsMs, true],
      ['Server (TTFB)', p.ttfbMs, false],
      ['Download', p.downloadMs, false],
    ] as const;
    const total = phases.reduce((n, [, v]) => n + v, 0) || 1;
    const max = Math.max(1, ...phases.map(([, v]) => v));
    const ms = (v: number) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
    const rows = phases
      .map(
        ([name, v, connect]) =>
          `<tr><td>${name}</td><td style="width:100%"><span style="display:block;height:10px;border-radius:2px;background:var(--accent);opacity:${connect ? 0.5 : 0.9};width:${v ? Math.max(0.5, (v / max) * 100) : 0}%"></span></td><td style="text-align:right;white-space:nowrap">${ms(v)}</td><td style="text-align:right" class="muted">${Math.round((v / total) * 100)}%</td></tr>`,
      )
      .join('');
    out.push(
      `<section class="chart"><h3>Where the time went <span class="muted" style="text-transform:none;font-weight:400;margin-left:6px">${p.requests} request${p.requests === 1 ? '' : 's'} · ${p.newConnections} new connection${p.newConnections === 1 ? '' : 's'}, ${p.reused} reused</span></h3><table>${rows}</table><div class="legend"><span><i style="background:var(--accent);opacity:.5"></i>Setting up connections</span><span><i style="background:var(--accent)"></i>The request itself</span></div></section>`,
    );
  }
  if (b.scores.length) {
    // per evaluator: five columns for 0–0.2 … 0.8–1, as small inline bars
    const rows = b.scores
      .map((s) => {
        const max = Math.max(1, ...s.buckets);
        const bars = s.buckets.map((n, i) => `<span title="${['0–0.2', '0.2–0.4', '0.4–0.6', '0.6–0.8', '0.8–1'][i]}: ${n}" style="display:inline-block;width:12px;margin-right:2px;vertical-align:bottom;border-radius:2px;background:var(--ok);opacity:${0.45 + i * 0.13};height:${n ? Math.max(3, Math.round((n / max) * 24)) : 0}px"></span>`).join('');
        return `<tr><td>${html(s.name)}</td><td style="text-align:right" class="${s.mean >= 0.7 ? 'passed' : 'skipped'}">${s.mean.toFixed(2)}</td><td style="text-align:right">${s.count}</td><td style="height:28px">${bars}</td></tr>`;
      })
      .join('');
    out.push(`<section class="chart"><h3>Scores <span class="muted" style="text-transform:none;font-weight:400;margin-left:6px">per evaluator, 0 to 1</span></h3><table><tr><th>Evaluator</th><th>Mean</th><th>Scores</th><th>0 → 1</th></tr>${rows}</table></section>`);
  }
  if (b.slowest.length)
    out.push(`<section class="chart"><h3>Slowest tests</h3><table>${b.slowest.map((r) => `<tr><td class="${r.status}">${r.status}</td><td>${html(r.name)}</td><td style="text-align:right">${r.latencyMs} ms</td></tr>`).join('')}</table></section>`);
  if (b.flaky.length)
    out.push(`<section class="chart"><h3>Flaky tests <span class="muted" style="text-transform:none;font-weight:400;margin-left:6px">passed after a retry</span></h3><table>${b.flaky.map((f) => `<tr><td>${html(f.name)}</td><td class="skipped" style="text-align:right">${f.attempts} attempts</td></tr>`).join('')}</table></section>`);
  if (b.failingChecks.length)
    out.push(`<section class="chart"><h3>Checks that failed most</h3><table>${b.failingChecks.map((c) => `<tr><td>${html(c.name)}</td><td class="failed" style="text-align:right">${c.count}×</td></tr>`).join('')}</table></section>`);
  return out.length ? `<div class="charts" id="charts">${out.join('')}</div>` : '';
}

export async function writeHtmlReport(path: string, summary: RunSummary, results: AsyncIterable<TestResult>): Promise<void> {
  await writeAll(path, async (w) => {
    const ok = summary.failed + summary.errors === 0;
    await w(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(summary.name)} — TestPion report</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--accent:#0969da;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#4493f8;--card:#161b22}}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.card b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--card)}.passed{color:var(--ok)}.failed,.error{color:var(--bad)}.skipped{color:var(--warn)}
details summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;background:var(--card);padding:8px;border-radius:6px;max-height:300px;overflow:auto}
.bar{display:flex;gap:2px;height:14px;margin:4px 0 6px}.bar span{border-radius:3px;min-width:3px}.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin:0 0 16px}.chart{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.chart h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 8px}.chart svg{width:100%;height:auto;font-size:10px}.chart svg text{fill:var(--muted)}.chart svg line{stroke:var(--line)}.chart table{font-size:12px}.chart td{padding:3px 6px}
.tag{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 6px;margin-left:4px}.judge{border-color:#8250df;color:#8250df}
input{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:280px}
</style></head><body>
<h1>${html(summary.name)} <span class="${ok ? 'passed' : 'failed'}">${ok ? 'PASSED' : 'FAILED'}</span></h1>
<div class="muted">Run ${html(summary.runId)} · ${html(summary.startedAt)}${summary.environment ? ' · env ' + html(summary.environment) : ''}</div>
<div class="cards">`);
    for (const [k, v] of summaryLines(summary)) await w(`<div class="card"><span class="muted">${html(k)}</span><b>${html(v)}</b></div>`);
    for (const [k, v] of Object.entries(summary.scores)) await w(`<div class="card"><span class="muted">score: ${html(k)}</span><b>${v.mean}</b><span class="muted">${v.count} check${v.count === 1 ? '' : 's'}</span></div>`);
    await w(`</div>
${resultBarHtml(summary)}
<div id="charts-slot"></div>
<p><input id="q" placeholder="Filter tests…" oninput="f()"> <label><input type="checkbox" id="fo" onchange="f()" style="width:auto"> failures only</label></p>
<p class="muted">Checks tagged <span class="tag judge">ai-judge</span> are model-generated judgements; <span class="tag">heuristic</span> checks are approximate. Costs are estimates from configured prices.</p>
<table><thead><tr><th>Status</th><th>Test</th><th>Type</th><th>Model</th><th>Latency ms</th><th>Tokens</th><th>Cost</th><th>Checks</th></tr></thead><tbody id="rows">\n`);
    let n = 0;
    let omitted = 0;
    // the charts need every result; they are written after the table and moved above it (below without scripts)
    const breakdown = runBreakdown();
    for await (const r of results) {
      breakdown.add(r);
      if (n >= MAX_DETAILED && r.status === 'passed') {
        omitted++;
        continue;
      }
      n++;
      const checks = r.checks
        .map((c) => `<div class="${c.passed ? 'passed' : 'failed'}">${c.passed ? '✓' : '✗'} ${html(c.name)}<span class="tag ${c.source === 'ai-judge' ? 'judge' : ''}">${c.source}</span>${c.score !== undefined ? ` <b>${c.score}</b>` : ''} — ${html(c.message)}${c.explanation ? `<div class="muted">${html(c.explanation)}</div>` : ''}</div>`)
        .join('');
      const detail = [r.error ? `<pre>${html(failureText(r))}</pre>` : '', r.input ? `<div class="muted">Input</div><pre>${html(r.input)}</pre>` : '', r.output ? `<div class="muted">Output</div><pre>${html(r.output)}</pre>` : ''].join('');
      await w(
        `<tr data-s="${r.status}"><td class="${r.status}">${r.status}</td><td><details><summary>${html(r.name)}</summary>${detail}</details></td><td>${r.type}</td><td>${html(r.model ?? '')}</td><td>${r.latencyMs ?? ''}</td><td>${r.tokens?.totalTokens ?? ''}</td><td>${r.costUsd !== undefined ? '$' + r.costUsd : ''}</td><td>${checks}</td></tr>\n`,
      );
    }
    await w(`</tbody></table>${omitted ? `<p class="muted">${omitted} further passing tests omitted — see the JSON report.</p>` : ''}
${breakdownHtml(breakdown.result())}
<script>{const c=document.getElementById('charts');if(c)document.getElementById('charts-slot').replaceWith(c)}</script>
<script>function f(){const q=document.getElementById('q').value.toLowerCase(),fo=document.getElementById('fo').checked;for(const tr of document.querySelectorAll('#rows tr')){const s=tr.dataset.s;tr.style.display=(!q||tr.textContent.toLowerCase().includes(q))&&(!fo||s==='failed'||s==='error')?'':'none'}}</script>
<p class="muted">Generated by TestPion</p></body></html>\n`);
  });
}

/** Write the requested report formats by streaming the JSONL results file once per format. */
export async function writeReports(
  dir: string,
  summary: RunSummary,
  results: () => AsyncIterable<TestResult>,
  formats: ReportFormat[] = ['json', 'junit', 'html', 'markdown'],
): Promise<Record<ReportFormat, string>> {
  const paths = {} as Record<ReportFormat, string>;
  for (const f of formats) {
    const p = join(dir, { json: 'report.json', junit: 'junit.xml', html: 'report.html', markdown: 'report.md' }[f]);
    if (f === 'json') await writeJsonReport(p, summary, results());
    if (f === 'junit') await writeJUnitReport(p, summary, results());
    if (f === 'html') await writeHtmlReport(p, summary, results());
    if (f === 'markdown') await writeMarkdownReport(p, summary, results());
    paths[f] = p;
  }
  return paths;
}
