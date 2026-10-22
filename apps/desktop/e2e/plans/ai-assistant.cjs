// The AI assistant drawer: a free question carries the open request as context (removable), follow-ups remember the
// conversation, answers render as Markdown and stream, Stop keeps what arrived; New conversation starts over.
// Uses the examples' offline demo model (no network, no key).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect } = require('../lib.cjs');

/** The offline model answers after 1.5 s (so Stop can be pressed while it works) and knows one GraphQL answer. */
const slowModel = (ws) => {
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  for (const h of c.providers.find((x) => x.id === 'demo').headers) if (h.key === 'x-mock-latency-ms') h.value = '1500';
  // "Generate GraphQL query" gets an operation in a code block (the request carries the current query)
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  // and "Suggest checks" / "Generate tests" for the demo server's /health get checks and tp tests as JSON
  rules.value = JSON.stringify([
    { match: 'currentQuery', response: 'Here it is:\n\n```graphql\nquery Generated { countries { code name } }\n```' },
    { match: '"gaps"', response: 'Tests for the most important gaps:\n\n```yaml\ntests:\n  - id: pet-not-found\n    type: http\n    request: { method: GET, url: "{{baseUrl}}/pet/0" }\n    checks:\n      - { type: status, expected: 404 }\n```' },
    // "Generate tests" (its context has the response's timeMs): one test passes, one does not
    {
      match: '"timeMs"',
      response: JSON.stringify({ tests: [{ name: 'is ok', code: 'tp.response.to.have.status(200);' }, { name: 'is created', code: 'tp.response.to.have.status(201);' }] }),
    },
    // "Suggest checks": two checks hold, one pins the server's time (fails, a safer form is offered)
    {
      match: '127.0.0.1:4010/health',
      response: JSON.stringify({
        checks: [
          { type: 'status', expected: 200 },
          { type: 'equals', path: '$.status', expected: 'ok' },
          { type: 'equals', path: '$.time', expected: '2020-01-01T00:00:00.000Z' },
        ],
      }),
    },
    ...JSON.parse(rules.value),
  ]);
  writeFileSync(p, JSON.stringify(c, null, 2));
};

const panel = `document.querySelector('aside[aria-label="AI assistant"]')`;
/** The drawer: how many questions and answers, the context chip, the last answer's text and model, the field's hint. */
const state = `(() => {
  const p = ${panel}; if (!p) return 'NO PANEL';
  const answers = [...p.querySelectorAll('[data-turn=assistant]')];
  const last = answers.at(-1);
  return 'questions: ' + p.querySelectorAll('[data-turn=user]').length + ' | answers: ' + answers.length
    + ' | context: ' + (p.querySelector('[data-assistant-context]')?.textContent.trim() ?? 'none')
    + ' | last: ' + (last?.querySelector('.markdown')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? '-')
    + ' | model: ' + (last?.querySelector('[data-answer-model]')?.textContent.trim() ?? '-')
    + ' | placeholder: ' + p.querySelector('input[aria-label="Question for the assistant"]').placeholder;
})()`;
/** Type a question (React reads the native value setter), press Enter. */
const send = (q) => `{
  const p = ${panel}; if (!p) return 'NO PANEL';
  const inp = p.querySelector('input[aria-label="Question for the assistant"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, ${JSON.stringify(q)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await __t.sleep(100);
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await __t.sleep(300);
}`;
const stopButton = `[...${panel}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop')`;
/** Ask and wait for the answer (while it is being written the Stop button shows). */
const ask = (q) => `(async () => {
  ${send(q)}
  for (let i = 0; i < 60 && ${stopButton}; i++) await __t.sleep(150);
  await __t.sleep(300);
  return ${state};
})()`;

