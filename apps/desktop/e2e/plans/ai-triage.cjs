// AI-2 · Explain and fix failures with AI, with real input: a collection run fails against the local demo server
// (127.0.0.1:4010: /health answers status "ok", the saved check expects "up"); right-click the run in the Tests view's
// runs list ▸ "Explain and fix failures with AI…", the dialog (the failures grouped, the estimate before anything is
// sent), Explain and fix (a scripted offline model answers with one cause and a check fix), the review (the finding with
// its evidence, the fix verified against the failing response), Apply (the saved request's check changes), then
// "Rerun the affected tests" runs the failed request again and it passes. Then the Problems list offers the same item.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';
const ANSWER = {
  summary: 'The health endpoint answers "ok" where the test expects "up".',
  causes: [
    {
      groups: ['g1'],
      kind: 'stale-test',
      title: 'Health answers "ok" now',
      explanation: 'The response has status "ok"; the check still expects "up".',
      confidence: 0.8,
      // a long unbroken fact (a URL with its query): the review wraps it instead of scrolling sideways
      evidence: ['$.status is "ok" in the failing response', `GET ${API}/health?probe=${'x'.repeat(220)} answered {"status":"ok"}`],
      fix: { type: 'check', check: { type: 'equals', path: '$.status', expected: 'up' }, newCheck: { type: 'equals', path: '$.status', expected: 'ok' } },
    },
  ],
};

