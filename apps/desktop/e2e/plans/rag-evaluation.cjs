// RAG testing, first half, with real mouse and keys (__t.real): the local demo RAG system (examples/servers/rag-server.mjs)
// is connected from AI Lab ▸ RAG — protocol, request, Probe, then CLICKS in the sample response assign the answer, the
// list of retrieved documents and each document's text, id and score (the mapping becomes JSONPath, and the sample the
// mapping reads is shown live); "What the judge receives" shows the exact prompt; the target is saved. An evaluation of
// type RAG then picks the target and a mock judge, runs the starter dataset (deterministic metrics and the two judged
// ones), is run again (the judge's verdicts come from the cache: the AI usage still counts the first run's calls), and
// a run without a judge is refused before it starts, with what to configure. Offline: the mock provider and a local
// server only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step, EDITOR_IN, setSelect, ensureRagServer } = require('../lib.cjs');

const HTTP = 'http://127.0.0.1:4020';

/** The mock judge's verdicts (what a model would answer), in the workspace's providers; the local RAG system on 4020/4021. */
async function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const rules = [
    { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'Every claim is in the documents.', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1] "opens at 8am"' }] }) },
    { match: 'answer-relevance-v1', response: JSON.stringify({ reasoning: 'It answers the question.', items: [{ text: 'It answers.', verdict: true, reason: 'addresses the question' }] }) },
  ];
  doc.providers.push({ id: 'rag-mock-judge', name: 'RAG mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  // started once per runner (the retry of a plan finds it up); one already up on the port is another runner's
  await ensureRagServer('__e2eRagServer', 4020, 4021);
}

const REQUEST = `type: http
method: POST
url: ${HTTP}/query
headers:
  Content-Type: application/json
json:
  question: "{{question}}"
`;
const key = (name) => `[...document.querySelectorAll('[data-rag-response] .syn-key')].find((b) => b.textContent.trim() === '"${name}"')`;
const slot = (s) => `document.querySelector('[data-rag-slot="${s}"]')?.value`;
/** Real clicks a key of the response tree, then the menu item that says what it is. */
const pick = (name, label) => `
  const k = ${key(name)}; if (!k) return 'NO KEY ${name}';
  await __t.real.click(k);
  const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === '${label}'), 3000); if (!item) return 'NO MENU ITEM ${label}';
  await __t.real.click(item); await __t.sleep(500);`;

const steps = [
  step(
    'rag-tab-in-ai-lab',
    `await __t.view('Bots with sources'); await __t.sleep(600);
     const t = vis('[role=tablist][aria-label="Bots with sources"] [role=tab]').find((x) => x.textContent.trim() === 'Bots'); if (!t) return 'NO TAB Bots';
     await __t.real.click(t); await __t.sleep(600);
     return 'empty: ' + /No bots yet/.test(document.querySelector('main')?.innerText ?? '');`,
  ),
  step(
    'connect-dialog',
    `await __t.real.click('[data-rag-connect-open]');
     const d = await __t.waitFor(() => document.querySelector('[data-rag-connect]'), 5000); if (!d) return 'NO DIALOG';
     await __t.real.click('[data-rag-name]'); await __t.real.type('Clinic bot');
     const ed = ${EDITOR_IN('[data-rag-step]')}; if (!ed) return 'NO EDITOR';
     ed.getModel().setValue(${JSON.stringify(REQUEST)}); await __t.sleep(500);
     return 'name: ' + document.querySelector('[data-rag-name]').value + ' | protocol: ' + document.querySelector('select[aria-label=Protocol]').selectedOptions[0].textContent.slice(0, 4) + ' | save disabled: ' + document.querySelector('[data-rag-save]').disabled;`,
  ),
  step(
    'probe',
    `await __t.real.click('[data-rag-probe]');
     const tree = await __t.waitFor(() => ${key('answer')}, 15000); if (!tree) return 'NO RESPONSE TREE: ' + short(document.querySelector('[data-rag-connect]')?.innerText, 200);
     return 'keys: ' + [...document.querySelectorAll('[data-rag-response] .syn-key')].map((b) => b.textContent.trim()).slice(0, 8).join(' ');`,
  ),
  step('click-the-answer', `${pick('answer', 'This is: The answer')} return 'answer path: ' + ${slot('answer')};`),
  step('click-the-contexts', `${pick('sources', 'This is: The list of retrieved contexts')} return 'contexts path: ' + ${slot('contexts')};`),
  step(
    'click-inside-a-document',
    `const row = [...document.querySelectorAll('[data-rag-response] [aria-label=Expand]')][0]; if (!row) return 'NO EXPAND';
     await __t.real.click(row); await __t.sleep(400);
     { ${pick('text', 'This is: Context text')} }
     { ${pick('id', 'This is: Context id')} }
     { ${pick('score', 'This is: Context score')} }
     return 'text: ' + ${slot('context.text')} + ' | id: ' + ${slot('context.id')} + ' | score: ' + ${slot('context.score')};`,
  ),
  step(
    'the-sample-the-mapping-reads',
    `const s = await __t.waitFor(() => /8am/.test(document.querySelector('[data-rag-answer]')?.textContent ?? '') && document.querySelector('[data-rag-sample]'), 5000); if (!s) return 'NO SAMPLE';
     return 'answer: ' + short(document.querySelector('[data-rag-answer]').textContent, 60) + ' | documents: ' + s.querySelectorAll('tbody tr').length + ' | first id: ' + s.querySelector('tbody td.mono')?.textContent + ' | warnings: ' + s.querySelectorAll('.text-warn').length;`,
  ),
  step(
    'what-the-judge-receives',
    `const b = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'What the judge receives'); if (!b) return 'NO BUTTON';
     await __t.real.click(b);
     const d = await __t.waitFor(() => document.querySelector('[data-ai-preview] [data-ai-estimate]') && document.querySelector('[data-ai-preview]'), 10000); if (!d) return 'NO PREVIEW: ' + short([...document.querySelectorAll('[role=alert]')].map((a) => a.textContent).join(' '), 200);
     const user = [...d.querySelectorAll('details')].find((x) => /^user/.test(x.querySelector('summary')?.textContent ?? ''))?.textContent ?? '';
     const r = 'model: ' + short(d.querySelector('[data-ai-model]')?.textContent, 40) + ' | metric in prompt: ' + /FAITHFULNESS/.test(user) + ' | answer in prompt: ' + /opens at 8am/.test(user) + ' | privacy switch: ' + !!d.querySelector('[role=radio]');
     const close = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close').pop(); await __t.real.click(close); await __t.sleep(400);
     return r;`,
  ),
  step(
    'save-the-target',
    `await __t.real.click('[data-rag-save]');
     const gone = await __t.waitFor(() => !document.querySelector('[data-rag-connect]'), 5000);
     await __t.sleep(800);
     const lib = await window.aps.invoke('lib.get', { kind: 'rag-targets' });
     const t = lib.items[0];
     return 'dialog closed: ' + !!gone + ' | saved: ' + lib.items.length + ' ' + t?.name + ' ' + t?.data.protocol + ' | mapping: ' + JSON.stringify(t?.data.mapping) + ' | listed: ' + /Clinic bot/.test(document.querySelector('main')?.innerText ?? '');`,
  ),
  step(
    'the-target-opens-again-with-its-mapping',
    `const row = vis('main [data-tree-row]').find((r) => r.textContent.includes('Clinic bot')); if (!row) return 'NO ROW';
     row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
     const d = await __t.waitFor(() => document.querySelector('[data-rag-connect]'), 5000); if (!d) return 'NO DIALOG';
     await __t.sleep(600);
     const r = 'name: ' + document.querySelector('[data-rag-name]').value + ' | answer: ' + ${slot('answer')} + ' | contexts: ' + ${slot('contexts')} + ' | request: ' + /rag-server|127.0.0.1:4020/.test(${EDITOR_IN('[data-rag-step]')}.getModel().getValue());
     const cancel = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Cancel'); await __t.real.click(cancel); await __t.sleep(300);
     return r;`,
  ),
  step(
    'a-rag-evaluation',
    `await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'Bot with sources')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('[data-rag-target]')`, 'Clinic bot')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('select[aria-label="AI reviewer provider"]')`, 'RAG mock judge')}
     await __t.sleep(500);
     await __t.real.click('input[aria-label="Evaluation name"]'); await __t.real.key('a', { ctrl: true }); await __t.real.type('Clinic RAG'); await __t.sleep(300);
     const run = vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim()));
     return 'target: ' + document.querySelector('[data-rag-target]').selectedOptions[0].textContent + ' | judge fields: ' + !!document.querySelector('[data-rag-judge]') + ' | prompt tab: ' + !!tab('Prompt') + ' | import button: ' + !!document.querySelector('[data-rag-import]') + ' | run: ' + run?.textContent.trim();`,
  ),
  step(
    'metrics-of-the-evaluation',
    `await __t.real.click(tab('Metrics')); await __t.sleep(800);
     const t = document.querySelector('main')?.innerText ?? '';
     const chosen = vis('[data-rag-metric]').filter((r) => r.querySelector('[data-rag-metric-check]')?.checked).map((r) => r.getAttribute('data-rag-metric'));
     return 'metrics: ' + ['Token F1', 'Context recall (ids)', 'Faithfulness', 'Answer relevance'].filter((m) => t.includes(m)).join(', ') + ' | chosen: ' + chosen.join(',') + ' | judge note: ' + !!document.querySelector('[data-rag-judge-note]');`,
  ),
  step(
    'run-it',
    `await __t.real.click(vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim())));
     const dlg = await __t.waitFor(() => document.querySelector('[data-rag-estimate-dialog]'), 10000); if (!dlg) return 'NO DIALOG';
     const est = await __t.waitFor(() => document.querySelector('[data-rag-estimate-total]'), 10000); if (!est) return 'NO ESTIMATE';
     const calls = est.textContent.slice(0, 40);
     await __t.real.click('[data-rag-estimate-run]'); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === 1 && runs[0].total > 0); i++) {
       await __t.sleep(500);
       runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Clinic RAG');
     }
     const res = runs[0] ? await window.aps.invoke('runs.results', { runId: runs[0].id, limit: 10 }) : { items: [] };
     // results.jsonl is in completion order (concurrency 4): the case is picked by its id, never by its place (hours -> token-f1 0.778, cancel -> 1)
    const hours = res.items.find((r) => /hours/i.test(String(r.id) + ' ' + String(r.name ?? ''))) ?? res.items[0];
    const checks = (hours ? hours.checks : []).map((c) => c.type + ':' + (c.score ?? 'n/a') + (c.passed ? '' : '(failed)'));
     return 'estimate: ' + /Judge calls\\s*4/.test(calls) + ' | runs: ' + runs.length + ' | passed: ' + runs[0]?.passed + '/' + runs[0]?.total + ' | judged: ' + res.items.flatMap((r) => r.checks).filter((c) => c.source === 'ai-judge').length + ' | ' + checks.slice(0, 5).join(' ');`,
  ),
  step(
    'again-costs-nothing',
    `const before = (await window.aps.invoke('ai.taskUsage', { days: 1 })).byTask.find((t) => t.task === 'rag-judge')?.calls ?? 0;
     await __t.real.click(vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim())));
     const go = await __t.waitFor(() => document.querySelector('[data-rag-estimate-run]'), 10000); if (!go) return 'NO DIALOG';
     await __t.sleep(400);
     const cached = /already cached/.test(document.querySelector('[data-rag-estimate-total]')?.textContent ?? '') ? 'cached-known' : 'cache-unknown';
     await __t.real.click(go); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === 2 && runs[0].total > 0); i++) {
       await __t.sleep(500);
       runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Clinic RAG');
     }
     const res = await window.aps.invoke('runs.results', { runId: runs[0].id, limit: 10 });
     const judged = res.items.flatMap((r) => r.checks).filter((c) => c.source === 'ai-judge');
     const after = (await window.aps.invoke('ai.taskUsage', { days: 1 })).byTask.find((t) => t.task === 'rag-judge')?.calls ?? 0;
     return 'runs: ' + runs.length + ' | judge calls before: ' + before + ' after: ' + after + ' | cached: ' + judged.filter((c) => c.metadata?.judge?.cached).length + '/' + judged.length;`,
  ),
  step(
    'the-matrix-shows-the-runs',
    `const seg = vis('main [role=radio], main button').find((b) => b.textContent.trim() === 'Matrix'); if (!seg) return 'NO MATRIX SWITCH';
     await __t.real.click(seg); await __t.sleep(2500);
     const t = document.querySelector('main')?.innerText ?? '';
     return 'cases: ' + ['hours', 'cancel'].filter((w) => t.toLowerCase().includes(w)).length + ' | matrix: ' + /Clinic RAG/.test(t);`,
  ),
  step(
    'no-judge-no-run',
    `const s = await window.aps.invoke('settings.get');
     await window.aps.invoke('settings.save', { ...s, assistantProvider: '', assistantModel: '' });
     ${setSelect(`document.querySelector('select[aria-label="AI reviewer provider"]')`, 'The AI settings')}
     await __t.sleep(400);
     const before = (await window.aps.invoke('runs.list', { limit: 20 })).items.length;
     await __t.real.click(vis('main button').find((b) => /^Run \\d+ cases/.test(b.textContent.trim())));
     const msg = await __t.waitFor(() => /needs a judge model/.test(document.body.innerText) && document.body.innerText, 8000);
     const after = (await window.aps.invoke('runs.list', { limit: 20 })).items.length;
     await window.aps.invoke('settings.save', s);
     return 'refused: ' + !!msg + ' | set up button: ' + [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Set up AI') + ' | runs started: ' + (after - before);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'rag-tab-in-ai-lab': /^empty: true$/,
    'connect-dialog': /^name: Clinic bot \| protocol: HTTP \| save disabled: true$/,
    probe: /^keys: .*"answer".*"sources"/,
    'click-the-answer': /^answer path: \$\.answer$/,
    'click-the-contexts': /^contexts path: \$\.sources\[\*\]$/,
    'click-inside-a-document': /^text: \$\.text \| id: \$\.id \| score: \$\.score$/,
    'the-sample-the-mapping-reads': /^answer: The clinic opens at 8am .* \| documents: [1-3] \| first id: doc-1 \| warnings: 0$/,
    'what-the-judge-receives': /^model: RAG mock judge.* \| metric in prompt: true \| answer in prompt: true \| privacy switch: false$/,
    'save-the-target': /^dialog closed: true \| saved: 1 Clinic bot http \| mapping: \{"answer":"\$\.answer","context":\{"id":"\$\.id","score":"\$\.score","text":"\$\.text"\},"contexts":"\$\.sources\[\*\]"\} \| listed: true$/,
    'the-target-opens-again-with-its-mapping': /^name: Clinic bot \| answer: \$\.answer \| contexts: \$\.sources\[\*\] \| request: true$/,
    'a-rag-evaluation': /^target: Clinic bot \| judge fields: true \| prompt tab: false \| import button: true \| run: Run 2 cases$/,
    'metrics-of-the-evaluation': /^metrics: Token F1, Context recall \(ids\), Faithfulness, Answer relevance \| chosen: [a-z0-9,-]+ \| judge note: true$/,
    'run-it': /^estimate: true \| runs: 1 \| passed: 2\/2 \| judged: 4 \| token-f1:0\.778 context-recall-ids:1 faithfulness:1 answer-relevance:1 latency:n\/a$/,
    'again-costs-nothing': /^runs: 2 \| judge calls before: 4 after: 4 \| cached: 4\/4$/,
    'the-matrix-shows-the-runs': /^cases: 2 \| matrix: true$/,
    'no-judge-no-run': /^refused: true \| set up button: true \| runs started: 0$/,
  },
  { prepare, settings: { assistantProvider: 'rag-mock-judge', assistantModel: 'mock-model' } },
);
