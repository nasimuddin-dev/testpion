// Screenshot steps for the documentation website. Loaded by the main process in capture mode.
// Drives the real UI (demo servers + example workspace) and writes JPEGs to docs/public/images/.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT = process.env.TESTPION_CAPTURE_DIR;
const W = 1440;
const H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Helpers injected into the page: find elements by visible text/title and drive React inputs. */
const HELPERS = `
window.__cap = {
  byText(text, tag = 'button') {
    // views stay mounted while hidden: prefer the element that is on screen
    const all = [...document.querySelectorAll(tag)].filter((e) => e.textContent.trim() === text || e.textContent.trim().startsWith(text));
    return all.find((e) => e.offsetParent !== null) ?? all[0];
  },
  click(text, tag) {
    const el = this.byText(text, tag);
    if (!el) throw new Error('not found: ' + text + ' (page: ' + document.body.innerText.slice(0, 400).replace(/\\s+/g, ' ') + ')');
    el.click();
  },
  nav(label) {
    const el = document.querySelector('nav [aria-label="' + label + '"]');
    // the request editors aren't on the rail (they open from Collections): use their Ctrl+Alt+n shortcut
    const keys = { REST: '2', GraphQL: '3', gRPC: '4', WebSocket: '5', MCP: '6' };
    if (!el && keys[label]) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: keys[label], ctrlKey: true, altKey: true, bubbles: true }));
      return;
    }
    if (!el) throw new Error('nav not found: ' + label);
    el.click();
  },
  setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  fieldInput(label) {
    const l = [...document.querySelectorAll('label')].find((x) => x.textContent.includes(label));
    return l && l.querySelector('input');
  },
};
true;`;

