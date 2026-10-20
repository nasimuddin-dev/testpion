// AI-12 · "Ask…" natural-language search, with real input. History gets two entries from the demo server (one succeeds,
// one is a 404); the History filter bar's Ask… opens the one dialog (scoped to History); a typed question is translated
// by the scripted offline model into a query that TestPion validates and runs (the dialog says how it was understood,
// lists the assumptions, shows the editable chips and the hits); a chip is edited and removed by real clicks and typing,
// Search runs the edited query with no model; a hit opens its entry. The same dialog opens from Quick Open's `~` mode
// and its trailing Ask row, and from the top bar's search box; a question the model cannot translate falls back to a
// plain text search, saying why. Traces and Runs have the same Ask… button.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';
const FAILED = {
  query: {
    sources: ['history'],
    where: [
      { field: 'failed', op: 'eq', value: true },
      { field: 'name', op: 'contains', value: 'E2E ask' },
    ],
    sort: { by: 'time', dir: 'desc' },
    limit: 10,
  },
  assumptions: ['"missing" taken as a failed call'],
};
const NOT_FOUND = {
  query: {
    where: [
      { field: 'status', op: 'eq', value: 404 },
      { field: 'name', op: 'contains', value: 'E2E ask' },
    ],
  },
  assumptions: [],
};

