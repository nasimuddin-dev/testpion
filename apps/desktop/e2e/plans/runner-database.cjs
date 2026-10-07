// The Collection Runner's "Database…" source: the button asks for a PostgreSQL / MySQL URL and the runner previews it.
// No database server runs in the suite, so the step points at a closed port and expects the connection error,
// explained once in a toast (the path from the button through the prompt to the backend's dataset reader).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step(
    'open-the-runner',
    `await __t.esc(); await __t.requests(); await __t.open('GET with query parameters');
     vis('nav[aria-label="Where this request is saved"] button')[0]?.click(); await __t.sleep(1500);
     await __t.tab('Run'); await __t.sleep(600);
     const db = vis('main button').find((b) => b.textContent.trim() === 'Database…');
     return 'database button: ' + !!db + ' | icon: ' + !!db?.querySelector('svg');`,
  ),
  step(
    'a-closed-port-is-explained',
    `vis('main button').find((b) => b.textContent.trim() === 'Database…').click();
     const input = await __t.waitFor(() => vis('[role=dialog] input')[0], 4000);
     setInput(input, 'postgres://app:secret@127.0.0.1:1/shop'); await __t.sleep(100);
     vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Connect')?.click();
     const toast = await __t.waitFor(() => vis('[data-sonner-toast]').map((t) => t.textContent).find((t) => /PostgreSQL dataset/.test(t)), 20000);
     return 'toast: ' + /could not connect/.test(toast ?? '') + ' | password shown: ' + /secret/.test(toast ?? '') + ' | dialog gone: ' + !vis('[role=dialog]').length;`,
  ),
  step(
    'generate-test-data',
    `vis('main button').find((b) => b.textContent.trim() === 'Generate…')?.click();
     const dlg = await __t.waitFor(() => vis('[role=dialog] [data-generate-data]')[0], 4000);
     if (!dlg) return 'NO DIALOG';
     vis('[role=dialog] button').find((b) => b.textContent.trim() === 'From a JSON schema')?.click(); await __t.sleep(200);
     setInput(vis('[role=dialog] input[aria-label="Dataset name"]')[0], 'e2e-generated-' + Date.now()); await __t.sleep(100);
     vis('[role=dialog] button').find((b) => b.textContent.trim() === 'Generate')?.click();
     const shown = await __t.waitFor(() => vis('main *').find((x) => x.children.length === 0 && /e2e-generated-\\d+\\.csv/.test(x.textContent)), 8000);
     return 'dialog closed: ' + !vis('[role=dialog]').length + ' | data: ' + !!shown;`,
  ),
];

module.exports = withExpect(steps, {
  'generate-test-data': /^dialog closed: true \| data: true$/,
  'open-the-runner': /^database button: true \| icon: true$/,
  'a-closed-port-is-explained': /^toast: true \| password shown: false \| dialog gone: true$/,
});
