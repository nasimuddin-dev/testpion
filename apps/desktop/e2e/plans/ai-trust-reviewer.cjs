// AU-23 · Trust the AI reviewer, with real mouse and keys (__t.real): an evaluation with a check "Graded by an AI reviewer" (a
// scripted offline reviewer that fails every message about a refill) is run; its Checks tab has the card "Trust the AI reviewer":
// ten answers of the run to grade yourself, good or bad, WITHOUT the reviewer's verdict; after the tenth the card says how often
// the AI reviewer agreed ("8 of 10 (80 %)", too strict on 2) and shows the shared agreement card (kappa, counts, the answers where
// you disagree). An evaluation with no AI reviewer check has no card. Offline: scripted mock models only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

const MESSAGES = [
  ['Cancel my appointment', 'cancellation'],
  ['I need to cancel my Friday visit', 'cancellation'],
  ['I need a refill', 'refill'],
  ['Can I get a refill of my prescription?', 'refill'],
  ['Can I book for Tuesday?', 'booking'],
  ['I want to schedule a checkup', 'booking'],
  ['Please book me a slot next week', 'booking'],
  ['What are your opening hours?', 'other'],
  ['Where can I park?', 'other'],
  ['Do you accept walk-ins?', 'other'],
];

function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const rules = [
    { match: 'CRITERIA[\\s\\S]*refill', response: '{"score":0,"reasoning":"The reply is not polite."}' },
    { match: 'CRITERIA', response: '{"score":1,"reasoning":"The reply is polite."}' },
  ];
  doc.providers.push({ id: 'trust-judge', name: 'Scripted AI reviewer', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
  writeFileSync(file, JSON.stringify(doc, null, 2));
  mkdirSync(join(ws, 'library'), { recursive: true });
  const data = {
    name: 'Polite replies',
    type: 'llm',
    provider: 'demo',
    model: 'demo',
    temperature: 0,
    prompt: 'Classify the customer message as cancellation, refill, booking or other. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\n\nCustomer: {{input}}',
    format: 'json',
    datasetFormat: 'jsonl',
    dataset: MESSAGES.map(([input, expected]) => JSON.stringify({ input, expected })).join('\n'),
    expectedField: 'expected',
    evaluators: [{ type: 'llm-judge', criteria: 'The reply is polite.', threshold: 0.5, provider: 'trust-judge' }],
    concurrency: 4,
    retries: 0,
  };
  writeFileSync(join(ws, 'library', 'evaluations.json'), JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'ev-polite', name: 'Polite replies', data, updatedAt: new Date().toISOString() }] }, null, 2));
}

const H = `
  const card = () => vis('[data-trust-reviewer]')[0];
  const cases = () => vis('[data-trust-case]');
  const done = () => card()?.querySelector('[data-trust-summary]')?.getAttribute('data-trust-done');
`;