/** The offline model answers the two questions this plan asks with a query; anything else it cannot translate. */
function prepare(ws) {
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([
    { match: 'Question: .*missing calls', response: JSON.stringify(FAILED) },
    { match: 'Question: .*404 calls', response: JSON.stringify(NOT_FOUND) },
    ...JSON.parse(rules.value),
  ]);
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const dlg = () => document.querySelector('[data-ask-dialog]');
  const hits = () => [...document.querySelectorAll('[data-ask-hit]')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim());
  const waitHits = (n, ms = 15000) => __t.waitFor(() => (document.querySelector('[data-ask-results]') && document.querySelectorAll('[data-ask-hit]').length === n ? true : null), ms);
  const askInput = () => document.querySelector('[data-ask-input]');
  // the scope line names the sources once the field catalog has arrived
  const scoped = async (re) => { await __t.waitFor(() => (re.test(dlg()?.textContent ?? '') ? true : null), 3000); return re.test(dlg()?.textContent ?? ''); };
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'seed-history',
    `await window.aps.invoke('http.send', { name: 'E2E ask health', request: { method: 'GET', url: '${API}/health', headers: [] } });
     await window.aps.invoke('http.send', { name: 'E2E ask missing', request: { method: 'GET', url: '${API}/no-such-endpoint-for-ask', headers: [] } }).catch(() => undefined);
     const l = await window.aps.invoke('history.list', { query: 'E2E ask', limit: 10 });
     return 'entries: ' + l.items.map((e) => e.name + '=' + e.status).sort().join(', ');`,
  ),
  step(
    'ask-button-in-history',
    `await __t.rail('History'); await __t.sleep(600);
     const b = await __t.waitFor(() => vis('[data-ask-button]')[0], 5000); if (!b) return 'NO BUTTON Ask…';
     await __t.real.click(b);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     return 'dialog: ' + !!d + ' | scope: ' + (await scoped(/Asking within History\\./)) +' | focus: ' + (document.activeElement === askInput());`,
  ),
  step(
    'ask-a-question',
    `await __t.real.type('E2E missing calls last week');
     await __t.real.key('Enter');
     if (!(await waitHits(1))) return 'NO RESULTS ' + short(dlg()?.textContent, 300);
     const chips = [...document.querySelectorAll('[data-ask-chip]')].map((c) => c.getAttribute('data-ask-chip'));
     return 'explain: ' + short(document.querySelector('[data-ask-explain]')?.textContent, 140)
       + ' | assumed: ' + short(document.querySelector('[data-ask-assumptions]')?.textContent, 60)
       + ' | chips: ' + chips.join(',')
       + ' | hits: ' + hits().map((h) => short(h, 60)).join(' ; ')
       + ' | model: ' + /Offline demo model/.test(dlg().textContent);`,
  ),
  step(
    'edit-a-chip',
    `// the value of "name contains": select it and type another word, Enter runs the query again (no model)
     const input = [...document.querySelectorAll('[data-ask-chip="name:contains"] input')][0]; if (!input) return 'NO INPUT chip';
     await __t.real.click(input); input.select();
     await __t.real.type('health');
     await __t.real.key('Enter');
     const none = await __t.waitFor(() => /Nothing matches/.test(document.querySelector('[data-ask-results]')?.textContent ?? '') && true, 8000);
     return 'failed AND name contains health → ' + (none ? 'nothing' : 'NO EMPTY ' + hits().join(';')) + ' | edited badge: ' + /edited/.test(dlg().textContent) + ' | explain: ' + short(document.querySelector('[data-ask-explain]')?.textContent, 120);`,
  ),
  step(
    'remove-a-chip',
    `const rm = document.querySelector('[data-ask-chip="failed:eq"] button[aria-label="Remove this filter"]'); if (!rm) return 'NO BUTTON remove';
     await __t.real.click(rm);
     await __t.real.click(document.querySelector('[data-ask-run]'));
     if (!(await waitHits(1))) return 'NO RESULTS ' + short(dlg()?.textContent, 300);
     return 'chips: ' + document.querySelectorAll('[data-ask-chip]').length + ' | hits: ' + hits().map((h) => short(h, 50)).join(' ; ') + ' | explain: ' + short(document.querySelector('[data-ask-explain]')?.textContent, 120);`,
  ),
  step(
    'invalid-edit-is-refused',
    `// an empty value never reaches the engine: the dialog says which filter to fix
     const input = document.querySelector('[data-ask-chip="name:contains"] input'); input.focus(); input.select(); await __t.real.key('Backspace');
     await __t.real.click(document.querySelector('[data-ask-run]'));
     const p = await __t.waitFor(() => document.querySelector('[data-ask-problem]'), 4000); if (!p) return 'NO PROBLEM';
     return 'problem: ' + short(p.textContent, 100);`,
  ),
  step(
    'open-a-hit',
    `const input = document.querySelector('[data-ask-chip="name:contains"] input'); await __t.real.click(input); await __t.real.type('E2E ask health');
     await __t.real.click(document.querySelector('[data-ask-run]'));
     if (!(await waitHits(1))) return 'NO RESULTS ' + short(dlg()?.textContent, 300);
     await __t.real.click(document.querySelector('[data-ask-hit]'));
     const gone = await __t.waitFor(() => !dlg() && true, 4000);
     await __t.sleep(600);
     return 'dialog closed: ' + !!gone + ' | entry shown: ' + document.body.textContent.includes('E2E ask health');`,
  ),
  step(
    'quick-open-ask-mode',
    `await __t.real.key('p', { ctrl: true });
     const pal = await __t.waitFor(() => document.querySelector('[role=dialog] input[placeholder]'), 3000); if (!pal) return 'NO PALETTE';
     await __t.real.type('~show 404 calls');
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-command="ask"]')][0], 3000); if (!row) return 'NO ROW Ask';
     const label = short(row.textContent, 80);
     await __t.real.key('Enter');
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     if (!(await waitHits(1))) return 'NO RESULTS ' + short(dlg()?.textContent, 300);
     return 'row: ' + label + ' | question: ' + askInput().value + ' | explain: ' + short(document.querySelector('[data-ask-explain]')?.textContent, 110) + ' | hit: ' + short(hits()[0], 50) + ' | scope note: ' + /Asking within/.test(d.textContent);`,
  ),
  step(
    'palette-trailing-ask-row',
    `await __t.esc(); await __t.sleep(300);
     await __t.real.key('p', { ctrl: true });
     await __t.waitFor(() => document.querySelector('[role=dialog] input[placeholder]'), 3000);
     await __t.real.type('no-such-item-zzz');
     const row = await __t.waitFor(() => [...document.querySelectorAll('[data-command="ask"]')][0], 5000); if (!row) return 'NO ROW Ask';
     const last = [...document.querySelectorAll('[role=dialog] [role=option]')].at(-1) === row;
     await __t.real.click(row);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     return 'last row: ' + last + ' | asks: ' + askInput().value;`,
  ),
  step(
    'unknown-question-falls-back-to-text',
    `// the scripted model has no query for this one: its answer is not a query, so the words are searched as typed
     const fb = await __t.waitFor(() => document.querySelector('[data-ask-fallback]'), 20000); if (!fb) return 'NO FALLBACK ' + short(dlg()?.textContent, 300);
     return 'fallback: ' + short(fb.textContent, 110) + ' | plain badge: ' + /plain text/.test(dlg().textContent) + ' | explain: ' + short(document.querySelector('[data-ask-explain]')?.textContent, 90);`,
  ),
  step(
    'search-box-ask-row',
    `await __t.esc(); await __t.sleep(400);
     await __t.real.click('[data-search-trigger]');
     const box = await __t.waitFor(() => document.querySelector('[role=dialog][aria-label="Search"] input'), 3000); if (!box) return 'NO INPUT search';
     await __t.real.type('zzz-nothing-matches');
     const row = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog][aria-label="Search"] [role=option]')].find((o) => /^Ask:/.test(o.textContent.trim())), 4000); if (!row) return 'NO ROW Ask';
     await __t.real.key('Enter');
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     return 'dialog from the search box: ' + !!d + ' | asks: ' + askInput().value;`,
  ),
  step(
    'traces-and-runs-have-the-button',
    `await __t.esc(); await __t.sleep(400);
     await __t.rail('Traces'); await __t.sleep(700);
     const t = await __t.waitFor(() => vis('[data-ask-button]')[0], 5000); if (!t) return 'NO BUTTON Ask… in Traces';
     await __t.real.click(t);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const traces = await scoped(/Asking within Traces\\./);
     await __t.esc(); await __t.sleep(400);
     await __t.rail('Tests'); await __t.sleep(900);
     // the runs list is the Runs tab of the Tests view (the page's tabs, or its sidebar's)
     const runsTab = await __t.waitFor(() => tab('Runs') ?? vis('[role=tab]').find((x) => x.textContent.trim().startsWith('Runs')), 4000); if (!runsTab) return 'NO TAB Runs';
     await __t.real.click(runsTab); await __t.sleep(700);
     const r = await __t.waitFor(() => vis('[data-ask-button]')[0], 5000); if (!r) return 'NO BUTTON Ask… in Runs';
     await __t.real.click(r);
     const d2 = await __t.waitFor(() => dlg(), 4000); if (!d2) return 'NO DIALOG runs';
     return 'traces scope: ' + traces + ' | runs scope: ' + (await scoped(/Asking within Runs and Test results\\./));`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'seed-history': /^entries: E2E ask health=200, E2E ask missing=404$/,
    'ask-button-in-history': /^dialog: true \| scope: true \| focus: true$/,
    'ask-a-question':
      /^explain: Looking in History where failed is yes and name contains "E2E ask"; newest first, at most 10\. \| assumed: "missing" taken as a failed call \| chips: failed:eq,name:contains \| hits: History.*E2E ask missing.* \| model: true$/,
    'edit-a-chip': /^failed AND name contains health → nothing \| edited badge: true \| explain: Looking in History where failed is yes and name contains "health"/,
    'remove-a-chip': /^chips: 1 \| hits: History.*E2E ask health.* \| explain: Looking in History where name contains "health"/,
    'invalid-edit-is-refused': /^problem: Give "Name" a valid value, or remove the filter\.$/,
    'open-a-hit': /^dialog closed: true \| entry shown: true$/,
    'quick-open-ask-mode':
      /^row: Ask: “show 404 calls”.* \| question: show 404 calls \| explain: Looking in History where status is 404 and name contains "E2E ask"; newest first, at most 25\. \| hit: History.*E2E ask missing.* \| scope note: false$/,
    'palette-trailing-ask-row': /^last row: true \| asks: no-such-item-zzz$/,
    'unknown-question-falls-back-to-text': /^fallback: .*not valid.* \| plain badge: true \| explain: Looking in History, Runs, Test results, Traces where text contains "no-such-item-zzz"/,
    'search-box-ask-row': /^dialog from the search box: true \| asks: zzz-nothing-matches$/,
    'traces-and-runs-have-the-button': /^traces scope: true \| runs scope: true$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
