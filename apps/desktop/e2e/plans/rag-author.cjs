// Evaluation authoring (AI-11), with real mouse and keys (__t.real): Evaluations ▸ type RAG ▸ the RAG target ▸ "Draft an
// evaluation with AI" with a goal and a dataset of the workspace (how many metrics the data can support is shown before
// anything is asked), the scripted offline model answers with a plan (one metric the data cannot run, one invented), the
// shared proposal review shows the evaluation with the dry-run badge and the notes of what TestPion dropped, Accept saves it
// in the saved evaluations, Undo takes it away. Offline: a scripted mock model only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step, setSelect } = require('../lib.cjs');

const PLAN = {
  name: 'Clinic quality check',
  summary: 'Did the right chunk come back, and does the answer match the reference.',
  assumptions: ['The handbook is the only source'],
  dataset: { slice: { limit: 2, reason: 'a quick first look' } },
  metrics: [
    { id: 'recall@k', threshold: 0.8, options: { k: 3 }, why: 'did the gold chunk come back' },
    { id: 'token-f1', threshold: 0.5, why: 'the answer matches the reference' },
    { id: 'tool-call-accuracy', why: 'the system calls tools' },
    { id: 'invented-metric', why: 'made up' },
  ],
  gates: { 'recall@k': 0.7 },
  risks: ['only 3 questions'],
};

