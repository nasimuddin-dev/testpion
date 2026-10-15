// WF-20 Right side: one pinnable host with the Info panel and the assistant. It waits as a tab on the edge, slides
// open with the open item's variables, file and runs; pinning docks it and the choice is kept; Ctrl+J shows the
// assistant in it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const host = () => document.querySelector('[data-pinnable-panel="right"]');
  const pinToggle = () => host()?.querySelector('[data-pin-toggle]');
`;

const steps = [
  step(
    'edge-tab-then-info',
    `${H}
     await __t.requests(); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses');
     const r = await __t.open('GET with query parameters'); if (r !== 'ok') return r;
     const h = await __t.waitFor(host, 3000); if (!h) return 'NO HOST';
     const was = h.getAttribute('data-pinned');
     h.querySelector('button[aria-expanded]')?.click();
     const info = await __t.waitFor(() => h.querySelector('[data-context-info]'), 5000);
     await __t.waitFor(() => h.querySelector('[data-context-variables], [data-context-info] p'), 4000);
     return 'pinned at first: ' + was + ' | info for: ' + info?.getAttribute('data-context-info') + ' | file: ' + /collections\\//.test(h.textContent);`,
  ),
  step(
    'pin-is-kept',
    `${H}
     pinToggle()?.click(); await __t.sleep(400);
     const pinned = host().getAttribute('data-pinned') + ' / stored ' + localStorage.getItem('aps.pinnable.right.pinned');
     pinToggle()?.click(); await __t.sleep(400);
     return pinned + ' → ' + host().getAttribute('data-pinned') + ' / stored ' + localStorage.getItem('aps.pinnable.right.pinned');`,
  ),
  step(
    'assistant-in-it',
    `${H}
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
     const a = await __t.waitFor(() => host()?.querySelector('aside[aria-label="AI assistant"]'), 4000);
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })); await __t.sleep(300);
     return 'assistant in the panel: ' + !!a;`,
  ),
];

module.exports = withExpect(steps, {
  'edge-tab-then-info': /^pinned at first: false \| info for: request \| file: true$/,
  'pin-is-kept': /^true \/ stored 1 → false \/ stored 0$/,
  'assistant-in-it': /^assistant in the panel: true$/,
});
