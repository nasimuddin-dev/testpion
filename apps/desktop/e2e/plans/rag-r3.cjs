// RAG R3 and the matrix views, with real mouse and keys (__t.real): AI Lab ▸ RAG lists the seeded safety probe sets and adds one to
// the workspace's datasets; the metric picker offers the Safety, Conversational, Agentic RAG and Multimodal presets, marks the
// options a metric cannot run without, and puts a decision-tree condition ("run only when faithfulness < 0.8") on a metric; the
// judge options have "Send pictures to the judge"; Try takes pictures and the other fields of a record, lists the pictures in
// "What will be sent" (thumbnails) and scores a multimodal sample; the Connect dialog has the conversation mode and maps tool
// calls, a conversation id and a chunk's picture. Then the views of a finished run that no other plan covers: By tag, Charts,
// Score again…, Compare, Runs × metrics, the export arrow, and the RAG fields of the monitor editor and the CI dialog.
// Offline: the mock provider and a local server only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { withExpect, step } = require('../lib.cjs');

const SERVER = resolve(__dirname, '..', '..', '..', '..', 'examples', 'servers', 'rag-server.mjs');
const HTTP = 'http://127.0.0.1:4020';
// a 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const verdict = (reasoning, items) => JSON.stringify({ reasoning, items });
  const rules = [
    { match: 'multimodal-faithfulness-v1', response: verdict('The picture shows it.', [{ text: 'verdict', verdict: true, reason: 'image 1 shows a Model X' }]) },
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
  if (globalThis.__e2eRagServer) return;
  try {
    const m = await import(pathToFileURL(SERVER).href);
    globalThis.__e2eRagServer = await m.startRagServer({ port: 4020, grpcPort: 4021 });
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
}

const EDITOR_IN = (sel) => `(window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.closest(${JSON.stringify(sel)}))`;
const setSelect = (el, text) => `{ const sel = ${el}; const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(${JSON.stringify(text)})); if (!opt) return 'NO OPTION ${text}'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); }`;
const row = (id) => `document.querySelector('[data-rag-metric="${id}"]')`;
const runButton = `vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim()))`;
const view = (label) => `{ const seg = vis('main [role=radio], main button').find((b) => b.textContent.trim() === ${JSON.stringify(label)}); if (!seg) return 'NO VIEW ${label}'; await __t.real.click(seg); await __t.sleep(700); }`;

const steps = [
  step(
    'probe-sets-in-ai-lab',
    `await __t.view('AI Lab'); await __t.sleep(600);
     const t = vis('main [role=tab]').find((x) => x.textContent.trim().startsWith('RAG')); if (!t) return 'NO TAB RAG';
     await __t.real.click(t); await __t.sleep(600);
     const box = await __t.waitFor(() => document.querySelector('[data-rag-probes] [data-rag-probe-set]') && document.querySelector('[data-rag-probes]'), 8000); if (!box) return 'NO PROBES';
     const sets = box.querySelectorAll('[data-rag-probe-set]').length;
     const add = box.querySelector('[data-rag-probe-add="benign"]'); if (!add) return 'NO BUTTON add benign';
     add.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(add);
     const gone = await __t.waitFor(() => !document.querySelector('[data-rag-probe-add="benign"]'), 8000);
     const info = (await window.aps.invoke('rag.probeSets')).find((s) => s.id === 'benign');
     return 'sets: ' + sets + ' | benign in workspace: ' + info.inWorkspace + ' (' + info.records + ' records) | add button gone: ' + !!gone;`,
  ),
  step(
    'a-rag-evaluation-with-the-metrics-tab',
    `await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'RAG')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('[data-rag-target]')`, 'Clinic bot')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="Judge provider"]')`, 'RAG mock judge')}
     await __t.sleep(500);
     await __t.real.click('input[aria-label="Evaluation name"]'); await __t.real.key('a', { ctrl: true }); await __t.real.type('R3 views'); await __t.sleep(300);
     const t = tab('Metrics'); if (!t) return 'NO TAB Metrics';
     await __t.real.click(t);
     const picker = await __t.waitFor(() => document.querySelector('[data-rag-picker] [data-rag-metric]') && document.querySelector('[data-rag-picker]'), 8000); if (!picker) return 'NO PICKER';
     return 'presets: ' + [...picker.querySelectorAll('[data-rag-preset]')].map((p) => p.getAttribute('data-rag-preset')).filter((p) => /safety|conversational|agentic-rag|multimodal/.test(p)).join(',') + ' | groups: ' + [...picker.querySelectorAll('[data-rag-group]')].map((g) => g.getAttribute('data-rag-group')).filter((g) => /conversation|multimodal/.test(g)).join(',');`,
  ),
  step(
    'a-required-option-is-marked-and-typed',
    `const r = ${row('role-adherence')}; if (!r) return 'NO ROW role-adherence';
     r.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(r.querySelector('[data-rag-metric-check]')); await __t.sleep(500);
     const field = ${row('role-adherence')}.querySelector('[data-rag-option="role"]'); if (!field) return 'NO OPTION role';
     const input = field.querySelector('input'); const star = !!field.querySelector('span.text-bad');
     const empty = input.className.includes('border-warn');
     await __t.real.click(input); await __t.real.type('a polite clinic receptionist'); await __t.sleep(400);
     const filled = !${row('role-adherence')}.querySelector('[data-rag-option="role"] input').className.includes('border-warn');
     return 'required mark: ' + star + ' | flagged while empty: ' + empty + ' | typed: ' + ${row('role-adherence')}.querySelector('[data-rag-option="role"] input').value + ' | flag gone: ' + filled;`,
  ),
  step(
    'a-metric-can-wait-for-another',
    `const r = ${row('answer-relevance')}; r.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     // a new evaluation starts with answer-relevance already chosen
     if (!r.querySelector('[data-rag-instance]')) { await __t.real.click(r.querySelector('[data-rag-metric-check]')); await __t.sleep(500); }
     const ctl = ${row('answer-relevance')}.querySelector('[data-rag-route]'); if (!ctl) return 'NO ROUTE CONTROL';
     const before = ctl.querySelector('select').value;
     ${setSelect(`${row('answer-relevance')}.querySelector('[data-rag-route] select')`, 'run only unless')}
     await __t.sleep(500);
     const cond = ${row('answer-relevance')}.querySelector('[data-rag-route-condition]'); if (!cond) return 'NO CONDITION INPUT';
     const shown = cond.value;
     await __t.real.click(cond); await __t.real.key('a', { ctrl: true }); await __t.real.type('faithfulness < 0.7'); await __t.sleep(400);
     return 'before: ' + before + ' | after: ' + ${row('answer-relevance')}.querySelector('[data-rag-route] select').value + ' | default condition: ' + shown + ' | typed: ' + ${row('answer-relevance')}.querySelector('[data-rag-route-condition]').value;`,
  ),
  step(
    'send-pictures-is-an-opt-in',
    `const sum = document.querySelector('[data-rag-judge-options] summary'); if (!sum) return 'NO JUDGE OPTIONS';
     await __t.real.click(sum); await __t.sleep(300);
     const box = document.querySelector('[data-rag-allow-images]'); if (!box) return 'NO CHECKBOX';
     const off = box.getAttribute("aria-checked") === "true";
     await __t.real.click(box); await __t.sleep(300);
     return 'off by default: ' + !off + ' | on after a click: ' + (document.querySelector('[data-rag-allow-images]').getAttribute('aria-checked') === 'true') + ' | summary says set: ' + /set/.test(document.querySelector('[data-rag-judge-options] summary').textContent);`,
  ),
  step(
    'try-a-multimodal-sample-with-a-picture',
    `const r = ${row('multimodal-faithfulness')}; if (!r) return 'NO ROW multimodal';
     r.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(r.querySelector('[data-rag-try]'));
     const d = await __t.waitFor(() => document.querySelector('[data-rag-try-dialog]'), 5000); if (!d) return 'NO DIALOG';
     const type = vis('[data-rag-try-dialog] [role=radio], [data-rag-try-dialog] button').find((b) => b.textContent.trim() === 'Type a sample'); if (type) { await __t.real.click(type); await __t.sleep(400); }
     await __t.real.click('[data-rag-try-qtext]'); await __t.real.type('What about the Tesla Model X?');
     await __t.real.click('[data-rag-try-answer]'); await __t.real.type('The Tesla Model X is an electric SUV.');
     const pic = document.querySelector('[data-rag-try-pictures]'); if (!pic) return 'NO PICTURES FIELD';
     await __t.real.click(pic); await window.aps.invoke('noop').catch(() => 0);
     const setNative = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setNative.call(pic, ${JSON.stringify(PNG)}); pic.dispatchEvent(new Event('input', { bubbles: true }));
     const will = await __t.waitFor(() => document.querySelector('[data-rag-try-willsend]'), 10000); if (!will) return 'NO WILL SEND: ' + short(document.querySelector('[data-rag-try-dialog]')?.textContent, 220);
     const allow = document.querySelector('[data-rag-try-allow-images]');
     const was = allow ? allow.getAttribute('aria-checked') === 'true' : 'none';
     return 'send pictures was on (from the evaluation): ' + was + ' | will send: ' + short(will.textContent, 80) + ' | fields: ' + !!document.querySelector('[data-rag-try-fields]');`,
  ),
  step(
    'the-preview-lists-the-picture',
    `await __t.real.click('[data-rag-try-show]');
     const p = await __t.waitFor(() => document.querySelector('[data-ai-preview] [data-ai-estimate]') && document.querySelector('[data-ai-preview]'), 10000); if (!p) return 'NO PREVIEW';
     const imgs = p.querySelectorAll('[data-ai-images] img');
     const text = p.querySelector('[data-ai-images]')?.textContent ?? '';
     const leaked = /iVBORw0KGgo/.test(p.textContent);
     const close = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close').pop(); await __t.real.click(close); await __t.sleep(400);
     return 'thumbnails: ' + imgs.length + ' | says: ' + short(text, 90) + ' | base64 in the text: ' + leaked;`,
  ),
  step(
    'the-picture-is-judged',
    `const before = (await window.aps.invoke('ai.taskUsage', { days: 1 })).byTask.find((t) => t.task === 'rag-judge')?.calls ?? 0;
     await __t.real.click('[data-rag-try-run]');
     const r = await __t.waitFor(() => document.querySelector('[data-rag-try-result]'), 15000); if (!r) return 'NO RESULT: ' + short(document.querySelector('[data-rag-try-dialog]')?.textContent, 200);
     const after = (await window.aps.invoke('ai.taskUsage', { days: 1 })).byTask.find((t) => t.task === 'rag-judge')?.calls ?? 0;
     const out = 'score: ' + document.querySelector('[data-rag-try-score]')?.textContent + ' | ' + short(r.textContent, 100) + ' | judge calls: ' + (after - before);
     const close = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close').pop(); await __t.real.click(close); await __t.sleep(300);
     return out;`,
  ),
  step(
    'the-connect-dialog-maps-tools-a-session-and-a-picture',
    `await __t.view('AI Lab'); await __t.sleep(600);
     const t = vis('main [role=tab]').find((x) => x.textContent.trim().startsWith('RAG')); if (t) { await __t.real.click(t); await __t.sleep(400); }
     await __t.real.click('[data-rag-connect-open]');
     const d = await __t.waitFor(() => document.querySelector('[data-rag-connect]'), 5000); if (!d) return 'NO DIALOG';
     const slots = ['toolCalls', 'toolCall.name', 'toolCall.arguments', 'conversationId', 'context.image'].map((s) => s + ':' + !!document.querySelector('[data-rag-slot="' + s + '"]')).join(',');
     const conv = d.querySelector('[data-rag-conversation] select'); if (!conv) return 'NO CONVERSATION SELECT';
     const options = [...conv.options].map((o) => o.value).join(',');
     ${setSelect(`document.querySelector('[data-rag-conversation] select')`, 'the system keeps a session')}
     await __t.sleep(400);
     const chosen = document.querySelector('[data-rag-conversation] select').value;
     const cancel = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Cancel'); await __t.real.click(cancel); await __t.sleep(300);
     return 'slots: ' + slots + ' | modes: ' + options + ' | chosen: ' + chosen;`,
  ),
  step(
    'a-run-for-the-views',
    `await __t.view('Evaluations'); await __t.sleep(800);
     const clear = vis('[data-rag-picker] button').find((b) => b.textContent.trim() === 'Clear'); if (clear) { await __t.real.click(clear); await __t.sleep(400); }
     await __t.real.click('[data-rag-preset="rag-triad"]'); await __t.sleep(800);
     const dsTab = tab('Dataset'); await __t.real.click(dsTab); await __t.sleep(500);
     const ed = ${EDITOR_IN('main')}; if (!ed) return 'NO EDITOR';
     ed.getModel().setValue('{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["hours"]}\\n{"id":"cancel","question":"Can appointments be cancelled?","reference":"Up to 24 hours before.","reference_ids":["doc-3"],"tags":["policy"]}\\n{"id":"parking","question":"Is there parking at the clinic?","reference":"I do not know.","reference_ids":["doc-1"],"tags":["policy"]}'); await __t.sleep(500);
     await __t.real.click(${runButton});
     const dlg = await __t.waitFor(() => document.querySelector('[data-rag-estimate-dialog]'), 10000); if (!dlg) return 'NO ESTIMATE DIALOG';
     await __t.sleep(800);
     await __t.real.click('[data-rag-estimate-run]'); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === 1 && runs[0].total > 0); i++) { await __t.sleep(500); runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'R3 views'); }
     return 'runs: ' + runs.length + ' | total: ' + runs[0]?.total;`,
  ),
  step(
    'by-tag-and-charts',
    `${view('Metrics')}
     const m = await __t.waitFor(() => document.querySelector('[data-rag-matrix-table] [data-rag-col]') && document.querySelector('[data-rag-matrix]'), 10000); if (!m) return 'NO MATRIX';
     ${view('By tag')}
     const tags = [...document.querySelectorAll('[data-rag-tag-row]')].map((r) => r.getAttribute('data-rag-tag-row'));
     ${view('Charts')}
     const hist = document.querySelectorAll('[data-rag-histogram]').length;
     const charts = !!document.querySelector('[data-rag-charts]');
     ${view('Samples')}
     return 'tags: ' + tags.sort().join(',') + ' | charts: ' + charts + ' | histograms: ' + hist;`,
  ),
  step(
    'score-again-then-compare-and-the-pivot',
    `await __t.real.click('[data-rag-rescore-open]');
     const dlg = await __t.waitFor(() => document.querySelector('[data-rag-rescore]'), 8000); if (!dlg) return 'NO RESCORE DIALOG';
     await __t.sleep(1200);
     await __t.real.click('[data-rag-rescore-run]');
     let runs = [];
     for (let i = 0; i < 120 && runs.length < 2; i++) { await __t.sleep(500); runs = (await window.aps.invoke('runs.list', { limit: 10 })).items.filter((r) => r.name === 'R3 views'); }
     await __t.sleep(1500);
     const gone = !document.querySelector('[data-rag-rescore]');
     ${view('Metrics')}
     await __t.waitFor(() => document.querySelector('[data-rag-matrix]'), 8000);
     ${view('Compare')}
     const cmp = await __t.waitFor(() => document.querySelector('[data-rag-compare]'), 8000);
     await __t.sleep(1200);
     const rows = document.querySelectorAll('[data-rag-compare-row]').length;
     const summary = short(document.querySelector('[data-rag-compare-summary]')?.textContent, 90);
     ${view('Runs × metrics')}
     const piv = await __t.waitFor(() => document.querySelector('[data-rag-pivot]'), 8000);
     await __t.sleep(800);
     return 'runs: ' + runs.length + ' | dialog closed: ' + gone + ' | compare: ' + !!cmp + ' rows ' + rows + ' | summary: ' + summary + ' | pivot rows: ' + document.querySelectorAll('[data-rag-pivot-row]').length;`,
  ),
  step(
    'the-matrix-export-offers-the-files',
    `${view('Samples')}
     const out = document.querySelector('[data-rag-matrix][data-output="rag.matrix"]'); if (!out) return 'NO OUTPUT';
     const btn = vis('[data-output-formats="rag.matrix"]')[0]; if (!btn) return 'NO EXPORT ARROW: ' + [...out.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).join('|');
     await __t.real.click(btn); await __t.sleep(600);
     const items = vis('[role=menuitem]').map((m) => m.textContent.trim());
     await __t.esc();
     return 'formats: ' + items.join(' | ');`,
  ),
  step(
    'the-monitor-editor-has-the-rag-fields',
    `// the monitor and the CI dialog list only saved evaluations
     const save = vis('button').find((b) => /^Save (this evaluation|changes to)/.test(b.getAttribute('title') ?? '')); if (save) { await __t.real.click(save); await __t.sleep(600); const ok = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Save'); if (ok) { await __t.real.click(ok); await __t.sleep(1000); } }
     await __t.view('Monitors'); await __t.sleep(800);
     const more = [...document.querySelectorAll('[aria-label^="More actions for Monitors"]')].find((x) => x.offsetParent); if (!more) return 'NO HEADER MENU';
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(600);
     const add = vis('[role=menuitem]').find((x) => x.textContent.trim() === 'New monitor'); if (!add) return 'NO NEW MONITOR ITEM (saved dialog clicked: ' + !!save + ')';
     await __t.real.click(add); await __t.sleep(600);
     if (!document.querySelector('select[aria-label="What the monitor runs"]')) return 'NO EDITOR after clicking "' + add.textContent.trim() + '": ' + (document.querySelector('[role=dialog]')?.innerText ?? 'no dialog').slice(0, 200);
     ${setSelect(`document.querySelector('select[aria-label="What the monitor runs"]')`, 'A RAG evaluation')}
     await __t.sleep(500);
     const pick = document.querySelector('select[aria-label="RAG evaluation"]'); if (!pick) return 'NO RAG EVALUATION SELECT';
     ${setSelect(`document.querySelector('select[aria-label="RAG evaluation"]')`, 'R3 views')}
     await __t.sleep(500);
     const fields = ['Gates', 'Share of samples judged', 'Daily judge budget in USD'].map((l) => l + ':' + !!document.querySelector('[aria-label="' + l + '"]')).join(',');
     await __t.real.click('[aria-label="Gates"]'); await __t.real.type('faithfulness=0.8'); await __t.sleep(300);
     return 'evaluation chosen: ' + document.querySelector('select[aria-label="RAG evaluation"]').selectedOptions[0]?.textContent + ' | fields: ' + fields + ' | gates typed: ' + document.querySelector('[aria-label="Gates"]').value;`,
  ),
  step(
    'the-ci-dialog-has-the-rag-options',
    `await __t.esc(); await __t.sleep(300);
     const cancel = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Cancel'); if (cancel) { await __t.real.click(cancel); await __t.sleep(300); }
     await __t.real.key('k', { ctrl: true }); await __t.sleep(500);
     await __t.real.type('Run in CI'); await __t.sleep(500);
     await __t.real.key('Enter'); await __t.sleep(1200);
     const sel = [...document.querySelectorAll('[role=dialog] select')].find((s) => [...s.options].some((o) => o.value === 'rag:R3 views')); if (!sel) return 'NO TARGET OPTION: dialog=' + (document.querySelector('[role=dialog]')?.innerText ?? 'none').slice(0, 150) + ' | selects=' + [...document.querySelectorAll('select')].map((s) => [...s.options].map((o) => o.value).join(',')).join(' ; ').slice(0, 300);
     ${setSelect(`[...document.querySelectorAll('[role=dialog] select')].find((s) => [...s.options].some((o) => o.value === 'rag:R3 views'))`, 'RAG: R3 views')}
     await __t.sleep(500);
     const opts = await __t.waitFor(() => document.querySelector('[data-ci-rag-options]'), 5000); if (!opts) return 'NO RAG OPTIONS';
     await __t.real.click(opts.querySelector('input[aria-label="Gates"]')); await __t.real.type('faithfulness=0.8');
     await __t.sleep(1200);
     const text = document.querySelector('[role=dialog]')?.innerText ?? '';
     return 'fields: ' + [...opts.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')).join(',') + ' | pipeline has the gate: ' + /--min\\s+["']?faithfulness=0\\.8/.test(text) + ' | comment option: ' + !!document.querySelector('[data-ci-rag-comment]');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'probe-sets-in-ai-lab': /^sets: 7 \| benign in workspace: true \(6 records\) \| add button gone: true$/,
    'a-rag-evaluation-with-the-metrics-tab': /^presets: .*agentic-rag.*conversational.*multimodal.*safety.* \| groups: .*conversation.*multimodal.*$|^presets: (?=.*safety)(?=.*conversational)(?=.*agentic-rag)(?=.*multimodal).* \| groups: (?=.*conversation)(?=.*multimodal).*$/,
    'a-required-option-is-marked-and-typed': /^required mark: true \| flagged while empty: true \| typed: a polite clinic receptionist \| flag gone: true$/,
    'a-metric-can-wait-for-another': /^before: always \| after: unless \| default condition: faithfulness < 0\.8 \| typed: faithfulness < 0\.7$/,
    'send-pictures-is-an-opt-in': /^off by default: true \| on after a click: true \| summary says set: true$/,
    'try-a-multimodal-sample-with-a-picture': /^send pictures was on \(from the evaluation\): true \| will send: .*multimodal-faithfulness-v1.* \| fields: true$/,
    'the-preview-lists-the-picture': /^thumbnails: 1 \| says: 1 picture .*will be sent to RAG mock judge as data.* \| base64 in the text: false$/,
    'the-picture-is-judged': /^score: 1 \| .* \| judge calls: 1$/,
    'the-connect-dialog-maps-tools-a-session-and-a-picture': /^slots: toolCalls:true,toolCall\.name:true,toolCall\.arguments:true,conversationId:true,context\.image:true \| modes: ,stateless-history,server-session \| chosen: server-session$/,
    'a-run-for-the-views': /^runs: 1 \| total: 3$/,
    'by-tag-and-charts': /^tags: hours,policy \| charts: true \| histograms: [1-9]/,
    'score-again-then-compare-and-the-pivot': /^runs: 2 \| dialog closed: true \| compare: true rows [1-9]\d* \| summary: .* \| pivot rows: [1-9]/,
    'the-matrix-export-offers-the-files': /formats: .*CSV.*JSON.*HTML/,
    'the-monitor-editor-has-the-rag-fields': /^evaluation chosen: R3 views \| fields: Gates:true,Share of samples judged:true,Daily judge budget in USD:true \| gates typed: faithfulness=0\.8$/,
    'the-ci-dialog-has-the-rag-options': /^fields: Gates,.*Metric preset.*Baseline run.*Judge budget.*Metric names.*Calls per question \| pipeline has the gate: true \| comment option: true$/,
  },
  { prepare, settings: { assistantProvider: 'rag-mock-judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'e2e' }] } },
);
