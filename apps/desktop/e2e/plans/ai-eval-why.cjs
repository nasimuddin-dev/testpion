// AU-15 · "Why did this fail?" on a failed case of an evaluation run: for a case no AI reviewer graded, the button is the AI action
// (the assistant explains it from the prompt, the reply, the expected answer and what each check said; "What will be sent…" shows
// the exact payload and the cost first; a scripted offline model answers). The answer names the cause. With the AI hidden, the
// button is not there. Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const ANSWER = 'The reply says cancellation, but the case expects refill. The expected answer looks wrong for this message: change the case, not the prompt.';

/** A second offline model that answers the explanation task (its context holds "failedChecks"), and is the assistant's model. */
function prepare(ws) {
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  c.providers.push({
    id: 'why-model',
    name: 'Why model',
    kind: 'mock',
    baseUrl: 'mock://',
    defaultModel: 'why',
    headers: [{ key: 'x-mock-rules', value: JSON.stringify([{ match: 'failedChecks', response: ANSWER }, { match: '.', response: 'ok' }]) }],
  });
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const finished = async (runId, ms = 40000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(250)) { const s = await window.aps.invoke('runs.summary', { runId }); if (s) return s; } return undefined; };
  const panel = () => document.querySelector('aside[aria-label="AI assistant"]');
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'a-run-with-a-wrong-expectation',
    `const dataset = [{ input: 'Cancel my appointment', expected: 'refill' }, { input: 'I need a refill', expected: 'refill' }].map((x) => JSON.stringify(x)).join('\\n');
     await window.aps.invoke('ai.sample', { run: false });
     const r = await window.aps.invoke('eval.runDraft', { draft: {
       name: 'Sample: support intents', type: 'llm', provider: 'demo', model: 'demo', temperature: 0, format: 'json', datasetFormat: 'jsonl', dataset, expectedField: 'expected', concurrency: 2, retries: 0,
       prompt: 'Classify the customer message. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\\n\\nCustomer: {{input}}',
       evaluators: [{ type: 'contains', expected: '{{expected}}', ignoreCase: true }],
     } });
     const s = await finished(r.runId); if (!s) return 'NO SUMMARY';
     window.__whyRun = r.runId;
     return 'run: ' + s.passed + '/' + s.total;`,
  ),
  step(
    'open-the-run',
    `await __t.view('Home'); await __t.view('AI Lab'); await __t.sleep(1000);
     const row = await __t.waitFor(() => vis('[data-start-run]')[0], 8000); if (!row) return 'NO RUN ROW';
     await __t.real.click([...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open'));
     const f = await __t.waitFor(() => vis('[data-eval-failure]')[0], 15000); if (!f) return 'NO FAILURE';
     const ai = f.querySelector('[data-eval-why-ai] [data-ai-action]');
     return 'failures: ' + vis('[data-eval-failure]').length + ' | label: ' + short(ai?.textContent) + ' | preview button: ' + !!f.querySelector('[data-ai-preview-open]');`,
  ),
  step(
    'what-will-be-sent-shows-the-case',
    `const f = vis('[data-eval-failure]')[0];
     await __t.real.click(f.querySelector('[data-ai-preview-open]'));
     const d = await __t.waitFor(() => vis('[role=dialog]').find((x) => /sent/i.test(x.textContent)), 8000); if (!d) return 'NO PREVIEW';
     await __t.sleep(800);
     const t = d.innerText;
     const out = 'prompt in payload: ' + /Cancel my appointment/.test(t) + ' | expected in payload: ' + /refill/.test(t) + ' | tokens/cost line: ' + /tokens/i.test(t);
     await __t.real.key('Escape'); await __t.sleep(300);
     return out;`,
  ),
  step(
    'one-click-explains',
    `const f = vis('[data-eval-failure]')[0];
     await __t.real.click(f.querySelector('[data-eval-why-ai] [data-ai-action]'));
     const a = await __t.waitFor(() => panel()?.querySelector('[data-turn=assistant] .markdown')?.innerText.length > 20 && panel().querySelector('[data-turn=assistant] .markdown'), 20000);
     if (!a) return 'NO ANSWER: ' + short(panel()?.innerText, 160);
     return 'title: ' + short(panel()?.querySelector('header, [data-assistant-title]')?.textContent, 60) + ' | answer: ' + short(a.innerText, 150);`,
  ),
];
module.exports = withExpect(
  steps,
  {
    'a-run-with-a-wrong-expectation': /^run: 1\/2$/,
    'open-the-run': /^failures: 1 \| label: Why did this fail\? \| preview button: true$/,
    'what-will-be-sent-shows-the-case': /^prompt in payload: true \| expected in payload: true \| tokens\/cost line: true$/,
    'one-click-explains': /answer: The reply says cancellation, but the case expects refill/,
  },
  { settings: { assistantProvider: 'why-model', assistantModel: 'why' }, prepare },
);
