// A-6 · Review answers: from the report card of the offline sample, ten answers are read and graded good or bad from the keyboard
// (G good, B bad, J next, K back); what the checks decided stays hidden until a case is graded, then it shows and says whether it
// agrees; the grades are the run's reviews (the result's own good / bad); the good answers can be added to the test cases.
// Offline: the demo model only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'the-sample-is-run-and-the-queue-opens',
    `await __t.view('AI Lab'); await __t.sleep(1200);
     await __t.real.click(vis('[data-start-sample]')[0]);
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 60000); if (!head) return 'NO REPORT';
     await __t.real.click(vis('[data-eval-review-open]')[0]);
     const q = await __t.waitFor(() => document.querySelector('[data-review-queue]'), 8000); if (!q) return 'NO QUEUE';
     return 'position: ' + q.querySelector('[data-review-position]').textContent.trim() + ' | verdict hidden: ' + !q.querySelector('[data-review-verdict]') + ' | text: ' + q.querySelector('[data-review-text]').textContent.trim().slice(0, 70);`,
  ),
  step(
    'g-grades-good-and-shows-what-the-checks-decided',
    `const first = document.querySelector('[data-review-case]').getAttribute('data-review-case');
     await __t.real.key('g'); await __t.sleep(900);
     const back = [...document.querySelectorAll('[data-review-case]')][0];
     await __t.real.key('k'); await __t.sleep(400);
     const q = document.querySelector('[data-review-queue]');
     const verdict = q.querySelector('[data-review-verdict]')?.textContent.replace(/\\s+/g, ' ').trim();
     return 'graded case ' + first + ' | rating: ' + q.querySelector('[data-review-case]').getAttribute('data-review-rating') + ' | verdict: ' + verdict + ' | agreement: ' + q.querySelector('[data-review-agreement]')?.textContent.trim().slice(0, 45);`,
  ),
  step(
    'j-moves-on-b-grades-bad',
    `await __t.real.key('j'); await __t.sleep(400);
     const pos = document.querySelector('[data-review-position]').textContent.trim();
     await __t.real.key('b'); await __t.sleep(900);
     const after = document.querySelector('[data-review-position]').textContent.trim();
     const counts = document.querySelector('[data-review-text]').textContent.trim();
     return 'moved to: ' + pos + ' | after grading: ' + after + ' | ' + counts;`,
  ),
  step(
    'the-grades-are-the-runs-reviews',
    `const runs = (await window.aps.invoke('runs.list', { limit: 5 })).items.filter((r) => r.name === 'Sample: support intents');
     const report = await window.aps.invoke('runs.review.list', { runId: runs[0].id }).catch(() => null);
     const q = await window.aps.invoke('eval.reviewQueue', { run: runs[0].id, count: 10 });
     return 'graded: ' + q.graded + ' | good: ' + q.cases.filter((c) => c.rating === 'good').length + ' | bad: ' + q.cases.filter((c) => c.rating === 'bad').length + ' | add offered: ' + !!document.querySelector('[data-review-add]');`,
  ),
  step(
    'the-good-answers-can-be-added-to-the-test-cases',
    `await __t.real.click(document.querySelector('[data-review-add]'));
     const t = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((x) => x.textContent.trim()).find((x) => /good answer/.test(x)), 8000);
     return t ? t.replace(/\\s+/g, ' ').slice(0, 120) : 'NO TOAST';`,
  ),
];

module.exports = withExpect(steps, {
  'the-sample-is-run-and-the-queue-opens': /^position: 1 of 10 \| verdict hidden: true \| text: Read 10 answers and grade each good or bad/,
  'g-grades-good-and-shows-what-the-checks-decided': /^graded case \S+ \| rating: good \| verdict: The checks: passed ?agrees with you \| agreement: The checks agreed with you on 1 of 1/,
  'j-moves-on-b-grades-bad': /^moved to: 2 of 10 \| after grading: 3 of 10 \| 2 of 10 graded: 8 to go\.$/,
  'the-grades-are-the-runs-reviews': /^graded: 2 \| good: 1 \| bad: 1 \| add offered: true$/,
  'the-good-answers-can-be-added-to-the-test-cases': /^Added 0 good answers as the expected answers of "Sample: support intents"; 1 already had one and keep it/,
});
