// The Debugger for corporate networks and sharing (FG-9, FG-14, FG-22, FG-23, FG-24, FG-28): Capture ▸ Connections… (gateway, secrets
// never shown back), the Session menu's SAZ / Fiddler rules / Compare / bundle items with the reason when one is disabled, the
// Fiddler rules report, comparing two sessions, large-session mode and starting a program through the proxy. The engine
// (CONNECT through a fake gateway, mutual TLS, SAZ round trip, diff, bundle, spool) is covered by tests/unit/debugger-gateway.test.ts
// and tests/unit/debugger-enterprise.test.ts.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const items = () => [...document.querySelectorAll('[role=menuitem]')].filter((m) => m.offsetParent);
  const pick = async (re) => { const it = await __t.waitFor(() => items().find((m) => re.test(m.textContent)), 3000); if (!it) return false; await __t.real.click(it); await __t.sleep(400); return true; };
  const menuButton = (label) => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === label);
  const setValue = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const dialog = () => document.querySelector('[role=dialog]');
  const btn = (d, text) => [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
  const har = (urls) => JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: urls.map(([u, status, ms]) => ({ startedDateTime: '2026-10-28T10:00:00.000Z', time: ms, request: { method: 'GET', url: u, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 }, response: { status, statusText: '', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: 'text/plain', text: '' }, redirectURL: '', headersSize: -1, bodySize: 0 }, cache: {}, timings: { send: 0, wait: ms, receive: 0 } })) } });
  const close = async () => { const d = dialog(); if (d) { const c = btn(d, 'Cancel') ?? btn(d, 'Close') ?? btn(d, 'Done'); if (c) await __t.real.click(c); await __t.sleep(250); } };
