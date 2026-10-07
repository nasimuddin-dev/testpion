// Not part of the suite (the _ prefix): the AI features against a real OpenAI model. It needs a key in the
// environment, never in a file:  TESTPION_SECRET_PROVIDER_OPENAI_APIKEY=sk-… npm run e2e -- --only _ai-live
// The examples' "openai" provider reads {{$secret.provider.openai.apiKey}}, which the app's environment secret store
// answers from that variable; the assistant is set to OpenAI for this run.
const { withExpect } = require('../lib.cjs');

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const button = (label) => vis('main button').find((b) => b.textContent.trim() === label && b.getAttribute('role') !== 'tab');
  const tab = (name) => vis('main [role=tab]').find((t) => t.textContent.trim().startsWith(name));
  const short = (s, n = 120) => String(s ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];
const panel = `document.querySelector('aside[aria-label="AI assistant"]')`;

const steps = [
  step(
    'models-listed',
    `const models = await window.aps.invoke('ai.models', { providerId: 'openai' });
     return 'models: ' + models.length + ' | has gpt-4o-mini: ' + models.includes('gpt-4o-mini');`,
  ),
  step(
    'playground-runs-on-openai',
    `await __t.view('AI Lab'); await __t.sleep(800);
     tab('Playground')?.click(); await __t.sleep(600);
     const sel = vis('main select[aria-label="Provider"]')[0];
     if (!sel) return 'NO PROVIDER SELECT';
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'openai');
     sel.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(500);
     button('Run')?.click();
     // finished when the latency is a number (it shows … while the model writes)
     const latency = () => vis('main *').find((x) => x.children.length === 0 && x.textContent.trim() === 'Latency')?.nextElementSibling?.textContent?.trim();
     const done = await __t.waitFor(() => (document.querySelector('main [role=alert]') || (latency() && latency() !== '…') ? true : null), 60000);
     await __t.sleep(500);
     const error = document.querySelector('main [role=alert]')?.textContent;
     const metrics = vis('main *').filter((x) => x.children.length === 0 && /^(Latency|Time to first token|Tokens in \\/ out|Est. cost)$/.test(x.textContent.trim())).map((x) => short(x.textContent + ' ' + (x.nextElementSibling?.textContent ?? ''), 40));
     const output = short(vis('main pre, main .markdown').map((x) => x.textContent).join(' '), 80);
     return 'finished: ' + !!done + ' | error: ' + short(error, 160) + ' | metrics: ' + metrics.join(', ') + ' | output: ' + output;`,
  ),
  step(
    'comparison-openai-and-demo',
    `const r = await window.aps.invoke('ai.compare', { requestId: 'cmp-e2e', models: [{ provider: 'openai', name: 'gpt-4o-mini' }, { provider: 'demo', name: 'demo' }], prompt: 'Say hello in French, one word.', evaluators: [{ type: 'contains', expected: 'onjour' }] });
     return r.map((x) => (x.provider ?? x.model?.provider ?? '?') + ':' + (x.error ? 'ERROR ' + short(x.error.message, 100) : short(x.text, 30) + ' checks ' + (x.checks ?? []).filter((c) => c.passed).length + '/' + (x.checks ?? []).length)).join(' | ');`,
  ),
  step(
    'assistant-answers',
    `await __t.requests(); await __t.sleep(400);
     document.querySelector('[aria-label="AI assistant"]:not(aside)')?.click(); await __t.sleep(800);
     const p = ${panel}; if (!p) return 'NO PANEL';
     p.querySelector('[aria-label="New conversation"]')?.click(); await __t.sleep(300);
     const inp = p.querySelector('input[aria-label="Question for the assistant"]');
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, 'In one sentence: what does HTTP status 404 mean?');
     inp.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(100);
     inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await __t.sleep(500);
     await __t.waitFor(() => (![...p.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Stop') ? true : null), 60000);
     await __t.sleep(400);
     const last = [...p.querySelectorAll('[data-turn=assistant]')].at(-1);
     const r = 'answer: ' + short(last?.querySelector('.markdown')?.innerText, 100) + ' | model: ' + short(last?.querySelector('[data-answer-model]')?.textContent, 40) + ' | error: ' + short(p.querySelector('[role=alert]')?.textContent, 160);
     p.querySelector('[aria-label="Close assistant"]')?.click(); await __t.sleep(300);
     return r;`,
  ),
  step(
    'generate-a-request',
    `const r = await window.aps.invoke('ai.generateRequest', { description: 'Get the pet with id 10 from the Swagger Petstore API at https://petstore3.swagger.io/api/v3' });
     return 'method: ' + r.request?.method + ' | url: ' + r.request?.url + ' | model: ' + r.model;`,
  ),
  step(
    'generate-tests',
    `const r = await window.aps.invoke('ai.generateTests', { request: { method: 'GET', url: 'https://petstore3.swagger.io/api/v3/pet/10' }, response: { status: 200, headers: [{ key: 'content-type', value: 'application/json' }], body: '{"id":10,"name":"doggie","status":"available"}', timeMs: 120 } });
     return 'tests: ' + (r.script.match(/tp\\.test\\(/g) ?? []).length + ' | uses pm: ' + /\\bpm\\./.test(r.script) + ' | model: ' + r.model;`,
  ),
  step(
    'evaluation-run',
    `const draft = { name: 'E2E live eval', type: 'llm', provider: 'openai', model: 'gpt-4o-mini', temperature: 0, prompt: 'Reply with the capital of {{country}}, one word.', format: 'text', datasetFormat: 'jsonl', dataset: '{"country":"France","expected":"Paris"}\\n{"country":"Japan","expected":"Tokyo"}', expectedField: 'expected', evaluators: [{ type: 'contains', expected: '{{expected}}' }], concurrency: 2, retries: 0 };
     const { runId } = await window.aps.invoke('eval.runDraft', { draft });
     let page;
     for (let i = 0; i < 60; i++) { await __t.sleep(1000); page = await window.aps.invoke('runs.results', { runId }).catch(() => undefined); if (page && (page.total ?? page.items?.length) >= 2 && page.items?.every((x) => x.status !== 'running')) break; }
     const items = page?.items ?? [];
     return 'results: ' + items.length + ' | passed: ' + items.filter((x) => x.status === 'passed').length + ' | errors: ' + items.map((x) => short(x.error?.message ?? x.checks?.find((c) => !c.passed)?.message, 80)).filter(Boolean).join('; ');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'models-listed': /^models: [1-9]\d* \| has gpt-4o-mini: true$/,
    'playground-runs-on-openai': /^finished: true \| error: \| metrics: .*Latency.* \| output: .+/,
    'comparison-openai-and-demo': /^OpenAI:(?!ERROR).* checks 1\/1 \| Offline demo model:/,
    'assistant-answers': /^answer: .*(not found|Not Found|could not be found).* \| model: .*gpt-4o-mini.* \| error: $/,
    'generate-a-request': /^method: GET \| url: .*\/pet\/10 \| model: OpenAI\/gpt-4o-mini/,
    'generate-tests': /^tests: [1-9]\d* \| uses pm: false \| model: OpenAI\/gpt-4o-mini/,
    'evaluation-run': /^results: 2 \| passed: 2 \| errors: $/,
  },
  { settings: { assistantProvider: 'openai', assistantModel: 'gpt-4o-mini' } },
);
