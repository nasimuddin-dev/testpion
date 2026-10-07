// The {{variable}} popover, the same everywhere: a click on a variable in the URL bar or a header, a double-click on a
// variable in any text field (auth) and in a code editor (the body). It shows the value and where it comes from.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const H = `
  const pop = () => document.querySelector('[role=dialog][aria-label^="Variable "]');
  const read = async () => {
    const p = await __t.waitFor(pop, 2500); if (!p) return 'NO DIALOG';
    const r = p.getAttribute('aria-label') + ' | ' + (p.querySelector('.text-\\\\[0\\\\.7rem\\\\]')?.textContent.trim() ?? '') + ' | value: ' + (p.querySelector('input')?.value ?? p.querySelector('.field')?.textContent.trim() ?? '');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300);
    return r + ' | closed: ' + !pop();
  };
  const filter = async (v) => { const f = document.querySelector('aside input[placeholder^="Filter"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(800); };
  const openRow = async (name) => { await filter(name); const r = [...document.querySelectorAll('aside [data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name) && b.getAttribute('aria-expanded') === null); r?.click(); await __t.sleep(1500); await filter(''); return !!r; };
  const subTab = async (label) => { const t = [...document.querySelectorAll('main [role=tab]')].find((x) => x.offsetParent && x.textContent.trim().startsWith(label)); t?.click(); await __t.sleep(700); return !!t; };
  /** A click on a {{variable}} in a field with highlighting: put the caret inside it and click. */
  const clickVar = async (input, name) => { const i = input.value.indexOf('{{' + name); input.focus(); input.setSelectionRange(i + 3, i + 3); input.click(); };
`;
const step = (name, body) => [name, `(async () => { ${H} ${body} })()`];

const steps = [
  step('url-bar-click', `await __t.requests(); if (!(await openRow('Custom headers'))) return 'NO ROW'; const url = [...document.querySelectorAll('main input[aria-label="Request URL"]')].find((x) => x.offsetParent); await clickVar(url, 'httpbin'); return await read();`),
  step('header-click', `await subTab('Headers'); const cell = [...document.querySelectorAll('main input')].find((x) => x.offsetParent && x.value.includes('{{appName}}')); if (!cell) return 'NO INPUT'; await clickVar(cell, 'appName'); return await read();`),
  step(
    'auth-field-double-click',
    `if (!(await openRow('Bearer token'))) return 'NO ROW'; await subTab('Authorization');
     const f = [...document.querySelectorAll('main input')].find((x) => x.offsetParent && x.value.includes('{{demoToken}}')); if (!f) return 'NO INPUT';
     f.focus(); f.setSelectionRange(4, 4); f.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: f.getBoundingClientRect().left + 30, clientY: f.getBoundingClientRect().top + 5 }));
     return await read();`,
  ),
  step(
    'code-editor-double-click',
    `if (!(await openRow('POST a JSON body'))) return 'NO ROW'; await subTab('Body'); await __t.sleep(800);
     const span = [...document.querySelectorAll('main .monaco-editor .view-line span span')].find((s) => s.offsetParent && s.textContent.includes('appName'));
     if (!span) return 'NO SPAN appName';
     const r = span.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
     for (const detail of [1, 2]) { span.dispatchEvent(new MouseEvent('mousedown', { ...o, detail })); span.dispatchEvent(new MouseEvent('mouseup', { ...o, detail })); await __t.sleep(60); }
     return await read();`,
  ),
  // a variable defined nowhere: Where it's set opens the overview on it, says so, and offers to add it
  step(
    'all-for-an-undefined-variable',
    `await __t.requests(); if (!(await openRow('Custom headers'))) return 'NO ROW';
     const url = [...document.querySelectorAll('main input[aria-label="Request URL"]')].find((x) => x.offsetParent);
     const before = url.value;
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, '{{nowhereDefined}}/x'); url.dispatchEvent(new Event('input', { bubbles: true })); await __t.sleep(400);
     await clickVar(url, 'nowhereDefined');
     const p = await __t.waitFor(pop, 2500); if (!p) return 'NO DIALOG';
     [...p.querySelectorAll('button')].find((b) => b.textContent.trim() === "Where it's set")?.click();
     const banner = await __t.waitFor(() => document.querySelector('[data-not-defined="nowhereDefined"]'), 4000);
     const focusOn = document.querySelector('[data-variable-focus]')?.getAttribute('data-variable-focus');
     const offersAdd = !!banner && [...banner.querySelectorAll('button')].some((b) => /^Add to /.test(b.textContent.trim()));
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300);
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(url, before); url.dispatchEvent(new Event('input', { bubbles: true }));
     return 'banner: ' + !!banner + ' | focus: ' + focusOn + ' | offers add: ' + offersAdd;`,
  ),
  // a defined one: which scope the request uses, and the others in the order they win
  step(
    'where-its-set-for-a-defined-variable',
    `await __t.requests(); if (!(await openRow('Custom headers'))) return 'NO ROW';
     const url = [...document.querySelectorAll('main input[aria-label="Request URL"]')].find((x) => x.offsetParent);
     await clickVar(url, 'httpbin');
     const p = await __t.waitFor(pop, 2500); if (!p) return 'NO DIALOG';
     [...p.querySelectorAll('button')].find((b) => b.textContent.trim() === "Where it's set")?.click();
     const trace = await __t.waitFor(() => document.querySelector('[data-variable-trace]'), 4000);
     const used = trace?.querySelector('[data-state=used]')?.getAttribute('data-scope');
     const uses = document.querySelector('[data-variable-resolves]')?.textContent ?? '';
     const tables = !!document.querySelector('input[aria-label="Filter variables"]');
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300);
     return 'used: ' + used + ' | value: ' + /httpbin\\.org/.test(uses) + ' | filter box: ' + tables;`,
  ),
  step(
    'new-websocket-tab-starts-empty',
    `await __t.newTab('WebSocket'); await __t.sleep(500);
     const url = [...document.querySelectorAll('main input[aria-label="WebSocket URL"]')].find((x) => x.offsetParent);
     return 'url: "' + (url?.value ?? 'NONE') + '"';`,
  ),
];

module.exports = withExpect(steps, {
  'all-for-an-undefined-variable': /^banner: true \| focus: nowhereDefined \| offers add: true$/,
  'where-its-set-for-a-defined-variable': /^used: environment \| value: true \| filter box: false$/,
  'new-websocket-tab-starts-empty': /^url: ""$/,
  'url-bar-click': /^Variable httpbin \| environment \| value: https:\/\/httpbin\.org \| closed: true$/,
  'header-click': /^Variable appName \| workspace \| value: TestPion \| closed: true$/,
  'auth-field-double-click': /^Variable demoToken \| environment \| value: demo-token-123 \| closed: true$/,
  'code-editor-double-click': /^Variable appName \| workspace \| value: TestPion \| closed: true$/,
});
