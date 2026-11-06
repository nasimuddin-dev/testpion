// Several teams in one workspace: with a CODEOWNERS, each collection shows its owners after its name in the Collections
// tree, and "@payments" in the explorer's filter keeps only the collections that team owns (whole, not filtered by text).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'a-repository-with-codeowners',
    `main:
      const { execFileSync } = require('node:child_process');
      const { join } = require('node:path');
      const { mkdirSync, readdirSync, writeFileSync } = require('node:fs');
      const ws = join(home, 'ws');
      execFileSync('git', ['init', '-b', 'main'], { cwd: ws });
      const first = readdirSync(join(ws, 'collections')).filter((f) => f.endsWith('.json')).sort()[0];
      mkdirSync(join(ws, '.github'), { recursive: true });
      writeFileSync(join(ws, '.github', 'CODEOWNERS'), '/collections/ @org/api\\n/collections/' + first + ' @org/payments\\n');
      return 'owners written';`,
    false,
  ],
  [
    'owners-on-the-rows',
    `(async () => {
      await __t.requests(); await __t.sleep(600);
      const refresh = [...document.querySelectorAll('button[aria-label="Refresh"]')].find((b) => b.offsetParent); if (!refresh) return 'NO REFRESH';
      refresh.click();
      const tag = await __t.waitFor(() => [...document.querySelectorAll('[data-collection-owners]')].find((t) => t.offsetParent), 8000); if (!tag) return 'NO OWNER TAG';
      const tags = [...new Set([...document.querySelectorAll('[data-collection-owners]')].map((t) => t.textContent.trim()))].sort();
      return 'tags: ' + tags.join(' | ');
    })()`,
  ],
  [
    'the-team-filter',
    `(async () => {
      const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const box = [...document.querySelectorAll('aside input')].find((i) => i.offsetParent && /Filter/.test(i.getAttribute('aria-label') || i.placeholder || '')); if (!box) return 'NO FILTER';
      const collectionRows = () => [...document.querySelectorAll('[data-collection-owners]')].filter((t) => t.offsetParent).map((t) => t.textContent.trim());
      const all = collectionRows().length;
      setVal(box, '@payments'); await __t.sleep(800);
      const payments = collectionRows();
      setVal(box, '@nobody'); await __t.sleep(800);
      const nobody = collectionRows().length;
      setVal(box, ''); await __t.sleep(600);
      return 'all > 1: ' + (all > 1) + ' | @payments: ' + payments.join(',') + ' | @nobody: ' + nobody + ' | back: ' + (collectionRows().length === all);
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'owners-on-the-rows': /^tags: @org\/api \| @org\/payments$/,
  'the-team-filter': /^all > 1: true \| @payments: @org\/payments \| @nobody: 0 \| back: true$/,
});