function prepare(ws) {
  const file = join(ws, 'providers.json');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const demo = doc.providers.find((x) => x.id === 'demo');
  const rules = demo.headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([{ match: '"target"', response: JSON.stringify(PLAN) }, ...JSON.parse(rules.value)]);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  mkdirSync(join(ws, 'library'), { recursive: true });
  writeFileSync(
    join(ws, 'library', 'rag-targets.json'),
    JSON.stringify({ schemaVersion: '1.0', folders: [], items: [{ id: 'rag-clinic', name: 'Clinic bot', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: 'https://rag.example.test/query', headers: { Authorization: 'Bearer e2e-secret-token-123456' }, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id' } } } }] }, null, 2),
  );
  mkdirSync(join(ws, 'datasets'), { recursive: true });
  const rows = [
    { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am.', reference_ids: ['doc-1'], answer: 'It opens at 8am.', contexts: [{ id: 'doc-1', text: 'The clinic opens at 8am on weekdays.' }] },
    { id: 'place', question: 'Where is the clinic?', reference: 'On Main Street.', reference_ids: ['doc-2'], answer: 'On Main Street.', contexts: [{ id: 'doc-2', text: 'We are at 5 Main Street.' }] },
    { id: 'birds', question: 'Do you treat birds?', reference: 'Yes, small birds.', reference_ids: ['doc-3'], answer: 'No idea.', contexts: [{ id: 'doc-9', text: 'Unrelated.' }] },
  ];
  writeFileSync(join(ws, 'datasets', 'clinic-qa.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const panel = `document.querySelector('aside[aria-label="AI assistant"]')`;
const library = `(await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.map((i) => i.name).join(',')`;

const steps = [
  step(
    'the-data-says-what-it-can-support',
    `await __t.view('Evaluations'); await __t.sleep(800);
     ${setSelect(`document.querySelector('select[aria-label="Evaluation type"]')`, 'Bot with sources')}
     await __t.sleep(500);
     ${setSelect(`document.querySelector('[data-rag-target]')`, 'Clinic bot')}
     const box = await __t.waitFor(() => document.querySelector('[data-rag-author]'), 6000); if (!box) return 'NO AUTHOR BOX';
     const none = (await __t.waitFor(() => document.querySelector('[data-rag-author-inputs]'), 6000))?.textContent.trim();
     ${setSelect(`document.querySelector('[data-rag-author-dataset]')`, 'clinic-qa.jsonl')}
     const withData = await __t.waitFor(() => /clinic-qa\\.jsonl \\(3 records\\)/.test(document.querySelector('[data-rag-author-inputs]')?.textContent ?? '') && document.querySelector('[data-rag-author-inputs]'), 6000);
     const n = (t) => Number(/(\\d+) of (\\d+)/.exec(t ?? '')?.[1]);
     return 'without a dataset: ' + n(none) + ' | with: ' + n(withData?.textContent) + ' | more with data: ' + (n(withData?.textContent) > n(none));`,
  ),
  step(
    'type-the-goal-and-draft',
    `await __t.real.click('[data-rag-author-goal]'); await __t.real.type('answers come from the handbook');
     const b = document.querySelector('[data-rag-author] [data-ai-action]'); if (!b) return 'NO BUTTON Draft';
     await __t.real.click(b);
     for (let i = 0; i < 100 && !${panel}?.querySelector('[data-proposal-review]'); i++) await __t.sleep(150);
     const review = ${panel}?.querySelector('[data-proposal-review]'); if (!review) return 'NO BUTTON Review';
     await __t.sleep(400);
     await __t.real.click(review);
     const modal = await __t.waitFor(() => document.querySelector('[data-proposal]'), 12000); if (!modal) return 'NO REVIEW (panel: ' + (${panel}?.textContent ?? '').slice(0, 160) + ')';
     const item = modal.querySelector('[data-proposal-item]');
     const badge = item?.querySelector('[data-verifier="rag-eval-dry-run"]');
     return 'title: ' + item?.querySelector('.mono, [data-proposal-title]')?.textContent.trim()
       + ' | badge: ' + badge?.getAttribute('data-verification') + ' ' + (badge?.textContent.trim() ?? '').slice(0, 60)
       + ' | ticked: ' + item?.querySelector('input[type=checkbox]')?.checked;`,
  ),
  step(
    'the-notes-say-what-was-dropped',
    `const modal = document.querySelector('[data-proposal]'); const text = modal?.textContent ?? '';
     return 'dropped unknown: ' + /invented-metric/.test(text) + ' | dropped tool-call-accuracy: ' + /tool-call-accuracy/.test(text) + ' | gate flag: ' + /--min recall@k=0.7/.test(text) + ' | risk: ' + /Cannot tell: only 3 questions/.test(text) + ' | no secret: ' + !/e2e-secret-token/.test(text);`,
  ),
  step(
    'accept-saves-it',
    `await __t.real.click('[data-proposal-accept]');
     let names = ''; for (let i = 0; i < 40 && !names.includes('Clinic quality check'); i++) { await __t.sleep(250); names = ${library}; }
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside *, main *')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Clinic quality check' && e.offsetParent), 6000);
     const ev = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.name === 'Clinic quality check');
     return 'saved: ' + names + ' | in the list: ' + !!row + ' | evaluators: ' + ev?.data.evaluators.map((e) => e.type).join(',') + ' | dataset records: ' + ev?.data.dataset.trim().split('\\n').length + ' | target: ' + ev?.data.target;`,
  ),
  step(
    'undo-takes-it-away',
    `const u = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === 'Undo'), 6000); if (!u) return 'NO BUTTON Undo';
     await __t.real.click(u);
     let names = 'x'; for (let i = 0; i < 40 && names.includes('Clinic quality check') || names === 'x'; i++) { await __t.sleep(250); names = ${library}; }
     return 'after undo: [' + names + ']';`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'the-data-says-what-it-can-support': /^without a dataset: \d+ \| with: \d+ \| more with data: true$/,
    'type-the-goal-and-draft': /^title: Evaluation: Clinic quality check \| badge: (pass|warn) \d of \d metrics can run.* \| ticked: true$/,
    'the-notes-say-what-was-dropped': /^dropped unknown: true \| dropped tool-call-accuracy: true \| gate flag: true \| risk: true \| no secret: true$/,
    'accept-saves-it': /^saved: (?:Learn: [^,|]+,)*Clinic quality check \| in the list: true \| evaluators: recall@k,token-f1 \| dataset records: 2 \| target: rag-clinic$/,
    'undo-takes-it-away': /^after undo: \[(?:Learn: [^,|\]]+(?:,|(?=\])))*\]$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
