// The collection's name in its settings reads like a request's name: plain text, renamed in place on a double-click
// (Enter saves it, Escape keeps the old name), not a field that is always open.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'name-is-text-not-a-field',
    `await __t.esc(); await __t.requests(); await __t.open('GET with query parameters');
     vis('nav[aria-label="Where this request is saved"] button')[0]?.click(); await __t.sleep(1500);
     const name = vis('main [data-collection-name]')[0];
     const field = vis('main input[aria-label="Collection name"]')[0];
     return 'text: ' + !!name + ' | field: ' + !!field;`,
  ),
  step(
    'double-click-renames-and-saves',
    `const name = vis('main [data-collection-name]')[0];
     const before = name.textContent.trim();
     name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(300);
     const input = await __t.waitFor(() => vis('main input[aria-label="Collection name"]')[0], 3000);
     if (!input) return 'NO FIELD';
     setInput(input, before + ' (renamed)'); key(input, 'Enter'); await __t.sleep(800);
     const after = vis('main [data-collection-name]')[0]?.textContent.trim();
     const saved = (await window.aps.invoke('col.list')).some((c) => c.name === before + ' (renamed)');
     // put it back, and check Escape keeps the name
     vis('main [data-collection-name]')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(300);
     const again = await __t.waitFor(() => vis('main input[aria-label="Collection name"]')[0], 3000);
     setInput(again, 'never saved'); key(again, 'Escape'); await __t.sleep(400);
     const kept = vis('main [data-collection-name]')[0]?.textContent.trim();
     const c = (await window.aps.invoke('col.list')).find((x) => x.name === before + ' (renamed)');
     await window.aps.invoke('col.save', { ...c, name: before }); await __t.sleep(500);
     return 'renamed: ' + (after === before + ' (renamed)') + ' | saved: ' + saved + ' | escape keeps: ' + (kept === before + ' (renamed)');`,
  ),
  step(
    'replace-previews-every-change',
    `vis('main button').find((b) => b.textContent.trim() === 'Replace')?.click();
     const find = await __t.waitFor(() => vis('[role=dialog] input[aria-label="Find"]')[0], 3000);
     if (!find) return 'NO DIALOG';
     setInput(find, 'httpbin'); setInput(vis('[role=dialog] input[aria-label="Replace with"]')[0], 'example');
     const head = await __t.waitFor(() => vis('[role=dialog] [data-replace-preview] div').map((d) => d.textContent).find((t) => /changes in \\d+ request/.test(t)), 5000);
     const button = vis('[role=dialog] button').find((b) => /^Replace \\d+$/.test(b.textContent.trim()));
     vis('[role=dialog] button[aria-label=Close]')[0]?.click(); await __t.sleep(300);
     return 'preview: ' + !!head + ' | replace button: ' + !!button;`,
  ),
];

module.exports = withExpect(steps, {
  'replace-previews-every-change': /^preview: true \| replace button: true$/,
  'name-is-text-not-a-field': /^text: true \| field: false$/,
  'double-click-renames-and-saves': /^renamed: true \| saved: true \| escape keeps: true$/,
});
