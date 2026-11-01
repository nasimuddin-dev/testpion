// Accessible names in every view: each visible button, tab, menu item, switch and link has a name (its text, aria-label or
// title), each input has a label (a <label>, aria-label or aria-labelledby: a placeholder is not a label), each image an
// alt, each dialog a name, and no two visible elements share an id. A screen reader and the keyboard route depend on it;
// so does every plan that finds a control by its name. One step per view: a failure names the view and the elements.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const H = `
  const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
  const text = (el) => (el.textContent ?? '').replace(/\\s+/g, ' ').trim();
  // a <button> is labelable: the <label> around a switch names it by its text
  const named = (el) => !!(text(el) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.querySelector('img[alt]:not([alt=""])') || el.querySelector('svg[aria-label]') || (el.closest('label') && text(el.closest('label'))));
  const labelled = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
    if (el.closest('label')) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    return false;
  };
  const where = (el) => {
    const tag = el.tagName.toLowerCase();
    const bits = ['data-testid', 'id', 'name', 'placeholder', 'type', 'class'].map((a) => (el.getAttribute(a) ? a + '=' + el.getAttribute(a).slice(0, 40) : '')).filter(Boolean);
    return tag + '[' + bits.join(' ') + ']';
  };
  const audit = () => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=radio], a[href]')) if (vis(el) && !named(el)) out.push('unnamed ' + where(el));
    // Monaco's IME helper textarea is the editor's own (its input area carries the name)
    for (const el of document.querySelectorAll('input:not([type=hidden]), textarea:not(.ime-text-area), select')) if (vis(el) && !labelled(el)) out.push('unlabelled ' + where(el));
    for (const el of document.querySelectorAll('img')) if (vis(el) && !el.hasAttribute('alt') && el.getAttribute('role') !== 'presentation') out.push('img without alt ' + where(el));
    for (const el of document.querySelectorAll('[role=dialog]')) if (vis(el) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) out.push('dialog without a name');
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) if (vis(el)) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) out.push('duplicate id #' + id + ' ×' + n);
    return out;
  };
  const report = (view) => { const f = audit(); return f.length ? view + ': ' + f.length + ' | ' + [...new Set(f)].slice(0, 10).join(' ; ') : 'ok'; };
  const visit = async (view) => { const r = await __t.view(view); if (r !== 'ok' && r !== true && r !== undefined) return 'NO VIEW ' + view + ': ' + r; await __t.sleep(1200); return report(view); };
  const tabs = async (view, names) => { const r = await __t.view(view); await __t.sleep(1000); const out = []; for (const n of names) { await __t.tab(n); await __t.sleep(900); const f = report(view + ' ▸ ' + n); if (f !== 'ok') out.push(f); } return out.length ? out.join(' || ') : 'ok'; };
`;
const step = stepOf(H);

const steps = [
  step('home', `return visit('Home');`),
  step('collections', `await __t.requests(); await __t.sleep(800); await __t.expand('HTTP basics (httpbin)'); await __t.expand('Requests & responses'); await __t.open('GET with query parameters'); await __t.sleep(800); return report('Collections');`),
  step('tests', `return visit('Tests');`),
  step('monitors', `return visit('Monitors');`),
  step('environments', `return visit('Environments');`),
  step('history', `return visit('History');`),
  step('traces', `return visit('Traces');`),
  step('git', `return visit('Git');`),
  step('load', `return visit('Load');`),
  step('debugger', `return visit('Debugger');`),
  step('ai-quality', `return tabs('AI Quality', ['Start', 'Checks', 'Try a Prompt', 'Compare', 'Models and Keys']);`),
  step('rag-bots', `return tabs('RAG Bots', ['Start', 'Bots', 'Questions', 'Metrics', 'Checks']);`),
  step('settings', `return tabs('Settings', ['Appearance', 'Keyboard', 'Requests', 'Git', 'Proxy', 'Certificates', 'Privacy & Security', 'Model Pricing', 'Load Testing', 'Storage', 'AI Assistant', 'AI Agents (MCP)', 'About']);`),
];

module.exports = withExpect(
  steps,
  Object.fromEntries(steps.map((s) => [s[0], /^ok$/])),
);
