// AI-4 · Tests from a spec, driven by the gaps, with real input: open an API definition, "Generate tests from this
// spec…" in its header (the dialog on "From a spec": the gap report with what is never tested, the estimate before
// anything is sent), Generate (a scripted offline model adds a case, an invented endpoint and a request that breaks the
// document), the review (a test file with its verification, the invented operation dropped and said so, the coverage
// before → after), Write the tests (the file appears under tests/ with Undo). The explorer's spec menu offers the same
// item, and "Use the tests TestPion builds without AI" is there when no model answers.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const SPEC = `openapi: 3.0.3
info: { title: E2E Shop, version: 1.0.0 }
servers: [{ url: http://127.0.0.1:4010 }]
security: [{ bearer: [] }]
paths:
  /health:
    get:
      operationId: health
      summary: Health
      security: []
      responses:
        '200': { description: Up }
  /orders:
    post:
      operationId: createOrder
      summary: Create an order
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [item, qty]
              properties:
                item: { type: string, minLength: 1, maxLength: 50 }
                qty: { type: integer, minimum: 1, maximum: 10 }
      responses:
        '201': { description: Created }
        '422': { description: Rejected }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
`;
const TESTS = `defaults: { type: http }
tests:
  - { id: health, name: Health, method: GET, url: "{{baseUrl}}/health", assertions: [{ type: status, expected: 200 }, { type: openapi, spec: specs/e2e-shop.yaml }] }
`;
const PLAN = {
  summary: 'Quantity limits.',
  assumptions: ['qty 0 is refused with 422'],
  cases: [
    { operation: 'POST /orders', category: 'negative', name: 'Quantity zero is refused', expectStatus: 422, bodyPatch: [{ field: 'qty', value: 0 }] },
    { operation: 'POST /invoices', category: 'negative', name: 'Invented endpoint', expectStatus: 400 },
    { operation: 'POST /orders', category: 'positive', name: 'Quantity 99 is created', expectStatus: 201, bodyPatch: [{ field: 'qty', value: 99 }] },
  ],
};

function prepare(ws) {
  mkdirSync(join(ws, 'specs'), { recursive: true });
  mkdirSync(join(ws, 'tests', 'smoke'), { recursive: true });
  writeFileSync(join(ws, 'specs', 'e2e-shop.yaml'), SPEC);
  writeFileSync(join(ws, 'tests', 'smoke', 'e2e-shop.yaml'), TESTS);
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([{ match: '"operations"', response: JSON.stringify(PLAN) }, ...JSON.parse(rules.value)]);
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const dlg = () => document.querySelector('[data-flow-generate-dialog]');
  const review = () => document.querySelector('[data-proposal-body]');
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'open-from-the-api-definition',
    `await __t.requests(); await __t.find('e2e-shop.yaml'); await __t.sleep(1000);
     const b = await __t.waitFor(() => document.querySelector('main [data-generate-spec-tests]'), 5000); if (!b) return 'NO BUTTON Generate tests from this spec';
     await __t.real.click(b);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const gaps = await __t.waitFor(() => d.querySelector('[data-spec-gaps]')?.textContent.includes('open gaps') && d.querySelector('[data-spec-gaps]'), 8000); if (!gaps) return 'NO GAPS ' + short(d.querySelector('[data-spec-gaps]')?.textContent, 120);
     const est = await __t.waitFor(() => /tokens in/.test(d.querySelector('[data-flow-estimate]')?.textContent ?? '') && d.querySelector('[data-flow-estimate]'), 10000);
     const mode = [...d.querySelectorAll('[role=radio]')].map((x) => x.textContent.trim() + (x.getAttribute('aria-checked') === 'true' ? '*' : '')).slice(0, 3).join(' / ');
     return 'mode: ' + mode + ' | spec: ' + d.querySelector('select[aria-label="API definition"]')?.value + ' | gaps: ' + short(gaps.textContent, 150) + ' | estimate: ' + /≈ [\\d,]+ tokens in/.test(est?.textContent ?? '');`,
  ),
  step(
    'generate-and-review',
    `const g = dlg()?.closest('[role=dialog]')?.querySelector('[data-flow-generate]'); if (!g) return 'NO BUTTON Generate';
     await __t.real.click(g);
     const r = await __t.waitFor(() => review()?.querySelector('[data-proposal-item]') && review(), 20000); if (!r) return 'NO REVIEW ' + short(dlg()?.querySelector('[role=alert]')?.textContent, 200);
     await __t.sleep(300);
     const badges = [...r.querySelectorAll('[data-verification]')].map((b) => b.getAttribute('data-verifier') + '=' + b.getAttribute('data-verification')).join(',');
     const notes = r.querySelector('[data-proposal-notes]')?.textContent ?? '';
     return 'items: ' + r.querySelectorAll('[data-proposal-item]').length + ' | badges: ' + badges + ' | invented dropped: ' + /POST \\/invoices is not an operation/.test(notes) + ' | invalid dropped: ' + /Quantity 99 is created/.test(notes) + ' | coverage: ' + /Coverage of the document: [\\d.]+% → [\\d.]+%/.test(r.textContent);`,
  ),
  step(
    'write-the-tests',
    `await __t.real.click(review().closest('[role=dialog]').querySelector('[data-proposal-accept]'));
     const t = await __t.waitFor(() => toastText(/Wrote 1 test file/), 8000); if (!t) return 'NO TOAST';
     const path = /tests\\/([^)]+)\\)/.exec(t)?.[1];
     const text = await window.aps.invoke('tests.read', { path }).catch((e) => 'ERR ' + e.message);
     return 'toast: ' + short(t, 70) + ' | file: ' + /^# AI-generated by TestPion/.test(text) + ',' + /Quantity zero is refused/.test(text) + ',' + !/invoices/.test(text) + ',' + /type: openapi/.test(text);`,
  ),
  step(
    'explorer-menu-has-the-item',
    `await __t.requests();
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.offsetParent && r.textContent.includes('e2e-shop.yaml')), 5000); if (!row) return 'NO ROW e2e-shop.yaml';
     await __t.real.rightClick(row);
     const aiMenu = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'AI'), 3000); if (!aiMenu) return 'NO AI submenu'; await __t.real.click(aiMenu);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Generate tests from this spec…'), 3000); if (!item) return 'NO MENU item';
     await __t.real.click(item);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const title = d.closest('[role=dialog]').textContent.includes('Generate tests from a spec with AI');
     await __t.esc(); await __t.sleep(300);
     return 'title: ' + title + ' | closed: ' + !dlg();`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'open-from-the-api-definition': /^mode: From a collection or folder \/ Describe in words \/ From a spec\* \| spec: specs\/e2e-shop\.yaml \| gaps: .*of 2 operations called.*open gaps.* \| estimate: true$/,
    'generate-and-review': /^items: 1 \| badges: test-file=pass,spec-tests=(pass|warn) \| invented dropped: true \| invalid dropped: true \| coverage: true$/,
    'write-the-tests': /^toast: Wrote 1 test file \(tests\/e2e-shop\/default-gaps\.yaml\).* \| file: true,true,true,true$/,
    'explorer-menu-has-the-item': /^title: true \| closed: true$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
