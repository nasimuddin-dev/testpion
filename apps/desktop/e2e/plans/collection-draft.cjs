// Collection settings drafts: what is typed in a collection's Variables / Auth / Scripts is not lost when the collection
// is read again (a request saved in a REST tab, a pull, the watcher, an AI apply: all of them save the collection and
// refresh the outline), is marked unsaved, saves with Ctrl+S, and asks before the view is left.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const dirtyMark = () => !!vis('main [data-collection-dirty]')[0];
  const saveButton = () => vis('main button').find((x) => x.textContent.trim() === 'Save');
`;
const step = stepOf(H);

const steps = [
  step(
    'open-the-collection-settings',
    `await __t.esc(); await __t.requests(); await __t.find('GET with query parameters');
     vis('nav[aria-label="Where this request is saved"] button')[0]?.click(); await __t.sleep(1500);
     await __t.tab('Variables');
     return 'clean: ' + !dirtyMark() + ' | save disabled: ' + !!saveButton()?.disabled;`,
  ),
  step(
    'typing-marks-the-collection-unsaved',
    `const field = vis('main input[aria-label^="New variable"]')[0];
     if (!field) return 'NO INPUT';
     setInput(field, 'draftVar'); await __t.sleep(400);
     return 'dirty: ' + dirtyMark() + ' | save enabled: ' + !saveButton()?.disabled;`,
  ),
  step(
    'a-save-elsewhere-keeps-the-draft',
    // what a Ctrl+S in a REST tab, the watcher, a pull or an applied AI proposal do: save the collection (its outline refreshes)
    `const id = (await window.aps.invoke('col.list')).find((c) => c.name === vis('main [data-collection-name]')[0]?.textContent.trim())?.id;
     const c = await window.aps.invoke('col.get', { id });
     const first = (function find(items) { for (const n of items) { if (n.kind === 'folder') { const r = find(n.items); if (r) return r; } else return n; } })(c.items);
     first.name = first.name + ' '; await window.aps.invoke('col.save', c); await __t.sleep(1800);
     const still = vis('main input').some((i) => i.value === 'draftVar');
     return 'row kept: ' + still + ' | still dirty: ' + dirtyMark();`,
  ),
  step(
    'leaving-asks-and-ctrl-s-saves',
    `await __t.view('History'); await __t.sleep(600);
     const dlg = vis('[role=dialog]').find((d) => /Unsaved changes/.test(d.textContent));
     const asked = !!dlg;
     vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Cancel')?.click(); await __t.sleep(500);
     const stayed = !!vis('main [data-collection-name]')[0];
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })); await __t.sleep(1800);
     const id = (await window.aps.invoke('col.list')).find((c) => c.name === vis('main [data-collection-name]')[0]?.textContent.trim())?.id;
     const saved = (await window.aps.invoke('col.get', { id })).variables.some((v) => v.key === 'draftVar');
     return 'asked: ' + asked + ' | stayed: ' + stayed + ' | saved by Ctrl+S: ' + saved + ' | clean: ' + !dirtyMark();`,
  ),
  step(
    'clean-up',
    `const id = (await window.aps.invoke('col.list')).find((c) => c.name === vis('main [data-collection-name]')[0]?.textContent.trim())?.id;
     const c = await window.aps.invoke('col.get', { id });
     c.variables = c.variables.filter((v) => v.key !== 'draftVar'); await window.aps.invoke('col.save', c); await __t.sleep(800);
     return 'ok';`,
  ),
];

module.exports = withExpect(steps, {
  'open-the-collection-settings': /^clean: true \| save disabled: true$/,
  'typing-marks-the-collection-unsaved': /^dirty: true \| save enabled: true$/,
  'a-save-elsewhere-keeps-the-draft': /^row kept: true \| still dirty: true$/,
  'leaving-asks-and-ctrl-s-saves': /^asked: true \| stayed: true \| saved by Ctrl\+S: true \| clean: true$/,
});
