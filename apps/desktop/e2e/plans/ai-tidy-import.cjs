// AI-10 · Tidy this import, with real input: right-click an imported collection ▸ "Tidy with AI…", the dialog (the
// estimate before anything is sent; no token is in the context), Tidy (a scripted offline model names the requests,
// puts them in a folder and names the host variable, plus an invented request), the review (separate changes, each
// verified: the collection stays valid and every request sends exactly what it sent; the model's extra drop is
// unticked), Apply (hosts and tokens become variables, the id is chained by a tp.* script, tracking requests are gone),
// then Undo puts the collection back exactly.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const HOST = 'https://api.shop.example.com';
const TOKEN = 'tok-e2e-abc-1234567890';
const AUTH = [{ key: 'Authorization', value: `Bearer ${TOKEN}` }];
const ex = (status, body) => ({ id: `ex-${status}`, name: `Captured ${status}`, status, headers: [], body: JSON.stringify(body) });
const PLAN = {
  summary: 'Orders get names and a folder; the host and token become variables; the order id is chained.',
  assumptions: ['The order id is returned by Create order in $.id'],
  requests: [
    { id: 'e2e-create', name: 'Create order', folder: 'Orders' },
    { id: 'e2e-get', name: 'Get order', folder: 'Orders' },
    { id: 'e2e-ghost', name: 'Invented', folder: 'Nowhere' },
  ],
  hosts: [{ origin: HOST, variable: 'apiUrl' }],
  drop: [{ id: 'e2e-users', reason: 'looks like noise to me' }],
};

