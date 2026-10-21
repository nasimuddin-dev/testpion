// Record a flow from the HTTP Debugger: a login (POST /auth/token → access_token), a request that sends the token
// (GET /patients with Authorization: Bearer …), a create (POST /jobs → id) and a read of what it created (GET
// /jobs/{id}) go through the proxy; the four rows are selected and "Create flow from 4 selected…" opens the dialog,
// which shows the values passed between the steps and takes the password from the environment that holds it; Create
// opens the flow in the designer with its steps and edges, and Run flow passes with a fresh token and a fresh job.
// Then the designer's empty state starts "Record a flow…": the Debugger records, Stop recording opens the dialog.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';
const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const send = (method, path, headers, body) => window.aps.invoke('debug.selfTest', { url: '${API}' + path, method, headers: { 'content-type': 'application/json', ...headers }, body });
  const rowOf = (text) => [...document.querySelectorAll('main [role=row]')].find((r) => r.textContent.includes(text));
  const dialog = () => document.querySelector('[data-create-flow-dialog]');
  const nodes = () => vis('[data-flow-designer] [data-flow-node]');
  const openMenu = (b) => { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); };
  const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(100)) { const v = await fn(); if (v) return v; } return undefined; };
`;
const step = stepOf(H);

const steps = [
  step(
    'traffic-through-the-proxy',
    `// the environment holds the password: the flow uses it by name, nothing written
     const ws = await window.aps.invoke('ws.current');
     const env = ws.environments.find((e) => e.name === 'Public APIs');
     await window.aps.invoke('env.save', { env: { ...env, variables: [...env.variables.filter((v) => v.key !== 'vetPassword'), { key: 'vetPassword', value: 'paws', enabled: true }] } });
     // an empty flow file for the last step (written before the Tests view first lists the files)
     await window.aps.invoke('tests.write', { path: 'rest/empty-recorded.yaml', content: 'name: Empty\\ntests: []\\n' });
     await __t.view('Debugger');
     await window.aps.invoke('debug.start', {});
     await window.aps.invoke('debug.clear');
     await __t.sleep(400);
     const login = await send('POST', '/auth/token', {}, JSON.stringify({ username: 'vet', password: 'paws' }));
     const token = JSON.parse(login.body).access_token;
     const list = await send('GET', '/patients', { authorization: 'Bearer ' + token });
     const job = await send('POST', '/jobs', {}, '{}');
     const id = JSON.parse(job.body).id;
     const read = await send('GET', '/jobs/' + id, {});
     const shown = await __t.waitFor(() => rowOf('/jobs/' + id) && rowOf('/auth/token') && rowOf('/patients'), 6000);
     return 'statuses: ' + [login, list, job, read].map((r) => r.status).join(',') + ' | rows: ' + !!shown;`,
  ),
  step(
    'select-and-create-from-the-row-menu',
    `// the rows are looked up again before each click: a selection re-renders them
     const find = (i) => i === 2 ? [...document.querySelectorAll('main [role=row]')].find((r) => /POST/.test(r.textContent) && /\\/jobs(?!\\/)/.test(r.textContent)) : rowOf(['/auth/token', '/patients', '', '/jobs/'][i]);
     if ([0, 1, 2, 3].some((i) => !find(i))) return 'NO ROWS';
     find(0).dispatchEvent(new MouseEvent('click', { bubbles: true })); await __t.sleep(200);
     for (const i of [1, 2, 3]) { find(i).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await __t.sleep(250); }
     const rows = [0, 1, 2, 3].map(find);
     const sel = rows.filter((r) => r.getAttribute('aria-selected') === 'true').length;
     const rr = rows[3].getBoundingClientRect();
     rows[3].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rr.left + 40, clientY: rr.top + 5 }));
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Create flow from 4 selected/.test(m.textContent.trim())), 3000);
     if (!item) return 'NO MENU ITEM: ' + [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).join(' / ');
     item.click();
     const d = await __t.waitFor(() => dialog(), 4000);
     if (!d) return 'NO DIALOG';
     const steps = await __t.waitFor(() => d.querySelectorAll('[data-flow-step]').length || null, 6000);
     return 'selected: ' + sel + ' | steps: ' + steps;`,
  ),
  step(
    'dialog-shows-the-links',
    `const d = dialog(); if (!d) return 'NO DIALOG';
     const envSel = d.querySelector('select[aria-label="Environment to propose variables for"]');
     setInput(envSel, 'Public APIs');
     const name = d.querySelector('input[aria-label="Flow file name"]');
     setInput(name, 'e2e recorded jobs');
     const ok = await __t.waitFor(() => /tests\\/recorded\\/e2e-recorded-jobs/.test(d.textContent) && /vetPassword/.test(d.textContent), 6000);
     const links = [...d.querySelectorAll('[data-flow-link]')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim());
     const token = links.some((l) => /\\{\\{accessToken\\}\\}\\s*from step 1\\s*\\(\\$\\.access_token\\)\\s*Authorization header in step 2/.test(l));
     const job = links.some((l) => /\\{\\{jobId\\}\\}\\s*from step 3\\s*\\(\\$\\.id\\)\\s*URL path in step 4/.test(l));
     const fromEnv = /\\{\\{vetPassword\\}\\}\\s*from Public APIs/.test(d.querySelector('[data-flow-variables]')?.textContent ?? '');
     return 'file: ' + !!ok + ' | token link: ' + token + ' | id link: ' + job + ' | password from environment: ' + fromEnv + (token && job ? '' : ' | ' + links.join(' / '));`,
  ),
  step(
    'create-opens-the-designer',
    `const b = document.querySelector('[data-create-flow]'); if (!b) return 'NO CREATE';
     b.click();
     const d = await __t.waitFor(() => document.querySelector('[data-flow-designer]') && nodes().length === 4, 10000);
     if (!d) return 'NO DESIGNER: ' + nodes().length;
     const edges = document.querySelectorAll('[data-flow-designer] [data-flow-edge]').length;
     const text = await window.aps.invoke('tests.read', { path: 'recorded/e2e-recorded-jobs.yaml' });
     return 'nodes: ' + nodes().map((n) => n.dataset.flowNode).join(',') + ' | edges: ' + edges + ' | no secret: ' + (!text.includes('paws') && !text.includes('demo-token')) + ' | bearer: ' + text.includes('Bearer {{accessToken}}') + ' | job url: ' + text.includes('/jobs/{{jobId}}');`,
  ),
  step(
    'run-passes',
    `if (!(await __t.button('Run flow'))) return 'NO RUN BUTTON';
     const done = await __t.waitFor(() => nodes().length === 4 && nodes().every((n) => ['passed', 'failed', 'error', 'skipped'].includes(n.dataset.status)) ? true : null, 60000);
     return 'statuses: ' + nodes().map((n) => n.dataset.status).join(',') + (done ? '' : ' (not finished)');`,
  ),
  step(
    'record-from-the-designer',
    `await __t.view('Tests'); await __t.sleep(600);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('empty-recorded.yaml')), 5000);
     if (!r) return 'NO ROW'; r.click(); await __t.sleep(1000);
     await __t.tab('Flow');
     const des = await __t.waitFor(() => document.querySelector('[data-flow-designer]'), 5000); if (!des) return 'NO DESIGNER';
     const rec = [...des.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Record from the Debugger'); if (!rec) return 'NO RECORD BUTTON';
     rec.click();
     const badge = await __t.waitFor(() => document.querySelector('main [data-recording-badge]'), 6000);
     if (!badge) return 'NO RECORDING BADGE';
     await __t.sleep(300);
     await send('GET', '/health', {});
     const counted = await until(() => /Recording · 1 exchange/.test(document.querySelector('main [data-recording-badge]')?.textContent ?? ''), 6000);
     const stop = [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Stop recording'); if (!stop) return 'NO STOP';
     stop.click();
     const d = await __t.waitFor(() => dialog(), 4000); if (!d) return 'NO DIALOG';
     const n = await __t.waitFor(() => d.querySelectorAll('[data-flow-step]').length || null, 6000);
     const url = d.querySelector('[data-flow-step]')?.textContent ?? '';
     await __t.esc();
     return 'badge: true | counted: ' + !!counted + ' | steps: ' + n + ' | health: ' + url.includes('{{baseUrl}}/health') + ' | badge gone: ' + !document.querySelector('main [data-recording-badge]');`,
  ),
];

module.exports = withExpect(steps, {
  'traffic-through-the-proxy': /^statuses: 200,200,201,200 \| rows: true$/,
  'select-and-create-from-the-row-menu': /^selected: \d \| steps: 4$/,
  'dialog-shows-the-links': /^file: true \| token link: true \| id link: true \| password from environment: true$/,
  'create-opens-the-designer': /^nodes: post-token,get-patients,post-jobs,get-jobs \| edges: [34] \| no secret: true \| bearer: true \| job url: true$/,
  'run-passes': /^statuses: passed,passed,passed,passed$/,
  'record-from-the-designer': /^badge: true \| counted: true \| steps: 1 \| health: true \| badge gone: true$/,
});
