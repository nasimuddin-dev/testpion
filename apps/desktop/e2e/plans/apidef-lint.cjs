// An API definition's Lint tab: the problems of the document with counts, a click shows the place in the editor,
// and a mistake typed into the definition appears in the tab a moment later.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'lint-tab-lists-the-notes',
    `(async () => {
      await __t.esc(); await __t.open('petstore.json'); await __t.sleep(800);
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
];

module.exports = withExpect(steps, {
  'preview-lists-the-operations': /^operations: 19 \| tags: pet,store,user$/,
  'an-operation-opens-as-a-request': /^params: true \| opened: true$/,
  'lint-tab-lists-the-notes': /^rules: component-unused,component-unused$/,
  'a-row-opens-its-place': /^tab: Definition \| line: [1-9]\d+$/,
});
