// A JSON body is completed and checked against the API definition the request belongs to (specs/): opening "Add a
// pet" (POST {{petstore}}/pet) shows where the schema comes from, and the editor's JSON schema is set for the body.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const steps = [
  [
    'schema-from-the-spec',
    `(async () => {
      await __t.requests(); await __t.expand('Swagger Petstore (OpenAPI contract)');
      const row = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('Add a pet')), 4000);
      if (!row) return 'NO ROW';
      row.click(); await __t.sleep(1200);
      [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim() === 'Body')?.click();
      const note = await __t.waitFor(() => [...document.querySelectorAll('main div')].map((d) => d.textContent.trim()).find((t) => /^Schema from specs\\//.test(t)), 6000);
      const schemas = (window.__monaco?.languages.json.jsonDefaults.diagnosticsOptions.schemas ?? []).map((s) => s.uri);
      const forBody = schemas.some((u) => /body\\//.test(u));
      return 'note: ' + (note ?? 'NONE').slice(0, 60) + ' | body schema set: ' + forBody;
    })()`,
  ],
  [
    'a-wrong-field-is-marked',
    `(async () => {
      const ed = (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent);
      if (!ed) return 'NO EDITOR';
      const model = ed.getModel(); const text = model.getValue();
      model.setValue('{ "name": 42, "noSuchField": true }'); await __t.sleep(2500);
      const markers = window.__monaco.editor.getModelMarkers({ resource: model.uri }).map((m) => m.message);
      model.setValue(text); await __t.sleep(500);
      return 'markers: ' + markers.join(' ; ');
    })()`,
  ],
];

module.exports = withExpect(steps, {
  'schema-from-the-spec': /^note: Schema from specs\/petstore\.json · POST \/pet.* \| body schema set: true$/,
  'a-wrong-field-is-marked': /markers: .*(Incorrect type|Expected "string"|string)/i,
});
