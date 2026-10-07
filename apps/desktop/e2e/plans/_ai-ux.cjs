// Not part of the suite (the _ prefix): what a person sees of the AI features before a key is set — screenshots of
// the Providers tab, a Playground run on OpenAI without a key, and the assistant set to OpenAI without a key.
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label && b.getAttribute('role') !== 'tab');
  const tab = (name) => vis('main [role=tab]').find((t) => t.textContent.trim().startsWith(name));
  const short = (s, n = 200) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];
const panel = `document.querySelector('aside[aria-label="AI assistant"]')`;

const steps = [
  step('providers-tab', `await __t.view('AI Lab'); await __t.sleep(800); tab('Providers')?.click(); await __t.sleep(800); return short(document.querySelector('main')?.innerText, 400);`),
  step(
    'playground-without-a-key',
    `tab('Playground')?.click(); await __t.sleep(600);
     const sel = vis('main select[aria-label="Provider"]')[0];
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'openai');
     sel.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(400);
     button('Run')?.click();
     const alert = await __t.waitFor(() => document.querySelector("main [role=alert]"), 20000);
     await __t.sleep(400);
     return short(alert?.innerText ?? 'NO ALERT', 400);`,
  ),
  step(
    'add-the-key-opens-the-provider',
    `const b = button('Add the key'); if (!b) return 'NO ADD THE KEY BUTTON';
     b.click(); await __t.sleep(800);
     const f = document.activeElement;
     const selected = vis('main [aria-selected=true], main [aria-current=true]').map((x) => short(x.innerText, 40));
     return 'focused=' + (f?.type === 'password' ? 'key field' : f?.tagName) + ' tab=' + short(vis('main [role=tab][aria-selected=true]')[0]?.innerText, 30) + ' selected=' + selected.join('|');`,
  ),
  step(
    'assistant-without-a-key',
    `await __t.requests(); await __t.sleep(400);
     document.querySelector('[aria-label="AI assistant"]:not(aside)')?.click(); await __t.sleep(800);
     const p = ${panel}; if (!p) return 'NO PANEL';
     const inp = p.querySelector('input[aria-label="Question for the assistant"]');
     if (inp) {
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, 'What is a 404?');
       inp.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(100);
       inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       await __t.sleep(3000);
     }
     return short(p.innerText, 500);`,
  ),
];

module.exports = withExpect(steps, {}, { settings: { assistantProvider: 'openai', assistantModel: 'gpt-4o-mini' } });