`;
const step = stepOf(H);

const FARX = `<?xml version="1.0"?><AutoResponder><State Enabled="true"><ResponseRule Match="EXACT:http://e2e.test/a" Action="*redir:http://e2e.test/b" Enabled="true"/><ResponseRule Match="orders" Action="*bpu"/><ResponseRule Match="NOT:static" Action="*drop"/></State></AutoResponder>`;

const steps = [
  step(
    'connections-dialog-opens-from-the-capture-menu',
    `await window.aps.invoke('debug.setGateway', { config: { mode: 'none' }, password: null });
     await __t.view('Debugger'); await __t.sleep(600);
     const b = menuButton('Capture'); if (!b) return 'NO CAPTURE MENU';
     await __t.real.click(b);
     if (!(await pick(/^Connections…/))) return 'NO CONNECTIONS ITEM';
     const d = await __t.waitFor(() => dialog(), 3000); if (!d) return 'NO DIALOG';
     await __t.sleep(400);
     const modes = [...d.querySelectorAll('[role=radio]')].map((r) => r.textContent.trim()).join(' / ');
     const save = btn(d, 'Save');
     return 'modes: ' + modes + ' | sections: ' + /Extra certificate authorities/.test(d.textContent) + ' ' + /Client certificates/.test(d.textContent) + ' | save enabled: ' + !save.disabled;`,
  ),
  step(
    'manual-gateway-needs-an-address-and-says-why',
    `const d = dialog();
     const manual = [...d.querySelectorAll('[role=radio]')].find((r) => /This address/.test(r.textContent)); await __t.real.click(manual); await __t.sleep(250);
     const save = btn(d, 'Save'); const test = btn(d, 'Save and test the gateway');
     const empty = 'save disabled: ' + save.disabled + ' (' + (save.title || save.getAttribute('aria-description') || '') + ') | test disabled: ' + test.disabled;
     return empty;`,
  ),
  step(
    'saving-keeps-the-password-out-of-sight',
    `const d = dialog();
     setValue(d.querySelector('[data-gateway-url]'), 'http://127.0.0.1:1'); await __t.sleep(150);
     const inputs = [...d.querySelectorAll('input')];
     const user = inputs.find((i) => i.autocomplete === 'off' && i.type === 'text' && !i.dataset.gatewayUrl && i.closest('label, div')?.textContent.includes('User name'));
     if (!user) return 'NO USER INPUT';
     setValue(user, 'ann'); await __t.sleep(150);
     const pw = d.querySelector('input[type=password]'); setValue(pw, 'e2e-not-a-real-password'); await __t.sleep(150);
     await __t.real.click(btn(d, 'Save')); await __t.sleep(700);
     const g = await window.aps.invoke('debug.gateway');
     return 'mode: ' + g.config.mode + ' | url: ' + g.config.url + ' | user: ' + g.config.username + ' | password set: ' + g.passwordSet + ' | leaked: ' + JSON.stringify(g).includes('e2e-not-a-real') + ' | closed: ' + !dialog();`,
  ),
  step(
    'gateway-test-says-what-went-wrong',
    `const r = await window.aps.invoke('debug.testGateway', { url: 'https://example.com/' });
     return 'ok: ' + r.ok + ' | via: ' + r.via + ' | ' + r.message.slice(0, 60);`,
  ),
  step(
    'a-bad-certificate-file-is-refused-with-the-file-name',
    `let msg = 'SAVED';
     try { await window.aps.invoke('debug.setGateway', { config: { mode: 'none', caFiles: ['C:/definitely/not/here.pem'] } }); } catch (e) { msg = e.message; }
     return msg.slice(0, 90);`,
  ),
  step(
    'back-to-direct-connections',
    `await window.aps.invoke('debug.setGateway', { config: { mode: 'none' }, password: null });
     const g = await window.aps.invoke('debug.gateway');
     return 'mode: ' + g.config.mode + ' | password set: ' + g.passwordSet;`,
  ),
  step(
    'session-menu-lists-the-new-items-with-reasons',
    `await window.aps.invoke('debug.clear');
     await __t.view('Debugger'); await __t.sleep(500);
     const b = menuButton('Session'); if (!b) return 'NO SESSION MENU';
     await __t.real.click(b); await __t.sleep(300);
     const all = items();
     const find = (re) => all.find((m) => re.test(m.textContent));
     const state = (re) => { const m = find(re); return m ? (m.getAttribute('aria-disabled') === 'true' || m.hasAttribute('disabled') ? 'disabled' : 'enabled') : 'MISSING'; };
     const out = 'saz: ' + state(/Export as a Fiddler session/) + ' | farx: ' + state(/Import Fiddler rules/) + ' | compare: ' + state(/Compare with an earlier session/) + ' | share: ' + state(/Share as a bundle/) + ' | open: ' + state(/Open a bundle/);
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(200);
     return out;`,
  ),
  step(
    'fiddler-rules-are-reported-rule-by-rule',
    `const r = await window.aps.invoke('debug.importFarx', { text: ${JSON.stringify(FARX)}, dryRun: true });
     return r.summary + ' | partial: ' + r.partial + ' | applied: ' + r.applied + ' | ' + r.items.map((i) => i.result).join(',');`,
  ),
  step(
    'compare-two-sessions',
    `await window.aps.invoke('debug.openSession', { text: har([['http://e2e.test/a', 200, 40], ['http://e2e.test/b', 200, 40], ['http://e2e.test/gone', 200, 40]]), append: false });
     await window.aps.invoke('debug.saveSession', { name: 'e2e-enterprise-before' });
     await window.aps.invoke('debug.openSession', { text: har([['http://e2e.test/a', 200, 45], ['http://e2e.test/b', 500, 40], ['http://e2e.test/new', 200, 40]]), append: false });
     const r = await window.aps.invoke('debug.diff', { with: 'e2e-enterprise-before' });
     return r.summary + ' | added: ' + r.added.map((x) => x.url.replace('http://e2e.test', '')).join(',') + ' | removed: ' + r.removed.map((x) => x.url.replace('http://e2e.test', '')).join(',') + ' | changed: ' + r.changed.map((x) => x.url.replace('http://e2e.test', '') + ':' + x.changes.join('+')).join(',');`,
  ),
  step(
    'compare-dialog-lists-the-differences',
    `await __t.view('Debugger'); await __t.sleep(500);
     await __t.real.click(menuButton('Session')); await __t.sleep(300);
     if (!(await pick(/Compare with an earlier session/))) return 'NO COMPARE ITEM';
     const d = await __t.waitFor(() => dialog(), 3000); if (!d) return 'NO DIALOG';
     const sel = d.querySelector('[data-compare-with]'); setValue(sel, 'e2e-enterprise-before'); await __t.sleep(150);
     await __t.real.click(btn(d, 'Compare')); await __t.sleep(700);
     const summary = d.querySelector('[data-compare-summary]')?.textContent ?? 'NO SUMMARY';
     const rows = d.querySelectorAll('[data-diff-row]').length;
     const tabs = [...d.querySelectorAll('[role=tab]')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim()).join(' / ');
     await close();
     return summary + ' | rows: ' + rows + ' | tabs: ' + tabs;`,
  ),
  step(
    'large-session-mode-switches-on-and-off',
    `const on = await window.aps.invoke('debug.largeSession', { on: true });
     const off = await window.aps.invoke('debug.largeSession', { on: false });
     return 'on: ' + on.on + ' | off: ' + off.on + ' | spilled: ' + off.spilled;`,
  ),
  step(
    'launch-says-what-it-would-set',
    `await window.aps.invoke('debug.start', { port: 0 });
     const j = await window.aps.invoke('debug.launch', { command: 'java', args: ['-jar', 'app.jar'], preview: true });
     const n = await window.aps.invoke('debug.launch', { command: 'chrome', preview: true });
     let bad = 'STARTED'; try { await window.aps.invoke('debug.launch', { command: 'x', kind: 'nope', preview: true }); } catch (e) { bad = e.message; }
     await window.aps.invoke('debug.stop');
     return 'java: ' + j.kind + ' ' + j.env.includes('JAVA_TOOL_OPTIONS') + ' started: ' + j.started + ' | chrome: ' + n.kind + ' ' + n.args.some((a) => a === '--disable-quic') + ' | bad kind: ' + bad.slice(0, 30);`,
  ),
  step(
    'clean-up',
    `await window.aps.invoke('debug.deleteSession', { name: 'e2e-enterprise-before' });
     await window.aps.invoke('debug.clear');
     const rules = (await window.aps.invoke('debug.rules')).rules.filter((r) => /^Fiddler: /.test(r.name));
     return 'fiddler rules left: ' + rules.length;`,
  ),
];

module.exports = withExpect(steps, {
  'connections-dialog-opens-from-the-capture-menu': /^modes: Connect directly \/ Follow the system settings \/ This address \| sections: true true \| save enabled: true$/,
  'manual-gateway-needs-an-address-and-says-why': /^save disabled: true \(.*Give the gateway address.*\) \| test disabled: true$/,
  'saving-keeps-the-password-out-of-sight': /^mode: manual \| url: http:\/\/127\.0\.0\.1:1 \| user: ann \| password set: true \| leaked: false \| closed: true$/,
  'gateway-test-says-what-went-wrong': /^ok: false \| via: 127\.0\.0\.1:1 \| .*(refused|ECONNREFUSED).*$/,
  'a-bad-certificate-file-is-refused-with-the-file-name': /^Cannot read the certificate file C:\/definitely\/not\/here\.pem/,
  'back-to-direct-connections': /^mode: none \| password set: false$/,
  'session-menu-lists-the-new-items-with-reasons': /^saz: disabled \| farx: enabled \| compare: disabled \| share: disabled \| open: enabled$/,
  'fiddler-rules-are-reported-rule-by-rule': /^3 Fiddler rules: 2 imported, 1 skipped \| partial: true \| applied: false \| imported,imported,skipped$/,
  'compare-two-sessions': /^1 added, 1 removed, 1 changed, 1 the same \(3 vs 3 requests\) \| added: \/new \| removed: \/gone \| changed: \/b:status$/,
  'compare-dialog-lists-the-differences': /^1 added, 1 removed, 1 changed, 1 the same \(3 vs 3 requests\) \| rows: 1 \| tabs: Changed1 \/ Added1 \/ Removed1$/,
  'large-session-mode-switches-on-and-off': /^on: true \| off: false \| spilled: 0$/,
  'launch-says-what-it-would-set': /^java: java true started: false \| chrome: chromium true \| bad kind: kind is one of node/,
  'clean-up': /^fiddler rules left: 0$/,
});
