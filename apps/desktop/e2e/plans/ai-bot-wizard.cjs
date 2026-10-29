// AU-20 · The wizard for a bot with sources: the Start page's "Answers come from my documents" card opens three steps (which bot, your
// questions, what should be true). With no bot it says so and offers Connect; with one it is chosen. The checks step shows two goals
// instead of the 138 metrics, the standard set of 5 as a preset line, and More checks opens the full picker. Run asks for the cost
// first (a judged check), runs on the local demo RAG system with a mock AI reviewer, and saves the SAME type rag evaluation.
// Offline: the mock provider and a local server only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step, setSelect, ensureRagServer } = require('../lib.cjs');

const HTTP = 'http://127.0.0.1:4020';

async function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const rules = [
    { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'Every claim is in the documents.', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1] "opens at 8am"' }] }) },
    { match: 'answer-relevance-v1', response: JSON.stringify({ reasoning: 'It answers the question.', items: [{ text: 'It answers.', verdict: true, reason: 'addresses the question' }] }) },
  ];
  doc.providers.push({ id: 'rag-mock-judge', name: 'RAG mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  await ensureRagServer('__e2eRagServer', 4020, 4021);
}

const H = `
  const bw = () => vis('[data-botwizard]')[0];
  const stepId = () => bw()?.getAttribute('data-botwizard-step');
  const goal = (id) => bw()?.querySelector('[data-botwizard-goal=' + id + ']');
`;
const TARGET = {
  protocol: 'http',
  step: { type: 'http', method: 'POST', url: `${HTTP}/query`, headers: { 'Content-Type': 'application/json' }, json: { question: '{{question}}' } },
  mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
};

const steps = [
  step(
    'the-documents-card-opens-the-bot-wizard',
    `${H} await __t.view('AI Lab'); await __t.sleep(1000);
     await __t.real.click(vis('[data-start-go=documents]')[0]);
     const w = await __t.waitFor(() => bw(), 8000); if (!w) return 'NO WIZARD';
     await __t.sleep(600);
     const next = vis('[data-botwizard-next]')[0];
     return 'title: ' + vis('[data-botwizard-title]')[0]?.textContent.replace(/\\s+/g, ' ').trim() + ' | step: ' + stepId() + ' | no bot says: ' + /No bot is connected yet/.test(bw().innerText) + ' | connect: ' + !!vis('[data-botwizard-connect]')[0] + ' | next: ' + (next?.disabled ? 'disabled: ' + next.getAttribute('title') : 'ENABLED');`,
  ),
  step(
    'connect-opens-the-connect-dialog',
    `${H} await __t.real.click(vis('[data-botwizard-connect]')[0]);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-connect]'), 5000); if (!d) return 'NO DIALOG';
     const presets = d.querySelectorAll('select option').length;
     const cancel = vis('[role=dialog] button').find((x) => x.textContent.trim() === 'Cancel'); await __t.real.click(cancel); await __t.sleep(400);
     return 'dialog opened: true | presets listed: ' + (presets > 3) + ' | wizard still open: ' + !!bw();`,
  ),
  step(
    'a-connected-bot-is-chosen',
    `${H} await window.aps.invoke('lib.save', { kind: 'rag-targets', library: { folders: [], items: [{ id: 'rt-clinic', name: 'Clinic bot', data: ${JSON.stringify(TARGET)} }] } });
     const sel = await __t.waitFor(() => vis('[data-botwizard-target]')[0], 6000); if (!sel) return 'NO SELECT';
     await __t.sleep(600);
     const next = vis('[data-botwizard-next]')[0];
     return 'chosen: ' + sel.selectedOptions[0]?.textContent + ' | next enabled: ' + !next?.disabled;`,
  ),
  step(
    'step-two-has-the-questions-and-three-ways-to-get-more',
    `${H} await __t.real.click(vis('[data-botwizard-next]')[0]);
     await __t.waitFor(() => stepId() === 'cases', 5000); await __t.sleep(600);
     return 'step: ' + stepId() + ' | questions: ' + /Preview . 2 cases/.test(bw().innerText) + ' | generate: ' + !!vis('[data-botwizard-generate]')[0] + ' | capture: ' + !!vis('[data-botwizard-capture]')[0] + ' | import: ' + !!vis('[data-rag-import]')[0] + ' | map columns: ' + !!vis('[data-rag-map-columns]')[0] + ' | run: ' + vis('[data-botwizard-run]')[0]?.textContent.trim();`,
  ),
  step(
    'generate-from-documents-opens-its-dialog',
    `${H} await __t.real.click(vis('[data-botwizard-generate]')[0]);
     const d = await __t.waitFor(() => vis('[role=dialog]').find((x) => /test set/i.test(x.innerText) && !x.hasAttribute('data-botwizard')), 6000);
     const opened = !!d;
     const close = vis('[role=dialog] button').filter((x) => /^(Cancel|Close)$/.test(x.textContent.trim())).pop(); if (close) await __t.real.click(close);
     await __t.sleep(500);
     return 'opened: ' + opened + ' | wizard still open: ' + !!bw();`,
  ),
  step(
    'step-three-shows-two-goals-and-the-standard-set',
    `${H} await __t.real.click(vis('[data-botwizard-next]')[0]);
     await __t.waitFor(() => stepId() === 'checks', 5000); await __t.sleep(1200);
     const metrics = (id) => [...goal(id).querySelectorAll('[data-botwizard-metric]')].map((m) => m.getAttribute('data-botwizard-metric')).join('+');
     return 'goals: ' + bw().querySelectorAll('[data-botwizard-goal]').length + ' | preset: ' + vis('[data-botwizard-preset]')[0]?.textContent.replace(/\\s+/g, ' ').slice(0, 60) + ' | sources: ' + metrics('sources') + ' on=' + goal('sources').getAttribute('data-botwizard-on') + ' | documents: ' + metrics('documents') + ' on=' + goal('documents').getAttribute('data-botwizard-on') + ' | extras: ' + /Token F1/.test(vis('[data-botwizard-extras]')[0]?.textContent ?? '') + ' | judge select: ' + !!vis('[data-botwizard-judge]')[0];`,
  ),
  step(
    'a-goal-switches-its-checks-off-and-on',
    `${H} await __t.real.click(goal('documents').querySelector('input[type=checkbox]')); await __t.sleep(500);
     const off = vis('[data-botwizard-count]')[0].textContent + ' / ' + vis('[data-botwizard-preset]')[0].textContent.includes('(the standard set)');
     await __t.real.click(goal('documents').querySelector('input[type=checkbox]')); await __t.sleep(500);
     return 'off: ' + off + ' | on again: ' + vis('[data-botwizard-count]')[0].textContent + ' / ' + vis('[data-botwizard-preset]')[0].textContent.includes('(the standard set)');`,
  ),
  step(
    'more-checks-opens-the-full-picker',
    `${H} await __t.real.click(vis('[data-botwizard-more]')[0]);
     const p = await __t.waitFor(() => vis('[data-botwizard-picker]')[0] && vis('[data-rag-metric]').length > 20 ? vis('[data-botwizard-picker]')[0] : null, 8000); if (!p) return 'NO PICKER';
     const n = vis('[data-rag-metric]').length;
     await __t.real.click(vis('[data-botwizard-more-done]')[0]); await __t.sleep(500);
     return 'picker rows: ' + (n > 20) + ' | back on the wizard: ' + !!bw() + ' | still ' + vis('[data-botwizard-count]')[0].textContent;`,
  ),
  step(
    'the-ai-reviewer-and-the-cost',
    `${H} ${setSelect(`vis('[data-botwizard-judge]')[0]`, 'RAG mock judge')}
     await __t.sleep(1500);
     const cost = vis('[data-botwizard-cost]')[0]?.innerText.replace(/\\s+/g, ' ');
     return 'cost line: ' + (cost && cost.length > 10 && !/Estimating/.test(cost) ? 'shown' : 'MISSING ' + cost);`,
  ),
  step(
    'run-asks-the-cost-then-saves-the-same-evaluation',
    `${H} await __t.real.click(vis('[data-botwizard-run]')[0]);
     const dlg = await __t.waitFor(() => document.querySelector('[data-rag-estimate-dialog]'), 15000); if (!dlg) return 'NO ESTIMATE DIALOG';
     const est = await __t.waitFor(() => document.querySelector('[data-rag-estimate-total]'), 10000); if (!est) return 'NO ESTIMATE';
     await __t.real.click('[data-rag-estimate-run]'); await __t.sleep(300);
     let runs = [];
     for (let i = 0; i < 120 && !(runs.length === 1 && runs[0].total > 0); i++) {
       await __t.sleep(500);
       runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'New bot evaluation');
     }
     const item = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.name === 'New bot evaluation');
     const d = item?.data ?? {};
     const known = ['name', 'type', 'provider', 'model', 'temperature', 'system', 'prompt', 'format', 'datasetFormat', 'dataset', 'expectedField', 'evaluators', 'concurrency', 'limit', 'retries', 'target', 'judge', 'passLine', 'maxCostUsd', 'variants', 'gates', 'maxJudgeCostUsd', 'maxJudgeCalls'];
     return 'passed: ' + runs[0]?.passed + '/' + runs[0]?.total + ' | type: ' + d.type + ' | target: ' + d.target + ' | checks: ' + (d.evaluators ?? []).map((e) => e.type).sort().join(',') + ' | judge: ' + d.judge?.provider + ' | extra fields: ' + (Object.keys(d).filter((k) => !known.includes(k)).join(',') || 'none') + ' | wizard closed: ' + !bw();`,
  ),
];
module.exports = withExpect(
  steps,
  {
    'the-documents-card-opens-the-bot-wizard': /^title: Answers come from my documents\s*Step 1 of 3 \| step: bot \| no bot says: true \| connect: true \| next: disabled: Choose the bot to test, or connect one$/,
    'connect-opens-the-connect-dialog': /^dialog opened: true \| presets listed: true \| wizard still open: true$/,
    'a-connected-bot-is-chosen': /^chosen: Clinic bot \| next enabled: true$/,
    'step-two-has-the-questions-and-three-ways-to-get-more': /^step: cases \| questions: true \| generate: true \| capture: true \| import: true \| map columns: true \| run: Run 2 questions$/,
    'generate-from-documents-opens-its-dialog': /^opened: true \| wizard still open: true$/,
    'step-three-shows-two-goals-and-the-standard-set': /^goals: 2 \| preset: Quality checks: 5 selected \(the standard set\).* \| sources: faithfulness\+answer-relevance on=true \| documents: context-recall-ids on=true \| extras: true \| judge select: true$/,
    'a-goal-switches-its-checks-off-and-on': /^off: 4 selected \/ false \| on again: 5 selected \/ true$/,
    'more-checks-opens-the-full-picker': /^picker rows: true \| back on the wizard: true \| still 5 selected$/,
    'the-ai-reviewer-and-the-cost': /^cost line: shown$/,
    'run-asks-the-cost-then-saves-the-same-evaluation': /^passed: 2\/2 \| type: rag \| target: rt-clinic \| checks: answer-relevance,context-recall-ids,faithfulness,latency,token-f1 \| judge: rag-mock-judge \| extra fields: none \| wizard closed: true$/,
  },
  { prepare },
);
