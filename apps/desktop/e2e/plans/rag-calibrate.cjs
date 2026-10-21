// Judge calibration, with real mouse and keys (__t.real): an evaluation of type RAG against the local demo RAG system
// (examples/servers/rag-server.mjs) and a mock judge, then the person's Pass / Fail labels in the sample detail (the matrix
// drill-down), the Calibrate judge report (Cohen's kappa, accuracy, the confusion matrix, the disagreement with the
// sample, the pass mark that agrees most), trying that pass mark in the matrix, and the labels file in the workspace.
// Offline: the mock provider and a local server only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { withExpect, step } = require('../lib.cjs');

const SERVER = resolve(__dirname, '..', '..', '..', '..', 'examples', 'servers', 'rag-server.mjs');
const HTTP = 'http://127.0.0.1:4022';
let WS = '';

async function prepare(ws) {
  WS = ws;
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
  if (globalThis.__e2eRagServer2) return;
  try {
    const m = await import(pathToFileURL(SERVER).href);
    globalThis.__e2eRagServer2 = await m.startRagServer({ port: 4022, grpcPort: 4023 });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
}

const EDITOR_IN = (sel) => `(window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.closest(${JSON.stringify(sel)}))`;
const setSelect = (el, text) => `{ const sel = ${el}; const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(${JSON.stringify(text)})); if (!opt) return 'NO OPTION ${text}'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); }`;
const runButton = `vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim()))`;
const label = (metric, v) => `document.querySelector('[data-rag-label="${metric}|${v}"]')`;
const close = `const cl = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close'); for (const b of cl.reverse()) { await __t.real.click(b); await __t.sleep(300); }`;

const steps = [
  step(
    'a-rag-evaluation-with-faithfulness',
    `await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'RAG')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('[data-rag-target]')`, 'Clinic bot')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="Judge provider"]')`, 'RAG mock judge')}
     await __t.sleep(500);
     await __t.real.click('input[aria-label="Evaluation name"]'); await __t.real.key('a', { ctrl: true }); await __t.real.type('Clinic calibrate'); await __t.sleep(300);
     const ds = tab('Dataset'); if (!ds) return 'NO TAB Dataset';
     await __t.real.click(ds); await __t.sleep(500);
     const ed = ${EDITOR_IN('main')}; if (!ed) return 'NO EDITOR';
     ed.getModel().setValue('{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"]}\\n{"id":"parking","question":"Is there parking at the clinic?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"]}'); await __t.sleep(500);
     const t = tab('Metrics'); if (!t) return 'NO TAB Metrics';
     await __t.real.click(t);
     const picker = await __t.waitFor(() => document.querySelector('[data-rag-picker] [data-rag-metric]') && document.querySelector('[data-rag-picker]'), 8000); if (!picker) return 'NO PICKER';
     const chosen = [...document.querySelectorAll('[data-rag-metric]')].filter((r) => r.querySelector('[data-rag-metric-check]')?.checked).map((r) => r.getAttribute('data-rag-metric'));
     return 'chosen: ' + chosen.join(',');`,
  ),
  step(
    'run-it',
    `await __t.real.click(${runButton});
     const d = await __t.waitFor(() => document.querySelector('[data-rag-estimate-run]'), 10000); if (!d) return 'NO DIALOG';
     await __t.real.click(d); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === 1 && runs[0].total > 0); i++) {
       await __t.sleep(500);
       runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Clinic calibrate');
     }
     return 'runs: ' + runs.length + ' | total: ' + runs[0]?.total;`,
  ),
  step(
    'the-matrix-and-the-sample-detail',
    `const seg = vis('main [role=radio], main button').find((b) => b.textContent.trim() === 'Metrics'); if (!seg) return 'NO METRICS SWITCH';
     await __t.real.click(seg);
     const m = await __t.waitFor(() => document.querySelector('[data-rag-matrix-table] [data-rag-col]') && document.querySelector('[data-rag-matrix]'), 10000); if (!m) return 'NO MATRIX';
     const cell = document.querySelector('[data-rag-cell$="|faithfulness"]'); if (!cell) return 'NO CELL';
     const id = cell.getAttribute('data-rag-cell').split('|')[0];
     cell.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(cell);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-detail]'), 8000); if (!d) return 'NO DETAIL';
     await __t.sleep(500);
     return 'label control: ' + !!${label('faithfulness', 'pass')} + !!${label('faithfulness', 'fail')} + ' | record: ' + id.split(':').pop();`,
  ),
  step(
    'label-the-first-sample-pass',
    `const b = ${label('faithfulness', 'pass')}; if (!b) return 'NO BUTTON pass';
     await __t.real.click(b); await __t.sleep(700);
     const pressed = ${label('faithfulness', 'pass')}.getAttribute('aria-pressed');
     ${close}
     return 'pressed: ' + pressed + ' | detail closed: ' + !document.querySelector('[data-rag-detail]');`,
  ),
  step(
    'label-the-second-sample-pass-against-the-judge',
    `const cells = [...document.querySelectorAll('[data-rag-cell$="|faithfulness"]')]; if (cells.length < 2) return 'NO CELL second';
     await __t.real.click(cells[1]);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-detail]'), 8000); if (!d) return 'NO DETAIL';
     await __t.sleep(500);
     await __t.real.click(${label('faithfulness', 'pass')}); await __t.sleep(700);
     const pressed = ${label('faithfulness', 'pass')}.getAttribute('aria-pressed');
     ${close}
     return 'pressed: ' + pressed;`,
  ),
  step(
    'the-labels-are-a-workspace-file',
    `const runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Clinic calibrate');
     const l = await window.aps.invoke('rag.label.list', { run: runs[0].id });
     return 'file: labels/' + l.labels + '.json | labels: ' + l.items.map((x) => x.record + ':' + x.metric + ':' + x.label).sort().join(',') + ' | judge kept: ' + l.items.every((x) => x.judge && x.judge.model === 'mock-model');`,
  ),
  step(
    'calibrate-judge-shows-the-agreement',
    `const open = document.querySelector('[data-rag-calibrate-open]'); if (!open) return 'NO BUTTON calibrate';
     await __t.real.click(open);
     const c = await __t.waitFor(() => document.querySelector('[data-rag-calibration-metric="faithfulness"]'), 10000); if (!c) return 'NO REPORT: ' + short(document.querySelector('[data-rag-calibration]')?.textContent, 160);
     const conf = [...c.querySelectorAll('[data-rag-confusion] td')].map((x) => x.textContent).join(',');
     const numbers = short(c.querySelector('[data-rag-calibration-numbers]')?.textContent, 120);
     const dis = c.querySelectorAll('[data-rag-disagreements] li').length;
     return 'confusion: ' + conf + ' | numbers: ' + numbers + ' | disagreements: ' + dis + ' | advice: ' + /Only 2 labelled/.test(c.textContent);`,
  ),
  step(
    'the-tuned-pass-mark-can-be-tried-in-the-matrix',
    `const tuned = document.querySelector('[data-rag-tuned="faithfulness"]'); if (!tuned) return 'NO TUNED';
     const text = short(tuned.textContent, 90);
     await __t.real.click(document.querySelector('[data-rag-use-threshold="faithfulness"]')); await __t.sleep(1200);
     const v = Number(document.querySelector('[data-rag-threshold="faithfulness"]').value);
     return 'tuned: ' + /Best pass mark/.test(text) + ' | matrix pass mark now ≤ 0.5: ' + (v <= 0.5) + ' | dialog closed: ' + !document.querySelector('[data-rag-calibration]');`,
  ),
  step(
    'clearing-a-label-removes-it',
    `const cell = document.querySelector('[data-rag-cell$="|faithfulness"]'); await __t.real.click(cell);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-detail]'), 8000); if (!d) return 'NO DETAIL';
     await __t.sleep(500);
     await __t.real.click(${label('faithfulness', 'pass')}); await __t.sleep(700);
     const pressed = ${label('faithfulness', 'pass')}.getAttribute('aria-pressed');
     ${close}
     const runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Clinic calibrate');
     const l = await window.aps.invoke('rag.label.list', { run: runs[0].id });
     return 'pressed: ' + pressed + ' | labels left: ' + l.items.length;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'a-rag-evaluation-with-faithfulness': /^chosen: .*faithfulness/,
    'run-it': /^runs: 1 \| total: 2$/,
    'the-matrix-and-the-sample-detail': /^label control: truetrue \| record: (hours|parking)$/,
    'label-the-first-sample-pass': /^pressed: true \| detail closed: true$/,
    'label-the-second-sample-pass-against-the-judge': /^pressed: true$/,
    'the-labels-are-a-workspace-file': /^file: labels\/Clinic-calibrate\.json \| labels: (hours|parking):faithfulness:pass,(hours|parking):faithfulness:pass \| judge kept: true$/,
    'calibrate-judge-shows-the-agreement': /^confusion: 1,0,1,0 \| numbers: .*Cohen.*kappa.* \| disagreements: 1 \| advice: true$/,
    'the-tuned-pass-mark-can-be-tried-in-the-matrix': /^tuned: true \| matrix pass mark now ≤ 0\.5: true \| dialog closed: true$/,
    'clearing-a-label-removes-it': /^pressed: false \| labels left: 1$/,
  },
  { prepare, settings: { assistantProvider: 'rag-mock-judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'e2e' }] } },
);

void existsSync;
void WS;
