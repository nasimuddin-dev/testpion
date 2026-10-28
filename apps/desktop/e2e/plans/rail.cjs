// The rail shows 7 views by default (AI Lab and Evaluations included, so a new person sees them) and More… for the rest; right-click an item to hide, keep or move it (saved per
// computer in the app's settings); Ctrl+Alt+1…9, the tooltips, the shortcuts list and the palette follow the shown views.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const railLabels = () => [...document.querySelectorAll('nav[aria-label="Main navigation"] button')].map((b) => b.getAttribute('aria-label')).join(' | ');
  const item = (label) => document.querySelector('nav[aria-label="Main navigation"] button[aria-label="' + label + '"]');
  const menuItem = (text) => __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim() === text), 2000);
  const pick = async (label, text) => {
    await __t.real.rightClick(item(label)); const m = await menuItem(text); if (!m) return 'NO ' + text;
    await __t.real.click(m); await __t.waitFor(() => !document.querySelector('[role=menu]'), 1500); await __t.sleep(300); return 'ok';
  };
  const saved = async () => JSON.stringify((await window.aps.invoke('settings.get')).rail ?? null);
`;

const steps = [
  step('default-rail', `${H} await __t.view('Home'); return railLabels();`),
  step(
    'more-reaches-hidden',
    `${H}
     const ok = await __t.view('Debugger');
     const transient = document.querySelector('nav [data-rail-transient]')?.getAttribute('aria-label');
     await __t.view('Home');
     const gone = !document.querySelector('nav [data-rail-transient]');
     return 'debugger shown: ' + ok + ' | on the rail while open: ' + transient + ' | gone after: ' + gone;`,
  ),
  step(
    'shortcut-follows-shown',
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, altKey: true, bubbles: true })); await __t.sleep(600);
     const three = localStorage.getItem('aps.view');
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '9', ctrlKey: true, altKey: true, bubbles: true })); await __t.sleep(400);
     return '3: ' + three + ' | 9 (no 9th): ' + localStorage.getItem('aps.view');`,
  ),
  step('hide-history', `${H} const r = await pick('History', 'Hide from the rail'); if (r !== 'ok') return r; return railLabels() + ' || ' + (await saved());`),
  step(
    'keep-git',
    `${H}
     await __t.view('Git');
     const r = await pick('Git', 'Keep on the rail'); if (r !== 'ok') return r;
     await __t.view('Home');
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '7', ctrlKey: true, altKey: true, bubbles: true })); await __t.sleep(800);
     return railLabels() + ' || Ctrl+Alt+7: ' + localStorage.getItem('aps.view');`,
  ),
  step('move-git-up', `${H} await __t.view('Home'); const r = await pick('Git', 'Move up'); if (r !== 'ok') return r; return railLabels() + ' || ' + (await saved());`),
  step(
    'palette-hint',
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
     const input = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Command palette"] input, [role=dialog] input'), 2000); if (!input) return 'NO PALETTE';
     await __t.real.type('Go to Git'); await __t.sleep(400);
     const row = [...document.querySelectorAll('[data-command="go-git"]')][0];
     const hint = row?.querySelector('span.ml-auto')?.textContent ?? 'NONE';
     await __t.esc();
     return 'Go to Git hint: ' + hint;`,
  ),
  step(
    'reset',
    `${H}
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
     await __t.waitFor(() => document.querySelector('[role=dialog] input'), 2000);
     await __t.real.type('Rail: Reset'); await __t.sleep(400);
     await __t.real.key('Enter'); await __t.sleep(800);
     return railLabels() + ' || ' + (await saved());`,
  ),
];

module.exports = withExpect(steps, {
  'default-rail': /^Home \| Collections \| Tests \| AI Lab \| Evaluations \| Environments \| History \| More views \| Settings$/,
  'more-reaches-hidden': /^debugger shown: true \| on the rail while open: Debugger \| gone after: true$/,
  'shortcut-follows-shown': /^3: tests \| 9 \(no 9th\): tests$/,
  'hide-history': /^Home \| Collections \| Tests \| AI Lab \| Evaluations \| Environments \| More views \| Settings \|\| \{"order":\[.*\],"shown":\["home","collections","tests","ai","evaluations","environments"\]\}$/,
  'keep-git': /^Home \| Collections \| Tests \| AI Lab \| Evaluations \| Environments \| Git \| More views \| Settings \|\| Ctrl\+Alt\+7: git$/,
  'move-git-up': /^Home \| Collections \| Tests \| AI Lab \| Evaluations \| Git \| Environments \| More views \| Settings \|\| .*"shown":\["home","collections","tests","ai","evaluations","git","environments"\]\}$/,
  'palette-hint': /^Go to Git hint: Ctrl\+Alt\+6$/,
  reset: /^Home \| Collections \| Tests \| AI Lab \| Evaluations \| Environments \| History \| More views \| Settings \|\| null$/,
});
