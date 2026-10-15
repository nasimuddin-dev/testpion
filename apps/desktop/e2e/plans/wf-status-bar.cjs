// WF-17 The status bar as the tool hub: the Problems count, Terminal, the environment segment and the Tools menu
// (Cookies, Find & replace, the reverse proxy for one API, Certificates) each open what they name.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const press = (b) => { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); };
  const seg = (name) => document.querySelector('footer [data-status="' + name + '"]');
  const dialogTitle = () => [...document.querySelectorAll('[role=dialog]')].map((d) => d.querySelector('h2, [data-modal-title]')?.textContent.trim() ?? d.getAttribute('aria-label') ?? '').filter(Boolean).join(' / ');
  /** Tools ▸ an item; what it opened. */
  const tool = async (label) => {
    await __t.esc(); press(seg('tools'));
    const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith(label)), 3000);
    if (!item) return 'NO ITEM ' + label;
    item.click(); await __t.sleep(1200);
    return 'ok';
  };
`;

const steps = [
  step(
    'problems-and-terminal',
    `${H}
     await __t.view('Home');
     const p = await __t.waitFor(() => seg('problems'), 5000); if (!p) return 'NO PROBLEMS BADGE';
     p.click(); const problems = await __t.waitFor(() => document.querySelector('[data-bottom-panel="problems"]'), 3000);
     const t = seg('terminal');
     let terminal = 'no shell here';
     if (t) { t.click(); terminal = String(!!(await __t.waitFor(() => document.querySelector('[data-bottom-tab="terminal"][aria-selected="true"]'), 4000))); t.click(); await __t.sleep(300); }
     return 'problems tab: ' + !!problems + ' | terminal tab: ' + terminal;`,
  ),
  step(
    'environment-segment',
    `${H}
     press(seg('environment'));
     const items = await __t.waitFor(() => { const m = [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()); return m.length ? m : undefined; }, 3000);
     await __t.esc();
     return 'menu: ' + (items ?? []).some((x) => x === 'No environment') + ' / ' + (items ?? []).some((x) => /^Manage environments/.test(x));`,
  ),
  step(
    'tools-cookies',
    `${H}
     const r = await tool('Cookies'); if (r !== 'ok') return r;
     const shown = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].some((d) => /Cookies/.test(d.textContent)), 3000);
     await __t.esc();
     return 'cookies: ' + !!shown;`,
  ),
  step(
    'tools-find-replace',
    `${H}
     const r = await tool('Find & replace'); if (r !== 'ok') return r;
     const shown = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].some((d) => /[Rr]eplace/.test(d.textContent)), 3000);
     await __t.esc();
     return 'find & replace: ' + !!shown;`,
  ),
  step(
    'tools-reverse-proxy',
    `${H}
     const r = await tool('Reverse proxy'); if (r !== 'ok') return r;
     const shown = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].some((d) => /reverse proxy for one API/.test(d.textContent)), 3000);
     const view = localStorage.getItem('aps.view');
     await __t.esc();
     return 'reverse proxy: ' + !!shown + ' | in: ' + view;`,
  ),
  step(
    'tools-certificates',
    `${H}
     const r = await tool('Certificates'); if (r !== 'ok') return r;
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'settings', 3000);
     return 'view: ' + localStorage.getItem('aps.view');`,
  ),
];

module.exports = withExpect(steps, {
  'problems-and-terminal': /^problems tab: true \| terminal tab: (true|no shell here)$/,
  'environment-segment': /^menu: true \/ true$/,
  'tools-cookies': /^cookies: true$/,
  'tools-find-replace': /^find & replace: true$/,
  'tools-reverse-proxy': /^reverse proxy: true \| in: debugger$/,
  'tools-certificates': /^view: settings$/,
});