/** A collection whose health check is stale, and the offline model's scripted triage. */
function prepare(ws) {
  writeFileSync(
    join(ws, 'collections', 'e2e-triage.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-triage',
        name: 'E2E Triage',
        version: 1,
        updatedAt: new Date().toISOString(),
        variables: [],
        items: [
          { kind: 'http', id: 'e2e-health', name: 'Health status', request: { method: 'GET', url: `${API}/health`, headers: [] }, assertions: [{ type: 'equals', path: '$.status', expected: 'up' }] },
          { kind: 'http', id: 'e2e-health-ok', name: 'Health answers', request: { method: 'GET', url: `${API}/health`, headers: [] }, assertions: [{ type: 'status', expected: 200 }] },
          { kind: 'http', id: 'e2e-health-down', name: 'Health is down', request: { method: 'GET', url: `${API}/health`, headers: [] }, assertions: [{ type: 'status', expected: 503 }] },
        ],
      },
      null,
      2,
    ),
  );
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([{ match: '"groups"', response: JSON.stringify(ANSWER) }, ...JSON.parse(rules.value)]);
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const dlg = () => document.querySelector('[data-ai-analysis="triage"]');
  const review = () => document.querySelector('[data-proposal]');
  const applied = () => document.querySelector('[data-triage-applied]');
  const finished = async (runId, ms = 30000) => { for (const end = Date.now() + ms; Date.now() < end; await __t.sleep(250)) { const s = await window.aps.invoke('runs.summary', { runId }); if (s) return s; } return undefined; };
  const runsTab = async () => { const t = [...document.querySelectorAll('[role=tablist][aria-label="Sidebar"] [role=tab]')].find((x) => x.offsetParent && x.textContent.trim().startsWith('Runs')); if (t) { t.click(); await __t.sleep(700); } return !!t; };
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'failing-collection-run',
    `const { runId } = await window.aps.invoke('col.run', { collectionId: 'e2e-triage', selection: ['e2e-health', 'e2e-health-ok'] });
     const s = await finished(runId); if (!s) return 'NO SUMMARY';
     window.__triageRun = runId;
     return 'run: ' + s.passed + ' passed, ' + s.failed + ' failed of ' + s.total;`,
  ),
  step(
    'right-click-run',
    `await __t.view('Tests'); if (!(await runsTab())) return 'NO RUNS TAB';
     const row = await __t.waitFor(() => document.querySelector('[data-run-row="' + window.__triageRun + '"]'), 6000); if (!row) return 'NO ROW';
     await __t.real.rightClick(row);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Explain and fix failures with AI…'), 3000); if (!item) return 'NO MENU ITEM';
     await __t.real.click(item);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const est = await __t.waitFor(() => /tokens in/.test(d.querySelector('[data-ai-analysis-estimate]')?.textContent ?? '') && d.querySelector('[data-ai-analysis-estimate]'), 10000);
     return 'subject: ' + short(d.querySelector('[data-ai-analysis-subject]')?.textContent, 140) + ' | estimate: ' + short(est?.textContent, 100);`,
  ),
  step(
    'explain-and-review',
    `const b = dlg()?.closest('[role=dialog]')?.querySelector('[data-ai-analyse]'); if (!b) return 'NO BUTTON';
     await __t.real.click(b);
     const r = await __t.waitFor(() => review(), 20000); if (!r) return 'NO REVIEW ' + short(document.querySelector('[data-ai-analysis-error]')?.textContent, 160);
     await __t.sleep(300);
     const f = r.querySelector('[data-finding]');
     const item = r.querySelector('[data-proposal-item]');
     const badge = item?.querySelector('[data-verification]');
     return 'finding: ' + f?.getAttribute('data-finding-kind') + ' ' + short(f?.querySelector('.font-medium')?.textContent, 40)
       + ' | evidence: ' + (f?.querySelectorAll('[aria-label=Evidence] li').length ?? 0)
       + ' | item: ' + short(item?.textContent.replace(/\\s+/g, ' '), 90)
       + ' | verified: ' + badge?.getAttribute('data-verifier') + '=' + badge?.getAttribute('data-verification')
       + ' | ticked: ' + !!item?.querySelector('input[type=checkbox]')?.checked;`,
  ),
  // the review never scrolls sideways: as it opens, in a narrower dialog and in compact density
  step(
    'review-fits',
    `const body = review()?.parentElement; if (!body) return 'NO REVIEW';
     const dialog = body.closest('[role=dialog]');
     const fits = () => body.scrollWidth <= body.clientWidth;
     const out = ['open ' + fits()];
     const width = dialog.style.width;
     dialog.style.width = '560px'; await __t.sleep(150); out.push('560px ' + fits());
     const density = document.documentElement.dataset.density;
     document.documentElement.dataset.density = 'compact'; await __t.sleep(150); out.push('compact ' + fits());
     document.documentElement.dataset.density = density; dialog.style.width = width; await __t.sleep(150);
     return 'fits: ' + out.join(', ');`,
  ),
  step(
    'apply-the-fix',
    `await __t.real.click(review().closest('[role=dialog]').querySelector('[data-proposal-accept]'));
     const a = await __t.waitFor(() => applied(), 8000); if (!a) return 'NOT APPLIED';
     const c = await window.aps.invoke('col.get', { id: 'e2e-triage' });
     return 'applied: ' + short(a.textContent, 60) + ' | check: ' + JSON.stringify(c.items[0].assertions.map((x) => ({ type: x.type, path: x.path, expected: x.expected }))) + ' | keys: ' + Object.keys(c.items[0].assertions[0]).sort().join(',');`,
  ),
  step(
    'rerun-passes',
    `const before = (await window.aps.invoke('runs.list', { limit: 5 })).items.map((r) => r.id);
     const b = applied()?.querySelector('[data-triage-rerun]'); if (!b) return 'NO RERUN BUTTON';
     await __t.real.click(b);
     let next;
     for (const end = Date.now() + 15000; Date.now() < end && !next; await __t.sleep(250)) next = (await window.aps.invoke('runs.list', { limit: 5 })).items.find((r) => !before.includes(r.id));
     if (!next) return 'NO NEW RUN';
     const s = await finished(next.id); if (!s) return 'NO SUMMARY';
     return 'rerun: ' + s.passed + '/' + s.total + ' passed · dialog closed: ' + !applied();`,
  ),
  step(
    'home-attention-offers-it',
    `const { runId } = await window.aps.invoke('col.run', { collectionId: 'e2e-triage', selection: ['e2e-health-down'] });
     await finished(runId);
     await __t.view('Home'); await __t.sleep(800);
     const card = document.querySelector('section[aria-label="Needs attention"]'); if (!card) return 'NO CARD';
     const row = await __t.waitFor(() => card.querySelector('[data-problem="run"]'), 6000); if (!row) return 'NO RUN PROBLEM';
     row.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.rightClick(row);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Explain and fix failures with AI…'), 3000); if (!item) return 'NO MENU ITEM';
     await __t.real.click(item);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const subject = await __t.waitFor(() => /failure/.test(d.querySelector('[data-ai-analysis-subject]')?.textContent ?? '') && d.querySelector('[data-ai-analysis-subject]'), 6000);
     await __t.esc(); await __t.sleep(300);
     return 'dialog for: ' + short(subject?.textContent, 140) + ' | closed: ' + !dlg();`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'failing-collection-run': /^run: 1 passed, 1 failed of 2$/,
    'right-click-run': /^subject: 1 failure ?in 1 group .*E2E Triage.* \| estimate: Offline demo model · demo \(on this computer\) · ≈ [\d,]+ tokens in/,
    'explain-and-review':
      /^finding: stale-test Health answers "ok" now \| evidence: [1-9]\d* \| item: .*Health status: equals \$\.status = "up" → equals \$\.status = "ok".* \| verified: fix=pass \| ticked: true$/,
    'review-fits': /^fits: open true, 560px true, compact true$/,
    'apply-the-fix': /^applied: Applied 1 fix\..* \| check: \[\{"type":"equals","path":"\$\.status","expected":"ok"\}\] \| keys: expected,path,type$/,
    'rerun-passes': /^rerun: 1\/1 passed · dialog closed: true$/,
    'home-attention-offers-it': /^dialog for: 1 failure ?in 1 group .*E2E Triage.* \| closed: true$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
