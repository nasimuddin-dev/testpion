// The Debugger's traffic shaping (FG-1, FG-4, FG-6, FG-7, FG-26): the Network speed menu in the header (presets, Custom…, Off, and the
// status bar says so), the rules the engine refuses (with the reason), and the rule editor's fields for remap, fault, frame and
// map-local replies. The engine itself (pacing, Host header, files, faults, frames) is covered by tests/unit/debugger-shaping.test.ts.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const items = () => [...document.querySelectorAll('[role=menuitem]')].filter((m) => m.offsetParent);
  const speedButton = () => document.querySelector('main [data-network-speed]');
  const pick = async (re) => { const it = await __t.waitFor(() => items().find((m) => re.test(m.textContent)), 3000); if (!it) return false; await __t.real.click(it); await __t.sleep(400); return true; };
  const setValue = (el, v) => { const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const dialog = () => document.querySelector('[role=dialog]');
  const mine = async () => (await window.aps.invoke('debug.rules')).rules.filter((r) => /^e2e shaping /.test(r.name));
  const fail = async (rule) => { try { await window.aps.invoke('debug.saveRule', { rule }); return 'SAVED'; } catch (e) { return e.message; } };
`;
const step = stepOf(H);

const steps = [
  step(
    'speed-menu-lists-the-presets',
    `await window.aps.invoke('debug.setSpeed', { preset: 'off' });
     await __t.view('Debugger'); await __t.sleep(600);
     const b = speedButton(); if (!b) return 'NO BUTTON';
     const label = b.textContent.trim();
     await __t.real.click(b);
     const names = (await __t.waitFor(() => (items().length ? items() : null), 3000) ?? []).map((m) => m.textContent.replace(/^[✓\\s]+/, '').trim());
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(200);
     return 'button: ' + label + ' | menu: ' + names.join(' / ');`,
  ),
  step(
    'choosing-3g-sets-the-speed',
    `await __t.real.click(speedButton());
     if (!(await pick(/^[✓\\s]*3G \\(/))) return 'NO 3G ITEM';
     const s = await window.aps.invoke('debug.speed');
     const label = speedButton().textContent.trim();
     return 'speed: ' + s.speed?.preset + ' down ' + s.speed?.downKbps + ' | button: ' + label;`,
  ),
  step(
    'custom-speed-and-back-to-off',
    `await __t.real.click(speedButton());
     if (!(await pick(/Custom…/))) return 'NO CUSTOM ITEM';
     const d = await __t.waitFor(() => dialog(), 3000); if (!d) return 'NO DIALOG';
     const down = d.querySelector('[data-speed-down]'); setValue(down, '500'); await __t.sleep(150);
     const use = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Use this speed'); await __t.real.click(use); await __t.sleep(500);
     const s = (await window.aps.invoke('debug.speed')).speed;
     const custom = 'custom: ' + s?.preset + ' ' + s?.downKbps + ' | button: ' + speedButton().textContent.trim();
     await __t.real.click(speedButton());
     if (!(await pick(/Off \\(full speed\\)/))) return 'NO OFF ITEM';
     return custom + ' | off: ' + ((await window.aps.invoke('debug.speed')).speed === null) + ' | button: ' + speedButton().textContent.trim();`,
  ),
  step(
    'impossible-rules-are-refused-with-the-reason',
    `const cut = await fail({ kind: 'fault', name: 'e2e shaping cut', match: {}, fault: { action: 'truncate' } });
     const escape = await fail({ kind: 'reply', name: 'e2e shaping escape', match: {}, reply: { status: 200, file: '../outside.txt' } });
     const remap = await fail({ kind: 'remap', name: 'e2e shaping remap', match: {}, remap: { to: 'localhost:3000' } });
     const pct = await fail({ kind: 'fault', name: 'e2e shaping pct', match: {}, fault: { action: 'drop', percent: 500 } });
     const re = await fail({ kind: 'modify', name: 'e2e shaping re', match: {}, responseReplace: [{ find: '(a+)+b', replace: 'x', regex: true }] });
     return [cut, escape, remap, pct, re].map((m) => m.slice(0, 60)).join(' | ');`,
  ),
  step(
    'valid-shaping-rules-are-saved-and-described',
    `await window.aps.invoke('debug.saveRule', { rule: { kind: 'remap', name: 'e2e shaping remap', match: { host: 'api.e2e.test' }, remap: { to: 'localhost:3000', preserveHost: true } } });
     await window.aps.invoke('debug.saveRule', { rule: { kind: 'fault', name: 'e2e shaping fail', match: { host: 'api.e2e.test' }, fault: { action: 'error', status: 503, percent: 20 } } });
     await window.aps.invoke('debug.saveRule', { rule: { kind: 'frame', name: 'e2e shaping frames', match: { url: 'ws*' }, frame: { direction: 'received', action: 'drop', when: 'noise' } } });
     await window.aps.invoke('debug.saveRule', { rule: { kind: 'reply', name: 'e2e shaping file', match: { url: '*/users' }, reply: { status: 200, file: 'mocks/users.json' } } });
     return (await mine()).map((r) => r.summary).join(' | ');`,
  ),
  step(
    'editor-shows-the-fields-of-each-kind',
    `const rail = document.querySelector('[data-tool-rail] button[aria-label="Modify"]'); if (!rail) return 'NO MODIFY RAIL';
     await __t.real.click(rail);
     await pick(/Modify headers/);
     const add = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Add' && b.closest('[data-rule-list]')), 4000); if (!add) return 'NO ADD';
     await __t.real.click(add);
     const menu = (await __t.waitFor(() => (items().length ? items() : null), 3000) ?? []).map((m) => m.textContent.trim());
     if (!(await pick(/^Remap a host$/))) return 'NO REMAP ITEM: ' + menu.join(',');
     const d = await __t.waitFor(() => dialog(), 3000); if (!d) return 'NO DIALOG';
     const kind = d.querySelector('select'); const remap = kind.value + ' ' + !!d.querySelector('[data-remap-to]') + ' ' + /Keep the Host header/.test(d.textContent);
     setValue(kind, 'fault'); await __t.sleep(200);
     const fault = /What fails/.test(d.textContent) + ' ' + /How often/.test(d.textContent);
     setValue(kind, 'frame'); await __t.sleep(200);
     const frame = /Sent by the program/.test(d.textContent) + ' ' + /Pause for editing/.test(d.textContent);
     setValue(kind, 'reply'); await __t.sleep(200);
     const reply = /Body from/.test(d.textContent) + ' ' + /A file of the workspace/.test(d.textContent);
     setValue(kind, 'modify'); await __t.sleep(200);
     const modify = /Replace in the response body/.test(d.textContent) + ' ' + /Answer with this status instead/.test(d.textContent);
     const cancel = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Cancel'); await __t.real.click(cancel); await __t.sleep(200);
     return 'remap: ' + remap + ' | fault: ' + fault + ' | frame: ' + frame + ' | reply: ' + reply + ' | modify: ' + modify + ' | closed: ' + !dialog();`,
  ),
  step(
    'clean-up',
    `for (const r of (await mine())) await window.aps.invoke('debug.deleteRule', { id: r.id });
     await window.aps.invoke('debug.setSpeed', { preset: 'off' });
     return 'left: ' + (await mine()).length;`,
  ),
];

module.exports = withExpect(steps, {
  'speed-menu-lists-the-presets': /^button: Network speed: Off \| menu: Off \(full speed\) \/ Modem .* \/ Edge .* \/ Slow 3G .* \/ 3G .* \/ Slow 4G .* \/ Custom…$/,
  'choosing-3g-sets-the-speed': /^speed: 3g down 1600 \| button: Network speed: 3G$/,
  'custom-speed-and-back-to-off': /^custom: custom 500 \| button: Network speed: Custom \| off: true \| button: Network speed: Off$/,
  'impossible-rules-are-refused-with-the-reason': /^Cutting a response needs the number of bytes.* \| The file must be a path inside the workspace.* \| A remap rule needs the host to remap.* \| The share of requests that fail is 1 to 100.* \| The pattern is refused.*$/,
  'valid-shaping-rules-are-saved-and-described': /^Reach api\.e2e\.test at localhost:3000, keeping the Host header \| For api\.e2e\.test: answer 503 in 20% of requests \| WebSocket ws\*: drop frames the server sends that contain noise \| Reply to \*\/users with the file mocks\/users\.json$/,
  'editor-shows-the-fields-of-each-kind': /^remap: remap true true \| fault: true true \| frame: true true \| reply: true true \| modify: true true \| closed: true$/,
  'clean-up': /^left: 0$/,
});
