// The environment switcher is the app's own menu: a colour dot on the left of every environment, "No environment",
// Manage environments…; and dialogs carry an icon on every button (New environment: a key, Create +, Cancel ×).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const picker = () => `document.querySelector('header button[aria-label="Environment"]')`;
const openPicker = () => `(() => { const b = ${picker()}; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); })()`;
const steps = [
  [
    'dots-on-the-left',
    `(async () => {
      ${openPicker()};
      const items = await __t.waitFor(() => { const m = [...document.querySelectorAll('[role=menuitem]')]; return m.length ? m : undefined; }, 2000);
      if (!items) return 'NO MENU';
      const rows = items.map((m) => {
        const dot = m.querySelector('span[style*="background"]');
        const r = m.getBoundingClientRect(); const d = dot?.getBoundingClientRect();
        return m.textContent.trim() + ':' + (dot ? (d.left < r.left + r.width / 3 ? 'dot-left' : 'dot-elsewhere') : (/Manage/.test(m.textContent) ? 'link' : 'no-dot'));
      });
      await __t.esc();
      return rows.join(' | ');
    })()`,
  ],
  [
    'pick-none-and-back',
    `(async () => {
      ${openPicker()};
      let item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'No environment'), 2000);
      item?.click(); await __t.sleep(600);
      const none = ${picker()}.textContent.trim() + ' / ' + [...document.querySelectorAll('footer span')].map((s) => s.textContent.trim()).find((t) => /environment/i.test(t));
      ${openPicker()};
      item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('Public APIs')), 2000);
      item?.click(); await __t.sleep(600);
      return none + ' → ' + ${picker()}.textContent.trim();
    })()`,
  ],
  [
    'dialog-buttons-have-icons',
    `(async () => {
      await __t.view('Environments'); await __t.sleep(800);
      // the Environments list's ⋯ menu offers New environment
      const more = [...document.querySelectorAll('main button[aria-label="More actions for Environments"]')].find((x) => x.offsetParent);
      if (!more) return 'NO BUTTON';
      more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'New environment'), 2000);
      if (!item) return 'NO MENU';
      item.click();
      const d = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find((x) => x.getClientRects().length && /New environment/.test(x.textContent)), 3000);
      if (!d) return 'NO DIALOG';
      const buttons = [...d.querySelectorAll('button')].filter((x) => x.textContent.trim());
      const withIcon = buttons.filter((x) => x.querySelector('svg')).map((x) => x.textContent.trim());
      const titleIcon = !!d.querySelector('span[aria-hidden] svg');
      await __t.esc();
      return 'title icon: ' + titleIcon + ' | buttons with icons: ' + withIcon.join(', ') + ' / ' + buttons.length;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'dots-on-the-left': /^No environment:dot-left \| Public APIs:dot-left \| Manage environments…:link$/,
  'pick-none-and-back': /^No environment \/ No environment → Public APIs$/,
  'dialog-buttons-have-icons': /^title icon: true \| buttons with icons: Cancel, Create \/ 2$/,
});
