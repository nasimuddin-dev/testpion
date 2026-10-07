// The AI results a person reviews: a RAG test's run opens its result by itself with the claims judged, a result is
// rated 👍 and leaves the "To review" filter, a Playground answer is kept as a dataset case, and the model
// comparison marks the fastest and says which model still needs a key.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label && b.getAttribute('role') !== 'tab');
  const tab = (name) => vis('main [role=tab]').find((t) => t.textContent.trim().startsWith(name));
  const radio = (name) => vis('main [role=radio]').find((t) => t.textContent.trim().startsWith(name));
  const short = (s, n = 300) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

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
     vis('main button[title^="Good result"]')[0]?.click(); await __t.sleep(800);
     const pressed = vis('main button[title^="Good result"]')[0]?.getAttribute('aria-pressed');
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
    `await __t.view('AI Lab'); await __t.sleep(800); tab('Playground')?.click(); await __t.sleep(600);
     button('Run')?.click(); await __t.waitFor(() => /Latency/.test(document.querySelector('main')?.innerText ?? ''), 20000); await __t.sleep(400);
     vis('main button').find((b) => b.textContent.trim() === 'Add to dataset')?.click(); await __t.sleep(500);
     const ok = [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Add'); if (!ok) return 'NO DIALOG';
     ok.click();
     const toast = await __t.waitFor(() => [...document.querySelectorAll('[role=status], li, div')].find((x) => x.children.length <= 2 && /Added case \\d+ to datasets\\//.test(x.textContent) && x.textContent.length < 200), 8000);
     return short(toast?.textContent, 160);`,
  ),
  step(
    'comparison-marks',
    `tab('Model comparison')?.click(); await __t.sleep(600);
     const hint = short(vis('main').map((m) => m.innerText).join(' ').match(/OpenAI needs an API key/)?.[0], 60);
     button('Run comparison')?.click(); await __t.sleep(5000);
     const t = vis('main table')[0]?.innerText ?? '';
     return 'hint=' + hint + ' | addKey=' + !!vis('main table button').find((b) => b.textContent.trim() === 'Add the key') + ' | ' + short(t.match(/OpenAI · .{0,20}/)?.[0], 40);`,
  ),
];

module.exports = withExpect(steps, {
  'rag-run-opens-its-result': /^detail=(\d+ not useful, )?\d+ useful \| All Failed 0 Passed 1 To review 1/,
  'rate-good': /before=To review 1 after=To review 0 pressed=true rowIcon=true/,
  note: /Review: Answer cites the hours document/,
  'add-to-dataset': /Added case \d+ to datasets\/playground-cases\.jsonl/,
  'comparison-marks': /hint=OpenAI needs an API key \| addKey=true \| OpenAI · gpt-4o-mini/,
});