const steps = [
  step(
    'before-a-run-the-card-says-what-to-do',
    `${H} await __t.view('Evaluations'); await __t.sleep(1200);
     const row = await __t.waitFor(() => vis('aside *, [data-sidebar] *, main *').find((e) => e.children.length === 0 && e.textContent.trim() === 'Polite replies'), 6000);
     if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(1000);
     await __t.real.click(tab('Checks')); await __t.sleep(600);
     const c = await __t.waitFor(() => card(), 6000); if (!c) return 'NO CARD';
     await __t.real.click(c.querySelector('summary')); await __t.sleep(400);
     const b = vis('[data-trust-norun] button')[0];
     return 'card: true | button disabled: ' + !!b?.disabled + ' | why: ' + b?.getAttribute('title') + ' | text: ' + card().innerText.replace(/\\s+/g, ' ').slice(0, 160);`,
  ),
  step(
    'run-the-evaluation',
    `${H} await __t.real.click(vis('main button[data-eval-run]')[0]);
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 60000);
     return 'headline: ' + (head ? head.textContent.trim() : 'NONE');`,
  ),
  step(
    'ten-answers-to-grade-without-the-reviewers-verdict',
    `${H} await __t.view('Home'); await __t.view('Evaluations'); await __t.sleep(1000);
     await __t.real.click(tab('Checks')); await __t.sleep(500);
     const c = await __t.waitFor(() => card(), 6000); if (!c) return 'NO CARD';
     c.scrollIntoView({ block: 'center' }); await __t.sleep(200);
     if (!cases().length) await __t.real.click(c.querySelector('summary'));
     await __t.waitFor(() => cases().length === 10, 10000);
     card().scrollIntoView({ block: 'start' }); await __t.sleep(150);
     const text = card().innerText;
     return 'answers: ' + cases().length + ' | graded: ' + cases().filter((x) => x.getAttribute('data-trust-yours') !== 'none').length + ' | shows a reviewer verdict: ' + /reasoning|not polite|score|reviewer (said|passed|failed)/i.test(text.replace('Trust the AI reviewer', '')) + ' | summary: ' + card().querySelector('[data-trust-sentence]')?.textContent.trim().slice(0, 70);`,
  ),
  step(
    'grade-them-all-good',
    `${H} for (let i = 0; i < 10; i++) {
       const row = cases().find((x) => x.getAttribute('data-trust-yours') === 'none'); if (!row) break;
       row.scrollIntoView({ block: 'center' }); await __t.sleep(120);
       await __t.real.click(row.querySelector('[data-trust-pass]'));
       await __t.waitFor(() => !cases().some((x) => x.querySelector('button[disabled]')), 8000);
     }
     await __t.waitFor(() => done() === 'true', 15000);
     return 'done: ' + done() + ' | sentence: ' + card().querySelector('[data-trust-sentence]')?.textContent.trim().replace(/\\s+/g, ' ');`,
  ),
  step(
    'the-agreement-card-shows-where-you-disagree',
    `${H} const m = await __t.waitFor(() => card().querySelector('[data-rag-calibration-metric]'), 6000); if (!m) return 'NO AGREEMENT CARD';
     const dis = m.querySelectorAll('[data-rag-disagreements] li').length;
     return 'metric: ' + m.getAttribute('data-rag-calibration-metric') + ' | kappa row: ' + /Cohen/.test(m.innerText) + ' | disagreements listed: ' + dis + ' | confusion: ' + !!m.querySelector('[data-rag-confusion]');`,
  ),
  step(
    'your-verdicts-are-kept-and-one-can-be-taken-back',
    `${H} const first = cases()[0]; first.scrollIntoView({ block: 'center' }); await __t.sleep(150);
     await __t.real.click(first.querySelector('[data-trust-pass]'));
     await __t.waitFor(() => done() === 'false', 8000);
     const graded = cases().filter((x) => x.getAttribute('data-trust-yours') !== 'none').length;
     const labels = (await window.aps.invoke('rag.label.list', { run: (await window.aps.invoke('runs.list', { limit: 5 })).items.find((r) => r.name === 'Polite replies').id })).items.length;
     return 'graded after taking one back: ' + graded + ' | labels kept: ' + labels + ' | done: ' + done();`,
  ),
  step(
    'an-evaluation-without-an-ai-reviewer-has-no-card',
    `${H} await window.aps.invoke('ai.sample', { run: false });
     await __t.view('Home'); await __t.view('Evaluations'); await __t.sleep(1000);
     const row = await __t.waitFor(() => vis('aside *, [data-sidebar] *, main *').find((e) => e.children.length === 0 && e.textContent.trim() === 'Sample: support intents'), 6000);
     await __t.real.click(row); await __t.sleep(900);
     await __t.real.click(tab('Checks')); await __t.sleep(600);
     return 'card: ' + !!card() + ' | checks picker: ' + !!vis('[data-good-answer]')[0];`,
  ),
];
module.exports = withExpect(
  steps,
  {
  'before-a-run-the-card-says-what-to-do': /^card: true \| button disabled: true \| why: Run this evaluation first/,
  'run-the-evaluation': /^headline: 8 of 10 passed$/,
  'ten-answers-to-grade-without-the-reviewers-verdict': /^answers: 10 \| graded: 0 \| shows a reviewer verdict: false \| summary: Read each answer and say whether it is good/,
  'grade-them-all-good': /^done: true \| sentence: The AI reviewer agreed with you on 8 of 10 answers \(80 %\)\. It failed 2 that you passed \(too strict\)\.$/,
  'the-agreement-card-shows-where-you-disagree': /^metric: llm-judge \| kappa row: true \| disagreements listed: 2 \| confusion: true$/,
  'your-verdicts-are-kept-and-one-can-be-taken-back': /^graded after taking one back: 9 \| labels kept: 9 \| done: false$/,
  'an-evaluation-without-an-ai-reviewer-has-no-card': /^card: false \| checks picker: true$/,
  },
  { prepare },
);
