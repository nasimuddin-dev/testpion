// WF-22 An onboarding path that follows the loops: a new workspace's Home shows Get started as the first loop — Send
// → Save → Save as test → Run → Run in CI — ticked from what the workspace holds (a request sent and saved ticks two),
// each button opening what its step builds on, and the other loops offered as walk-throughs.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const card = () => document.querySelector('section[aria-label="Get started"]');
  const steps = () => [...(card()?.querySelectorAll('[data-get-started] li') ?? [])].map((li) => (li.querySelector('[aria-label="done"]') ? '✓' : '○') + li.textContent.replace(/^\\d+\\.\\s*/, '').split(/[.:]/)[0].replace(/^\\d+\\.\\s*/, '').trim());
`;

const steps = [
  [
    'fresh-workspace',
    `main:const { BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows()[0];
     await w.webContents.executeJavaScript("window.aps.invoke('ws.create', { name: 'E2E onboarding' })");
     w.webContents.reload(); await new Promise((r) => setTimeout(r, 6000)); return 'reloaded';`,
    false,
  ],
  step(
    'the-first-loop',
    `${H}
     const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const v = fn(); if (v) return v; } };
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, altKey: true, bubbles: true }));
     const c = await until(() => card()?.querySelectorAll('[data-get-started] li').length === 5 && card(), 15000); if (!c) return 'NO CARD';
     const walk = [...document.querySelectorAll('[data-walkthroughs] button')].map((b) => b.textContent.trim()).filter((t) => t !== '(guide)' && t !== 'Hide');
     return c.querySelectorAll('[aria-label="done"]').length + ' done | walk-throughs: ' + walk.join(', ');`,
  ),
  step(
    'ticked-from-the-workspace',
    `${H}
     const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const v = await fn(); if (v) return v; } };
     // a request saved in a collection, and one sent: Send and Save are done
     await window.aps.invoke('col.save', { schemaVersion: '1.0', id: 'e2e-ob', name: 'E2E onboarding API', version: 0, updatedAt: '', variables: [], items: [{ kind: 'http', id: 'ob-1', name: 'Health', request: { method: 'GET', url: 'http://127.0.0.1:4010/health', headers: [] } }] });
     await window.aps.invoke('http.send', { request: { method: 'GET', url: 'http://127.0.0.1:4010/health', headers: [] } }).catch(() => undefined);
     // Home reloads what changed when it is shown again
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, altKey: true, bubbles: true })); await new Promise((r) => setTimeout(r, 600));
     window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, altKey: true, bubbles: true }));
     const n = await until(() => (card()?.querySelectorAll('[aria-label="done"]').length ?? 0) >= 2 && card().querySelectorAll('[aria-label="done"]').length, 8000);
     const done = [...card().querySelectorAll('[data-get-started] li')].filter((li) => li.querySelector('[aria-label="done"]')).map((li) => li.querySelector('.font-medium').textContent.replace(/^\\d+\\.\\s*/, '').trim());
     return (n ?? 0) + ' done: ' + done.join(', ');`,
  ),
  step(
    'save-as-test-opens-the-request',
    `${H}
     const li = [...card().querySelectorAll('[data-get-started] li')].find((x) => /Save it as a test/.test(x.textContent)); if (!li) return 'NO STEP';
     li.querySelector('button').click();
     const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const v = fn(); if (v) return v; } };
     await until(() => localStorage.getItem('aps.view') === 'rest', 5000);
     return 'view: ' + localStorage.getItem('aps.view');`,
  ),
];

module.exports = withExpect(steps, {
  'the-first-loop': /^0 done \| walk-throughs: Debug a failing test, Capture traffic into requests, Collaborate through git$/,
  'ticked-from-the-workspace': /^2 done: Send a request, Save it in a collection$/,
  'save-as-test-opens-the-request': /^view: rest$/,
});