/** Open a saved item through the explorer's filter, open the assistant and read its context chip; close it again. */
const contextOf = (item) => `(async () => {
  await __t.requests();
  const f = document.querySelector('aside input[placeholder^="Filter"]');
  const setF = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
  setF(${JSON.stringify(item)}); await __t.sleep(900);
  const r = [...document.querySelectorAll('aside button[data-tree-row], aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes(${JSON.stringify(item)}) && b.getAttribute('aria-expanded') === null);
  if (!r) { setF(''); return 'NO ROW'; }
  r.click(); await __t.sleep(2000); setF(''); await __t.sleep(300);
  document.querySelector('[aria-label="AI assistant"]:not(aside)').click(); await __t.sleep(800);
  const chip = ${panel}?.querySelector('[data-assistant-context]')?.textContent.trim() ?? 'none';
  ${panel}?.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(400);
  return 'view: ' + document.querySelector('nav [aria-current="page"]')?.getAttribute('aria-label') + ' | ' + chip;
})()`;

const steps = [
  ['open-with-request', `(async () => { await __t.requests(); await __t.expand('HTTP basics'); await __t.expand('Requests & responses'); await __t.open('Custom headers'); const b = document.querySelector('[aria-label="AI assistant"]:not(aside)'); if (!b) return 'NO BUTTON'; b.click(); await __t.sleep(800); return ${state}; })()`],
  ['first-question', ask('Why does this request fail?')],
  ['follow-up', ask('And how do I fix it?')],
  ['new-conversation', `(async () => { ${panel}.querySelector('[aria-label="New conversation"]').click(); await __t.sleep(600); return ${state}; })()`],
  ['without-context', `(async () => { ${panel}.querySelector('[aria-label="Leave out the context"]').click(); await __t.sleep(300); return await ${ask('What is a 404?')}; })()`],
  ['stop', `(async () => { ${send('A long question')} const stop = ${stopButton}; if (!stop) return 'NO BUTTON Stop'; stop.click(); await __t.sleep(1800); return 'error shown: ' + !!${panel}.querySelector('[role=alert]') + ' | ' + ${state}; })()`],
  ['close', `(async () => { ${panel}.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(500); return 'panel open: ' + !!${panel}; })()`],
  ['context-graphql', contextOf('Country by code')],
  ['context-grpc', contextOf('Add two numbers')],
  ['context-websocket', contextOf('Postman echo')],
  ['context-mcp', contextOf('Weather (offline mock)')],
  ['shortcut-and-suggestions', `(async () => {
    const ctrlJ = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
    ctrlJ(); await __t.sleep(700);
    const chips = [...(${panel}?.querySelectorAll('[data-suggestion]') ?? [])].map((b) => b.textContent.trim());
    if (!chips.length) return 'NO BUTTON suggestion';
    ${panel}.querySelector('[data-suggestion]').click(); await __t.sleep(300);
    for (let i = 0; i < 60 && ${stopButton}; i++) await __t.sleep(150);
    await __t.sleep(300);
    const s = ${state};
    ctrlJ(); await __t.sleep(500);
    const closedByCtrlJ = !${panel};
    // Esc in the question field closes it too
    ctrlJ(); await __t.sleep(600);
    ${panel}?.querySelector('input[aria-label="Question for the assistant"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await __t.sleep(400);
    return 'chips: ' + chips.join(' / ') + ' | ' + s + ' | open after Ctrl+J: ' + !closedByCtrlJ + ' | open after Esc: ' + !!${panel};
  })()`],
  ['apply-checks', `(async () => {
    await __t.requests();
    const plus = document.querySelector('[aria-label="New tab"]'); plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await __t.sleep(500);
    [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith('HTTP request'))?.click(); await __t.sleep(1200);
    const url = [...document.querySelectorAll('main input[aria-label="Request URL"]')].find((x) => x.offsetParent); if (!url) return 'NO INPUT url';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, 'http://127.0.0.1:4010/health'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(300);
    const tests = () => [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim().startsWith('Tests'))?.textContent.trim();
    const before = tests();
    [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Send')?.click(); await __t.sleep(2000);
    if (!(await __t.responseAction('Suggest checks'))) return 'NO BUTTON Suggest checks';
    // the checks come as a proposal that opens by itself: each verified against this response; the one that pins the
    // server's time fails, is unticked, and offers safer forms — switching to one checks it again
    const modal = await __t.waitFor(() => document.querySelector('[data-proposal]'), 12000); if (!modal) return 'NO REVIEW';
    const badges = [...modal.querySelectorAll('[data-proposal-item] [data-verification]')].map((b) => b.getAttribute('data-verification')).join(',');
    const ticked = [...modal.querySelectorAll('[data-proposal-item] input[type=checkbox]')].map((c) => (c.checked ? 1 : 0)).join('');
    const safer = [...modal.querySelectorAll('[data-proposal-safer] button')];
    const offered = safer.map((b) => b.textContent.trim()).join(' / ');
    const exists = safer.find((b) => b.textContent.trim() === 'exists $.time'); if (!exists) return 'NO BUTTON safer exists';
    await __t.real.click(exists);
    await __t.waitFor(() => [...document.querySelectorAll('[data-proposal-item] input[type=checkbox]')].every((c) => c.checked), 6000);
    const after = [...document.querySelectorAll('[data-proposal-item] input[type=checkbox]')].map((c) => (c.checked ? 1 : 0)).join('');
    const apply = document.querySelector('[data-proposal-accept]'); if (!apply) return 'NO BUTTON accept';
    const label = apply.textContent.trim(); apply.click(); await __t.sleep(800);
    ${panel}?.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(400);
    return 'button: ' + label + ' | verified: ' + badges + ' | ticked: ' + ticked + ' | safer: ' + offered + ' | after: ' + after + ' | tests tab: ' + before + ' -> ' + tests();
  })()`],
  ['generate-tests-verified', `(async () => {
    // the same response: Generate tests writes tp tests, each run in the sandbox against it; the failing one is unticked
    if (!(await __t.responseAction('Generate tests'))) return 'NO BUTTON Generate tests';
    const modal = await __t.waitFor(() => document.querySelector('[data-proposal]'), 12000); if (!modal) return 'NO REVIEW';
    const rows = [...modal.querySelectorAll('[data-proposal-item]')].map((r) => (r.querySelector('input[type=checkbox]').checked ? '[x] ' : '[ ] ') + r.querySelector('.mono').textContent.trim() + ' ' + r.querySelector('[data-verification]')?.getAttribute('data-verification'));
    // Run now sends the request again and checks every test against the new response
    const run = modal.closest('[role=dialog]').querySelector('[data-proposal-run-now]'); if (!run) return 'NO BUTTON Run now';
    await __t.real.click(run);
    const toast = await __t.waitFor(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => /^Sent again/.test(t)), 15000);
    const apply = document.querySelector('[data-proposal-accept]'); if (!apply) return 'NO BUTTON accept';
    const label = apply.textContent.trim(); apply.click(); await __t.sleep(800);
    const added = [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => /Post-response script/.test(t)) ?? 'no toast';
    ${panel}?.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(400);
    return 'items: ' + rows.join(', ') + ' | run now: ' + String(toast ?? 'none').slice(0, 60) + ' | button: ' + label + ' | ' + String(added).slice(0, 60);
  })()`],
  ['apply-coverage', `(async () => {
    await __t.requests();
    const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('petstore.json')); if (!r) return 'NO ROW petstore.json';
    r.click(); await __t.sleep(1500);
    [...document.querySelectorAll('main [role=tab]')].find((t) => t.offsetParent && t.textContent.trim() === 'Coverage')?.click(); await __t.sleep(600);
    [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Analyse')?.click();
    let sug; for (let i = 0; i < 60 && !(sug = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Suggest tests with AI' && !b.disabled)); i++) await __t.sleep(150);
    if (!sug) return 'NO BUTTON Suggest tests with AI';
    sug.click(); await __t.sleep(400);
    for (let i = 0; i < 80 && !${panel}?.querySelector('[data-proposal-review]'); i++) await __t.sleep(150);
    const review = ${panel}?.querySelector('[data-proposal-review]'); if (!review) return 'NO BUTTON Review';
    review.click(); await __t.sleep(600);
    const apply = document.querySelector('[data-proposal-accept]'); if (!apply) return 'NO BUTTON accept';
    const label = apply.textContent.trim(); apply.click(); await __t.sleep(1200);
    const toast = [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => t.includes('Saved tests/')) ?? 'no toast';
    const path = /tests\\/(\\S+?\\.yaml)/.exec(toast)?.[1];
    const content = path ? await window.aps.invoke('tests.read', { path }).catch((e) => 'ERR ' + e.message) : '';
    ${panel}?.querySelector('[aria-label="Close assistant"]').click(); await __t.sleep(400);
    return 'button: ' + label + ' | toast: ' + toast + ' | file: ' + String(typeof content === 'string' ? content : JSON.stringify(content)).replace(/\\s+/g, ' ').slice(0, 120);
  })()`],
  ['apply-graphql', `(async () => {
    await __t.requests();
    const f = document.querySelector('aside input[placeholder^="Filter"]');
    const setF = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
    setF('Country by code'); await __t.sleep(900);
    [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.includes('Country by code'))?.click(); await __t.sleep(1500); setF(''); await __t.sleep(300);
    const gen = [...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === 'Generate'); if (!gen) return 'NO BUTTON Generate';
    gen.click(); await __t.sleep(400);
    for (let i = 0; i < 60 && !${panel}?.querySelector('[data-answer-apply]'); i++) await __t.sleep(150);
    const apply = ${panel}?.querySelector('[data-answer-apply]'); if (!apply) return 'NO BUTTON apply';
    const label = apply.textContent.trim(); apply.click(); await __t.sleep(800);
    // the editor draws the new text a moment later: wait for it
    // textContent: innerText of a half-laid-out editor can be just the first token
    const read = () => [...document.querySelectorAll('main .monaco-editor')].find((e) => e.offsetParent)?.querySelector('.view-lines')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
    const text = (await __t.waitFor(() => (/countries \\{ code name \\} \\}/.test(read()) ? read() : ''), 6000)) || read();
    const toast = [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).join(' / ');
    return 'button: ' + label + ' | editor: ' + text + ' | toast: ' + toast;
  })()`],
  // the assistant is still open on the GraphQL task: New conversation runs the task again
  ['restart-reruns-task', `(async () => {
    const p = ${panel}; if (!p) return 'NO PANEL';
    p.querySelector('[aria-label="New conversation"]').click(); await __t.sleep(300);
    const busyAfter = !!${stopButton};
    for (let i = 0; i < 60 && !p.querySelector('[data-answer-apply]'); i++) await __t.sleep(150);
    return 'ran again: ' + busyAfter + ' | ' + ${state};
  })()`],
  // New conversation while an answer is being written: the old answer doesn't land in the new conversation
  ['restart-during-answer', `(async () => {
    const p = ${panel}; if (!p) return 'NO PANEL';
    p.querySelector('[aria-label="New conversation"]').click(); await __t.sleep(400);
    p.querySelector('[aria-label="New conversation"]').click();
    await __t.sleep(2500);
    for (let i = 0; i < 60 && ${stopButton}; i++) await __t.sleep(150);
    return ${state} + ' | stopped shown: ' + /stopped/.test(p.textContent);
  })()`],
  // an AI item of a menu has no button to show its cost: the assistant opens on the estimate and "What will be sent", and sends on Send
  ['menu-item-waits-for-send-with-the-estimate', `(async () => {
    await __t.requests(); await __t.expand('HTTP basics'); await __t.expand('Requests & responses');
    const shown = await __t.menu('Custom headers');
    const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => /^Suggest checks with AI/.test(m.textContent.trim()));
    if (!item) return 'NO ITEM: ' + shown;
    await __t.real.click(item);
    const card = await __t.waitFor(() => ${panel}?.querySelector('[data-ai-preflight]'), 6000); if (!card) return 'NO PREFLIGHT';
    const est = await __t.waitFor(() => /≈ [\\d,]+ tokens in/.test(card.querySelector('[data-ai-estimate]')?.textContent ?? '') && card.querySelector('[data-ai-estimate]').textContent, 8000);
    await __t.sleep(1800);
    const sentEarly = ${panel}.querySelectorAll('[data-turn=assistant]').length > 0 || !!${stopButton};
    const live = card.querySelector('[data-ai-estimate]').getAttribute('role') === 'status';
    const preview = [...card.querySelectorAll('button')].some((b) => /What will be sent/.test(b.textContent));
    await __t.real.click(card.querySelector('[data-ai-send]'));
    const gone = await __t.waitFor(() => !${panel}?.querySelector('[data-ai-preflight]'), 4000);
    for (let i = 0; i < 80 && ${stopButton}; i++) await __t.sleep(150);
    return 'estimate shown: ' + !!est + ' | announced (role status): ' + live + ' | what-will-be-sent offered: ' + preview + ' | sent before Send: ' + sentEarly + ' | card gone after Send: ' + !!gone;
  })()`],
];

