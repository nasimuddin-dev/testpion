// WF-01 Quick Open: Ctrl+P lists the items opened lately and finds any item by name; > runs a command, # switches the
// environment; Ctrl+K is still the command palette (plain text finds commands).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const key = (k, mods = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods }));
  const input = () => document.querySelector('[role=dialog] input');
  const type = async (v) => { const i = await __t.waitFor(input, 2000); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(700); };
  const rows = () => [...document.querySelectorAll('[role=dialog] [role=option] [data-command-label]')].map((x) => x.textContent.trim());
  const groups = () => [...document.querySelectorAll('[role=dialog] [role=listbox] > div:not([role])')].map((x) => x.textContent.trim());
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });

const steps = [
  s(
    'recent-first',
    `await __t.requests(); await __t.find('Custom headers'); await __t.esc();
     key('p', { ctrlKey: true }); await __t.waitFor(input, 2000); await __t.sleep(400);
     const r = 'groups: ' + groups().join(',') + ' | first: ' + rows()[0];
     await __t.esc(); return r;`,
  ),
  s(
    'find-by-name',
    // the pointer rests where the list's later rows appear: rows landing under a still pointer are not chosen (Enter
    // opens the first hit, the one the keyboard is on)
    `await __t.real.move({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight * 0.12) + 44 + 4 + 3 * 46 });
     key('p', { ctrlKey: true }); await type('Say hello');
     const hit = await __t.waitFor(() => rows().find((x) => /Say hello/.test(x)), 4000);
     if (!hit) return 'NO HIT | ' + rows().slice(0, 5).join(' / ');
     document.querySelector('[role=dialog] input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'grpc', 5000);
     return 'hit: ' + hit + ' | view: ' + localStorage.getItem('aps.view');`,
  ),
  s(
    'commands-and-environments',
    `key('p', { ctrlKey: true }); await type('>new http');
     const cmd = rows()[0];
     await type('#');
     const env = rows().slice(0, 3).join(' / ');
     await __t.esc();
     key('k', { ctrlKey: true }); await type('feedback');
     const k = rows()[0];
     await __t.esc();
     return 'cmd: ' + cmd + ' | env rows: ' + env + ' | ctrl+k: ' + k;`,
  ),
];

module.exports = withExpect(steps, {
  'recent-first': /^groups: Recently opened \| first: Custom headers$/,
  'find-by-name': /^hit: .*Say hello.* \| view: grpc$/,
  'commands-and-environments': /^cmd: New HTTP Request \| env rows: .+ \| ctrl\+k: Send Feedback or Report a Problem…$/,
});
