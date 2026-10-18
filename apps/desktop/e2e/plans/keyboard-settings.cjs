// Settings ▸ Keyboard: every shortcut with a search; click a shortcut and press new keys (real input); a conflict says
// which command has the keys and can take them over; the global key handler, the shortcuts list (?) and the palette's
// hints follow; Reset all goes back to the defaults (saved per computer in settings.json `keybindings`).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const page = () => vis('[data-keyboard-settings]')[0];
  const binding = (id) => vis('[data-binding="' + id + '"]')[0];
  const keysOf = (id) => [...(binding(id)?.querySelectorAll('kbd') ?? [])].map((k) => k.textContent.trim()).join('+') || binding(id)?.textContent.trim();
  const saved = async () => JSON.stringify((await window.aps.invoke('settings.get')).keybindings ?? null);
  const paletteOpen = () => !!document.querySelector('[role=dialog][aria-label="Command palette"], [data-palette]') || !!vis('[role=dialog] input[placeholder]')[0];
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'open-and-search',
    `await __t.view('Settings'); await __t.tab('Keyboard');
     if (!(await __t.waitFor(() => page(), 3000))) return 'NO PAGE';
     const all = vis('[data-shortcut-row]').length;
     setVal(vis('input[aria-label="Search shortcuts"]')[0], 'palette'); await __t.sleep(300);
     const found = vis('[data-shortcut-row]').map((r) => r.firstElementChild.textContent.trim());
     return 'rows: ' + (all > 30) + ' | found: ' + found.join(' / ') + ' | palette keys: ' + keysOf('palette');`,
  ),
  s(
    'rebind-palette',
    `await __t.real.click(binding('palette')); await __t.sleep(200);
     const listening = binding('palette').textContent.trim();
     await __t.real.key('p', { ctrl: true, shift: true }); await __t.sleep(800);
     return listening + ' | now: ' + keysOf('palette') + ' | saved: ' + (await saved());`,
  ),
  s(
    'new-keys-work',
    `document.body.focus(); await __t.esc();
     await __t.real.key('k', { ctrl: true }); await __t.sleep(500);
     const oldOpens = paletteOpen(); await __t.esc();
     await __t.real.key('p', { ctrl: true, shift: true }); await __t.sleep(600);
     const q = vis('[role=dialog] input')[0]?.placeholder; const opens = paletteOpen(); await __t.esc();
     return 'Ctrl+K opens: ' + oldOpens + ' | Ctrl+Shift+P opens: ' + opens + ' (' + q + ')';`,
  ),
  s(
    'conflict-and-take-over',
    `await __t.view('Settings'); await __t.tab('Keyboard'); setVal(vis('input[aria-label="Search shortcuts"]')[0], ''); await __t.sleep(300);
     await __t.real.click(binding('search')); await __t.real.key('p', { ctrl: true }); await __t.sleep(500);
     const msg = vis('[data-binding-problem] > span')[0]?.textContent.replace(/\\s+/g, ' ').trim() ?? 'NO MESSAGE';
     vis('[data-binding-problem] button').find((b) => b.textContent.trim() === 'Use it here')?.click(); await __t.sleep(800);
     return msg + ' || search: ' + keysOf('search') + ' | quick open: ' + keysOf('quick-open');`,
  ),
  s(
    'reserved-refused',
    `await __t.real.click(binding('assistant')); await __t.real.key('s', { ctrl: true }); await __t.sleep(500);
     const msg = vis('[data-binding-problem] > span')[0]?.textContent.replace(/\\s+/g, ' ').trim() ?? 'NO MESSAGE';
     vis('[data-binding-problem] button').find((b) => b.textContent.trim() === 'Cancel')?.click(); await __t.sleep(200);
     return msg + ' || assistant: ' + keysOf('assistant');`,
  ),
  s(
    'list-and-hints-follow',
    `document.body.focus(); await __t.esc();
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
     const d = await __t.waitFor(() => vis('[role=dialog]').find((x) => /Keyboard shortcuts/.test(x.textContent)), 3000); if (!d) return 'NO DIALOG';
     const row = [...d.querySelectorAll('dl > div')].find((x) => /^Command palette/.test(x.querySelector('dd')?.textContent ?? ''));
     const keys = [...(row?.querySelectorAll('kbd') ?? [])].map((k) => k.textContent).join('+');
     await __t.esc();
     return 'list: ' + keys;`,
  ),
  s(
    'reset-all',
    `await __t.view('Settings'); await __t.tab('Keyboard');
     vis('button').find((b) => /^Reset all/.test(b.textContent.trim()))?.click(); await __t.sleep(800);
     return 'palette: ' + keysOf('palette') + ' | search: ' + keysOf('search') + ' | saved: ' + (await saved());`,
  ),
];

module.exports = withExpect(steps, {
  // the search reads the descriptions too: Download Output's mentions the palette (0.51)
  'open-and-search': /^rows: true \| found: Command palette \(Quick Open at >\) \/ Download the output you are in [^|]*the command palette has Download Output… for the other formats \| palette keys: Ctrl\+K$/,
  'rebind-palette': /^Press keys… \| now: Ctrl\+Shift\+P \| saved: \{"palette":"Mod\+Shift\+P"\}$/,
  'new-keys-work': /^Ctrl\+K opens: false \| Ctrl\+Shift\+P opens: true \(.*command/i,
  'conflict-and-take-over': /^Search the workspace: Ctrl\+P is already “Quick Open”\. \|\| search: Ctrl\+P \| quick open: Ctrl\+Shift\+F$/,
  'reserved-refused': /^AI assistant: Ctrl\+S is Save \(requests and tabs\): it can't be changed\. \|\| assistant: Ctrl\+J$/,
  'list-and-hints-follow': /^list: Ctrl\+Shift\+P$/,
  'reset-all': /^palette: Ctrl\+K \| search: Ctrl\+Shift\+F \| saved: null$/,
});
