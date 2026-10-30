// AU-4, AU-5, AU-7, AU-9, AU-17 · The first result of an AI evaluation in one click, with no key: AI Lab opens on Start (cards
// by task, the sample button, no runs yet); "Try the sample (offline)" adds the offline demo model and the 10-case sample, runs it
// and opens the result with the chip "10 of 10 passed" and an "Offline demo" label; the price is beside Run ("free" for the demo
// model); Start lists the run; Run in CI… opens the pipeline dialog on that evaluation with the "last good run" command. A new
// evaluation's empty Run pane says what a run does and offers the sample.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'start-page',
    `await __t.view('AI Lab'); await __t.sleep(1200);
     const tabs = vis('main [role=tab]').map((t) => t.textContent.trim().replace(/\\d+$/, '')).join(',');
     const sel = vis('main [role=tab][aria-selected=true]').map((t) => t.textContent.trim()).join(',');
     const cards = vis('[data-start-card]').map((c) => c.getAttribute('data-start-card')).join(',');
     const sample = vis('[data-start-sample]')[0]?.textContent.trim();
     const recent = vis('[data-start-recent]')[0]?.getAttribute('data-start-recent');
     return 'tabs: ' + tabs + ' | selected: ' + sel + ' | cards: ' + cards + ' | sample: ' + sample + ' | recent: ' + recent;`,
  ),
  step(
    'cards-without-an-evaluation-say-why',
    `const worse = vis('[data-start-go=worse]')[0];
     return 'run in CI disabled: ' + !!worse?.disabled + ' | why: ' + (worse?.getAttribute('title') ?? 'NO REASON');`,
  ),
  step(
    'empty-run-pane-says-what-a-run-does',
    `await __t.view('Evaluations'); await __t.sleep(1200);
     const empty = vis('main').map((m) => m.innerText).join(' ');
     const buttons = vis('main button').map((b) => b.textContent.trim());
     await __t.view('AI Lab'); await __t.sleep(600);
     return 'title: ' + /Run this evaluation/.test(empty) + ' | steps: ' + /Each test case is sent/.test(empty) + ' | to review hidden: ' + !/To review/.test(empty) + ' | sample button: ' + buttons.includes('Try the sample (offline)');`,
  ),
  step(
    'sample-in-one-click',
    `let clicks = 0;
     await __t.real.click(vis('[data-start-sample]')[0]); clicks++;
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 40000);
     const view = (document.querySelector('nav[aria-label="Main navigation"] [aria-current=page]')?.getAttribute('aria-label')) ?? '?';
     const offline = vis('main').some((m) => /Offline demo/.test(m.innerText));
     return 'clicks: ' + clicks + ' | view: ' + view + ' | headline: ' + (head ? head.textContent.trim() : 'NONE') + ' | offline label: ' + offline;`,
  ),
  step(
    'the-price-is-beside-run',
    `await __t.sleep(800);
     const run = vis('main button[data-eval-run]')[0];
     const cost = vis('main [data-eval-cost]')[0];
     return 'run: ' + run?.textContent.trim() + ' | cost: ' + cost?.getAttribute('data-eval-cost') + ' | line: ' + cost?.textContent.trim().replace(/\\s+/g, ' ');`,
  ),
  step(
    'start-lists-the-run',
    `await __t.view('Home'); await __t.view('AI Lab'); await __t.sleep(1200);
     const row = await __t.waitFor(() => vis('[data-start-run]')[0], 6000);
     return 'row: ' + (row ? row.textContent.replace(/\\s+/g, ' ').trim() : 'NONE');`,
  ),
  step(
    'open-from-start-shows-the-result',
    `await __t.real.click([...vis('[data-start-run] button')].find((b) => b.textContent.trim() === 'Open'));
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 15000);
     return 'headline: ' + (head ? head.textContent.trim() : 'NONE') + ' | name: ' + vis('main input[aria-label="Evaluation name"]')[0]?.value;`,
  ),
  step(
    'run-in-ci-from-the-evaluation',
    `await __t.real.click(vis('main [data-eval-ci]')[0]);
     const dlg = await __t.waitFor(() => vis('[role=dialog]').find((d) => /Run in CI/.test(d.textContent)), 6000);
     if (!dlg) return 'NO DIALOG';
     await __t.sleep(1200);
     const note = dlg.querySelector('[data-ci-evaluation-note]')?.textContent.trim().slice(0, 60);
     const text = dlg.innerText;
     const sel = [...dlg.querySelectorAll('select')].map((s) => s.options[s.selectedIndex]?.textContent.trim()).find((t) => /Evaluation:/.test(t ?? ''));
     const ok = /eval run "Sample: support intents"/.test(text) && /--baseline last-good --fail-on-regression/.test(text);
     await __t.real.key('Escape'); await __t.sleep(300);
     return 'chosen: ' + sel + ' | command: ' + ok + ' | note: ' + note;`,
  ),
];
module.exports = withExpect(steps, {
  'start-page': /^tabs: Start,Checks,Try a prompt,Compare,Models and keys \| selected: Start \| cards: correct,better,documents,worse,agent,models \| sample: Try the sample \(offline\) \| recent: empty$/,
  'cards-without-an-evaluation-say-why': /^run in CI disabled: true \| why: Save an evaluation first/,
  'sample-in-one-click': /^clicks: 1 \| view: AI quality \| headline: 10 of 10 passed \| offline label: true$/,
  'the-price-is-beside-run': /^run: Run 10 cases · free \| cost: offline \| line: 10 cases · free .*Offline demo/,
  'start-lists-the-run': /^row: Sample: support intents.*10 of 10 passed/,
  'open-from-start-shows-the-result': /^headline: 10 of 10 passed \| name: Sample: support intents$/,
  'run-in-ci-from-the-evaluation': /^chosen: Evaluation: Sample: support intents \| command: true \| note: The pipeline runs this evaluation/,
  'empty-run-pane-says-what-a-run-does': /^title: true \| steps: true \| to review hidden: true \| sample button: true$/,
});
