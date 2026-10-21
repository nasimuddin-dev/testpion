// Not part of the suite (the _ prefix): how many times the components render while typing in the explorer filter, opening requests,
// switching tabs and going Home and back, with a large workspace. Build with TESTPION_PROFILE=1 (readable component names), then
//   npm run e2e -w @testpion/desktop -- --only _render-count
// Each step's result ends with "commits N · components rendered M · Name count, …" (see e2e/render-count.cjs), the same numbers
// before and after a change, so a render saved is a number, not a feeling.
const { withExpect } = require('../lib.cjs');
const { bigCollection } = require('./perf-large-workspace.cjs');

const painted = `(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })`;
/** Resets the counter, runs `body` (page code returning a string) and appends the render report. */
const counted = (name, body) => [
  name,
  `(async () => {
    if (!window.__renders) return 'NO RENDER COUNTER (E2E_RENDER_COUNT)';
    await ${painted}(); window.__renders.watch('RequestRow', 'FolderRow', 'CollectionRow', 'TreeRowShell', 'CollectionTree', 'Explorer', 'RowMenu', 'NodeMenu', 'GitMark'); window.__renders.reset();
    const what = await (async () => { ${body} })();
    await ${painted}();
    return what + ' | ' + window.__renders.report(24) + ' || why: ' + window.__renders.why();
  })()`,
  false,
];

const steps = [
  [
    'setup',
    `(async () => { await __t.requests(); await __t.menu('Big collection'); [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Expand all')?.click(); await __t.sleep(1500); return 'rows ' + document.querySelectorAll('aside [data-tree-row]').length; })()`,
    false,
  ],
  counted(
    'open-15-requests',
    `const rows = [...document.querySelectorAll('aside [data-tree-row]')].filter((b) => b.textContent.includes('of folder 2')).slice(0, 15);
     if (!rows.length) return 'NO ROWS';
     for (const r of rows) { r.click(); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await ${painted}(); }
     return 'opened ' + rows.length;`,
  ),
  counted(
    'switch-tabs-20',
    `const all = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')];
     if (!all.length) return 'NO TABS';
     for (let i = 0; i < 20; i++) { all[i % all.length].click(); await ${painted}(); }
     return 'switched 20 over ' + all.length + ' tabs';`,
  ),
  counted(
    'type-in-explorer-filter-16',
    `const input = document.querySelector('aside input[aria-label^="Filter"]');
     if (!input) return 'NO FILTER';
     const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
     for (const ch of 'folder 7 request') { set.call(input, input.value + ch); input.dispatchEvent(new Event('input', { bubbles: true })); await ${painted}(); }
     const rows = document.querySelectorAll('aside [data-tree-row]').length;
     set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }));
     return 'typed 16 keys, rows after: ' + rows;`,
  ),
  counted(
    'home-and-back-x3',
    `for (let i = 0; i < 3; i++) { await __t.view('Home'); await ${painted}(); await __t.requests(); await __t.waitFor(() => document.querySelectorAll('aside [data-tree-row]').length > 100, 5000); await ${painted}(); }
     return 'home and back x3';`,
  ),
  counted(
    'idle-2s',
    `await __t.sleep(2000); return 'idle 2 s';`,
  ),
];

module.exports = withExpect(steps, {}, { prepare: bigCollection, env: { E2E_RENDER_COUNT: '1' } });
