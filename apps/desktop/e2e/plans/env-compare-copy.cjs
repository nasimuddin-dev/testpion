// Compare environments, then copy a value across: a row that differs has → and ←; → asks, then puts the left value into the
// right environment (replacing it), and the row reads Same; a variable missing on one side is added there the same way.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'two-environments-that-differ',
    `await window.aps.invoke('env.save', { env: { id: 'e2e-cmp-left', name: 'Cmp Staging', variables: [{ key: 'baseUrl', value: 'https://staging.example.com', enabled: true }, { key: 'onlyHere', value: '1', enabled: true }] } });
     await window.aps.invoke('env.save', { env: { id: 'e2e-cmp-right', name: 'Cmp Production', variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }] } });
     const d = await window.aps.invoke('env.diff', { left: 'e2e-cmp-left', right: 'e2e-cmp-right' });
     return 'different: ' + d.summary.different + ' | only left: ' + d.summary.onlyLeft;`,
  ),
  step(
    'copy-right-replaces-and-adds',
    `await __t.view('Environments'); await __t.sleep(900);
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((r) => r.textContent.trim().startsWith('Cmp Staging')), 8000); if (!row) return 'NO ROW';
     row.click(); await __t.sleep(900);
     const compare = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Compare'), 6000); if (!compare) return 'NO COMPARE';
     await __t.real.click(compare);
     const right = await __t.waitFor(() => document.querySelector('[role=dialog] select[aria-label="Right environment"]'), 6000); if (!right) return 'NO PICKER';
     const opt = [...right.options].find((o) => o.textContent.trim() === 'Cmp Production'); right.value = opt.value; right.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(900);
     const arrows = () => [...document.querySelectorAll('[role=dialog] [data-env-copy="right"]')];
     await __t.waitFor(() => arrows().length >= 2, 6000);
     const before = arrows().length;
     await __t.real.click(arrows()[0]);
     const ok = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.offsetParent && b.textContent.trim() === 'Copy'), 4000); if (!ok) return 'NO CONFIRM';
     const asked = [...document.querySelectorAll('[role=dialog]')].some((d) => /replaced|is added/.test(d.textContent));
     await __t.real.click(ok);
     await __t.waitFor(() => arrows().length === before - 1, 6000);
     const prod = await window.aps.invoke('env.diff', { left: 'e2e-cmp-left', right: 'e2e-cmp-right' });
     await __t.real.key('Escape'); await __t.sleep(300);
     await window.aps.invoke('env.delete', { id: 'e2e-cmp-left' }).catch(() => undefined); await window.aps.invoke('env.delete', { id: 'e2e-cmp-right' }).catch(() => undefined);
     return 'arrows before: ' + before + ' | asked: ' + asked + ' | arrows after: ' + (before - 1) + ' | now same: ' + prod.summary.same + ' | different: ' + prod.summary.different;`,
  ),
];

module.exports = withExpect(steps, {
  'two-environments-that-differ': /^different: 1 \| only left: 1$/,
  'copy-right-replaces-and-adds': /^arrows before: 2 \| asked: true \| arrows after: 1 \| now same: 1 \| different: 0$/,
});
