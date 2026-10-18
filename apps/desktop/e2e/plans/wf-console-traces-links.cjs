// WF-16 Console, Traces and History link to each other: a request sent from a saved request shows, in its Console
// entry, links to the saved request, its History entry and its trace (and Open as request); the trace names the same
// request and History entry; History's menu opens the request and the trace.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

/** A saved request against the demo server (run-e2e starts it on 127.0.0.1:4010). */
function prepare(ws) {
  const items = [{ kind: 'http', id: 'links-health', name: 'E2E links health', request: { method: 'GET', url: 'http://127.0.0.1:4010/health?links=1', headers: [] } }];
  writeFileSync(
    join(ws, 'collections', 'e2e-links.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-links', name: 'E2E links', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

const H = `
  const links = (root) => [...(root?.querySelectorAll('[data-related-refs] [data-ref-link]') ?? [])].map((a) => a.textContent.trim());
  const entry = () => vis('button[aria-expanded]').find((b) => /links=1/.test(b.textContent));
`;
const s = (name, body, shot) => step(name, body, shot, { extra: H });

const steps = [
  s(
    'send-from-saved',
    `await __t.requests();
     const r = await __t.find('E2E links health'); if (r !== 'ok') return r;
     const b = await __t.waitFor(() => button('Send') && !button('Send').disabled && button('Send'), 6000);
     if (!b) return 'NO BUTTON Send';
     b.click();
     const ok = await __t.waitFor(() => /\\b200\\b/.test(document.querySelector('main')?.innerText ?? ''), 8000);
     return 'sent: ' + !!ok;`,
  ),
  s(
    'console-entry-links',
    `const c = [...document.querySelectorAll('footer button')].find((x) => x.textContent.trim() === 'Console');
     if (!c) return 'NO BUTTON Console';
     if (!document.querySelector('[data-bottom-tab="console"][aria-selected="true"]')) c.click();
     const e = await __t.waitFor(entry, 5000);
     if (!e) return 'NO ENTRY';
     if (e.getAttribute('aria-expanded') !== 'true') e.click();
     const box = await __t.waitFor(() => e.parentElement.querySelector('[data-related-refs]'), 3000);
     return 'links: ' + links(e.parentElement).join(' | ');`,
  ),
  s(
    'console-opens-trace',
    `const a = [...(entry()?.parentElement.querySelectorAll('[data-related-refs] [data-ref-link="trace"]') ?? [])][0];
     if (!a) return 'NO LINK trace';
     a.click();
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'traces' && document.querySelector('[data-trace-view] [data-related-refs]'), 6000);
     return 'view: ' + localStorage.getItem('aps.view') + ' | trace links: ' + links(document.querySelector('[data-trace-view]')).join(' | ');`,
  ),
  s(
    'trace-opens-history',
    `const a = [...document.querySelectorAll('[data-trace-view] [data-related-refs] [data-ref-link="history"]')].find((x) => x.textContent.trim() === 'History entry');
     if (!a) return 'NO LINK History entry';
     a.click();
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'history' && /E2E links health/.test(document.querySelector('main')?.innerText ?? ''), 6000);
     return 'view: ' + localStorage.getItem('aps.view') + ' | selected: ' + /E2E links health/.test(vis('main .font-medium').map((x) => x.textContent).join(' '));`,
  ),
  s(
    'history-menu-links',
    `const more = vis('main [aria-label="More actions for E2E links health"]').pop();
     if (!more) return 'NO BUTTON ⋯';
     more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
     await __t.waitFor(() => document.querySelector('[role=menu]'), 2000);
     const items = [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.textContent.trim());
     [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((m) => m.textContent.trim() === 'Open request')?.click();
     await __t.waitFor(() => localStorage.getItem('aps.view') === 'rest', 5000);
     return 'menu: ' + items.join(' | ') + ' | view: ' + localStorage.getItem('aps.view');`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'send-from-saved': /^sent: true$/,
    'console-entry-links': /^links: E2E links health \| History entry \| Trace \| Open as request$/,
    'console-opens-trace': /^view: traces \| trace links: E2E links health \| History entry \| Open as request$/,
    'trace-opens-history': /^view: history \| selected: true$/,
    'history-menu-links': /^menu: Open request \| Open trace \| Copy link \| Save as test… \| Delete… \| view: rest$/,
  },
  { prepare },
);
