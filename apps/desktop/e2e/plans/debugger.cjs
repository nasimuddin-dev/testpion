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
];

module.exports = withExpect(steps, {
  start: /^listening \| port: \d+$/,
  'exchange-listed-and-opens': /^row: GET true 200 true \| detail tabs: true \| body shown: true \| opened as request: true$/,
});
