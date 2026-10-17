// AI-1 · An integration flow from a folder, with real input: right-click a folder ▸ "Generate integration flow with
// AI…", the dialog (the folder preselected, the estimate before anything is sent), Generate (a scripted offline model
// answers with a plan naming the saved requests by id, plus one invented request), the review (canvas preview marked
// AI-generated, assumptions, the dropped step, verification badges, Try on mock), Accept writes the file, and Run now
// runs it against the local demo server (127.0.0.1:4010). Then the flow canvas's "Generate with AI" opens the same dialog.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, stepWith } = require('../lib.cjs');

const API = 'http://127.0.0.1:4010';
const PLAN = {
  name: 'Job queue lifecycle',
  summary: 'Starts a job, then reads it back by the id the start returned.',
  assumptions: ['POST /jobs answers with the new job id in $.id'],
  steps: [
    {
      id: 'start-job',
      request: 'e2e-start-job',
      extract: { jobId: '$.id' },
      assertions: [
        { type: 'status', expected: 201 },
        { type: 'exists', path: '$.id' },
      ],
    },
    {
      id: 'read-job',
      request: 'e2e-get-job',
      dependsOn: ['start-job'],
      url: `${API}/jobs/{{jobId}}`,
      assertions: [
        { type: 'status', expected: 200 },
        { type: 'equals', path: '$.id', expected: '{{jobId}}' },
      ],
    },
    { id: 'refund-job', request: 'e2e-refund-invented' },
  ],
};

/** A collection with a "Job queue" folder (saved examples, so a mock can serve it) and a "Health checks" folder; the offline model's scripted plan. */
function prepare(ws) {
  const ex = (status, body) => ({ id: `ex-${status}`, name: String(status), status, headers: [{ key: 'content-type', value: 'application/json' }], body: JSON.stringify(body) });
  writeFileSync(
    join(ws, 'collections', 'e2e-ai-flows.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-ai-flows',
        name: 'E2E AI flows',
        version: 1,
        updatedAt: new Date().toISOString(),
        variables: [],
        items: [
          {
            kind: 'folder',
            id: 'e2e-jobs',
            name: 'Job queue',
            items: [
              { kind: 'http', id: 'e2e-start-job', name: 'Start a job', request: { method: 'POST', url: `${API}/jobs`, headers: [] }, examples: [ex(201, { id: 'job-1', status: 'running' })] },
              {
                kind: 'http',
                id: 'e2e-get-job',
                name: 'Get a job',
                request: { method: 'GET', url: `${API}/jobs/job-1`, headers: [] },
                examples: [ex(200, { id: 'job-1', status: 'running', polls: 1 })],
              },
            ],
          },
          { kind: 'folder', id: 'e2e-health', name: 'Health checks', items: [{ kind: 'http', id: 'e2e-health-get', name: 'Health', request: { method: 'GET', url: `${API}/health`, headers: [] } }] },
        ],
      },
      null,
      2,
    ),
  );
  const p = join(ws, 'providers.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  const rules = c.providers.find((x) => x.id === 'demo').headers.find((h) => h.key === 'x-mock-rules');
  rules.value = JSON.stringify([{ match: '"source"', response: JSON.stringify(PLAN) }, ...JSON.parse(rules.value)]);
  writeFileSync(p, JSON.stringify(c, null, 2));
}

const H = `
  const dlg = () => document.querySelector('[data-flow-generate-dialog]');
  const review = () => document.querySelector('[data-flow-proposal]');
  const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));
  const toastButton = (re, label) => [...document.querySelectorAll('[data-sonner-toast]')].find((t) => re.test(t.textContent))?.querySelector('button[data-button]') ?? [...document.querySelectorAll('[data-sonner-toast] button')].find((b) => b.textContent.trim() === label);
`;
const step = stepWith({ extra: H });

