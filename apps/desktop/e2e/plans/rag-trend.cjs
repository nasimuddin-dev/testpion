// The trend of RAG metrics and the nightly side of RAG evaluations, with real mouse and keys (__t.real): an evaluation of type
// RAG against the local demo RAG system (examples/servers/rag-server.mjs) and a mock judge is run twice; the matrix's views
// (By tag, Charts, Compare, Runs × metrics) are opened and the Trend view draws one chart per metric (the shared chart card)
// with the run that was measured differently marked; the monitor editor shows the nightly fields (rotating sample, run cost
// limit, regression gate, the estimate of a run) and saves them; the Run in CI dialog writes a nightly workflow with a schedule,
// a sample and a regression gate. Offline: the mock provider and a local server only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step, EDITOR_IN, setSelect, ensureRagServer } = require('../lib.cjs');

const HTTP = 'http://127.0.0.1:4024';

async function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const verdict = (reasoning, items) => JSON.stringify({ reasoning, items });
  const rules = [
    { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: verdict('The parking claim is in no document.', [{ text: 'The clinic opens at 8am on weekdays.', verdict: true, reason: '[doc-1] "opens at 8am"' }, { text: 'Parking is free for two hours.', verdict: false, reason: 'no document mentions parking' }]) },
    { match: 'faithfulness-v1', response: verdict('Every claim is in the documents.', [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1] "opens at 8am"' }]) },
  ];
  doc.providers.push({ id: 'rag-mock-judge', name: 'RAG mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  mkdirSync(join(ws, 'library'), { recursive: true });
  writeFileSync(
    join(ws, 'library', 'rag-targets.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'rag-clinic', name: 'Clinic bot', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${HTTP}/query`, headers: { 'Content-Type': 'application/json' }, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }] }, null, 2),
  );
  // a saved evaluation for the monitor and the CI dialog to pick (the one built in the window below is a draft until it is saved)
  const dataset = '{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["hours"]}\n{"id":"parking","question":"Is there parking at the clinic?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["parking"]}';
  writeFileSync(
    join(ws, 'library', 'evaluations.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'ev-nightly', name: 'Clinic nightly', data: { name: 'Clinic nightly', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators: [{ type: 'token-f1', threshold: 0.3 }], concurrency: 2, retries: 0, target: 'Clinic bot' } }] }, null, 2),
  );
  await ensureRagServer('__e2eRagServer3', 4024, 4025);
}

const runButton = `vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim()))`;
const runOnce = (n) => `await __t.real.click(${runButton});
     const d = await __t.waitFor(() => document.querySelector('[data-rag-estimate-run]'), 10000); if (!d) return 'NO DIALOG';
     await __t.real.click(d); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === ${n} && runs.every((r) => r.total > 0)); i++) {
       await __t.sleep(500);
       runs = (await window.aps.invoke('runs.list', { limit: 10 })).items.filter((r) => r.name === 'Clinic trend');
     }
     return 'runs: ' + runs.length + ' | total: ' + runs.map((r) => r.total).join(',');`;
const view = (name) => `{ const seg = vis('main [role=radio], main button').find((b) => b.getAttribute('role') !== 'tab' && b.textContent.trim() === ${JSON.stringify(name)}); if (!seg) return 'NO SWITCH ${name}'; await __t.real.click(seg); await __t.sleep(700); }`;

const steps = [
  step(
    'an-evaluation-of-type-rag',
    `await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'Bot with sources')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('[data-rag-target]')`, 'Clinic bot')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="AI reviewer provider"]')`, 'RAG mock judge')}
     await __t.sleep(500);
     await __t.real.click('input[aria-label="Evaluation name"]'); await __t.real.key('a', { ctrl: true }); await __t.real.type('Clinic trend'); await __t.sleep(300);
     const ds = tab('Test cases'); if (!ds) return 'NO TAB Test cases';
     await __t.real.click(ds); await __t.sleep(500);
     const ed = ${EDITOR_IN('main')}; if (!ed) return 'NO EDITOR';
     ed.getModel().setValue('{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["hours"]}\\n{"id":"parking","question":"Is there parking at the clinic?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["parking"]}'); await __t.sleep(500);
     const t = tab('Metrics'); if (!t) return 'NO TAB Metrics';
     await __t.real.click(t);
     const picker = await __t.waitFor(() => document.querySelector('[data-rag-picker] [data-rag-metric]') && document.querySelector('[data-rag-picker]'), 8000); if (!picker) return 'NO PICKER';
     const chosen = [...document.querySelectorAll('[data-rag-metric]')].filter((r) => r.querySelector('[data-rag-metric-check]')?.checked).map((r) => r.getAttribute('data-rag-metric'));
     return 'chosen: ' + chosen.join(',');`,
  ),
  step('the-first-run', runOnce(1)),
  step('the-second-run', runOnce(2)),
  step(
    'the-matrix-views-open',
    `${view('Metrics')}
     const m = await __t.waitFor(() => document.querySelector('[data-rag-matrix-table] [data-rag-col]') && document.querySelector('[data-rag-matrix]'), 10000); if (!m) return 'NO MATRIX';
     const seen = [];
     ${view('By tag')}
     seen.push('tags ' + !!document.querySelector('[data-rag-bytag]'));
     ${view('Charts')}
     seen.push('charts ' + !!document.querySelector('[data-rag-histogram]'));
     ${view('Compare')}
     seen.push('compare ' + /Compare|against|baseline/i.test(document.querySelector('[data-rag-matrix]')?.textContent ?? ''));
     ${view('Runs × metrics')}
     seen.push('pivot ' + !!document.querySelector('[data-rag-matrix] table'));
     return seen.join(' | ');`,
  ),
  step(
    'the-trend-draws-a-chart-per-metric',
    `${view('Trend')}
     const c = await __t.waitFor(() => document.querySelector('[data-rag-trend-chart]'), 10000); if (!c) return 'NO CHART: ' + short(document.querySelector('[data-rag-matrix]')?.textContent, 120);
     const names = [...document.querySelectorAll('[data-rag-trend-chart]')].map((x) => x.getAttribute('data-rag-trend-chart'));
     const card = c.closest('section[data-output="chart"]');
     const out = !!card && !!card.querySelector('[data-output-actions], button[aria-label*="Download" i], button[aria-label*="Save" i], button[aria-label*="Copy" i]');
     const dots = c.querySelectorAll('svg circle').length;
     return 'charts: ' + names.join(',') + ' | points: ' + dots + ' | shared chart card with output: ' + (!!card && out) + ' | findings line: ' + !!document.querySelector('[data-rag-trend-findings]');`,
  ),
  step(
    'the-trend-through-the-engine',
    `const t = await window.aps.invoke('rag.trend', { evaluation: 'Clinic trend' });
     return 'points: ' + t.points.length + ' | faithfulness: ' + t.points.map((p) => p.metrics.faithfulness?.mean).join(',') + ' | judge: ' + t.points[0].judge;`,
  ),
  step(
    'the-monitor-editor-has-the-nightly-fields',
    `await __t.view('Monitors'); await __t.sleep(900);
     const hb = [...document.querySelectorAll('[aria-label^="More actions for Monitors"]')].find((x) => x.offsetParent); if (!hb) return 'NO HEADER MENU';
     hb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(600);
     const add = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((x) => /^New monitor/.test(x.textContent.trim())), 3000); if (!add) return 'NO NEW MONITOR ITEM';
     add.click(); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="What the monitor runs"]')`, 'An evaluation (a prompt, an agent or a bot with sources)')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation"]')`, 'Clinic nightly')}
     await __t.sleep(800);
     const f = await __t.waitFor(() => document.querySelector('[data-rag-monitor-fields]'), 5000); if (!f) return 'NO FIELDS';
     await __t.real.click('input[placeholder="e.g. API health"]'); await __t.real.type('Clinic nightly check'); await __t.sleep(200);
     await __t.real.click('input[aria-label="Number of questions"]'); await __t.real.type('1'); await __t.sleep(200);
     await __t.real.click('input[aria-label="Cost limit of one run in USD"]'); await __t.real.type('0.5'); await __t.sleep(200);
     ${setSelect(`document.querySelector('[data-rag-monitor-baseline]')`, 'Against the previous run')}
     await __t.sleep(300);
     await __t.real.click('input[aria-label="Largest drop allowed"]'); await __t.real.type('0.08'); await __t.sleep(200);
     const rot = [...f.querySelectorAll('label, button, [role=switch]')].find((x) => /Rotate the sample nightly/.test(x.textContent)); if (!rot) return 'NO ROTATE';
     await __t.real.click(rot); await __t.sleep(300);
     const est = await __t.waitFor(() => /One run:/.test(document.querySelector('[data-rag-monitor-estimate]')?.textContent ?? '') && document.querySelector('[data-rag-monitor-estimate]'), 8000);
     return 'estimate: ' + (est ? short(est.textContent, 90) : 'NONE: ' + short(document.querySelector('[data-rag-monitor-estimate]')?.textContent, 90));`,
  ),
  step(
    'saving-keeps-them',
    `const b = vis('button').find((x) => x.textContent.trim() === 'Create monitor'); if (!b) return 'NO SAVE';
     await __t.real.click(b);
     let m;
     for (let i = 0; i < 30 && !m; i++) { await __t.sleep(400); m = (await window.aps.invoke('monitor.list')).find((x) => x.name === 'Clinic nightly check'); }
     if (!m) return 'NOT SAVED';
     return 'rotate: ' + m.rotate + ' | limit: ' + m.limit + ' | maxCostUsd: ' + m.maxCostUsd + ' | baseline: ' + m.baseline + ' | maxDrop: ' + m.maxDrop;`,
  ),
  step(
    'run-in-ci-writes-a-nightly-workflow',
    `await __t.esc();
     await __t.real.key('k', { ctrl: true }); await __t.sleep(400);
     await __t.real.type('Run in CI'); await __t.sleep(500);
     await __t.real.key('Enter'); await __t.sleep(800);
     const dlg = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /Run in CI/.test(d.textContent)), 5000); if (!dlg) return 'NO DIALOG';
     ${setSelect(`[...dlg.querySelectorAll('select')].find((s) => [...s.options].some((o) => /RAG: Clinic nightly/.test(o.textContent)))`, 'RAG: Clinic nightly')}
     const opts = await __t.waitFor(() => dlg.querySelector('[data-ci-rag-options]'), 4000); if (!opts) return 'NO RAG OPTIONS';
     await __t.real.click(dlg.querySelector('[data-ci-rag-nightly]')); await __t.sleep(400);
     await __t.real.click(dlg.querySelector('[data-ci-rag-sample]')); await __t.real.type('25'); await __t.sleep(300);
     const cmd = await __t.waitFor(() => [...dlg.querySelectorAll('pre, code')].map((x) => x.textContent).find((t) => /rag run .*--rotate/.test(t)), 6000);
     const yaml = [...dlg.querySelectorAll('pre')].map((x) => x.textContent).find((t) => /schedule:/.test(t)) ?? '';
     await __t.esc();
     return 'command: ' + (cmd ? (/--limit 25 --rotate/.test(cmd) && /--baseline-results previous\\/results.jsonl/.test(cmd) ? 'sampled with a rotation and a baseline' : cmd) : 'NONE') + ' | workflow: ' + (/cron: '0 3 \\* \\* \\*'/.test(yaml) ? 'on a schedule' : 'NO SCHEDULE');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'an-evaluation-of-type-rag': /^chosen: .*faithfulness/,
    'the-first-run': /^runs: 1 \| total: 2$/,
    'the-second-run': /^runs: 2 \| total: 2,2$/,
    'the-matrix-views-open': /^tags true \| charts true \| compare true \| pivot true$/,
    'the-trend-draws-a-chart-per-metric': /^charts: .*faithfulness.* \| points: 2 \| shared chart card with output: true \| findings line: true$/,
    'the-trend-through-the-engine': /^points: 2 \| faithfulness: 0\.75,0\.75 \| judge: RAG mock judge\/mock-model$/,
    'the-monitor-editor-has-the-nightly-fields': /^estimate: One run:/,
    'saving-keeps-them': /^rotate: true \| limit: 1 \| maxCostUsd: 0\.5 \| baseline: previous \| maxDrop: 0\.08$/,
    'run-in-ci-writes-a-nightly-workflow': /^command: sampled with a rotation and a baseline \| workflow: on a schedule$/,
  },
  { prepare, settings: { assistantProvider: 'rag-mock-judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'e2e' }] } },
);
