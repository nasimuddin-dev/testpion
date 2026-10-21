// RAG testing, second half, with real mouse and keys (__t.real): an evaluation of type RAG against the local demo RAG
// system (examples/servers/rag-server.mjs) and a mock judge. The metric picker (138 metrics, a Ragas name finds its metric,
// the RAG triad preset in one click, the inputs a dataset lacks said in amber, the estimate under the list), Try on one
// sample (ask the target, the exact prompt before anything is sent, then the score), the estimate dialog before a run, the
// samples × metrics matrix (columns grouped by type, the aggregates, an edited pass mark deciding pass and fail again, why
// a sample failed, the drill-down with the contexts lane and "Try again with another judge"), the dataset column mapper, the
// Connect dialog's presets, limits and AI Suggest mapping. Offline: the mock provider and a local server only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step, EDITOR_IN, setSelect, ensureRagServer } = require('../lib.cjs');

const HTTP = 'http://127.0.0.1:4020';

/** The mock judge's verdicts, a mock answer for Suggest mapping, a saved target, and the local RAG system on 4020/4021. */
async function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const verdict = (reasoning, items) => JSON.stringify({ reasoning, items });
  const rules = [
    // the mapping the AI suggests for the demo system's response
    { match: 'protocol', response: JSON.stringify({ mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' }, usage: { input: '$.usage.prompt_tokens', output: '$.usage.completion_tokens' } }, notes: ['check the score scale'] }) },
    { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: verdict('The parking claim is in no document.', [{ text: 'The clinic opens at 8am on weekdays.', verdict: true, reason: '[doc-1] "opens at 8am"' }, { text: 'Parking is free for two hours.', verdict: false, reason: 'no document mentions parking' }]) },
    { match: 'faithfulness-v1', response: verdict('Every claim is in the documents.', [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1] "opens at 8am"' }]) },
    { match: 'answer-relevance-v1', response: verdict('It answers the question.', [{ text: 'It answers.', verdict: true, reason: 'addresses the question' }]) },
    { match: 'context-relevance-chunks-v1', response: JSON.stringify({ reasoning: 'doc-1 answers it', items: [{ text: 'doc-1', verdict: true, rating: 3, reason: 'has the opening hours' }, { text: 'doc-2', verdict: false, rating: 0, reason: 'about vaccines' }] }) },
  ];
  doc.providers.push({ id: 'rag-mock-judge', name: 'RAG mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  mkdirSync(join(ws, 'library'), { recursive: true });
  writeFileSync(
    join(ws, 'library', 'rag-targets.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'rag-clinic', name: 'Clinic bot', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${HTTP}/query`, headers: { 'Content-Type': 'application/json' }, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }] }, null, 2),
  );
  // started once per runner (the retry of a plan finds it up); one already up on the port is another runner's
  await ensureRagServer('__e2eRagServer', 4020, 4021);
}

const row = (id) => `document.querySelector('[data-rag-metric="${id}"]')`;
const runButton = `vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim()))`;

const steps = [
  step(
    'a-rag-evaluation-with-the-metrics-tab',
    `await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'RAG')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('[data-rag-target]')`, 'Clinic bot')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="Judge provider"]')`, 'RAG mock judge')}
     await __t.sleep(500);
     await __t.real.click('input[aria-label="Evaluation name"]'); await __t.real.key('a', { ctrl: true }); await __t.real.type('Clinic metrics'); await __t.sleep(300);
     const t = tab('Metrics'); if (!t) return 'NO TAB Metrics';
     await __t.real.click(t);
     const picker = await __t.waitFor(() => document.querySelector('[data-rag-picker] [data-rag-metric]') && document.querySelector('[data-rag-picker]'), 8000); if (!picker) return 'NO PICKER';
     return 'metrics listed: ' + picker.querySelectorAll('[data-rag-metric]').length + ' | groups: ' + picker.querySelectorAll('[data-rag-group]').length + ' | presets: ' + picker.querySelectorAll('[data-rag-preset]').length + ' | judge options: ' + !!document.querySelector('[data-rag-judge-options]');`,
  ),
  step(
    'a-ragas-name-finds-its-metric',
    `document.querySelector('[data-rag-picker-search]').scrollIntoView({ block: 'center' }); await __t.sleep(200); await __t.real.click('[data-rag-picker-search]'); await __t.real.type('LLMContextRecall'); await __t.sleep(600);
     const shown = vis('[data-rag-metric]').map((r) => r.getAttribute('data-rag-metric'));
     await __t.real.key('a', { ctrl: true }); await __t.real.key('Backspace'); await __t.sleep(300);
     document.querySelector('[data-rag-picker-search]').scrollIntoView({ block: 'center' }); await __t.sleep(200); await __t.real.click('[data-rag-picker-search]'); await __t.real.key('a', { ctrl: true }); await __t.real.type('nv_context_relevance'); await __t.sleep(600);
     const nv = vis('[data-rag-metric]').map((r) => r.getAttribute('data-rag-metric'));
     await __t.real.key('a', { ctrl: true }); await __t.real.key('Backspace'); await __t.sleep(300);
     return 'LLMContextRecall: ' + shown.join(',') + ' | nv_context_relevance: ' + nv.join(',') + ' | cleared: ' + (vis('[data-rag-metric]').length > 20);`,
  ),
  step(
    'a-preset-chooses-the-triad',
    `await __t.real.click('[data-rag-preset="rag-triad"]'); await __t.sleep(800);
     const chosen = vis('[data-rag-metric]').filter((r) => r.querySelector('[data-rag-metric-check]')?.checked).map((r) => r.getAttribute('data-rag-metric'));
     const modes = [...${row('context-relevance')}.querySelectorAll('[data-rag-instance] select')].map((s) => s.selectedOptions[0].textContent).join(',');
     return 'chosen: ' + chosen.sort().join(',') + ' | context-relevance mode: ' + modes;`,
  ),
  step(
    'the-estimate-follows-the-choice',
    `const line = await __t.waitFor(() => { const l = document.querySelector('[data-rag-estimate-calls]'); return l && l.textContent === '6' ? l : null; }, 10000); if (!line) return 'NO ESTIMATE: ' + short(document.querySelector('[data-rag-picker-footer]')?.textContent, 160);
     const foot = document.querySelector('[data-rag-picker-footer]')?.textContent ?? '';
     return 'judge calls: ' + line.textContent + ' | text: ' + short(foot, 120);`,
  ),
  step(
    'the-inputs-a-dataset-lacks-are-said',
    `await __t.real.click('[data-rag-picker-search]'); await __t.real.type('lexical'); await __t.sleep(600);
     const r = ${row('context-precision-lexical')}; if (!r) return 'NO ROW lexical';
     const missing = r.querySelector('[data-rag-missing]')?.textContent ?? 'none';
     await __t.real.key('a', { ctrl: true }); await __t.real.key('Backspace'); await __t.sleep(300);
     return 'missing: ' + short(missing, 100);`,
  ),
  step(
    'try-faithfulness-on-a-sample-from-the-target',
    `const tryButton = ${row('faithfulness')}.querySelector('[data-rag-try]'); tryButton.scrollIntoView({ block: 'center' }); await __t.sleep(400);
     await __t.real.click(tryButton);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-try-dialog]'), 5000); if (!d) return 'NO DIALOG';
     const q = document.querySelector('[data-rag-try-question]'); if (!q) return 'NO QUESTION';
     await __t.real.click('[data-rag-try-probe]');
     const sample = await __t.waitFor(() => document.querySelector('[data-rag-try-sample]'), 15000); if (!sample) return 'NO SAMPLE: ' + short(document.querySelector('[data-rag-try-dialog]')?.textContent, 200);
     const will = await __t.waitFor(() => document.querySelector('[data-rag-try-willsend]'), 10000); if (!will) return 'NO WILL SEND';
     return 'answer: ' + short(sample.textContent, 70) + ' | will send: ' + short(will.textContent, 90);`,
  ),
  step(
    'the-prompt-is-shown-before-anything-is-sent',
    `await __t.real.click('[data-rag-try-show]');
     const p = await __t.waitFor(() => document.querySelector('[data-ai-preview] [data-ai-estimate]') && document.querySelector('[data-ai-preview]'), 10000); if (!p) return 'NO PREVIEW';
     const user = [...p.querySelectorAll('details')].find((x) => /^user/.test(x.querySelector('summary')?.textContent ?? ''))?.textContent ?? '';
     const before = (await window.aps.invoke('ai.taskUsage', { days: 1 })).byTask.find((t) => t.task === 'rag-judge')?.calls ?? 0;
     const close = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close').pop(); await __t.real.click(close); await __t.sleep(400);
     return 'FAITHFULNESS in prompt: ' + /FAITHFULNESS/.test(user) + ' | answer in prompt: ' + /opens at 8am/.test(user) + ' | judge calls so far: ' + before;`,
  ),
  step(
    'run-the-try',
    `await __t.real.click('[data-rag-try-run]');
     const r = await __t.waitFor(() => document.querySelector('[data-rag-try-result]'), 15000); if (!r) return 'NO RESULT';
     const after = (await window.aps.invoke('ai.taskUsage', { days: 1 })).byTask.find((t) => t.task === 'rag-judge')?.calls ?? 0;
     const out = 'score: ' + document.querySelector('[data-rag-try-score]')?.textContent + ' | ' + short(r.textContent, 80) + ' | judge calls: ' + after;
     const close = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close').pop(); await __t.real.click(close); await __t.sleep(300);
     return out;`,
  ),
  step(
    'the-estimate-dialog-before-a-run',
    `await __t.real.click(${runButton});
     const d = await __t.waitFor(() => document.querySelector('[data-rag-estimate-dialog]'), 10000); if (!d) return 'NO DIALOG';
     const est = await __t.waitFor(() => document.querySelector('[data-rag-estimate-total]'), 10000); if (!est) return 'NO ESTIMATE';
     const metrics = [...document.querySelectorAll('[data-rag-estimate-metric]')].map((m) => m.getAttribute('data-rag-estimate-metric') + ':' + m.querySelector('td:nth-child(2)')?.textContent);
     return 'metrics: ' + metrics.join(',') + ' | total: ' + short(est.textContent, 80) + ' | judge: ' + /RAG mock judge/.test(d.textContent) + ' | stays local: ' + /stays on this computer/.test(d.textContent);`,
  ),
  step(
    'run-it-from-the-dialog',
    `await __t.real.click('[data-rag-estimate-run]'); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === 1 && runs[0].total > 0); i++) {
       await __t.sleep(500);
       runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Clinic metrics');
     }
     const res = runs[0] ? await window.aps.invoke('runs.results', { runId: runs[0].id, limit: 10 }) : { items: [] };
     const names = [...new Set(res.items.flatMap((r) => r.checks.map((c) => c.name)))];
     return 'runs: ' + runs.length + ' | total: ' + runs[0]?.total + ' | metrics: ' + names.join(',') + ' | judge cost kept: ' + ((await window.aps.invoke('runs.summary', { runId: runs[0].id }))?.judgeCostUsd > 0);`,
  ),
  step(
    'the-metrics-matrix',
    `const seg = vis('main [role=radio], main button').find((b) => b.textContent.trim() === 'Metrics'); if (!seg) return 'NO METRICS SWITCH';
     await __t.real.click(seg);
     const m = await __t.waitFor(() => document.querySelector('[data-rag-matrix-table] [data-rag-col]') && document.querySelector('[data-rag-matrix]'), 10000);
     if (!m) { const rs = vis('main button').filter((b) => /Clinic metrics/.test(b.textContent)); return 'NO MATRIX: runs listed ' + rs.length + ' | ' + short(document.querySelector('main')?.innerText, 160); }
     const cols = [...m.querySelectorAll('[data-rag-col]')].map((c) => c.getAttribute('data-rag-col'));
     const groups = [...m.querySelectorAll('[data-rag-group-toggle]')].map((g) => g.getAttribute('data-rag-group-toggle'));
     const mean = [...m.querySelectorAll('[data-rag-stat=mean] td')].map((c) => c.textContent).join(',');
     return 'columns: ' + cols.join(',') + ' | groups: ' + groups.join(',') + ' | rows: ' + m.querySelectorAll('[data-rag-row]').length + ' | means: ' + mean;`,
  ),
  step(
    'an-edited-pass-mark-decides-again',
    `const before = [...document.querySelectorAll('[data-rag-stat=pass] td')].map((c) => c.textContent).join(',');
     const input = document.querySelector('[data-rag-threshold="faithfulness"]'); if (!input) return 'NO THRESHOLD';
     await __t.real.click(input); await __t.real.key('a', { ctrl: true }); await __t.real.type('1.1'); await __t.sleep(1200);
     const after = [...document.querySelectorAll('[data-rag-stat=pass] td')].map((c) => c.textContent).join(',');
     const cell = [...document.querySelectorAll('[data-rag-cell$="|faithfulness"]')].map((c) => c.className.includes('bad') ? 'fail' : 'ok').join(',');
     await __t.real.click(input); await __t.real.key('a', { ctrl: true }); await __t.real.type('0.8'); await __t.sleep(800);
     return 'pass rates changed: ' + (before !== after) + ' | faithfulness cells at 1.1: ' + cell;`,
  ),
  step(
    'a-cell-opens-the-sample',
    `const cell = document.querySelector('[data-rag-cell$="|faithfulness"]'); if (!cell) return 'NO CELL';
     cell.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(cell);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-detail]'), 8000); if (!d) return 'NO DETAIL';
     await __t.sleep(500);
     return 'question: ' + short(d.querySelector('[data-rag-detail-question]')?.textContent, 50) + ' | answer: ' + short(d.querySelector('[data-rag-detail-answer]')?.textContent, 40) + ' | chunks: ' + d.querySelectorAll('[data-rag-chunk]').length + ' | gold marked: ' + /gold/.test(d.querySelector('[data-rag-lane]')?.textContent ?? '') + ' | cards: ' + !!d.querySelector('[data-rag-cards]') + ' | try again: ' + !!d.querySelector('[data-rag-tryagain]');`,
  ),
  step(
    'try-again-with-another-judge',
    `await __t.real.click(document.querySelector('[data-rag-tryagain]'));
     const t = await __t.waitFor(() => document.querySelector('[data-rag-try-dialog]'), 5000); if (!t) return 'NO TRY DIALOG';
     await __t.sleep(800);
     const answer = document.querySelector('[data-rag-try-answer]')?.value ?? '';
     const judge = !!document.querySelector('select[aria-label="Judge for this try"]');
     const close = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close'); for (const b of close.reverse()) { await __t.real.click(b); await __t.sleep(300); }
     return 'stored answer prefilled: ' + /clinic opens at 8am/i.test(answer) + ' | judge choice: ' + judge + ' | detail closed: ' + !document.querySelector('[data-rag-detail]');`,
  ),
  step(
    'the-column-mapper',
    `const dsTab = tab('Dataset'); await __t.real.click(dsTab); await __t.sleep(500);
     const ed = ${EDITOR_IN('main')}; if (!ed) return 'NO EDITOR';
     ed.getModel().setValue('{"prompt":"What time does the clinic open?","gold":"The clinic opens at 8am.","doc_ids":["doc-1"],"topic":"hours"}\\n{"prompt":"Can appointments be cancelled?","gold":"Up to 24 hours before.","doc_ids":["doc-3"],"topic":"policy"}'); await __t.sleep(500);
     await __t.real.click('[data-rag-map-columns]');
     const m = await __t.waitFor(() => document.querySelector('[data-rag-mapper] [data-rag-map-field="question"]'), 8000); if (!m) return 'NO MAPPER';
     await __t.sleep(600);
     const guessed = 'question=' + m.value + ' ids=' + document.querySelector('[data-rag-map-field="reference_ids"]').value;
     ${setSelect(`document.querySelector('[data-rag-map-field="reference"]')`, 'gold')}
     await __t.sleep(600);
     const preview = document.querySelector('[data-rag-mapper-preview]')?.textContent ?? '';
     await __t.real.click('[data-rag-mapper-apply]'); await __t.sleep(600);
     const text = ed.getModel().getValue();
     return 'guessed: ' + guessed + ' | preview has reference: ' + /"reference":"The clinic opens at 8am\\."/.test(preview) + ' | applied: ' + /"question":"What time does the clinic open\\?"/.test(text) + ' ' + /"reference_ids":\\["doc-1"\\]/.test(text) + ' ' + /"tags":\\["hours"\\]/.test(text);`,
  ),
  step(
    'connect-from-a-preset-with-limits',
    `await __t.real.click('[data-rag-connect-open]');
     const d = await __t.waitFor(() => document.querySelector('[data-rag-connect]'), 5000); if (!d) return 'NO DIALOG';
     ${setSelect(`document.querySelector('[data-rag-preset-select]')`, 'LangServe')}
     await __t.sleep(600);
     const ed = ${EDITOR_IN('[data-rag-step]')};
     const req = ed?.getModel().getValue() ?? '';
     const answer = document.querySelector('[data-rag-slot="answer"]').value;
     const ctxs = document.querySelector('[data-rag-slot="contexts"]').value;
     const name = document.querySelector('[data-rag-name]').value;
     await __t.real.click('[data-rag-limits] summary'); await __t.sleep(300);
     await __t.real.click('[data-rag-limit="concurrency"]'); await __t.real.type('2');
     await __t.real.click('[data-rag-limit="requestsPerMinute"]'); await __t.real.type('120');
     await __t.sleep(300);
     const limits = document.querySelector('[data-rag-limit="concurrency"]').value + '/' + document.querySelector('[data-rag-limit="requestsPerMinute"]').value;
     const cancel = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Cancel'); await __t.real.click(cancel); await __t.sleep(300);
     return 'limits: ' + limits + ' | request has /invoke: ' + /\\/invoke/.test(req) + ' | answer: ' + answer + ' | contexts: ' + ctxs + ' | named: ' + name;`,
  ),
  step(
    'ai-suggest-mapping-reads-the-sample',
    `await __t.real.click('[data-rag-connect-open]');
     const d = await __t.waitFor(() => document.querySelector('[data-rag-connect]'), 5000); if (!d) return 'NO DIALOG';
     ${setSelect(`document.querySelector('[data-rag-preset-select]')`, 'Generic JSON')}
     await __t.sleep(500);
     const ed = ${EDITOR_IN('[data-rag-step]')};
     ed.getModel().setValue(ed.getModel().getValue().replace('{{ragUrl}}', '${HTTP}')); await __t.sleep(400);
     // empty the preset's mapping so the suggestion has something to do
     for (const s of ['answer', 'contexts', 'context.text', 'context.id', 'context.score']) { const i = document.querySelector('[data-rag-slot="' + s + '"]'); await __t.real.click(i); await __t.real.key('a', { ctrl: true }); await __t.real.key('Backspace'); }
     await __t.real.click('[data-rag-probe]');
     const tree = await __t.waitFor(() => document.querySelector('[data-rag-response] .syn-key'), 15000); if (!tree) return 'NO RESPONSE';
     const suggest = vis('[data-rag-connect] [data-ai-action]').find((b) => /Suggest mapping/.test(b.textContent)); if (!suggest) return 'NO BUTTON';
     await __t.real.click(suggest);
     const filled = await __t.waitFor(() => document.querySelector('[data-rag-slot="answer"]').value === '$.answer' && document.querySelector('[data-rag-slot="contexts"]').value, 15000);
     const sample = await __t.waitFor(() => /8am/.test(document.querySelector('[data-rag-answer]')?.textContent ?? '') && document.querySelector('[data-rag-sample]'), 8000);
     return 'answer: ' + document.querySelector('[data-rag-slot="answer"]').value + ' | contexts: ' + document.querySelector('[data-rag-slot="contexts"]').value + ' | text: ' + document.querySelector('[data-rag-slot="context.text"]').value + ' | sample reads the answer: ' + !!sample + ' | note: ' + short(document.querySelector('[data-rag-suggest-note]')?.textContent, 40);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'a-rag-evaluation-with-the-metrics-tab': /^metrics listed: 138 \| groups: 13 \| presets: 13 \| judge options: true$/,
    'a-ragas-name-finds-its-metric': /^LLMContextRecall: context-recall(,context-recall-lexical)? \| nv_context_relevance: context-relevance \| cleared: true$/,
    'a-preset-chooses-the-triad': /^chosen: answer-relevance,context-relevance,faithfulness \| context-relevance mode: chunks(,always run)?$/,
    'the-estimate-follows-the-choice': /^judge calls: 6 \| text: .*judge calls/,
    'the-inputs-a-dataset-lacks-are-said': /^missing: needs a "reference_contexts" column/,
    'try-faithfulness-on-a-sample-from-the-target': /^answer: .*8am.* \| will send: .*faithfulness-v1/,
    'the-prompt-is-shown-before-anything-is-sent': /^FAITHFULNESS in prompt: true \| answer in prompt: true \| judge calls so far: 0$/,
    'run-the-try': /^score: 1 \| passed.* \| judge calls: 1$/,
    'the-estimate-dialog-before-a-run': /^metrics: .*context-relevance:1.*faithfulness:1.*answer-relevance:1.* \| total: Judge calls6.* \| judge: true \| stays local: true$/,
    'run-it-from-the-dialog': /^runs: 1 \| total: 2 \| metrics: .*faithfulness.* \| judge cost kept: true$/,
    'the-metrics-matrix': /^columns: .*faithfulness.* \| groups: .* \| rows: 2 \| means: /,
    'an-edited-pass-mark-decides-again': /^pass rates changed: true \| faithfulness cells at 1\.1: fail,fail$/,
    'a-cell-opens-the-sample': /^question: .* \| answer: .* \| chunks: [1-3] \| gold marked: true \| cards: true \| try again: true$/,
    'try-again-with-another-judge': /^stored answer prefilled: true \| judge choice: true \| detail closed: true$/,
    'the-column-mapper': /^guessed: question=prompt ids=doc_ids \| preview has reference: true \| applied: true true true$/,
    'connect-from-a-preset-with-limits': /^limits: 2\/120 \| request has \/invoke: true \| answer: \$\.output\.answer \| contexts: \$\.output\.context\[\*\] \| named: LangServe.*$/,
    'ai-suggest-mapping-reads-the-sample': /^answer: \$\.answer \| contexts: \$\.sources\[\*\] \| text: \$\.text \| sample reads the answer: true \| note: check the score scale$/,
  },
  { prepare, settings: { assistantProvider: 'rag-mock-judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'e2e' }] } },
);
