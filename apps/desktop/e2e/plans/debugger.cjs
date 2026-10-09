// The HTTP Debugger: start the proxy, a program sends through it (the harness's main process, with the proxy as its
// HTTP proxy), the exchange is listed with its program, status and size, and opens whole; Open as a request works.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(label)})`;
const steps = [
  [
    'home-tile-opens-the-debugger',
    `(async () => {
      await __t.view('Home');
      const tile = await __t.waitFor(() => [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.includes('Debug HTTP traffic')), 8000);
      if (!tile) return 'NO TILE';
      const icon = !!tile.querySelector('svg');
      tile.click(); await __t.sleep(800);
      const opened = !![...document.querySelectorAll('main h1, main h2, main *')].find((x) => x.children.length === 0 && x.textContent.trim() === 'HTTP Debugger');
      return 'tile: true | icon: ' + icon + ' | opens: ' + opened;
    })()`,
  ],
  [
    'start',
    `(async () => {
      await __t.view('Debugger');
      ${button('Start capturing')}?.click();
      const sub = await __t.waitFor(() => [...document.querySelectorAll('main *')].map((x) => x.textContent?.trim() ?? '').find((t) => /^Proxy address http:\\/\\/127\\.0\\.0\\.1:\\d+/.test(t)), 5000);
      const st = await window.aps.invoke('debug.status');
      return (sub ? 'listening' : 'NO STATUS') + ' | port: ' + st.port;
    })()`,
  ],
  [
    'status-bar-shows-it',
    `(async () => {
      const seg = await __t.waitFor(() => [...document.querySelectorAll('footer button')].map((b) => b.textContent.trim()).find((t) => /^Debugger :\\d+/.test(t)), 4000);
      return 'status bar: ' + (seg ?? 'NONE');
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
      const detail = !!document.querySelector('main [data-details-pane=request]') && !!document.querySelector('main [data-details-pane=response]');
      [...document.querySelectorAll('main [data-details-pane=response] [role=tab]')].find((t) => t.textContent.trim().startsWith('Content'))?.click(); await __t.sleep(300);
      const body = await __t.waitFor(() => /"status"|ok/.test([...document.querySelectorAll('main [data-details-pane=response] [data-raw-view] .leading-5 > span:last-child')].map((x) => x.textContent).join('\\n')), 3000);
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
      const tab = (side, name) => [...document.querySelectorAll('main [data-details-pane=' + side + '] [role=tab]')].find((t) => t.textContent.trim().startsWith(name));
      tab('request', 'Raw')?.click(); tab('response', 'Raw')?.click(); await __t.sleep(400);
      const raw = [...document.querySelectorAll('main [data-details-pane] pre')].map((p) => p.textContent).join('\\n');
      tab('request', 'Auth')?.click(); await __t.sleep(400);
      const auth = [...document.querySelectorAll('main *')].some((x) => x.children.length === 0 && /No credentials in this exchange/.test(x.textContent ?? ''));
      tab('response', 'Hex')?.click(); await __t.sleep(400);
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
  [
    'rule-replies-without-the-server',
    `(async () => {
      // Rules ▸ Presets for the host ▸ Offline: reply 503; the next request is answered by TestPion
      const row = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/health')), 4000);
      row?.click(); await __t.sleep(500);
      [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Rules'))?.click(); await __t.sleep(600);
      const presets = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && /^Presets for 127\\.0\\.0\\.1:4010/.test(b.textContent.trim()));
      if (!presets) return 'NO PRESETS BUTTON';
      presets.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /Offline: reply 503/.test(m.textContent))?.click(); await __t.sleep(800);
      const listed = !!(await __t.waitFor(() => [...document.querySelectorAll('main [data-rule]')].some((r) => /Offline/.test(r.textContent)), 4000));
      const bar = await __t.waitFor(() => ([...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Traffic'))?.click(), document.querySelector('main [data-rules-bar]')?.textContent), 3000);
      const r = await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?rule=1' });
      await __t.sleep(600);
      const ruleRow = [...document.querySelectorAll('main [role=row]')].find((x) => x.textContent.includes('rule=1'));
      ruleRow?.click(); await __t.sleep(600);
      const badge = [...document.querySelectorAll('main *')].some((x) => x.children.length === 0 && /answered by a rule/.test(x.textContent ?? ''));
      // the rule is removed again so the other steps see the real server
      const rules = await window.aps.invoke('debug.rules');
      for (const rule of rules.rules.filter((x) => /Offline/.test(x.name))) await window.aps.invoke('debug.deleteRule', { id: rule.id });
      return 'rule listed: ' + listed + ' | bar: ' + /rules? active/.test(bar ?? '') + ' | status: ' + r.status + ' | row 503: ' + /503/.test(ruleRow?.textContent ?? '') + ' | badge: ' + badge;
    })()`,
  ],
  [
    'breakpoint-holds-and-edits',
    `(async () => {
      // a breakpoint preset for the host; the next request waits in a dialog, where its URL is changed, then goes on
      const st = await window.aps.invoke('debug.addPreset', { preset: 'break-request', host: '127.0.0.1:4010' });
      const pending = window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/health?bp=1' });
      const dialog = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /Breakpoint: the request/.test(d.textContent)), 6000);
      if (!dialog) return 'NO DIALOG';
      const url = [...dialog.querySelectorAll('input')].find((i) => /bp=1/.test(i.value));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(url, 'http://127.0.0.1:4010/health?bp=edited'); url.dispatchEvent(new Event('input', { bubbles: true }));
      [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue with changes')?.click();
      const r = await pending;
      await __t.sleep(800);
      const edited = !!(await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].some((x) => x.textContent.includes('bp=edited')), 4000));
      const rules = await window.aps.invoke('debug.rules');
      for (const rule of rules.rules.filter((x) => x.kind === 'breakpoint')) await window.aps.invoke('debug.deleteRule', { id: rule.id });
      const gone = !!(await __t.waitFor(() => (document.querySelector('[role=dialog]') ? null : true), 3000));
      return 'added: ' + st.rules.some((x) => x.kind === 'breakpoint') + ' | status: ' + r.status + ' | edited url listed: ' + edited + ' | dialog gone: ' + gone;
    })()`,
  ],
  [
    'websocket-frames-and-sse-events',
    `(async () => {
      [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Traffic'))?.click();
      await window.aps.invoke('debug.selfTest', { url: 'ws://127.0.0.1:4013/' });
      await window.aps.invoke('debug.selfTest', { url: 'http://127.0.0.1:4010/events?count=3' });
      await __t.sleep(800);
      const wsRow = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('ws://127.0.0.1:4013')), 8000);
      if (!wsRow) return 'NO WS ROW';
      wsRow.click(); await __t.sleep(700);
      const tab = (name) => [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith(name));
      tab('Frames')?.click(); await __t.sleep(400);
      const sent = [...document.querySelectorAll('main [data-frame=sent]')].some((r) => r.textContent.includes('hello from TestPion'));
      const received = [...document.querySelectorAll('main [data-frame=received]')].some((r) => /echo/.test(r.textContent));
      const sseRow = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/events?count=3')), 4000);
      sseRow?.click(); await __t.sleep(700);
      tab('Events')?.click(); await __t.sleep(400);
      const events = document.querySelectorAll('main [data-event]').length;
      const closed = !!(await __t.waitFor(() => { const r = [...document.querySelectorAll('main [role=row]')].find((x) => x.textContent.includes('ws://127.0.0.1:4013')); return r && !/live/.test(r.textContent); }, 10000));
      return 'ws sent: ' + sent + ' | ws received: ' + received + ' | sse events: ' + events + ' | ws closed: ' + closed;
    })()`,
  ],
  [
    'https-certificate-and-decode',
    `(async () => {
      // the HTTPS menu: decryption on, the certificate dialog shows a fingerprint; the Decode panel reads Base64 and a JWT
      document.querySelector('main button[aria-label="HTTPS (tunnels)"]')?.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Decrypt HTTPS/.test(m.textContent.trim()))?.click(); await __t.sleep(800);
      const st = await window.aps.invoke('debug.status');
      const label = !!document.querySelector('main button[aria-label="HTTPS (decrypted)"]');
      document.querySelector('main button[aria-label="HTTPS (decrypted)"]')?.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Root certificate/.test(m.textContent.trim()))?.click();
      const fp = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] *')].find((x) => x.children.length === 0 && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x.textContent.trim())), 15000);
      document.querySelector('[role=dialog] button[aria-label=Close]')?.click(); await __t.sleep(400);
      await window.aps.invoke('debug.decrypt', { on: false });
      ${button('Decode')}?.click(); await __t.sleep(500);
      const area = document.querySelector('main [data-convert] textarea[aria-label="Text to convert"]');
      if (!area) return 'NO DECODE';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(area, 'aGVsbG8gd29ybGQ='); area.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
      const b64 = document.querySelector('main [data-convert] [data-decode="Base64 Decode"] pre')?.textContent;
      return 'decrypt on: ' + st.decrypt + ' | label: ' + label + ' | fingerprint: ' + !!fp + ' | base64: ' + b64;
    })()`,
  ],
  [
    'grpc-call-and-connections',
    `(async () => {
      // a gRPC call through the proxy (h2c inside a CONNECT, as grpc-js does): listed as gRPC over HTTP/2, its messages
      // decoded field by field (this workspace has no .proto for the demo PetService), the status from the trailers
      [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Traffic'))?.click();
      await window.aps.invoke('debug.selfTest', { url: 'grpc://127.0.0.1:4014/vet.v1.PetService/GetPet?id=1' });
      await window.aps.invoke('debug.selfTest', { url: 'grpc://127.0.0.1:4014/vet.v1.PetService/GetPet?id=99' });
      const row = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('/vet.v1.PetService/GetPet') && /gRPC/.test(r.textContent)), 6000);
      if (!row) return 'NO GRPC ROW';
      const h2 = /HTTP\\/2/.test(row.textContent);
      row.click(); await __t.sleep(700);
      const tab = (name) => [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith(name));
      tab('gRPC')?.click(); await __t.sleep(400);
      const raw = !!document.querySelector('main [data-grpc-decoded=raw]');
      const sent = [...document.querySelectorAll('main [data-grpc-message=Sent]')].some((p) => /"1": 1\\b/.test(p.textContent));
      const received = (await __t.waitFor(() => document.querySelectorAll('main [data-grpc-message=Received]').length || null, 4000)) ?? 0;
      const failed = await __t.waitFor(() => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes('GetPet') && r.querySelector('[title="gRPC NOT_FOUND"]')), 4000);
      tab('Connections')?.click(); await __t.sleep(500);
      const h2conn = document.querySelectorAll('main [data-connection=h2]').length;
      tab('Traffic')?.click(); await __t.sleep(300);
      return 'h2: ' + h2 + ' | raw: ' + raw + ' | sent: ' + sent + ' | received: ' + received + ' | not found: ' + !!failed + ' | h2 connections: ' + (h2conn > 0);
    })()`,
  ],
  [
    'phone-dialog',
    `(async () => {
      ${button('Capture')}?.click(); await __t.sleep(500);
      [...document.querySelectorAll('[role=menuitem]')].find((m) => /^A phone or another computer/.test(m.textContent.trim()))?.click();
      const dialog = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog]')].find((d) => /phone or another computer/.test(d.textContent)), 4000);
      if (!dialog) return 'NO DIALOG';
      // the addresses (and their QR codes) load after the dialog opens
      await __t.waitFor(() => !/Looking for this computer/.test(dialog.textContent), 8000);
      const offers = /Listen on the network/.test(dialog.textContent);
      dialog.querySelector('button[aria-label=Close]')?.click(); await __t.sleep(300);
      return 'dialog: true | offers to listen on the network: ' + offers;
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'status-bar-shows-it': /^status bar: Debugger :\d+$/,
  'grpc-call-and-connections': /^h2: true \| raw: true \| sent: true \| received: 1 \| not found: true \| h2 connections: true$/,
  'phone-dialog': /^dialog: true \| offers to listen on the network: true$/,
  'home-tile-opens-the-debugger': /^tile: true \| icon: true \| opens: true$/,
  start: /^listening \| port: \d+$/,
  'exchange-listed-and-opens': /^row: GET true 200 true \| detail tabs: true \| body shown: true \| opened as request: true$/,
  'inspectors-and-keyboard': /^raw request line: true \| raw response line: true \| auth: true \| hex: true \| delete key: true$/,
  'session-saved-and-opened': /^saved: true \| cleared: true \| opened: true$/,
  'rule-replies-without-the-server': /^rule listed: true \| bar: true \| status: 503 \| row 503: true \| badge: true$/,
  'websocket-frames-and-sse-events': /^ws sent: true \| ws received: true \| sse events: 3 \| ws closed: true$/,
  'https-certificate-and-decode': /^decrypt on: true \| label: true \| fingerprint: true \| base64: hello world$/,
  'breakpoint-holds-and-edits': /^added: true \| status: 200 \| edited url listed: true \| dialog gone: true$/,
});