const steps = [
  step(
    'right-click-folder',
    `await __t.requests(); await __t.expand('E2E AI flows');
     const row = await __t.waitFor(() => [...document.querySelectorAll('aside [data-tree-row]')].find((r) => r.offsetParent && r.textContent.includes('Job queue')), 4000); if (!row) return 'NO ROW Job queue';
     await __t.real.rightClick(row);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === 'Generate integration flow with AI…'), 3000); if (!item) return 'NO MENU item';
     await __t.real.click(item);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const est = await __t.waitFor(() => /tokens in/.test(d.querySelector('[data-flow-estimate]')?.textContent ?? '') && d.querySelector('[data-flow-estimate]'), 10000);
     const folder = d.querySelector('select[aria-label="Folder"]');
     return 'folder: ' + folder?.selectedOptions[0]?.textContent.trim() + ' | estimate: ' + short(est?.textContent, 120);`,
  ),
  step(
    'generate-and-review',
    `const g = dlg()?.closest('[role=dialog]')?.querySelector('[data-flow-generate]'); if (!g) return 'NO BUTTON Generate';
     await __t.real.click(g);
     const r = await __t.waitFor(() => review()?.querySelector('[data-flow-node]') && review(), 20000); if (!r) return 'NO REVIEW ' + short(dlg()?.querySelector('[role=alert]')?.textContent, 200);
     await __t.sleep(400);
     const badges = [...r.querySelectorAll('[data-flow-proposal-badges] [data-verification]')].map((b) => b.getAttribute('data-verifier') + '=' + b.getAttribute('data-verification')).join(',');
     return 'label: ' + short(r.querySelector('[data-flow-proposal-label]')?.textContent, 20)
       + ' | nodes: ' + r.querySelectorAll('[data-flow-node]').length
       + ' | badges: ' + badges
       + ' | assumed: ' + short(r.querySelector('[data-flow-proposal-assumptions] li')?.textContent, 80)
       + ' | dropped: ' + /Dropped step "refund-job"/.test(r.querySelector('[data-flow-proposal-notes]')?.textContent ?? '');`,
  ),
  step(
    'try-on-mock',
    `const b = review().closest('[role=dialog]').querySelector('[data-proposal-try-mock]'); if (!b) return 'NO BUTTON Try on mock';
     await __t.real.click(b);
     const badge = await __t.waitFor(() => review().querySelector('[data-verifier="flow-mock"]'), 15000);
     return 'mock: ' + short(badge?.textContent, 80) + ' | nothing written: ' + !(await window.aps.invoke('tests.read', { path: 'flows/e2e-ai-flows-job-queue.yaml' }).catch(() => ''));`,
  ),
  step(
    'accept-writes-the-file',
    `await __t.real.click(review().closest('[role=dialog]').querySelector('[data-proposal-accept]'));
     const t = await __t.waitFor(() => toastText(/Saved tests\\/flows\\//), 8000); if (!t) return 'NO TOAST';
     const text = await window.aps.invoke('tests.read', { path: 'flows/e2e-ai-flows-job-queue.yaml' }).catch((e) => 'ERR ' + e.message);
     return 'toast: ' + short(t, 80) + ' | review open: ' + !!review() + ' | file: ' + /^# AI-generated by TestPion/.test(text) + ',' + /read-job/.test(text) + ',' + /jobs\\/\\{\\{jobId\\}\\}/.test(text) + ',' + !/refund/.test(text);`,
  ),
  step(
    'run-now-passes',
    `const b = toastButton(/Saved tests\\/flows\\//, 'Run now'); if (!b) return 'NO BUTTON Run now';
     await __t.real.click(b);
     let run, seen = [];
     for (const end = Date.now() + 30000; Date.now() < end && !run; await __t.sleep(300)) {
       const items = (await window.aps.invoke('runs.list', { limit: 5 })).items;
       seen = items.map((x) => x.name);
       const r = items.find((x) => /e2e-ai-flows-job-queue/.test(x.name));
       if (r && r.total && r.passed + r.failed + r.errors >= r.total) run = r;
     }
     return run ? 'run: ' + run.passed + '/' + run.total + ' passed, ' + run.failed + ' failed, ' + run.errors + ' errors' : 'NO RUN (runs: ' + seen.join(', ') + ')';`,
  ),
  step(
    'canvas-generate-with-ai',
    `await window.aps.invoke('tests.write', { path: 'flows/e2e-empty.yaml', content: 'name: Empty\\ntests: []\\n' });
     await __t.view('Tests'); await __t.sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('e2e-empty.yaml')), 4000);
     if (!r) return 'NO ROW e2e-empty.yaml'; r.click(); await __t.sleep(1200);
     await __t.tab('Flow');
     const s = await __t.waitFor(() => document.querySelector('[data-flow-suggestion="ai"]'), 6000); if (!s) return 'NO SUGGESTION';
     await __t.real.click(s);
     const d = await __t.waitFor(() => dlg(), 4000); if (!d) return 'NO DIALOG';
     const modes = [...d.querySelectorAll('[role=radio]')].map((x) => x.textContent.trim() + (x.getAttribute('aria-checked') === 'true' ? '*' : '')).slice(0, 2).join(' / ');
     await __t.esc(); await __t.sleep(300);
     return 'modes: ' + modes + ' | closed: ' + !dlg();`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'right-click-folder': /^folder: Job queue \(2\) \| estimate: .*2 requests.*Offline demo model · demo \(on this computer\) · ≈ [\d,]+ tokens in/,
    'generate-and-review': /^label: AI-generated \| nodes: 2 \| badges: test-file=pass,flow-vars=pass,flow-mock=pass \| assumed: POST \/jobs answers with the new job id in \$\.id \| dropped: true$/,
    'try-on-mock': /^mock: 2\/2 steps pass on a mock of E2E AI flows \| nothing written: true$/,
    'accept-writes-the-file': /^toast: Saved tests\/flows\/e2e-ai-flows-job-queue\.yaml.* \| review open: false \| file: true,true,true,true$/,
    'run-now-passes': /^run: 2\/2 passed, 0 failed, 0 errors$/,
    'canvas-generate-with-ai': /^modes: From a collection or folder \/ Describe in words\* \| closed: true$/,
  },
  { settings: { assistantProvider: 'demo', assistantModel: 'demo' }, prepare },
);
