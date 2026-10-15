// WF-19 One tab model: saved load tests open as tabs like every editor — a click in the list opens a preview tab (in
// italics) that the next click replaces, a double-click keeps it, each tab keeps its own edits, and Evaluations has
// the same strip.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  mkdirSync(join(ws, 'library'), { recursive: true });
  const item = (id, name, url) => ({ id, name, data: { kind: 'http', method: 'GET', url, headers: [], vus: 2, duration: 5 } });
  writeFileSync(
    join(ws, 'library', 'load-tests.json'),
    JSON.stringify({ folders: [], items: [item('lt-a', 'E2E load A', 'http://127.0.0.1:4010/health?a'), item('lt-b', 'E2E load B', 'http://127.0.0.1:4010/health?b')] }, null, 2),
  );
}

const H = `
  const strip = () => [...document.querySelectorAll('[role=tablist][aria-label="Open load tests"] [role=tab]')];
  const names = () => strip().map((t) => t.textContent.trim() + (t.hasAttribute('data-preview') ? '(preview)' : '')).join(', ');
  const item = (n) => [...document.querySelectorAll('[data-tree-row]')].find((r) => r.getAttribute('aria-label') === n);
  const url = () => [...document.querySelectorAll('main input')].find((i) => /4010\\/health/.test(i.value))?.value;
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
`;

const steps = [
  step(
    'preview-replaced',
    `${H}
     await __t.view('Load'); await __t.sleep(800);
     const a = await __t.waitFor(() => item('E2E load A'), 4000); if (!a) return 'NO ITEM';
     a.click(); await __t.sleep(600);
     const first = names();
     item('E2E load B').click(); await __t.sleep(600);
     return first + ' → ' + names();`,
  ),
  step(
    'double-click-keeps',
    `${H}
     const t = strip().find((x) => /E2E load B/.test(x.textContent)); if (!t) return 'NO TAB';
     t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await __t.sleep(400);
     item('E2E load A').click(); await __t.sleep(600);
     return names();`,
  ),
  step(
    'each-tab-its-own-edits',
    `${H}
     const b = strip().find((x) => /E2E load B/.test(x.textContent)); b.click(); await __t.sleep(500);
     const input = [...document.querySelectorAll('main input')].find((i) => /4010\\/health/.test(i.value)); if (!input) return 'NO URL FIELD';
     setVal(input, 'http://127.0.0.1:4010/health?edited'); await __t.sleep(400);
     strip().find((x) => /E2E load A/.test(x.textContent)).click(); await __t.sleep(500);
     const inA = url();
     strip().find((x) => /E2E load B/.test(x.textContent)).click(); await __t.sleep(500);
     return 'A: ' + inA + ' | B: ' + url();`,
  ),
  step(
    'evaluations-has-tabs',
    `await __t.view('Evaluations'); await __t.sleep(800);
     return 'strip: ' + !!document.querySelector('[role=tablist][aria-label="Open evaluations"]');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'preview-replaced': /^E2E load A\(preview\) → E2E load B\(preview\)$/,
    'double-click-keeps': /^E2E load B, E2E load A\(preview\)$/,
    'each-tab-its-own-edits': /^A: http:\/\/127\.0\.0\.1:4010\/health\?a \| B: http:\/\/127\.0\.0\.1:4010\/health\?edited$/,
    'evaluations-has-tabs': /^strip: true$/,
  },
  { prepare },
);
