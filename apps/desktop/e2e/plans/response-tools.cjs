// The response body's JSONPath filter suggests the response's own paths (arrays as [*]), counts the matches and says
// why a path is wrong; Diff vs previous compares a response with the request's previous one (field by field).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const filter = () => vis('main input[aria-label="Filter with JSONPath"]')[0];
  const count = () => vis('main [data-filter-count]')[0]?.textContent.trim() ?? 'NONE';
  const send = async (url) => {
    const u = vis('main input[aria-label="Request URL"]')[0]; if (!u) return 'NO INPUT url';
    setVal(u, url); await __t.sleep(300);
    vis('main button').find((b) => b.textContent.trim() === 'Send')?.click(); await __t.sleep(1500); // (the demo server answers at once)
    return (await __t.waitFor(() => filter(), 8000)) ? 'ok' : 'NO RESPONSE';
  };
`;
const s = (name, body) => step(name, body, true, { extra: H });

const steps = [
  s(
    'first-response',
    `await __t.newTab('HTTP request');
     const r = await send('http://127.0.0.1:4010/echo?n=1&tag=a'); if (r !== 'ok') return r;
     return 'filter: ' + !!filter();`,
  ),
  s(
    'suggests-paths',
    `await __t.real.click(filter()); await __t.real.type('$.qu'); await __t.sleep(300);
     const opts = vis('[role=listbox] [role=option]').map((o) => o.textContent.trim());
     await __t.real.key('Enter'); await __t.sleep(500);
     return 'options: ' + opts.slice(0, 3).join(', ') + ' | value: ' + filter().value + ' | ' + count();`,
  ),
  s(
    'word-finds-key',
    `setVal(filter(), ''); await __t.sleep(200); await __t.real.click(filter()); await __t.real.type('tag'); await __t.sleep(300);
     const first = vis('[role=listbox] [role=option]')[0]?.textContent.trim();
     await __t.real.key('Enter'); await __t.sleep(500);
     return 'first: ' + first + ' | value: ' + filter().value + ' | ' + count();`,
  ),
  s(
    'invalid-path',
    `setVal(filter(), '$.query['); await __t.sleep(500);
     const bad = count();
     await __t.real.click(filter()); await __t.real.key('Escape'); await __t.real.key('Escape'); await __t.sleep(400);
     return bad + ' | cleared: ' + (filter().value === '');`,
  ),
  s(
    'diff-vs-previous',
    `const r = await send('http://127.0.0.1:4010/echo?n=2&tag=a'); if (r !== 'ok') return r;
     await __t.sleep(500);
     if (!(await __t.responseAction('Diff vs previous'))) return 'NO ACTION';
     const panel = await __t.waitFor(() => vis('main [data-response-diff]')[0], 4000); if (!panel) return 'NO DIFF';
     const changes = [...panel.querySelectorAll('section')][0]?.innerText.replace(/\\s+/g, ' ').trim() ?? '';
     return short(changes, 160);`,
  ),
  s(
    'diff-closes',
    `vis('main button[aria-label="Close the diff"]')[0]?.click(); await __t.sleep(400);
     return 'diff shown: ' + !!vis('main [data-response-diff]')[0] + ' | body shown: ' + !!filter();`,
  ),
];

module.exports = withExpect(steps, {
  'first-response': /^filter: true$/,
  'suggests-paths': /^options: \$\.query, \$\.query\.n, \$\.query\.tag \| value: \$\.query \| 1 match$/,
  'word-finds-key': /^first: \$\.query\.tag \| value: \$\.query\.tag \| 1 match$/,
  'invalid-path': /^Not a valid JSONPath: “\]” is missing \| cleared: true$/,
  'diff-vs-previous': /^Body ~ changed \$\.query\.n "1" → "2"/,
  'diff-closes': /^diff shown: false \| body shown: true$/,
});
