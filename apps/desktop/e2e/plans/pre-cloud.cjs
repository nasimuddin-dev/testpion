// The features of 0.58: Recently deleted for a saved prompt (the one remove and restore), Uses and used by… on a
// request's row, the Type column of an environment's variables with a value that does not fit, the API catalog from the
// Collections header, and a failed run's menu with Repro bundle… and Create issue… (the drafted issue in its dialog).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';

/** A collection with a failing check and a request that names an environment's variable; an environment with a typed variable that does not fit. */
function prepare(ws) {
  const http = (id, name, url, assertions) => ({ kind: 'http', id, name, request: { method: 'GET', url, headers: [], params: [] }, assertions });
  writeFileSync(
    join(ws, 'collections', 'e2e-pc.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-pc',
        name: 'E2E Catalog API',
        description: 'The API the 0.58 plan runs.',
        version: 1,
        updatedAt: new Date().toISOString(),
        variables: [],
        items: [
          http('e2e-pc-health', 'Health status', `${API}/health`, [{ type: 'equals', path: '$.status', expected: 'up' }]),
          http('e2e-pc-uses', 'Uses a variable', '{{pcBase}}/health', []),
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(ws, 'environments', 'e2e-pc-env.json'),
    JSON.stringify(
      {
        id: 'e2e-pc-env',
        name: 'E2E PC env',
        variables: [
          { key: 'pcBase', value: API, enabled: true },
          { key: 'port', value: 'abc', valueType: 'number', enabled: true },
          { key: 'retries', value: '3', valueType: 'number', enabled: true },
        ],
      },
      null,
      2,
    ),
  );
}

const H = `
  const node = (id) => document.querySelector('aside [data-node-id="' + id + '"]');
  const toggleOf = (r) => (r?.hasAttribute('aria-expanded') ? r : r?.querySelector('[aria-expanded]'));
  const unfold = async (id) => { const r = await __t.waitFor(() => node(id), 5000); const t = toggleOf(r); if (t && t.getAttribute('aria-expanded') === 'false') { t.click(); await __t.sleep(400); } return r; };
  const items = () => [...document.querySelectorAll('[role=menuitem]')];
  const dialog = (title) => [...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes(title));
  const finished = async (runId, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(250)) { const s = await window.aps.invoke('runs.summary', { runId }); if (s) return s; } return undefined; };
  const runsTab = async () => { const t = [...document.querySelectorAll('[role=tablist][aria-label="Sidebar"] [role=tab]')].find((x) => x.offsetParent && x.textContent.trim().startsWith('Runs')); if (t) { t.click(); await __t.sleep(700); } return !!t; };
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'a-saved-prompt-goes-to-recently-deleted-and-comes-back',
    `const lib = await window.aps.invoke('lib.get', { kind: 'ai-prompts' });
     await window.aps.invoke('lib.save', { kind: 'ai-prompts', library: { etag: lib.etag, folders: lib.folders, items: [...lib.items, { id: 'e2e-pc-prompt', name: 'E2E deleted prompt', data: { messages: [{ role: 'user', content: 'hello' }] } }] } });
     const gone = await window.aps.invoke('item.remove', { ref: { kind: 'saved', library: 'ai-prompts', itemId: 'e2e-pc-prompt' } });
     const inLib = async () => (await window.aps.invoke('lib.get', { kind: 'ai-prompts' })).items.some((i) => i.id === 'e2e-pc-prompt');
     const after = await inLib();
     const listed = (await window.aps.invoke('trash.list')).find((t) => t.id === gone.trashId);
     const back = await window.aps.invoke('item.restore', { trashId: gone.trashId });
     const restored = await inLib();
     // clean-up: the prompt goes for good
     const now = await window.aps.invoke('lib.get', { kind: 'ai-prompts' });
     await window.aps.invoke('lib.save', { kind: 'ai-prompts', library: { etag: now.etag, folders: now.folders, items: now.items.filter((i) => i.id !== 'e2e-pc-prompt') } });
     return 'removed: ' + gone.kind + ' "' + gone.name + '" | still listed: ' + after + ' | in the trash: ' + (listed?.kind ?? 'no') + ' "' + (listed?.name ?? '') + '" | restored: ' + back.id + ' ' + restored;`,
  ),
  step(
    'uses-and-used-by-on-a-request',
    `await __t.requests(); await __t.sleep(800);
     await unfold('e2e-pc');
     const row = await __t.waitFor(() => node('e2e-pc:e2e-pc-uses'), 5000); if (!row) return 'NO ROW';
     await __t.real.rightClick(row);
     const item = await __t.waitFor(() => items().find((m) => m.textContent.trim() === 'Uses and used by…'), 3000); if (!item) { const all = items().map((m) => m.textContent.trim()).join(' | '); await __t.esc(); return 'NO MENU ITEM: ' + all; }
     await __t.real.click(item);
     const d = await __t.waitFor(() => { const x = dialog('Uses and used by'); return x && /It uses/.test(x.textContent) ? x : null; }, 8000); if (!d) return 'NO DIALOG';
     const uses = [...d.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === 'It uses');
     const out = 'uses: ' + [...(uses?.querySelectorAll('li') ?? [])].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()).filter((t) => /E2E PC env/.test(t)).join(' ; ');
     await __t.esc();
     return out;`,
  ),
  step(
    'a-typed-variable-that-does-not-fit-is-marked',
    `await __t.view('Environments'); await __t.sleep(600);
     const env = await __t.waitFor(() => [...document.querySelectorAll('[role=treeitem], button, [data-node-id]')].find((x) => x.offsetParent && x.textContent.trim().startsWith('E2E PC env')), 6000); if (!env) return 'NO ENVIRONMENT ROW';
     env.click(); await __t.sleep(700);
     const bad = await __t.waitFor(() => document.querySelector('main [data-type-problem="port"]'), 6000); if (!bad) return 'NO PROBLEM CELL';
     const types = [...document.querySelectorAll('main select[aria-label^="Type of "]')].filter((s) => s.offsetParent);
     const of = (key) => types.find((s) => s.getAttribute('aria-label') === 'Type of ' + key);
     return 'problem: ' + bad.getAttribute('title') + ' | types: ' + ['pcBase', 'port', 'retries'].map((k) => k + '=' + (of(k)?.value ?? '?') + (of(k)?.getAttribute('aria-invalid') ? '!' : '')).join(',') + ' | other problems: ' + (document.querySelectorAll('main [data-type-problem]').length - 1);`,
  ),
  step(
    'the-api-catalog-from-the-collections-header',
    `await __t.requests(); await __t.sleep(600);
     const b = await __t.waitFor(() => document.querySelector('aside button[aria-label="API catalog"]'), 5000); if (!b) return 'NO BUTTON';
     await __t.real.click(b);
     const card = await __t.waitFor(() => document.querySelector('[data-catalog] [data-catalog-api="e2e-pc"]'), 10000); if (!card) return 'NO CARD ' + (dialog('API catalog')?.textContent.slice(0, 120) ?? 'no dialog');
     const text = card.textContent.replace(/\\s+/g, ' ');
     const out = 'card: ' + /E2E Catalog API/.test(text) + ' | 2 requests: ' + /2 requests/.test(text) + ' | summary: ' + /The API the 0\\.58 plan runs/.test(text) + ' | environment: ' + /E2E PC env/.test(text) + ' | save: ' + !!dialog('API catalog') ?.textContent.includes('Save as a page');
     await __t.esc();
     return out;`,
  ),
  step(
    'a-failing-run',
    `const { runId } = await window.aps.invoke('col.run', { collectionId: 'e2e-pc', selection: ['e2e-pc-health'] });
     const s = await finished(runId); if (!s) return 'NO SUMMARY';
     window.__pcRun = runId;
     return 'run: ' + s.passed + ' passed, ' + s.failed + ' failed of ' + s.total;`,
  ),
  step(
    'the-run-menu-offers-a-repro-bundle-and-an-issue',
    `await __t.view('Tests'); if (!(await runsTab())) return 'NO RUNS TAB';
     const row = await __t.waitFor(() => document.querySelector('[data-run-row="' + window.__pcRun + '"]'), 6000); if (!row) return 'NO ROW';
     await __t.real.rightClick(row);
     const issue = await __t.waitFor(() => items().find((m) => m.textContent.trim() === 'Create issue…'), 3000);
     const repro = items().find((m) => m.textContent.trim() === 'Repro bundle…');
     if (!issue) { const all = items().map((m) => m.textContent.trim()).join(' | '); await __t.esc(); return 'NO MENU ITEM: ' + all; }
     await __t.real.click(issue);
     const d = await __t.waitFor(() => document.querySelector('[data-issue-draft]'), 10000); if (!d) return 'NO DIALOG';
     const title = d.querySelector('input[aria-label="Issue title"]')?.value ?? '';
     const body = d.querySelector('textarea[aria-label="Issue text"]')?.value ?? '';
     const out = 'repro item: ' + !!repro + ' | title: ' + title + ' | body names the step: ' + /## Health status/.test(body) + ' | to reproduce: ' + /### To reproduce/.test(body) + ' | copy: ' + !!dialog('Create issue')?.textContent.includes('Copy as Markdown');
     await __t.esc();
     return out;`,
  ),
  step(
    'clean-up',
    `await window.aps.invoke('col.delete', { id: 'e2e-pc' }).catch(() => undefined);
     await window.aps.invoke('item.remove', { ref: { kind: 'environment', environmentId: 'e2e-pc-env' } }).catch(() => undefined);
     return 'done';`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'a-saved-prompt-goes-to-recently-deleted-and-comes-back': /^removed: prompt "E2E deleted prompt" \| still listed: false \| in the trash: prompt "E2E deleted prompt" \| restored: e2e-pc-prompt true$/,
    'uses-and-used-by-on-a-request': /^uses: environment ?E2E PC env ?defines \{\{pcBase\}\}/,
    'a-typed-variable-that-does-not-fit-is-marked': /^problem: The value is not a number: "abc" \| types: pcBase=string,port=number!,retries=number \| other problems: 0$/,
    'the-api-catalog-from-the-collections-header': /^card: true \| 2 requests: true \| summary: true \| environment: true \| save: true$/,
    'a-failing-run': /^run: 0 passed, 1 failed of 1$/,
    'the-run-menu-offers-a-repro-bundle-and-an-issue': /^repro item: true \| title: Health status: .+ \| body names the step: true \| to reproduce: true \| copy: true$/,
    'clean-up': /^done$/,
  },
  { prepare },
);
