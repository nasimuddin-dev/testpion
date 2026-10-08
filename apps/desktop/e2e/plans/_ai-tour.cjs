// Not part of the suite (the _ prefix): screenshots of every AI screen as a person meets it, for a UI review —
// AI Lab (Playground before and after a run, Model comparison, Usage, Providers), Evaluations, a RAG test's result, the assistant.
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step('playground', `await __t.view('AI Lab'); await __t.sleep(800); tab('Playground')?.click(); await __t.sleep(800); return short(document.querySelector('main')?.innerText);`),
  step(
    'playground-run',
    `button('Run')?.click(); await __t.waitFor(() => /Latency/.test(document.querySelector('main')?.innerText ?? ''), 20000); await __t.sleep(600); return short(document.querySelector('main')?.innerText, 600);`,
  ),
  step('comparison', `tab('Model comparison')?.click(); await __t.sleep(800); return short(document.querySelector('main')?.innerText);`),
  step('comparison-run', `vis('main button').find((b) => b.textContent.trim() === 'Run comparison')?.click(); await __t.sleep(6000); return short(document.querySelector('main')?.innerText, 600);`),
  step('usage', `tab('Usage')?.click(); await __t.sleep(800); return short(document.querySelector('main')?.innerText);`),
  step('providers', `tab('Providers')?.click(); await __t.sleep(800); return short(document.querySelector('main')?.innerText);`),
  step('evaluations', `await __t.view('Evaluations'); await __t.sleep(1200); return short(document.querySelector('main')?.innerText, 600);`),
  step(
    'evaluations-run',
    `vis('main button').find((b) => /^Run \\d+ cases?$/.test(b.textContent.trim()))?.click(); await __t.sleep(8000); return short(document.querySelector('main')?.innerText, 600);`,
  ),
  step('tests', `await __t.view('Tests'); await __t.sleep(1200); return short(document.querySelector('main')?.innerText, 600);`),
  step(
    'rag-test',
    `const row = vis('main *').find((x) => x.children.length === 0 && /^RAG|rag/i.test(x.textContent.trim()) && x.textContent.trim().length < 60);
     row?.click(); await __t.sleep(1200); return short(document.querySelector('main')?.innerText, 600);`,
  ),
  step('rag-test-run', `const b = button('Run') ?? button('Run test'); b?.click(); await __t.sleep(4000); return short(document.querySelector('main')?.innerText, 800);`),
  step(
    'assistant',
    `document.querySelector('[aria-label="AI assistant"]:not(aside)')?.click(); await __t.sleep(1000); return short(document.querySelector('aside[aria-label="AI assistant"]')?.innerText, 500);`,
  ),
];

module.exports = withExpect(steps, {});
