// Arazzo 1.0 in and out: Import ▸ Choose file… with an Arazzo document writes a flow file under tests/arazzo/ (its
// OpenAPI source found in specs/), the Tests tree shows it, its menu's Export as Arazzo… saves the workflow back
// (the save dialog answered by E2E_STUB_SAVE), and the export maps the steps to the same operations.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

const ARAZZO = `arazzo: 1.0.1
info: { title: Pet check, version: 1.0.0 }
sourceDescriptions:
  - { name: petstore, url: petstore.json, type: openapi }
workflows:
  - workflowId: petCheck
    inputs: { type: object, properties: { petId: { type: string, default: '1' } } }
    steps:
      - stepId: getPet
        operationId: getPetById
        parameters: [{ name: petId, in: path, value: $inputs.petId }]
        successCriteria: [{ condition: $statusCode == 200 }]
        outputs: { name: $response.body#/name }
      - stepId: again
        operationPath: '{$sourceDescriptions.petstore.url}#/paths/~1pet~1{petId}/get'
        parameters: [{ name: petId, in: path, value: $inputs.petId }]
        successCriteria: [{ condition: "$response.body#/name == 'doggie'" }]
        onSuccess: [{ name: back, type: goto, stepId: getPet }]
`;

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const row = (name) => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name));
  const openMenu = async (name) => { await __t.esc(); const r = row(name); if (!r) return false; r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); return !!(await __t.waitFor(() => document.querySelector('[role=menu]'), 2000)); };
  const menuItem = (label) => vis('[role=menuitem]').find((m) => m.textContent.trim() === label);
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'import',
    `const orig = HTMLInputElement.prototype.click;
     HTMLInputElement.prototype.click = function () {
       if (this.type !== 'file') return orig.call(this);
       HTMLInputElement.prototype.click = orig;
       Object.defineProperty(this, 'files', { value: [new File([${JSON.stringify(ARAZZO)}], 'pet-check.arazzo.yaml', { type: 'text/plain' })], configurable: true });
       this.dispatchEvent(new Event('change'));
     };
     await __t.requests();
     document.querySelector('[aria-label^="Import (OpenAPI"]').click();
     const btn = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Choose file…'), 3000);
     if (!btn) return 'NO BUTTON';
     btn.click();
     const t = await __t.waitFor(() => toastText(/Imported arazzo/), 5000);
     await __t.esc();
     const text = await window.aps.invoke('tests.read', { path: 'arazzo/petcheck.yaml' });
     return (t ?? 'no toast') + ' || ' + text.split(/\\r?\\n/).filter((l) => /url:|method:|# Arazzo, not imported/.test(l)).map((l) => l.trim()).join(' ; ');`,
  ),
  step(
    'tree-menu',
    `await __t.view('Tests'); await __t.sleep(1000); if (!(await openMenu('petcheck.yaml'))) return 'NO ROW OR MENU'; return vis('[role=menuitem]').map((m) => m.textContent.trim()).join(' | ');`,
  ),
  step('export', `menuItem('Export as Arazzo…')?.click(); const t = await __t.waitFor(() => toastText(/Arazzo workflow/), 5000); return t ?? 'no toast';`),
  step(
    'export-maps-operations',
    `const r = await window.aps.invoke('tests.exportArazzo', { path: 'arazzo/petcheck.yaml' });
     const w = r.document.workflows[0];
     return [w.workflowId, ...w.steps.map((s) => s.stepId + ':' + (s.operationId ?? s.operationPath) + ':' + (s.parameters ?? []).map((p) => p.in + ' ' + p.name + '=' + p.value).join(',') + ':' + (s.successCriteria ?? []).map((c) => c.condition).join(','))].join(' | ');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    import:
      /Imported arazzo: flow tests\/arazzo\/petcheck\.yaml.*\|\| method: GET ; url: "\{\{baseUrl\}\}\/pet\/\{\{petId\}\}" ; # Arazzo, not imported: on success goto getPet .* method: GET ; url: "\{\{baseUrl\}\}\/pet\/\{\{petId\}\}"/,
    'tree-menu': /Open \| Run \| Expose as MCP tool… \| Export as Arazzo… \| Rename/,
    export: /Arazzo workflow saved to .*petcheck\.arazzo\.yaml/,
    'export-maps-operations': /^petCheck \| getPet:getPetById:path petId=\$inputs\.petId:\$statusCode == 200 \| again:getPetById:path petId=\$inputs\.petId:\$response\.body#\/name == 'doggie'$/,
  },
  { env: (out) => ({ E2E_STUB_SAVE: join(out, 'petcheck.arazzo.yaml') }) },
);