function prepare(ws) {
  writeFileSync(
    join(ws, 'collections', 'e2e-har.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-har',
        name: 'E2E HAR import',
        version: 1,
        updatedAt: new Date().toISOString(),
        variables: [],
        items: [
          { kind: 'http', id: 'e2e-create', name: `${HOST}/orders`, request: { method: 'POST', url: `${HOST}/orders`, headers: AUTH, body: { type: 'json', content: '{"item":"shelf"}' } }, examples: [ex(201, { id: 'ord-77' })] },
          { kind: 'http', id: 'e2e-get', name: 'GET /orders/ord-77', request: { method: 'GET', url: `${HOST}/orders/ord-77`, headers: AUTH } },
          { kind: 'http', id: 'e2e-delete', name: 'DELETE /orders/ord-77', request: { method: 'DELETE', url: `${HOST}/orders/ord-77`, headers: AUTH } },
          { kind: 'http', id: 'e2e-ga', name: 'GET analytics', request: { method: 'GET', url: 'https://www.google-analytics.com/collect' } },
          { kind: 'http', id: 'e2e-users', name: 'GET /users', request: { method: 'GET', url: `${HOST}/users` } },
        ],
      },
      null,
      2,
    ),
  );
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([{ match: '"origins"', response: JSON.stringify(PLAN) }, ...JSON.parse(rules.value)]);
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const dlg = () => document.querySelector('[data-tidy-import-dialog]');
  const review = () => document.querySelector('[data-proposal-body]');
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const col = () => window.aps.invoke('col.get', { id: 'e2e-har' });
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'right-click-collection',
    `await __t.requests();
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.offsetParent && r.textContent.includes('E2E HAR import')), 4000); if (!row) return 'NO ROW';
     row.scrollIntoView({ block: 'center' }); await __t.sleep(200); await __t.real.rightClick(row);
     const aiMenu = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'AI'), 3000); if (!aiMenu) return 'NO AI submenu'; await __t.real.click(aiMenu);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Tidy with AI…'), 3000); if (!item) return 'NO MENU item';
     await __t.real.click(item);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const est = await __t.waitFor(() => /tokens in/.test(d.querySelector('[data-tidy-estimate]')?.textContent ?? '') && d.querySelector('[data-tidy-estimate]'), 10000);
     return 'collection: ' + d.textContent.includes('E2E HAR import') + ' | estimate: ' + /Offline demo model · demo \\(on this computer\\) · ≈ [\\d,]+ tokens in/.test(est?.textContent ?? '');`,
  ),
  step(
    'tidy-and-review',
    `await __t.real.click(dlg().closest('[role=dialog]').querySelector('[data-tidy-generate]'));
     const r = await __t.waitFor(() => review()?.querySelector('[data-proposal-item]') && review(), 20000); if (!r) return 'NO REVIEW ' + short(dlg()?.querySelector('[role=alert]')?.textContent, 200);
     await __t.sleep(300);
     const items = [...r.querySelectorAll('[data-proposal-item]')];
     const ticked = items.filter((i) => i.querySelector('input[type=checkbox]')?.checked).length;
     const fails = r.querySelectorAll('[data-verification="fail"]').length;
     const notes = r.querySelector('[data-proposal-notes]')?.textContent ?? '';
     return 'changes: ' + items.length + ' | ticked: ' + ticked + ' | failed checks: ' + fails + ' | invented skipped: ' + /e2e-ghost/.test(notes) + ' | titles: ' + items.map((i) => short(i.textContent, 28)).join(' ; ').slice(0, 220);`,
  ),
  step(
    'apply',
    `await __t.real.click(review().closest('[role=dialog]').querySelector('[data-proposal-accept]'));
     const t = await __t.waitFor(() => toastText(/Applied \\d+ changes? to E2E HAR import/), 8000); if (!t) return 'NO TOAST';
     const c = await col();
     const vars = Object.fromEntries(c.variables.map((v) => [v.key, v.value]));
     const flat = (n) => (n.kind === 'folder' ? n.items.flatMap(flat) : [n]);
     const reqs = c.items.flatMap(flat);
     const get = reqs.find((r) => r.id === 'e2e-get');
     const create = reqs.find((r) => r.id === 'e2e-create');
     return 'vars: ' + Object.keys(vars).sort().join(',') + ' | url: ' + get?.request.url + ' | header: ' + get?.request.headers[0].value + ' | folder: ' + c.items.map((n) => n.name).join(',') + ' | script: ' + /tp\\.variables\\.set\\('orderId'/.test(create?.testScript ?? '') + ' | analytics gone: ' + !reqs.some((r) => r.id === 'e2e-ga') + ' | users kept: ' + reqs.some((r) => r.id === 'e2e-users');`,
  ),
  step(
    'undo-puts-it-back',
    `const b = [...document.querySelectorAll('[data-sonner-toast] button')].find((x) => x.textContent.trim() === 'Undo'); if (!b) return 'NO UNDO';
     const outside = [...document.querySelectorAll('[data-sonner-toast]')].some((t) => /changed outside TestPion/.test(t.textContent));
     await __t.real.click(b); await __t.sleep(1200);
     const c = await col();
     const flat = (n) => (n.kind === 'folder' ? n.items.flatMap(flat) : [n]);
     const get = c.items.flatMap(flat).find((r) => r.id === 'e2e-get');
     return 'vars: ' + c.variables.length + ' | url: ' + get?.request.url + ' | top-level: ' + c.items.length + ' | reported as an outside change: ' + outside;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'right-click-collection': /^collection: true \| estimate: true$/,
    'tidy-and-review': /^changes: [4-9] \| ticked: [3-8] \| failed checks: 0 \| invented skipped: true \| titles: /,
    apply: new RegExp(`^vars: apiUrl,orderId,token \\| url: \\{\\{apiUrl\\}\\}/orders/\\{\\{orderId\\}\\} \\| header: Bearer \\{\\{token\\}\\} \\| folder: .*Orders.* \\| script: true \\| analytics gone: true \\| users kept: true$`),
    'undo-puts-it-back': new RegExp(`^vars: 0 \\| url: ${HOST.replace(/[.]/g, '\\.').replace(/\//g, '\\/')}\\/orders\\/ord-77 \\| top-level: 5 \\| reported as an outside change: false$`),
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
