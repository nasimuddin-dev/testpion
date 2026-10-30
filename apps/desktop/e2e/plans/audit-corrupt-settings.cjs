// The desktop preferences in settings.json (`rail`, `keybindings`, `density`) of the wrong shape — a hand edit, an
// older or newer version — must not stop the app: it starts with the defaults for them (core normalizeUiPrefs), the
// rail shows its default views, the shortcuts work and the density is comfortable.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const alive = `((document.querySelector('header')?.innerText.length ?? 0) > 0 ? 'ALIVE' : 'BLANK')`;

const steps = [
  [
    'starts-with-defaults',
    `(async () => {
      await __t.waitFor(() => document.querySelector('nav[aria-label="Main navigation"] button'), 8000);
      const rail = [...document.querySelectorAll('nav[aria-label="Main navigation"] button')].map((b) => b.getAttribute('aria-label')).join(' | ');
      const s = await window.aps.invoke('settings.get');
      return ${alive} + ' | rail: ' + rail + ' | density: ' + document.documentElement.dataset.density + ' | saved: ' + JSON.stringify([s.rail ?? null, s.keybindings ?? null, s.density ?? null]);
    })()`,
  ],
  [
    'shortcuts-work',
    `(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      const open = !!(await __t.waitFor(() => document.querySelector('[role=dialog] input'), 2000));
      await __t.esc();
      await __t.view('Settings'); await __t.tab('Keyboard');
      const rows = (await __t.waitFor(() => document.querySelectorAll('[data-shortcut-row]').length, 3000)) || 0;
      return 'palette: ' + open + ' | keyboard rows: ' + (rows > 30) + ' | ' + ${alive};
    })()`,
  ],
];

module.exports = withExpect(
  steps,
  {
    'starts-with-defaults': /^ALIVE \| rail: Home \| Collections \| Tests \| AI quality \| RAG bots \| Environments \| History \| More views \| Settings \| density: comfortable \| saved: \[null,null,null\]$/,
    'shortcuts-work': /^palette: true \| keyboard rows: true \| ALIVE$/,
  },
  { settings: { rail: { order: 'home', shown: 5 }, keybindings: ['Mod+K'], density: { compact: true } } },
);
