// AU-14, AU-22 · The report card of an evaluation run: the sentence "8 of 10 passed", the cost and time, how it compares with the
// last run, the trend line, how many cases passed each check, and the failed cases first. "Since last run" on a failed case shows
// its reply next to the reply in the run before (the same answer, the case got worse). A pass line set under Options is read from
// the saved evaluation: "Pass line 90%: not met" with a bar. The same sentence is on the runs overview of Evaluations.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepWith } = require('../lib.cjs');

const H = `
  const finished = async (runId, ms = 40000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(250)) { const s = await window.aps.invoke('runs.summary', { runId }); if (s) return s; } return undefined; };
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const report = () => vis('[data-run-report]')[0];
  const openNewest = async () => {
    await __t.view('Home'); await __t.view('AI Lab'); await __t.sleep(1000);
    const row = await __t.waitFor(() => vis('[data-start-run]')[0], 8000); if (!row) return false;
    await __t.real.click([...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open'));
    return !!(await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 15000));
  };
`;
const step = stepWith({ extra: H });

// two cases of the sample now expect the wrong answer, so the second run has two failures
const WRONG = `
  const lines = [
    { input: 'Cancel my appointment', expected: 'refill' }, { input: 'I need to cancel my Friday visit', expected: 'cancellation' }, { input: 'I need a refill', expected: 'booking' },
    { input: 'Can I get a refill of my prescription?', expected: 'refill' }, { input: 'Can I book for Tuesday?', expected: 'booking' }, { input: 'I want to schedule a checkup', expected: 'booking' },
    { input: 'Please book me a slot next week', expected: 'booking' }, { input: 'What are your opening hours?', expected: 'other' }, { input: 'Where can I park?', expected: 'other' }, { input: 'Do you accept walk-ins?', expected: 'other' },
  ].map((x) => JSON.stringify(x)).join('\\n');
`;

