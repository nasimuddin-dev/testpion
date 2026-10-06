// The HTTP Debugger: start the proxy, a program sends through it (the harness's main process, with the proxy as its
// HTTP proxy), the exchange is listed with its program, status and size, and opens whole; Open as a request works.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(label)})`;
const steps = [
  [
    'start',
    `(async () => {
      await __t.view('Debugger');
      ${button('Start capturing')}?.click();
      const sub = await __t.waitFor(() => [...document.querySelectorAll('main *')].map((x) => x.textContent?.trim() ?? '').find((t) => /^Listening on http:\\/\\/127\\.0\\.0\\.1:\\d+/.test(t)), 5000);
      const st = await window.aps.invoke('debug.status');
      return (sub ? 'listening' : 'NO STATUS') + ' | port: ' + st.port;
    })()`,
  ],
  [
    'exchange-listed-and-opens',
    `(async () => {
      const st = await window.aps.invoke('debug.status');
      // a program sends through the proxy: the window itself cannot, so the backend's own HTTP client does, with the proxy set
      await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health' });
      const row = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/health')), 6000);
      if (!row) return 'NO ROW';
      row.click(); await __t.sleep(800);
      const text = row.textContent;
      const detail = [...document.querySelectorAll('main *')].some((x) => x.getAttribute('role') === 'tab' && (x.textContent?.trim() ?? '').startsWith('Response'));
      const body = await __t.waitFor(() => [...document.querySelectorAll('main *')].some((x) => x.children.length === 0 && /"status"|ok/.test(x.textContent ?? '')), 3000);
      ${button('Open')}?.click(); await __t.sleep(1500);
      const url = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && /127\\.0\\.0\\.1:4010\\/health/.test(i.value));
      return 'row: GET ' + /GET/.test(text) + ' 200 ' + /200/.test(text) + ' | detail tabs: ' + detail + ' | body shown: ' + !!body + ' | opened as request: ' + !!url;
    })()`,
  ],
  [
    'inspectors-and-keyboard',
    `(async () => {
      await __t.view('Debugger');
      const row = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/health')), 4000);
      if (!row) return 'NO ROW';
      row.click(); await __t.sleep(600);
      const tab = (name) => [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith(name));
      tab('Raw')?.click(); await __t.sleep(400);
      const raw = [...document.querySelectorAll('main pre')].map((p) => p.textContent).join('\\n');
      tab('Auth')?.click(); await __t.sleep(400);
      const auth = [...document.querySelectorAll('main *')].some((x) => x.children.length === 0 && /No credentials in this exchange/.test(x.textContent ?? ''));
      tab('Hex')?.click(); await __t.sleep(400);
      const hex = [...document.querySelectorAll('main pre')].some((p) => /^00000000  /.test(p.textContent));
      // keyboard: the grid takes the focus; Delete removes the selected row
      const grid = document.querySelector('main [aria-label="Captured exchanges"]');
      grid.focus();
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); await __t.sleep(800);
      const gone = ![...document.querySelectorAll('main [role=row]')].some((r) => r.textContent.includes('/health'));
      return 'raw request line: ' + /GET \\/health HTTP\\/1\\.1/.test(raw) + ' | raw response line: ' + /HTTP\\/1\\.1 200/.test(raw) + ' | auth: ' + auth + ' | hex: ' + hex + ' | delete key: ' + gone;
    })()`,
  ],
  [
    'session-saved-and-opened',
    `(async () => {
      await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health' });
      await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].some((r) => r.textContent.includes('/health')), 6000);
      // Session ▸ Save session… ▸ the name dialog ▸ Save
      ${button('Session')}?.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Save session/.test(m.textContent.trim()))?.click(); await __t.sleep(600);
      const field = [...document.querySelectorAll('input')].find((i) => i.getClientRects().length && /^session-/.test(i.value));
      if (!field) return 'NO NAME DIALOG';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(field, 'e2e-session'); field.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('button')].find((b) => b.getClientRects().length && b.textContent.trim() === 'Save')?.click(); await __t.sleep(800);
      const sessions = await window.aps.invoke('debug.sessions');
      const saved = sessions.find((x) => x.name === 'e2e-session');
      await window.aps.invoke('debug.clear'); await __t.sleep(400);
      const empty = !document.querySelector('main [role=row]');
      ${button('Session')}?.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Open e2e-session/.test(m.textContent.trim()))?.click(); await __t.sleep(1000);
      const back = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].some((r) => r.textContent.includes('/health')), 4000);
      return 'saved: ' + !!saved + ' | cleared: ' + empty + ' | opened: ' + !!back;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  start: /^listening \| port: \d+$/,
  'exchange-listed-and-opens': /^row: GET true 200 true \| detail tabs: true \| body shown: true \| opened as request: true$/,
  'inspectors-and-keyboard': /^raw request line: true \| raw response line: true \| auth: true \| hex: true \| delete key: true$/,
  'session-saved-and-opened': /^saved: true \| cleared: true \| opened: true$/,
});
