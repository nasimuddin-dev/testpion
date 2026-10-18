// Favorites: ⋯ ▸ Add to favorites stars the request (saved in its collection) and lists it in the explorer's Favorites
// section, from where it opens; Remove from favorites takes it out again.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const rows = () => [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.offsetParent);
  const treeRow = (name) => rows().find((b) => b.getAttribute('data-rename-id') !== 'fav-' && b.textContent.trim().replace(/^(GET|POST|PUT|PATCH|DELETE)/, '') === name && !b.closest('[data-section="favorites"]'));
  const favSection = () => [...document.querySelectorAll('aside button')].find((b) => b.offsetParent && /^Favorites\\d*$/.test(b.textContent.trim()));
  const favRows = () => rows().filter((b) => (b.getAttribute('data-rename-id') ?? '').includes('fav-'));
  const menuOf = async (row) => { row.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 })); return await __t.waitFor(() => { const m = [...document.querySelectorAll('[role=menuitem]')]; return m.length ? m : undefined; }, 2000); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'add-to-favorites',
    `await __t.requests(); for (const t of ['HTTP basics', 'REST17', 'Requests & responses10']) { await __t.expand(t); await __t.sleep(200); }
     const r = rows().find((b) => b.textContent.trim().endsWith('Custom headers') && !(b.getAttribute('data-rename-id') ?? '').includes('fav-')); if (!r) return 'NO ROW';
     const before = !!favSection();
     const items = await menuOf(r); const add = items?.find((m) => m.textContent.trim() === 'Add to favorites'); if (!add) return 'NO MENU ' + (items ?? []).map((m) => m.textContent.trim()).join('|');
     add.click(); await __t.sleep(1200);
     const star = !!rows().find((b) => b.textContent.trim().endsWith('Custom headers') && b.querySelector('[data-favorite]'));
     const saved = (await window.aps.invoke('col.list')).find((c) => c.id === 'httpbin');
     const flat = (n) => n.flatMap((x) => (x.kind === 'folder' ? flat(x.items) : [x]));
     return 'section before: ' + before + ' | star: ' + star + ' | saved: ' + !!flat(saved.items).find((x) => x.name === 'Custom headers')?.favorite + ' | favorites: ' + favRows().map((b) => b.textContent.trim()).join(' / ');`,
  ),
  step('open-from-favorites', `const f = favRows()[0]; if (!f) return 'NO ROW'; f.click(); await __t.sleep(1500); return 'active tab: ' + document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')?.textContent.trim();`),
  // opening a favorite leaves the tree as the user left it: nothing unfolds, nothing scrolls
  step(
    'favorite-keeps-tree-still',
    `document.querySelector('aside [aria-label="Collapse all"]').click(); await __t.sleep(600);
     const list = document.querySelector('aside .overflow-auto'); const top = list?.scrollTop ?? 0;
     const before = rows().length;
     [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].forEach(() => {});
     const f = favRows()[0]; f.click(); await __t.sleep(1500);
     return 'rows before: ' + before + ' | after: ' + rows().length + ' | scrolled: ' + ((list?.scrollTop ?? 0) !== top) + ' | open tab: ' + document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]')?.textContent.trim();`,
  ),
  step(
    'remove-from-favorites',
    `const f = favRows()[0]; const items = await menuOf(f); const rm = items?.find((m) => m.textContent.trim() === 'Remove from favorites'); if (!rm) return 'NO MENU';
     rm.click(); await __t.sleep(1200);
     return 'favorites: ' + favRows().length + ' | section: ' + !!favSection() + ' | star: ' + !!rows().find((b) => b.textContent.trim().endsWith('Custom headers') && b.querySelector('[data-favorite]'));`,
  ),
];

module.exports = withExpect(steps, {
  'add-to-favorites': /^section before: false \| star: true \| saved: true \| favorites: GETCustom headersHTTP basics \(httpbin\)$/,
  'open-from-favorites': /^active tab: GETCustom headers$/,
  'favorite-keeps-tree-still': (r) => {
    const m = /^rows before: (\d+) \| after: (\d+) \| scrolled: false \| open tab: GETCustom headers$/.exec(r);
    return (m && m[1] === m[2]) || 'the tree should not unfold or scroll';
  },
  'remove-from-favorites': /^favorites: 0 \| section: false \| star: false$/,
});
