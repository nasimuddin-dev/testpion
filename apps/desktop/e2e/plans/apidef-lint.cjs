// An API definition's Lint tab: the problems of the document with counts, a click shows the place in the editor,
// and a mistake typed into the definition appears in the tab a moment later.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'lint-tab-lists-the-notes',
    `(async () => {
      await __t.requests(); await __t.find('petstore.json'); await __t.sleep(800);
      await __t.tab('Lint');
      const rows = await __t.waitFor(() => { const r = [...document.querySelectorAll('main [data-api-lint] [data-lint-rule]')]; return r.length ? r : null; }, 6000);
      return 'rules: ' + (rows ?? []).map((r) => r.getAttribute('data-lint-rule')).join(',');
    })()`,
  ],
  [
    'a-row-opens-its-place',
    `(async () => {
      document.querySelector('main [data-api-lint] [data-lint-rule]').click();
      await __t.sleep(800);
      const tab = [...document.querySelectorAll('main [role=tab][aria-selected=true]')].map((t) => t.textContent.trim()).join(',');
      const sel = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent)?.getSelection();
      return 'tab: ' + tab + ' | line: ' + (sel?.startLineNumber ?? 0);
    })()`,
  ],
  [
    'preview-lists-the-operations',
    `(async () => {
      await __t.tab('Preview');
      const ops = await __t.waitFor(() => { const r = [...document.querySelectorAll('main [data-api-preview] [data-operation]')]; return r.length ? r : null; }, 6000);
      const tags = [...document.querySelectorAll('main [data-api-preview] h3')].map((h) => h.firstChild?.textContent?.trim()).join(',');
      return 'operations: ' + (ops ?? []).length + ' | tags: ' + tags;
    })()`,
  ],
  [
    'an-operation-opens-as-a-request',
    `(async () => {
      const row = document.querySelector('main [data-api-preview] [data-operation="GET /pet/{petId}"] button');
      row?.click(); await __t.sleep(300);
      const detail = row?.parentElement?.textContent ?? '';
      const params = /petId\\*/.test(detail) && /integer \\(int64\\)/.test(detail);
      [...(row?.parentElement?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Open as request')?.click();
      await __t.sleep(1200);
      const url = [...document.querySelectorAll('main input')].map((i) => i.value).find((v) => /\\/pet\\/\\{\\{petId\\}\\}$/.test(v));
      return 'params: ' + params + ' | opened: ' + !!url;
    })()`,
  ],
  [
    'generate-tests-from-the-preview',
    `(async () => {
      await __t.tab('Preview'); await __t.sleep(500);
      // the Generate tests menu: a test per operation
      [...document.querySelectorAll('main [data-api-preview] button')].find((b) => b.textContent.trim() === 'Generate tests')?.click();
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((b) => /A test per operation/.test(b.textContent)), 4000);
      item?.click();
      const ok = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Generate tests'), 4000);
      ok?.click();
      const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => /tests: review the example values|exists already/.test(t)), 6000);
      return 'toast: ' + !!toast;
    })()`,
  ],
  [
    'generate-flows-from-the-preview',
    `(async () => {
      // the same menu: integration flows (a flow per resource), which say the variables to set
      [...document.querySelectorAll('main [data-api-preview] button')].find((b) => b.textContent.trim() === 'Generate tests')?.click();
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((b) => /Integration flows/.test(b.textContent)), 4000);
      item?.click();
      const ok = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Generate flows'), 4000);
      ok?.click();
      const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent).find((t) => /flows, \\d+ steps.*must set \\{\\{baseUrl\\}\\}|exists already/.test(t)), 6000);
      return 'toast: ' + (toast ?? 'NONE').replace(/\\s+/g, ' ').slice(0, 120);
    })()`,
  ],
  [
    'fuzz-runs-and-summarises',
    `(async () => {
      await __t.requests(); await __t.find('petstore.json'); await __t.sleep(600);
      await __t.tab('Fuzz');
      const input = document.querySelector('main [data-api-fuzz] input[aria-label="Base URL"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://127.0.0.1:4010/api/v3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('main [data-api-fuzz] button')].find((b) => b.textContent.trim() === 'Fuzz')?.click();
      const sum = await __t.waitFor(() => document.querySelector('main [data-fuzz-summary]'), 60000);
      return 'summary: ' + (sum?.textContent ?? 'NONE').replace(/\\s+/g, ' ').trim().slice(0, 40);
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'generate-tests-from-the-preview': /^toast: true$/,
  'generate-flows-from-the-preview': /^toast: \d+ flows, \d+ steps/,
  'fuzz-runs-and-summarises': /^summary: \d+ requests to 16 operations:/,
  'preview-lists-the-operations': /^operations: 19 \| tags: pet,store,user$/,
  'an-operation-opens-as-a-request': /^params: true \| opened: true$/,
  'lint-tab-lists-the-notes': /^rules: component-unused,component-unused$/,
  // the selected tabs of the page (the editor tab, …) include Definition; the selection is on the problem's line
  'a-row-opens-its-place': /^tab: .*\bDefinition\b.* \| line: [1-9]\d+$/,
});
