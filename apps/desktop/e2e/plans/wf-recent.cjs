// WF-10 Recent items and a nav history that names things: Recent places names what was open ("GET … · collection"),
// Home's "Pick up where you left off" lists the items opened lately, and Ctrl+Shift+T reopens the tab closed last.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

function prepare(ws) {
  const req = (id, name, method) => ({ kind: 'http', id, name, request: { method, url: `http://127.0.0.1:4010/health?${id}`, headers: [] } });
  const items = [req('rc-1', 'E2E recent one', 'GET'), req('rc-2', 'E2E recent two', 'POST'), req('rc-3', 'E2E recent three', 'DELETE')];
  writeFileSync(
    join(ws, 'collections', 'e2e-recent.json'),
    JSON.stringify({ schemaVersion: '1.0', id: 'e2e-recent', name: 'E2E recent', version: 1, updatedAt: new Date().toISOString(), variables: [], items }, null, 2),
  );
}

const H = `
  const press = (b) => { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); b.click(); };
  const tabs = () => [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].map((t) => t.textContent.trim());
`;

const steps = [
  step(
    'recent-places-names',
    `${H}
     await __t.requests(); await __t.expand('E2E recent');
     for (const n of ['E2E recent one', 'E2E recent two', 'E2E recent three']) { const r = await __t.open(n); if (r !== 'ok') return r; }
     await __t.view('Home');
     const b = document.querySelector('header button[aria-label="Recent places"]'); if (!b) return 'NO RECENT PLACES';
     press(b);
     const items = await __t.waitFor(() => { const m = [...document.querySelectorAll('[role=menuitem]')].map((x) => x.textContent.trim()); return m.length ? m : undefined; }, 3000);
     await __t.esc();
     return (items ?? []).filter((x) => /E2E recent/.test(x)).slice(0, 3).join(' | ');`,
  ),
  step(
    'home-pick-up',
    `const card = await __t.waitFor(() => [...document.querySelectorAll('section')].find((s) => /Pick up where you left off/.test(s.querySelector('header')?.textContent ?? '')), 3000);
     if (!card) return 'NO CARD';
     return [...card.querySelectorAll('[data-recent-item]')].slice(0, 3).map((r) => r.textContent.replace(/\\d+\\s*\\w+ ago|just now/, '').trim()).join(' | ');`,
  ),
  step(
    'reopen-closed-tab',
    `${H}
     await __t.requests();
     const before = tabs().filter((t) => /E2E recent three/.test(t)).length;
     const t = [...document.querySelectorAll('[role=tablist][aria-label="Open requests"] [role=tab]')].find((x) => /E2E recent three/.test(x.textContent));
     if (!t) return 'NO TAB: ' + tabs().join(', ');
     t.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })); await __t.sleep(800);
     const closed = tabs().filter((x) => /E2E recent three/.test(x)).length;
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true, bubbles: true }));
     await __t.waitFor(() => tabs().some((x) => /E2E recent three/.test(x)), 4000);
     return 'open ' + before + ' → closed ' + closed + ' → reopened ' + tabs().filter((x) => /E2E recent three/.test(x)).length;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'recent-places-names': /^DELETE E2E recent three · E2E recent \| POST E2E recent two · E2E recent \| GET E2E recent one · E2E recent$/,
    'home-pick-up': /^E2E recent threeRequest \| E2E recent twoRequest \| E2E recent oneRequest$/,
    'reopen-closed-tab': /^open 1 → closed 0 → reopened 1$/,
  },
  { prepare },
);
