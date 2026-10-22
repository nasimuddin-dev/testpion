// A request whose test script calls tp.visualizer.set with a malicious Handlebars template (the shapes of the Handlebars advisories:
// the Function-constructor chain, prototype lookups, process access) cannot touch the app: the template is rendered inside the
// script sandbox, so the canary in the app's environment never shows, the app keeps working, and an ordinary template still
// renders, with its values escaped.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const CANARY = 'canary-7f3a91-do-not-leak';

const H = `
  const send = (testScript) => window.aps.invoke('http.send', { name: 'viz', request: { method: 'GET', url: 'http://127.0.0.1:4010/health' }, testScript });
`;
const s = (name, body, shot = false) => step(name, body, shot, { extra: H });

const MALICIOUS = [
  `{{#with "s" as |string|}}{{#with "e"}}{{#with split as |conslist|}}{{this.pop}}{{this.push (lookup string.sub "constructor")}}{{this.pop}}{{#with string.split as |codelist|}}{{this.pop}}{{this.push "return process.env.TP_E2E_CANARY;"}}{{this.pop}}{{#each conslist}}{{#with (string.sub.apply 0 codelist)}}{{this}}{{/with}}{{/each}}{{/with}}{{/with}}{{/with}}{{/with}}`,
  `{{lookup (lookup this "__proto__") "constructor"}}{{process.env.TP_E2E_CANARY}}`,
];

const steps = [
  s(
    'malicious-templates-render-nothing-from-the-app',
    `const out = [];
     for (const t of ${JSON.stringify(MALICIOUS)}) {
       const r = await send('tp.visualizer.set(' + JSON.stringify(t) + ', { a: 1 });');
       const html = (r.visualizer && r.visualizer.html) || '';
       const err = (r.visualizer && r.visualizer.error) || '';
       out.push(html.includes(${JSON.stringify(CANARY)}) || err.includes(${JSON.stringify(CANARY)}) ? 'LEAK' : 'safe');
     }
     return out.join(',');`,
  ),
  s(
    'an-ordinary-template-still-renders-escaped',
    `const r = await send('tp.visualizer.set("<b>{{who}}</b>", { who: "<img src=x onerror=alert(1)>" });');
     return 'html: ' + ((r.visualizer && r.visualizer.html) || '').replace(/&#x3D;/g, '=');`,
  ),
  s(
    'the-app-is-intact',
    `const info = await window.aps.invoke('app.info', {});
     await __t.sleep(300);
     return 'info: ' + (info && info.appVersion ? 'ok' : 'NO') + ' | window: ' + (document.querySelector('#root') && document.querySelector('#root').children.length > 0 ? 'drawn' : 'EMPTY') + ' | process in page: ' + typeof process;`,
    true,
  ),
];

module.exports = withExpect(
  steps,
  {
    'malicious-templates-render-nothing-from-the-app': /^safe,safe$/,
    'an-ordinary-template-still-renders-escaped': /^html: <b>&lt;img src=x onerror=alert\(1\)&gt;<\/b>$/,
    'the-app-is-intact': /^info: ok \| window: drawn \| process in page: undefined$/,
  },
  { env: { TP_E2E_CANARY: CANARY } },
);