module.exports = withExpect(
  steps,
  {
    'open-with-request': /^questions: 0 \| answers: 0 \| context: Context: GET \S*headers \| last: - \| model: - \| placeholder: Ask a question…$/,
    // the mock model echoes the last message: the first carries the question and the request
    'first-question': /^questions: 1 \| answers: 1 \| context: none \| last: Mock response: Question: Why does this request fail\? Context: .*Custom headers.* \| model: Offline demo model · demo \| placeholder: Ask a follow-up…$/,
    // a follow-up is just the question (the conversation goes with it)
    'follow-up': /^questions: 2 \| answers: 2 \| context: none \| last: Mock response: And how do I fix it\? \| model: Offline demo model · demo \|/,
    'new-conversation': /^questions: 0 \| answers: 0 \| context: Context: GET .* \| placeholder: Ask a question…$/,
    'without-context': /^questions: 1 \| answers: 1 \| context: none \| last: Mock response: Question: What is a 404\? \| model: Offline demo model · demo \|/,
    // stopped before any text: no error, the answer says it was stopped
    stop: /^error shown: false \| questions: 2 \| answers: 2 \| context: none \| last: \(stopped\) \|/,
    close: /^panel open: false$/,
    // every request editor offers what it shows
    'context-graphql': /\| Context: GraphQL Country by code · \{\{countriesGraphql\}\}$/,
    'context-grpc': /\| Context: gRPC Sum · \{\{grpcHost\}\}$/,
    'context-websocket': /\| Context: WebSocket \{\{wsEcho\}\} · closed$/,
    'context-mcp': /\| Context: MCP Weather \(offline mock\)$/,
    // Ctrl+J opens the assistant with questions that fit the open MCP server; a click asks one; Ctrl+J closes it
    'shortcut-and-suggestions': /^chips: What can this server do\? \/ .* \| questions: 1 \| answers: 1 \| context: none \| last: Mock response: Question: What can this server do\? Context: .*Weather.* \| open after Ctrl\+J: false \| open after Esc: false$/,
    // an answer can be put to use where it was asked for
    'apply-coverage': /^button: Save as a test file \(1\) \| toast: Saved tests\/coverage\/[\w-]+-gaps\.yaml.*Open \| file: tests: - id: pet-not-found/,
    'apply-checks': (r) => {
      const m = /^button: Add to the checks \(3\) \| verified: pass,pass,fail \| ticked: 110 \| safer: regex \$\.time \/.*\/ \/ type \$\.time = "string" \/ exists \$\.time \| after: 111 \| tests tab: Tests(\d*) -> Tests(\d+)$/.exec(r);
      return (m && +m[2] === (+m[1] || 0) + 3) || 'the failing time check should be unticked, switch to exists, and all three be added to the Tests tab';
    },
    'generate-tests-verified': /^items: \[x\] is ok pass, \[ \] is created fail \| run now: Sent again \(status 200\): 1 item fails now \| button: Add to the Post-response script \(1\) \| Added the tests to the Post-response script/,
    'restart-reruns-task': /^ran again: true \| questions: 0 \| answers: 1 \| .*last: Here it is: query Generated/,
    // the second New conversation lands while the first answer is being written: one fresh answer, nothing stopped
    'restart-during-answer': /^questions: 0 \| answers: 1 \| .*last: Here it is: query Generated.* \| stopped shown: false$/,
    'menu-item-waits-for-send-with-the-estimate': /^estimate shown: true \| announced \(role status\): true \| what-will-be-sent offered: true \| sent before Send: false \| card gone after Send: true$/,
    'apply-graphql': /^button: Use this query \| editor: query Generated \{ countries \{ code name \} \} \| toast: .*Use this query: done/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare: slowModel },
);