const steps = [
  step(
    'two-runs',
    `${WRONG}
     const first = await window.aps.invoke('ai.sample');
     const a = await finished(first.runId); if (!a) return 'NO FIRST SUMMARY';
     await __t.sleep(50);
     const second = await window.aps.invoke('eval.runDraft', { draft: {
       name: 'Sample: support intents', type: 'llm', provider: 'demo', model: 'demo', temperature: 0, format: 'json', datasetFormat: 'jsonl', dataset: lines, expectedField: 'expected', concurrency: 4, retries: 0,
       prompt: 'Classify the customer message as cancellation, refill, booking or other. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\\n\\nCustomer: {{input}}',
       evaluators: [{ type: 'contains', expected: '{{expected}}', ignoreCase: true }],
     } });
     const b = await finished(second.runId); if (!b) return 'NO SECOND SUMMARY';
     return 'first: ' + a.passed + '/' + a.total + ' | second: ' + b.passed + '/' + b.total;`,
  ),
  step(
    'the-report-card',
    `if (!(await openNewest())) return 'NO RUN OPENED';
     await __t.sleep(600);
     const r = report();
     const failures = vis('[data-eval-failure]');
     return 'headline: ' + short(vis('[data-eval-headline-text]')[0]?.textContent)
       + ' | vs last: ' + short(vis('[data-eval-vs-last]')[0]?.textContent)
       + ' | trend: ' + (vis('[data-eval-trend]').length > 0)
       + ' | by check: ' + short(vis('[data-eval-by-check]')[0]?.textContent, 80)
       + ' | failures: ' + failures.length + ' (' + failures.map((f) => f.getAttribute('data-eval-failure')).join(',') + ')'
       + ' | first: ' + short(failures[0]?.textContent, 120);`,
  ),
  step(
    'failed-cases-name-what-was-expected',
    `const f = vis('[data-eval-failure]')[0];
     const why = f?.querySelector('[data-eval-why-ai], [data-eval-why-stored]');
     const diff = f?.querySelector('[data-eval-diff-open]');
     return 'expected shown: ' + /Expected refill/.test(f?.textContent ?? '') + ' | got shown: ' + /Got .*cancellation/.test(f?.textContent ?? '') + ' | why button: ' + !!why + ' | since last run button: ' + diff?.textContent.trim() + ' enabled: ' + !diff?.disabled;`,
  ),
  step(
    'since-last-run',
    `const b = vis('[data-eval-diff-open]')[0];
     await __t.real.click(b);
     const p = await __t.waitFor(() => vis('[data-eval-case-diff]')[0], 10000); if (!p) return 'NO DIFF';
     return 'same answer: ' + p.getAttribute('data-same') + ' | change: ' + p.getAttribute('data-change') + ' | text: ' + short(p.querySelector('p')?.textContent, 120) + ' | sides: ' + (/The last run/.test(p.textContent) && /This run/.test(p.textContent));`,
  ),
  step(
    'show-all-failures',
    `const before = vis('[data-eval-failure]').length;
     const t = vis('[data-eval-failures-toggle]')[0];
     return 'failures shown: ' + before + ' | toggle for more: ' + !!t;`,
  ),
  step(
    'the-pass-line',
    `const input = vis('[data-eval-pass-line-input]')[0];
     if (!input) { const sum = vis('[data-eval-options] summary')[0]; if (sum) await __t.real.click(sum); await __t.sleep(300); }
     const field = vis('[data-eval-pass-line-input]')[0]; if (!field) return 'NO PASS LINE FIELD';
     setValue(field, '90'); await __t.sleep(200);
          await __t.real.click(vis('main button').find((b) => /^Save\\*?$/.test(b.textContent.trim()))); await __t.sleep(800);
     const kept = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.map((i) => i.name + ':' + i.data.passLine).join(',');
     if (!(await openNewest())) return 'NO RUN OPENED';
     await __t.sleep(600);
     const line = vis('[data-eval-pass-line]')[0];
     return 'pass line: ' + line?.getAttribute('data-eval-pass-line') + ' | text: ' + short(line?.textContent, 60)+ ' | kept: ' + kept;`,
  ),
  step(
    'the-sentence-tops-the-runs-overview',
    `const back = vis('main button, aside button').find((b) => /Overview of all runs/.test(b.textContent));
     const tabRuns = vis('[role=tablist][aria-label="Sidebar"] [role=tab]').find((t) => t.textContent.trim().startsWith('Runs'));
     if (tabRuns) { await __t.real.click(tabRuns); await __t.sleep(500); }
     const o = vis('button').find((b) => /Overview of all runs/.test(b.textContent));
     if (!o) return 'NO OVERVIEW BUTTON';
     await __t.real.click(o); await __t.sleep(1200);
     const head = vis('[data-run-report] [data-eval-headline-text]')[0];
     return 'overview headline: ' + short(head?.textContent) + ' | no failure list in the overview: ' + (vis('[data-eval-failure]').length === 0);`,
  ),
];
module.exports = withExpect(steps, {
  'two-runs': /^first: 10\/10 \| second: 8\/10$/,
  'the-report-card': /^headline: 8 of 10 passed \| vs last: Against the last run: −2 passed, 0 got better, 2 got worse \| trend: true \| by check: By check.*\d+\/\d+ \| failures: 2 \(1,3\) \| first: 1.*/,
  'failed-cases-name-what-was-expected': /^expected shown: true \| got shown: true \| why button: true \| since last run button: Since last run enabled: true$/,
  'since-last-run': /^same answer: true \| change: got worse \| text: The answer is the same as in the last run, but the case got worse.* \| sides: true$/,
  'show-all-failures': /^failures shown: 2 \| toggle for more: false$/,
  'the-pass-line': /^pass line: not-met \| text: Pass line 90%: not met \| kept: Sample: support intents:90$/,
  'the-sentence-tops-the-runs-overview': /^overview headline: \d+ of \d+ passed \| no failure list in the overview: true$/,
});
