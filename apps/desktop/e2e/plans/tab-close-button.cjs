// The ✕ on a tab closes it, in every view that has tabs (a real mouse click, not a middle click or the menu).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const strip = (label) => [...document.querySelectorAll('[role=tablist][aria-label="' + label + '"] [role=tab]')];
  const names = (label) => strip(label).map((t) => t.textContent.trim()).join(' | ');
  // a real click on the ✕ of the tab at index i (the ✕ shows on hover: the real pointer move shows it first)
  const closeAt = async (label, i) => {
    const t = strip(label)[i]; if (!t) return false;
    await __t.real.move(t); await __t.sleep(150);
    const x = t.querySelector('button[aria-label^="Close "]'); if (!x) return false;
    await __t.real.click(x); await __t.sleep(700);
    return true;
  };
  const addTab = async (btnLabel) => { const b = document.querySelector('button[aria-label="' + btnLabel + '"]'); if (!b) return false; b.click(); await __t.sleep(700); return true; };
  // two tabs, close the second by its ✕, then close the last one by its ✕
  const twoThenNone = async (label, btnLabel) => {
    if (!strip(label).length) return 'NO STRIP ' + label;
    if (strip(label).length < 2 && !(await addTab(btnLabel))) return 'NO + ' + btnLabel;
    const before = strip(label).length;
    if (!(await closeAt(label, before - 1))) return 'NO ✕';
    const afterOne = strip(label).length;
    let last = '';
    while (strip(label).length > 1) { if (!(await closeAt(label, strip(label).length - 1))) return 'NO ✕ loop'; }
    const n1 = strip(label).length;
    if (!(await closeAt(label, 0))) return 'NO ✕ last';
    return 'tabs ' + before + ' → ' + afterOne + ', one left: ' + n1 + ' → ' + strip(label).length + ' | ' + (document.body.innerText.match(/No open [a-z ]+/)?.[0] ?? 'no empty state');
  };
`;
const step = stepOf(H);

const steps = [
  step('evaluations', `await __t.view('Evaluations'); await __t.sleep(900); return await twoThenNone('Open evaluations', 'New evaluation');`),
  step('load-tests', `await __t.view('Load'); await __t.sleep(900); return await twoThenNone('Open load tests', 'New load test');`),
  step('prompts', `await __t.view('AI Lab'); await __t.sleep(700); await __t.tab('Playground'); await __t.sleep(900); return await twoThenNone('Open prompts', 'New prompt');`),
  // an environment opens in a tab from the list; its ✕ closes it and the view says nothing is open
  step(
    'environments',
    `await __t.view('Environments'); await __t.sleep(900);
     const row = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent); if (!row) return 'NO ROW';
     await __t.real.dblclick(row); await __t.sleep(700);
     const before = strip('Open environments').length;
     if (!(await closeAt('Open environments', 0))) return 'NO ✕';
     return 'tabs ' + before + ' → ' + strip('Open environments').length + ' | ' + (/Select an environment|No environments yet/.test(document.body.innerText) ? 'empty state' : 'NO empty state');`,
  ),
  // monitors and test files open from their list; the ✕ closes the tab
  step(
    'monitors',
    `await __t.view('Monitors'); await __t.sleep(900);
     const row = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent); if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(700);
     const before = strip('Open monitors').length; if (!before) return 'NO TAB';
     if (!(await closeAt('Open monitors', 0))) return 'NO ✕';
     return 'tabs ' + before + ' → ' + strip('Open monitors').length;`,
  ),
  step(
    'test-files',
    `await __t.view('Tests'); await __t.sleep(900);
     const row = [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.getAttribute('aria-expanded') === null && /\.(ya?ml|json)$/.test(b.textContent.trim())); if (!row) return 'NO ROW';
     await __t.real.dblclick(row); await __t.sleep(1200);
     const before = strip('Open test files').filter((t) => t.querySelector('button[aria-label^="Close "]')).length; if (!before) return 'NO TAB';
     const t0 = strip('Open test files').findIndex((t) => t.querySelector('button[aria-label^="Close "]'));
     if (!(await closeAt('Open test files', t0))) return 'NO ✕';
     return 'closable tabs ' + before + ' → ' + strip('Open test files').filter((t) => t.querySelector('button[aria-label^="Close "]')).length;`,
  ),
  // request tabs of every kind: ✕ on each closable tab in turn (a pinned tab has none), down to the single one, then that one
  step(
    'requests',
    `await __t.requests(); await __t.sleep(700); const L = 'Open requests';
     const closable = () => strip(L).map((t, i) => (t.querySelector('button[aria-label^="Close "]') ? i : -1)).filter((i) => i >= 0);
     const before = closable().length; if (!before) return 'NO TABS';
     let guard = 0; while (closable().length > 1 && guard++ < 40) if (!(await closeAt(L, closable()[closable().length - 1]))) return 'NO ✕ loop';
     const single = closable().length;
     if (!(await closeAt(L, closable()[0]))) return 'NO ✕ single';
     const left = closable().length;
     return 'closable ' + before + ' → single: ' + single + ' → ' + left + ' | ' + (strip(L).length ? 'only pinned left' : /No open requests/.test(document.body.innerText) ? 'empty state' : 'NO empty state');`,
  ),
];

module.exports = withExpect(steps, {
  evaluations: /^tabs 2 → 1, one left: 1 → 0 \| No open evaluations$/,
  'load-tests': /^tabs 2 → 1, one left: 1 → 0 \| No open load tests$/,
  prompts: /^tabs 2 → 1, one left: 1 → 0 \| No open prompts$/,
  environments: /^tabs 1 → 0 \| empty state$/,
  monitors: /^tabs 1 → 0$/,
  'test-files': /^closable tabs 1 → 0$/,
  requests: /^closable \d+ → single: 1 → 0 \| (empty state|only pinned left)$/,
});