module.exports = async function run(win) {
  mkdirSync(OUT, { recursive: true });
  win.setContentSize(W, H);
  // keep painting while the window is covered or the screen is locked, or capturePage returns stale frames
  win.webContents.setBackgroundThrottling(false);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    await sleep(700);
    // force a full repaint: a window that isn't visible on screen (covered, locked screen) otherwise keeps
    // stale regions; a one-pixel resize makes the compositor redraw everything
    win.setContentSize(W, H + 1);
    await sleep(150);
    win.setContentSize(W, H);
    win.webContents.invalidate();
    await sleep(600);
    const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const out = img.resize({ width: W, quality: 'best' });
    writeFileSync(join(OUT, `${name}.jpg`), out.toJPEG(88));
    console.log(`[capture] ${name}.jpg ${JSON.stringify(out.getSize())}`);
  };

  // REST: a request from the collection, sent with a token
  await js(`localStorage.setItem('aps.view', 'rest');
    localStorage.setItem('aps.tree.open', JSON.stringify({ 'fld-patients': true, 'fld-auth': true }));
    localStorage.setItem('aps.draft.rest', JSON.stringify({ active: 't1', tabs: [{ id: 't1', name: 'List patients', collectionId: 'veterinary-api', requestId: 'req-list',
      request: { method: 'GET', url: '{{baseUrl}}/patients', params: [], headers: [], auth: { type: 'bearer', token: 'demo-token-3f9a1c' } },
      assertions: [{ type: 'status', expected: 200 }, { type: 'exists', path: '$.items[0].id' }, { type: 'latency', max: 1000 }] }] }));
    location.reload(); true`);
  await sleep(3000);
  await js(HELPERS);
  // a fresh profile opens on Home
  win.webContents.sendInputEvent({ type: 'mouseMove', x: W - 5, y: H - 5 });
  await js(`__cap.nav('Home'); true`);
  await sleep(1200);
  await shot('home');
  await js(`__cap.nav('REST'); true`);
  await sleep(1200);
  // keep the pointer off the navigation rail so no hover highlight ends up in the screenshots
  win.webContents.sendInputEvent({ type: 'mouseMove', x: W - 5, y: H - 5 });
  await js(`__cap.click('Send'); true`);
  // wait for the response panel (status badge + timing) rather than a fixed delay
  for (let i = 0; i < 40; i++) {
    if (await js(`!!document.querySelector('main') && /Time\\s+\\d/.test(document.querySelector('main').innerText)`)) break;
    await sleep(250);
  }
  await sleep(1500);
  await shot('rest');
  // the response's timeline: connection set-up, waiting and download
  await js(`__cap.click('Timeline'); true`);
  await sleep(800);
  await shot('rest-timeline');
  await js(`__cap.click('Body'); true`);
  await sleep(300);
  // a token response: its id_token (a JWT) decoded in the JWT tab
  // the request may be in a folded folder: the explorer's filter shows it, then the filter is cleared
  await js(`(async () => {
    const f = document.querySelector('aside input[placeholder^="Filter"]');
    const set = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
    if (f) { set('Get access token'); await new Promise((r) => setTimeout(r, 900)); }
    [...document.querySelectorAll('aside [data-tree-row], aside button')].find((b) => b.offsetParent !== null && b.textContent.includes('Get access token'))?.click();
    await new Promise((r) => setTimeout(r, 1200));
    if (f) set('');
    return true;
  })()`);
  await sleep(800);
  await js(`__cap.click('Send'); true`);
  await sleep(2500);
  await js(`__cap.click('JWT'); true`);
  await sleep(800);
  await shot('rest-jwt');

  // GraphQL: introspect, run, show autocomplete-ready editor
  await js(`__cap.nav('GraphQL'); true`);
  await sleep(1500);
  await js(`__cap.click('Introspect'); true`);
  await sleep(1500);
  await js(`__cap.click('Run'); true`);
  await sleep(1500);
  await shot('graphql');

  // MCP: connect, run a tool, then the protocol trace
  await js(`__cap.nav('MCP'); true`);
  await sleep(1000);
  await js(`__cap.click('Connect'); true`);
  await sleep(1200);
  // the example's own stdio server: allowed for this (throwaway) workspace when TestPion asks before running it
  await js(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === 'Run once'); b?.click(); return true; })()`);
  await sleep(3500);
  await js(`(() => { const i = __cap.fieldInput('customer_id'); if (!i) throw new Error('no customer_id field; dialogs: ' + [...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText.slice(0, 300)).join(' | ') + ' || main: ' + (document.querySelector('main')?.innerText ?? '').slice(0, 600).replace(/\s+/g, ' ')); __cap.setInput(i, '123'); return true; })()`);
  await sleep(300);
  await js(`__cap.click('Execute'); true`);
  await sleep(1500);
  await shot('mcp');
  await js(`__cap.click('Protocol trace'); true`);
  await sleep(1000);
  await js(`document.querySelectorAll('.overflow-auto button')[6]?.click(); true`);
  await shot('mcp-trace');
  // calls, failures and time per tool
  await js(`__cap.click('Usage'); true`);
  await sleep(1200);
  await shot('mcp-usage');

  // AI Lab playground
  await js(`__cap.nav('AI Lab'); true`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('button[title^="Run"]')].find((b) => b.offsetParent !== null)?.click(); true`);
  await sleep(2500);
  await shot('ai-lab');
  // tokens, cost and time per model
  await js(`__cap.click('Usage'); true`);
  await sleep(1200);
  await shot('ai-usage');
  await js(`__cap.click('Playground'); true`);
  await sleep(300);

  // Evaluations
  await js(`__cap.nav('Evaluations'); true`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('button')].find((b) => /^Run \\d+ cases/.test(b.textContent.trim())).click(); true`);
  await sleep(4000);
  await shot('evaluations');

  // Tests: run everything, then open a result
  await js(`__cap.nav('Tests'); true`);
  await sleep(1500);
  await js(`__cap.click('Run all tests'); true`);
  await sleep(6000);
  await js(`__cap.click('Booking agent uses the right tools'); true`);
  await sleep(1000);
  await shot('tests');

  // Traces
  await js(`__cap.nav('Traces'); true`);
  await sleep(1500);
  // the booking agent's trace when it is listed, else the newest one
  await js(`(() => { const rows = [...document.querySelectorAll('main button')].filter((b) => b.offsetParent !== null && /spans/.test(b.textContent)); (rows.find((b) => b.textContent.includes('Booking agent uses the right tools')) ?? rows[0])?.click(); return true; })()`);
  await sleep(1500);
  await shot('traces');

  // Load test
  await js(`__cap.nav('Load'); true`);
  await sleep(1000);
  await js(`__cap.click('Start load test'); true`);
  await sleep(9000);
  await shot('load');

  // Monitors: one scheduled check with a few runs, one paused
  await js(`(async () => {
    const a = await window.aps.invoke('monitor.save', { monitor: { name: 'Diagnostics', collectionId: 'veterinary-api', selection: ['fld-diag'], environment: 'Development', everyMinutes: 15, enabled: true } });
    await window.aps.invoke('monitor.save', { monitor: { name: 'Whole API (nightly)', collectionId: 'veterinary-api', environment: 'Development', everyMinutes: 1440, enabled: false } });
    for (let i = 0; i < 5; i++) await window.aps.invoke('monitor.run', { id: a.id });
    return true;
  })()`);
  await js(`__cap.nav('Monitors'); true`);
  await sleep(1500);
  await shot('monitors');

  // the HTTP Debugger: a session of a clinic's traffic (opened from a HAR, so nothing has to listen), a 404 selected
  await js(`__cap.nav('Debugger'); true`);
  await sleep(1200);
  await js(`(async () => {
    const t0 = Date.now() - 90_000;
    const calls = [
      ['chrome', 'GET', '/api/patients', 200, 42], ['chrome', 'GET', '/api/patients/7', 200, 18], ['chrome', 'GET', '/api/appointments?date=today', 200, 63],
      ['node', 'POST', '/api/appointments', 201, 88], ['node', 'GET', '/api/patients/41', 404, 9], ['python', 'GET', '/api/vaccines', 200, 120],
      ['python', 'PUT', '/api/patients/7/vitals', 200, 47], ['chrome', 'GET', '/api/invoices?status=open', 500, 310], ['node', 'DELETE', '/api/appointments/12', 204, 21],
      ['chrome', 'GET', '/api/patients?search=byron', 200, 35], ['python', 'POST', '/api/labs/results', 201, 152], ['node', 'GET', '/api/patients/99', 404, 8],
      ['chrome', 'GET', '/api/staff', 200, 29], ['node', 'PATCH', '/api/appointments/13', 200, 54], ['chrome', 'GET', '/api/reports/daily', 200, 410],
    ];
    const entries = calls.map(([app, method, path, status, ms], i) => {
      const body = status >= 400 ? JSON.stringify({ error: status === 404 ? 'not_found' : 'internal', message: status === 404 ? 'Patient not found' : 'Invoice service timed out' }) : status === 204 ? '' : JSON.stringify({ id: 7 + i, name: ['Byron', 'Biscuit', 'Pepper'][i % 3], species: ['dog', 'cat', 'rabbit'][i % 3] });
      return {
        startedDateTime: new Date(t0 + i * 5200).toISOString(), time: ms,
        request: { method, url: 'http://api.vetclinic.test:8080' + path, httpVersion: 'HTTP/1.1', headers: [{ name: 'accept', value: 'application/json' }, { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' }, { name: 'user-agent', value: app === 'chrome' ? 'Mozilla/5.0 Chrome/141' : app === 'node' ? 'node' : 'python-requests/2.32' }], queryString: [], cookies: [], headersSize: -1, bodySize: method === 'GET' || method === 'DELETE' ? 0 : 64, ...(method === 'GET' || method === 'DELETE' ? {} : { postData: { mimeType: 'application/json', text: '{"petId":7,"note":"annual check"}' } }) },
        response: { status, statusText: status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : status === 201 ? 'Created' : status === 204 ? 'No Content' : 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }, { name: 'x-request-id', value: 'req-' + (1000 + i) }], cookies: [], content: { size: body.length, mimeType: 'application/json', text: body }, redirectURL: '', headersSize: -1, bodySize: body.length },
        cache: {}, timings: { send: 1, wait: Math.round(ms * 0.8), receive: Math.round(ms * 0.2) }, serverIPAddress: '10.20.0.15',
        _testpion: { id: 'cap-' + i, kind: 'http', application: app, clientPort: 52000 + i, pid: { chrome: 8124, node: 4116, python: 9532 }[app], serverAddress: '10.20.0.15:8080' },
      };
    });
    await window.aps.invoke('debug.openSession', { text: JSON.stringify({ log: { version: '1.2', creator: { name: 'TestPion', version: '1' }, entries } }) });
    await new Promise((r) => setTimeout(r, 1200));
    [...document.querySelectorAll('main [role=row][data-exchange]')].find((r) => r.textContent.includes('/api/patients/41'))?.click();
    await new Promise((r) => setTimeout(r, 800));
    if (document.querySelector('main [data-dock]')?.getAttribute('data-dock') !== 'summary') document.querySelector('[data-tool-rail] button[aria-label=Summary]')?.click();
    return true;
  })()`);
  await sleep(1500);
  await shot('debugger');
  await js(`window.aps.invoke('debug.clear').then(() => true)`);

  // Home again, now with the activity of all of the above: the dashboard
  await js(`__cap.nav('Home'); true`);
  await sleep(1500);
  await js(`document.querySelector('section[aria-label=Activity]')?.scrollIntoView({ block: 'start' }); true`);
  await sleep(800);
  await shot('home-activity');

  // a run's Charts tab (the test run from above)
  await js(`__cap.nav('Tests'); true`);
  await sleep(1200);
  await js(`(() => { const t = [...document.querySelectorAll('[role=tab]')].filter((x) => x.textContent.trim().startsWith('Runs')).pop(); t?.click(); return true; })()`);
  await sleep(1200);
  await js(`(() => { const r = [...document.querySelectorAll('main button')].find((b) => b.textContent.includes('All tests') && b.querySelector('.bg-ok, .bg-bad')); r?.click(); return true; })()`);
  await sleep(1500);
  await js(`(() => { const c = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.trim() === 'Charts'); c?.click(); return true; })()`);
  await sleep(1500);
  await shot('run-charts');
};
