// The JSONPath filter in a trace's payload panes, with the inputs people type: a match that is an object or a list
// opens to show its fields (it used to stay folded as `0: {3}`, which looked as if the filter did nothing).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const type = (el, value) =>
  `{ const el_ = ${el}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el_, ${JSON.stringify(value)}); el_.dispatchEvent(new Event('input', { bubbles: true })); }`;
const TRIES = ['$..message', '$.errors', '$.errors[0]', 'errors', '$.errors[*].message', '$.errors[0].path', 'errors[0].message'];

const steps = [
  [
    'serve',
    `main: const http = require('http'); await new Promise((r) => http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ errors: [{ message: 'Cannot query field "patient"', locations: [{ line: 1, column: 3 }], path: ['patient'] }] })); }).listen(18765, '127.0.0.1', r)); return 'serving';`,
    false,
  ],
  step(
    'open-a-trace',
    `await window.aps.invoke('http.send', { request: { method: 'POST', url: 'http://127.0.0.1:18765/graphql', headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], body: { type: 'json', content: '{"query":"{ patient { id } }"}' } } });
     await __t.view('Traces');
     const row = await __t.waitFor(() => vis('main *').find((x) => x.children.length === 0 && x.textContent.includes('127.0.0.1:18765/graphql')), 10000);
     row?.click(); await __t.sleep(800);
     tab('Payload')?.click(); await __t.sleep(600);
     return 'filters: ' + vis('main input[aria-label="Filter with JSONPath"]').length;`,
  ),
  ...TRIES.map((t, n) =>
    step(
      `try-${n}`,
      `const inputs = vis('main input[aria-label="Filter with JSONPath"]'); const i = inputs[inputs.length - 1];
       ${type('i', t)}
       await __t.sleep(500);
       return 'value: ' + i.value + ' | ' + short(i.closest('.h-full')?.innerText, 300);`,
    ),
  ),
  step(
    'json-in-a-text-value-opens-as-a-tree',
    `tab('Output')?.click(); await __t.sleep(600);
     const rows = () => vis('main .mono .leading-5');
     const body = rows().find((r) => /"body"/.test(r.textContent));
     if (!body) return 'NO BODY ROW: ' + short(vis('main')[0]?.innerText, 200);
     const badge = /JSON in text/.test(body.textContent);
     body.querySelector('button[aria-label=Expand]')?.click(); await __t.sleep(400);
     const inside = rows().filter((r) => /"errors"|"message"/.test(r.textContent)).length;
     return 'badge: ' + badge + ' | rows inside the text: ' + inside;`,
  ),
];
module.exports = withExpect(steps, {
  'json-in-a-text-value-opens-as-a-tree': /^badge: true \| rows inside the text: [1-9]/,
  'open-a-trace': /^filters: 2$/,
  'try-0': /1 match .*"Cannot query field "patient""/,
  'try-1': /1 match .*"message" : "Cannot query field/,
  'try-2': /1 match .*"message" : "Cannot query field .*"path" : \[ 0 : "patient" \]/,
  'try-3': /1 match .*"message" : "Cannot query field/,
  'try-4': /1 match .*"Cannot query field "patient""/,
  'try-5': /1 match .*\[ 0 : "patient" \]/,
  'try-6': /1 match .*"Cannot query field "patient""/,
});
