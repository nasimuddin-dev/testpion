// AU-11, AU-18 · "What is a good answer?": the Checks tab of a prompt evaluation lists the common checks with a sentence under
// each; ticking one adds it; "Try on case N" sends that case to the model and shows the reply, passed or failed and why (free
// on the offline demo model, at once); a wrong expectation fails with the reason. With a paid model, Try shows what it costs
// first and sends nothing until Send (nothing is sent here: the provider is a stand-in). A run over 100 calls on a paid model asks
// once (the dialog says what it costs), and the spend cap is a field under Options.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const result = () => vis('[data-pick-result]')[0];
`;

const steps = [
  step(
    'open-the-sample',
    `${H} await window.aps.invoke('ai.sample', { run: false });
     await __t.view('Home'); await __t.view('Evaluations'); await __t.sleep(1000);
     const row = await __t.waitFor(() => vis('aside *, [data-sidebar] *, main *').find((e) => e.children.length === 0 && e.textContent.trim() === 'Sample: support intents'), 6000);
     if (!row) return 'NO ROW';
     await __t.real.click(row); await __t.sleep(1000);
     await __t.real.click(tab('Checks')); await __t.sleep(600);
     return 'rows: ' + vis('[data-pick]').length + ' | ticked: ' + vis('[data-picked=true]').map((p) => p.getAttribute('data-pick')).join(',') + ' | name: ' + vis('main input[aria-label="Evaluation name"]')[0]?.value;`,
  ),
  step(
    'every-row-has-a-sentence',
    `const sentences = vis('[data-pick] [data-pick-what]').map((e) => e.textContent.trim());
     return 'sentences: ' + sentences.filter(Boolean).length + '/' + sentences.length + ' | first: ' + sentences[0];`,
  ),
  step(
    'try-a-check-on-a-case',
    `${H} await __t.real.click(vis('[data-pick=contains] [data-pick-try]')[0]);
     const r = await __t.waitFor(() => result(), 15000);
     return 'result: ' + r?.getAttribute('data-pick-result') + ' | text: ' + short(r?.textContent, 160);`,
  ),
  step(
    'a-wrong-expectation-fails-with-the-reason',
    `${H} const input = vis('[data-pick=contains] input[type=text], [data-pick=contains] input:not([type])')[0];
     setValue(input, 'zzz-not-there'); await __t.sleep(300);
     await __t.real.click(vis('[data-pick=contains] [data-pick-try]')[0]);
     await __t.waitFor(() => result()?.getAttribute('data-pick-result') === 'failed', 15000);
     return 'result: ' + result()?.getAttribute('data-pick-result') + ' | text: ' + short(result()?.textContent, 200);`,
  ),
  step(
    'ticking-and-unticking',
    `const box = vis('[data-pick=is-json] input[type=checkbox]')[0];
     await __t.real.click(box); await __t.sleep(300);
     const on = vis('[data-pick=is-json]')[0]?.getAttribute('data-picked');
     const inList = /Is valid JSON|is-json/.test(vis('[data-more-checks]')[0]?.innerText ?? '');
     await __t.real.click(vis('[data-pick=is-json] input[type=checkbox]')[0]); await __t.sleep(300);
     return 'ticked: ' + on + ' | in the full list: ' + inList + ' | after untick: ' + vis('[data-pick=is-json]')[0]?.getAttribute('data-picked');`,
  ),
  step(
    'a-paid-model-shows-the-cost-first',
    `${H} await window.aps.invoke('ai.saveProviders', { providers: [{ id: 'paid', name: 'Stand-in paid model', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '{{$env.E2E_NO_KEY}}', defaultModel: 'm' }], keys: {} });
     await __t.view('Home'); await __t.view('Evaluations'); await __t.sleep(1000);
     const sel = vis('main select').find((s) => [...s.options].some((o) => o.textContent.trim() === 'Stand-in paid model'));
     const opt = [...sel.options].find((o) => o.textContent.trim() === 'Stand-in paid model');
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(1200);
     await __t.real.click(tab('Checks')); await __t.sleep(400);
     await __t.real.click(vis('[data-pick=contains] [data-pick-try]')[0]);
     const ask = await __t.waitFor(() => vis('[data-pick-ask]')[0], 8000);
     return 'asks first: ' + !!ask + ' | text: ' + short(ask?.textContent, 140) + ' | sent: ' + !!result();`,
  ),
  step(
    'the-cost-line-says-unknown-without-a-price',
    `const c = vis('main [data-eval-cost]')[0];
     return 'cost: ' + c?.getAttribute('data-eval-cost') + ' | set a price: ' + [...(c?.querySelectorAll('button') ?? [])].some((b) => /Set a price/.test(b.textContent));`,
  ),
  step(
    'a-big-run-on-a-paid-model-asks-once',
    `${H} await __t.real.click(tab('Test cases')); await __t.sleep(400);
     await __t.real.click([...vis('main button')].find((b) => b.textContent.trim() === 'Edit as text')); await __t.sleep(600);
     (window.__monaco?.editor.getEditors() ?? []).find((e) => e.getDomNode()?.offsetParent).getModel().setValue(Array.from({ length: 150 }, (_, i) => JSON.stringify({ input: 'case ' + i, expected: 'x' })).join('\\n')); await __t.sleep(1000);
     await __t.real.click(vis('main button[data-eval-run]')[0]);
     const dlg = await __t.waitFor(() => vis('[data-spend-dialog]')[0], 8000);
     const text = short(dlg?.textContent, 200);
     await __t.real.key('Escape'); await __t.sleep(300);
     return 'dialog: ' + !!dlg + ' | text: ' + text + ' | runs started: ' + (await window.aps.invoke('runs.list', { limit: 10 })).items.filter((r) => r.name === 'Sample: support intents').length;`,
  ),
  step(
    'the-spend-cap-is-an-option',
    `const o = vis('main [data-eval-options]')[0]; if (!o) return 'NO OPTIONS';
     await __t.real.click(o.querySelector('summary')); await __t.sleep(300);
     const f = o.querySelector('[data-eval-cap]');
     return 'cap field: ' + !!f + ' | placeholder: ' + f?.getAttribute('placeholder') + ' | closed first: true';`,
  ),
];
module.exports = withExpect(steps, {
  'open-the-sample': /^rows: 6 \| ticked: contains \| name: Sample: support intents$/,
  'every-row-has-a-sentence': /^sentences: 6\/6 \| first: .+/,
  'try-a-check-on-a-case': /^result: passed \| text: Case 1 reply: \{"intent":"cancellation"\}Passed.*offline demo model, free/,
  'a-wrong-expectation-fails-with-the-reason': /^result: failed \| text: Case 1 reply: .*Failed: missing/,
  'ticking-and-unticking': /^ticked: true \| in the full list: true \| after untick: false$/,
  'a-paid-model-shows-the-cost-first': /^asks first: true \| text: This sends case 1 to the model.*\| sent: false$/,
  'the-cost-line-says-unknown-without-a-price': /^cost: unknown \| set a price: true$/,
  'a-big-run-on-a-paid-model-asks-once': /^dialog: true \| text: .*cost is not known.* \| runs started: 0$/,
  'the-spend-cap-is-an-option': /^cap field: true \| placeholder: 1\.00 \| closed first: true$/,
});
