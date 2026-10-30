// The AI results a person reviews: a RAG test's run opens its result by itself with the claims judged, a result is
// rated 👍 (the "To review" filter appears with the first rating, AU-7), a Playground answer is kept as a dataset case, and the model
// comparison marks the fastest and says which model still needs a key.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepWith } = require('../lib.cjs');

const step = stepWith({ extra: `const radio = (name) => vis('main [role=radio]').find((t) => t.textContent.trim().startsWith(name));` });

const steps = [
  step(
    'rag-run-opens-its-result',
    `await __t.view('Tests'); await __t.sleep(1000);
     vis('main *').find((x) => x.children.length === 0 && x.textContent.trim() === 'rag.yaml')?.click(); await __t.sleep(800);
     button('Run')?.click();
     const detail = await __t.waitFor(() => vis("main details").find((d) => d.querySelector("summary")), 20000);
     return 'detail=' + short(detail?.querySelector('summary')?.textContent, 80) + ' | ' + short(vis('main [role=radiogroup][aria-label="Status filter"]')[0]?.innerText, 80);`,
  ),
  step(
    'rate-good',
    `const before = short(radio('To review')?.textContent, 20);
     vis('main button[aria-label^="Good result"]')[0]?.click(); await __t.sleep(800);
     const pressed = vis('main button[aria-label^="Good result"]')[0]?.getAttribute('aria-pressed');
     return 'before=' + before + ' after=' + short(radio('To review')?.textContent, 20) + ' pressed=' + pressed + ' rowIcon=' + !!vis('main [aria-label="Rated good"]').length;`,
  ),
  step(
    'note',
    `button('Note')?.click(); await __t.sleep(400);
     const ta = document.querySelector('textarea[aria-label="Review note"]'); if (!ta) return 'NO NOTE BOX';
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Answer cites the hours document');
     ta.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(100);
     [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save note')?.click(); await __t.sleep(800);
     return short(vis('main').map((m) => m.innerText).join(' ').match(/Review: .{0,60}/)?.[0], 80);`,
  ),
  step(
    'add-to-dataset',
    `await __t.view('AI Lab'); await __t.sleep(800); tab('Try a prompt')?.click(); await __t.sleep(600);
     button('Run')?.click(); await __t.waitFor(() => /Latency/.test(document.querySelector('main')?.innerText ?? ''), 20000); await __t.sleep(400);
     vis('main button').find((b) => b.textContent.trim() === 'Add to dataset')?.click(); await __t.sleep(500);
     const ok = [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Add'); if (!ok) return 'NO DIALOG';
     ok.click();
     const toast = await __t.waitFor(() => [...document.querySelectorAll('[role=status], li, div')].find((x) => x.children.length <= 2 && /Added case \\d+ to datasets\\//.test(x.textContent) && x.textContent.length < 200), 8000);
     return short(toast?.textContent, 160);`,
  ),
  // the wording being tried becomes a version of a saved evaluation; the evaluation keeps the prompt it has
  step(
    'save-as-a-prompt-version',
    `const before = await window.aps.invoke('lib.get', { kind: 'evaluations' });
     const target = before.items.find((i) => i.data.type !== 'rag'); if (!target) return 'NO EVALUATION';
     const promptBefore = target.data.prompt;
     const open = await __t.waitFor(() => vis('[data-save-as-version]')[0], 5000); if (!open) return 'NO LINK';
     await __t.real.click(open);
     const name = await __t.waitFor(() => vis('[data-version-name]')[0], 5000); if (!name) return 'NO DIALOG';
     const off = vis('[data-version-save]')[0]?.disabled;
     await __t.real.click(name); await __t.real.type('Tried in the playground');
     await __t.sleep(300);
     await __t.real.click(vis('[data-version-save]')[0]);
     const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => /Saved "Tried in the playground" as a version of/.test(t)), 8000);
     const v = await window.aps.invoke('eval.versions', { evaluation: target.id });
     const after = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.id === target.id);
     return 'disabled until named: ' + off + ' | toast: ' + !!toast + ' | listed: ' + v.versions.some((x) => x.name === 'Tried in the playground') + ' | evaluation prompt unchanged: ' + (after.data.prompt === promptBefore);`,
  ),
  step(
    'comparison-marks',
    `tab('Compare')?.click(); await __t.sleep(600);
     const hint = short(vis('main').map((m) => m.innerText).join(' ').match(/OpenAI needs an API key/)?.[0], 60);
     button('Run comparison')?.click(); await __t.sleep(5000);
     const t = vis('main table')[0]?.innerText ?? '';
     return 'hint=' + hint + ' | addKey=' + !!vis('main table button').find((b) => b.textContent.trim() === 'Add the key') + ' | ' + short(t.match(/OpenAI · .{0,20}/)?.[0], 40);`,
  ),
];

module.exports = withExpect(steps, {
  'rag-run-opens-its-result': /^detail=(\d+ not useful, )?\d+ useful \| All Failed 0 Passed 1/,
  'rate-good': /before= after=To review 0 pressed=true rowIcon=true/,
  note: /Review: Answer cites the hours document/,
  'add-to-dataset': /Added case \d+ to datasets\/playground-cases\.jsonl/,
  'save-as-a-prompt-version': /^disabled until named: true \| toast: true \| listed: true \| evaluation prompt unchanged: true$/,
  'comparison-marks': /hint=OpenAI needs an API key \| addKey=true \| OpenAI · gpt-4o-mini/,
});
