// Several requests picked at once in the Collections tree: Ctrl+click picks two, the bar says so and runs them as one run;
// Shift+click widens to a range; Esc lets go; Delete removes the picked ones with one Undo.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const named = (re) => [...document.querySelectorAll('aside button[data-tree-row]')].filter((b) => b.offsetParent && re.test(b.textContent));
  const click = (el, o = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...o }));
  const bar = () => document.querySelector('[data-picked-bar]');
`;

const steps = [
  [
    'pick-two-and-run',
    `(async () => {${H}
      await __t.requests(); await __t.sleep(500);
      await __t.expand('HTTP basics'); await __t.sleep(300); await __t.expand('Requests & responses'); await __t.sleep(400);
      const a = named(/GET with query/)[0], b = named(/Custom headers/)[0]; if (!a || !b) return 'NO ROWS';
      const tabsBefore = document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]').length;
      click(a, { ctrlKey: true }); await __t.sleep(200); click(b, { ctrlKey: true }); await __t.sleep(300);
      const count = bar()?.getAttribute('data-picked-bar');
      const marked = document.querySelectorAll('[data-picked]').length;
      const tabsAfter = document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]').length;
      const run = [...bar().querySelectorAll('button')].find((x) => x.textContent.trim() === 'Run'); run.click();
      const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => /Running 2 requests/.test(t)), 6000);
      return 'bar: ' + count + ' | marked: ' + marked + ' | no tab opened: ' + (tabsAfter === tabsBefore) + ' | ' + (toast ? 'running 2' : 'NO TOAST');
    })()`,
  ],
  [
    'shift-widens-esc-lets-go',
    `(async () => {${H}
      const a = named(/GET with query/)[0], c = named(/Custom headers/)[0];
      // a fresh pick, then a range to the other
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(200);
      click(a, { ctrlKey: true }); await __t.sleep(200); click(c, { shiftKey: true }); await __t.sleep(300);
      const range = Number(bar()?.getAttribute('data-picked-bar') || 0);
      a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300);
      return 'range of 2 or more: ' + (range >= 2) + ' | after Esc: ' + (bar() ? 'STILL THERE' : 'gone');
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'pick-two-and-run': /^bar: 2 \| marked: 2 \| no tab opened: true \| running 2$/,
  'shift-widens-esc-lets-go': /^range of 2 or more: true \| after Esc: gone$/,
});
