// The down arrow on the rest of the outputs (planning/output-export.md, release B): real clicks on the shared control of
// History, Traces, a Debugger exchange, an MCP resource / prompt / protocol trace, the AI Playground's answer and the
// model comparison, Git changes, an API lint report, a chart, the environment matrix, a monitor's runs, the runs list,
// the workspace report, collection documentation and Settings ▸ About's diagnostics — and the bytes the Save-as dialog
// (answered by E2E_STUB_SAVE) received: each file is checked for its format and for what must not be in it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { join } = require('node:path');
const { withExpect, stepOf } = require('../lib.cjs');

const DEMO = 'http://127.0.0.1:4010';
const LEAK = 'sk-e2e-leak-0123456789abcdef';

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const dl = (id) => vis('[data-output-download="' + id + '"]')[0];
  const toasts = () => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim());
  const savedToasts = () => [...document.querySelectorAll('[data-sonner-toast]')].filter((t) => / saved to /.test(t.textContent));
  const newSaved = async (seen, ms) => { const t = await __t.waitFor(() => savedToasts().find((x) => !seen.has(x)) ?? null, ms); return t ? t.textContent.trim() : null; };
  const clearToasts = async () => {
    const open = [...document.querySelectorAll('[data-sonner-toast] [aria-label="Close toast"]')];
    open.forEach((c) => c.click());
    if (open.length) await __t.waitFor(() => (document.querySelector('[data-sonner-toast]') ? null : true), 3000);
  };
  /** Click the down arrow (or a format from its ▾ menu) with the real mouse; the toast that says where it went. */
  const save = async (id, label) => {
    await clearToasts();
    const seen = new Set(savedToasts());
    if (label) {
      const menu = vis('[data-output-formats="' + id + '"]')[0]; if (!menu) return 'NO MENU BUTTON ' + id;
      await __t.real.click(menu);
      const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith(label)), 3000);
      if (!item) return 'NO FORMAT ' + label + ': ' + vis('[role=menuitem]').map((m) => m.textContent.trim()).join(' | ');
      await __t.real.click(item);
    } else {
      const b = await __t.waitFor(() => (dl(id) && !dl(id).disabled ? dl(id) : null), 15000); if (!b) return 'NO DOWNLOAD ' + id;
      await __t.real.click(b);
    }
    const t = await newSaved(seen, 20000);
    return t ? 'saved: ' + t.replace(/ to .*[\\\\/]/, ' to …/').slice(0, 120) : 'NO TOAST ' + toasts().slice(-2).join(' / ');
  };
  /** The formats a control offers (its ▾ menu), as labels. */
  const formats = async (id) => {
    const menu = vis('[data-output-formats="' + id + '"]')[0]; if (!menu) return 'NO MENU BUTTON ' + id;
    await __t.real.click(menu);
    const items = await __t.waitFor(() => { const m = vis('[role=menuitem]').map((x) => x.textContent.trim()); return m.length ? m : null; }, 3000);
    await __t.real.key('Escape'); await __t.sleep(200);
    return items ?? [];
  };
`;
const step = stepOf(H);
/** A step in the main process: the file the stubbed Save-as dialog got. */
const file = (name, check) => [
  name,
  `main:const fs = require('node:fs'); const p = process.env.E2E_STUB_SAVE; if (!fs.existsSync(p)) return 'NO FILE'; if (fs.existsSync(p + '.part')) return 'PART LEFT'; const buf = fs.readFileSync(p); const text = buf.toString('utf8'); ${check}`,
  false,
];

const steps = [
  // ---- History and Traces
  step(
    'history-har',
    `await window.aps.invoke('http.send', { name: 'e2e history', request: { method: 'GET', url: '${DEMO}/echo?n=7&api_key=${LEAK}', headers: [] } });
     await __t.view('History'); await __t.sleep(800);
     return await save('history');`,
  ),
  file('history-har-file', `const h = JSON.parse(text); return 'har ' + h.log.version + ' | entries: ' + (h.log.entries.length >= 1) + ' | key in a URL: ' + h.log.entries.some((e) => e.request.url.includes('${LEAK}'));`),
  step('history-csv', `return await save('history', 'List (CSV)');`),
  file('history-csv-file', `const l = text.split('\\r\\n'); return 'header: ' + l[0] + ' | rows: ' + (l.length > 2) + ' | key leaked: ' + text.includes('${LEAK}');`),
  step(
    'traces-otlp',
    `await __t.view('Traces'); await __t.sleep(800);
     return await save('traces');`,
  ),
  file('traces-otlp-file', `const t = JSON.parse(text); return 'resourceSpans: ' + (Array.isArray(t.resourceSpans) && t.resourceSpans.length > 0);`),
  step(
    'traces-selected',
    `const row = vis('main button').find((b) => /\\d+ spans?/.test(b.textContent)); if (!row) return 'NO ROW';
     row.click(); await __t.sleep(800);
     return await save('traces', 'Selected trace');`,
  ),
  file(
    'traces-selected-file',
    `const t = JSON.parse(text); const spans = t.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)); return 'one trace: ' + (new Set(spans.map((s) => s.traceId)).size === 1);`,
  ),

  // ---- a Debugger exchange (a request a mock server received)
  step(
    'debugger-exchange-text',
    `await window.aps.invoke('col.save', {
       schemaVersion: '1.0', id: 'e2e-mocked', name: 'E2E mocked', version: 0, variables: [], updatedAt: '',
       items: [{ kind: 'http', id: 'm1', name: 'Create pet', request: { method: 'POST', url: 'http://api.test/pets' },
         examples: [{ id: 'ex1', name: 'Created', status: 201, headers: [{ key: 'content-type', value: 'application/json', enabled: true }], body: '{"id":7,"name":"Rex"}' }] }],
     });
     const info = await window.aps.invoke('mock.start', { collectionId: 'e2e-mocked' });
     await window.aps.invoke('http.send', { request: { method: 'POST', url: info.url + '/pets?source=e2e', headers: [{ key: 'Authorization', value: 'Bearer e2e-secret-token-0123456789', enabled: true }, { key: 'Content-Type', value: 'application/json', enabled: true }], body: { type: 'json', content: '{"name":"Rex"}' } } });
     await __t.view('Debugger'); await __t.sleep(800);
     vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Incoming requests'))?.click(); await __t.sleep(600);
     const row = await __t.waitFor(() => vis('main [data-incoming-row]').find((x) => x.textContent.includes('/pets')), 4000); if (!row) return 'NO ROW';
     row.click(); await __t.sleep(800);
     return await save('debugger.exchange');`,
  ),
  file(
    'debugger-exchange-text-file',
    `return 'request line: ' + /POST \\/pets\\?source=e2e/.test(text) + ' | status line: ' + /HTTP\\/1\\.1 201/.test(text) + ' | token leaked: ' + text.includes('e2e-secret-token');`,
  ),
  step('debugger-exchange-har', `return await save('debugger.exchange', 'HAR (this exchange)');`),
  file(
    'debugger-exchange-har-file',
    `const e = JSON.parse(text).log.entries[0]; return 'status: ' + e.response.status + ' | method: ' + e.request.method + ' | token leaked: ' + text.includes('e2e-secret-token');`,
  ),
  step('debugger-exchange-body', `return await save('debugger.exchange', 'Response body');`),
  file('debugger-exchange-body-file', `return 'body: ' + text.trim();`),

  // ---- MCP: a resource, a prompt, the protocol trace (the offline mock server of the examples)
  step(
    'mcp-resource',
    `await __t.requests(); if ((await __t.open('Weather (offline')) !== 'ok') return 'NO ROW Weather'; await __t.sleep(800);
     if (!(await __t.button('Connect'))) return 'NO BUTTON Connect';
     if (!(await __t.waitFor(() => vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Resources')), 8000))) return 'NO TAB Resources';
     await __t.tab('Resources');
     const r = await __t.waitFor(() => vis('main button').find((b) => b.textContent.includes('Weather stations')), 3000); if (!r) return 'NO ROW';
     r.click(); await __t.sleep(1200);
     return await save('mcp.resource');`,
  ),
  file('mcp-resource-file', `const v = JSON.parse(text); return 'stations: ' + v.map((s) => s.city).join(',');`),
  step(
    'mcp-prompt',
    `await __t.tab('Prompts');
     const r = await __t.waitFor(() => vis('main button').find((b) => b.textContent.includes('packing_list')), 3000); if (!r) return 'NO ROW';
     r.click(); await __t.sleep(400);
     const input = vis('main input').find((i) => i.closest('[class*="flex-col"]') && (i.getAttribute('aria-label') ?? '').includes('city') || i.getAttribute('name') === 'city') ?? vis('main input')[vis('main input').length - 1];
     if (input) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Paris'); input.dispatchEvent(new Event('input', { bubbles: true })); }
     await __t.button('Get prompt'); await __t.sleep(1500);
     return await save('mcp.prompt', 'Conversation (Markdown)');`,
  ),
  file('mcp-prompt-file', `return 'heading: ' + text.startsWith('# packing_list') + ' | user: ' + text.includes('## user');`),
  step('mcp-trace', `await __t.tab('Protocol trace'); await __t.sleep(600); return await save('mcp.trace');`),
  file(
    'mcp-trace-file',
    `const lines = text.trim().split('\\n').map((l) => JSON.parse(l)); return 'messages: ' + (lines.length >= 2) + ' | methods: ' + lines.map((l) => l.method).includes('initialize');`,
  ),

  // ---- AI: the Playground's answer and the model comparison (the offline demo model)
  step(
    'ai-answer',
    `await __t.view('AI Lab'); await __t.sleep(800);
     vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Playground'))?.click(); await __t.sleep(600);
     if (!(await __t.button('Run'))) return 'NO BUTTON Run';
     await __t.waitFor(() => /Latency/.test(document.querySelector('main')?.innerText ?? ''), 20000); await __t.sleep(400);
     return await save('ai.answers');`,
  ),
  file('ai-answer-file', `return 'answer: ' + (text.length > 20) + ' | footer: ' + /_[^_]+ · /.test(text);`),
  step(
    'ai-comparison',
    `vis('main [role=tab]').find((t) => t.textContent.trim().startsWith('Model comparison'))?.click(); await __t.sleep(600);
     await __t.button('Run comparison'); await __t.sleep(5000);
     return await save('ai.compare', 'Measurements (CSV)');`,
  ),
  file('ai-comparison-file', `return 'header: ' + text.split('\\r\\n')[0].split(',').slice(0, 3).join(',') + ' | rows: ' + (text.split('\\r\\n').length > 2);`),

  // ---- Git changes (a repository the plan makes: a tracked file then changed)
  [
    'git-repository',
    `main:
      const { execFileSync } = require('node:child_process'); const { join } = require('node:path'); const fs = require('node:fs');
      const ws = join(home, 'ws');
      const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', '-c', 'commit.gpgsign=false', ...a], { cwd: ws, stdio: 'pipe' });
      git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'base');
      fs.appendFileSync(join(ws, 'tests', 'offline.suite.yaml'), '\\n# changed by the e2e plan\\n');
      return 'repository ready';`,
    false,
  ],
  step(
    'git-changes-patch',
    `await __t.view('Git'); await __t.sleep(1500);
     if (!(await __t.waitFor(() => vis('main [aria-label="Changes"] li').length, 8000))) return 'NO CHANGES LISTED';
     return await save('git.diff');`,
  ),
  file('git-changes-patch-file', `return 'diff: ' + text.startsWith('diff --git') + ' | the change: ' + text.includes('+# changed by the e2e plan');`),
  step('git-changes-markdown', `return await save('git.diff', 'What changed');`),
  file('git-changes-markdown-file', `return 'text: ' + (text.length > 0);`),

  // ---- an API report (the lint tab of an API definition)
  step(
    'api-lint-report',
    `await __t.requests(); await __t.find('petstore.json'); await __t.sleep(800);
     await __t.tab('Lint');
     if (!(await __t.waitFor(() => vis('main [data-api-lint] [data-lint-rule]').length, 6000))) return 'NO LINT ROWS';
     return await save('api.reports');`,
  ),
  file('api-lint-report-file', `return 'document: ' + text.startsWith('# API lint:') + ' | table: ' + text.includes('| severity |');`),
  step('api-lint-json', `return await save('api.reports', 'Data (JSON)');`),
  file('api-lint-json-file', `const v = JSON.parse(text); return 'problems: ' + (v.problems.length > 0) + ' | counts: ' + Object.keys(v.counts).join(',');`),

  // ---- collection documentation
  step(
    'collection-docs-markdown',
    `await __t.requests(); await __t.find('GET with query parameters'); await __t.sleep(600);
     vis('nav[aria-label="Where this request is saved"] button')[0]?.click(); await __t.sleep(1500);
     await __t.tab('Docs'); await __t.sleep(1200);
     return await save('collection.docs');`,
  ),
  file('collection-docs-markdown-file', `return 'markdown: ' + (text.length > 100 && text.startsWith('#'));`),
  step('collection-docs-html', `return await save('collection.docs', 'HTML page');`),
  file('collection-docs-html-file', `return 'html: ' + /^<!doctype html>/i.test(text.trimStart());`),

  // ---- environments: the matrix
  step(
    'environment-matrix',
    `await window.aps.invoke('env.save', { env: { id: 'e2e-second', name: 'E2E second', variables: [{ key: 'httpbin', value: 'https://example.test', enabled: true }, { key: 'onlyHere', value: '1', enabled: true }] } });
     await __t.view('Environments'); await __t.sleep(1200);
     if (!(await __t.button('Matrix'))) return 'NO BUTTON Matrix';
     await __t.sleep(1200);
     return await save('env.matrix');`,
  ),
  file('environment-matrix-file', `const l = text.split('\\r\\n'); return 'header: ' + l[0].split(',')[0] + ' | rows: ' + (l.length > 2) + ' | statuses only: ' + !/demo-password|password123|demo-token/.test(text);`),

  // ---- the workspace report (Home), the runs list, a monitor's runs, charts, diagnostics
  step(
    'workspace-report',
    `await __t.view('Home'); await __t.sleep(1200);
     return await save('workspace.report');`,
  ),
  file('workspace-report-file', `return 'html: ' + /^<!doctype html>/i.test(text.trimStart()) + ' | no script: ' + !/<script/i.test(text);`),
  step(
    'chart-png',
    `const cards = vis('[data-output="chart"]'); if (!cards.length) return 'NO CHART';
     const b = cards[0].querySelector('[data-output-download]'); await __t.real.click(b);
     const seen = new Set(); const t = await newSaved(seen, 15000);
     return t ? 'saved: ' + t.slice(0, 40) : 'NO TOAST';`,
  ),
  file('chart-png-file', `return 'png: ' + (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') + ' | size: ' + (buf.length > 500);`),
  step(
    'chart-svg',
    `const card = vis('[data-output="chart"]').find((c) => c.querySelector('svg') && c.querySelector('[data-output-formats]')); if (!card) return 'NO CHART WITH A PLOT';
     await clearToasts(); const seen = new Set(savedToasts());
     await __t.real.click(card.querySelector('[data-output-formats]'));
     const item = await __t.waitFor(() => vis('[role=menuitem]').find((m) => m.textContent.trim().startsWith('Plot (SVG)')), 3000); if (!item) return 'NO FORMAT Plot (SVG)';
     await __t.real.click(item);
     const t = await newSaved(seen, 15000);
     return t ? 'saved: ' + t.slice(0, 40) : 'NO TOAST';`,
  ),
  file('chart-svg-file', `return 'svg: ' + /<svg[^>]*xmlns="http:\\/\\/www.w3.org\\/2000\\/svg"/.test(text) + ' | colours resolved: ' + !/var\\(--/.test(text);`),
  step(
    'runs-list',
    `await window.aps.invoke('tests.run', { paths: ['offline.suite.yaml'] });
     let runs = 0; for (let i = 0; i < 120 && !runs; i++) { runs = (await window.aps.invoke('runs.list', { limit: 1 })).total ?? 0; if (!runs) await __t.sleep(500); } if (!runs) return 'NO RUN';
     await __t.sleep(1500);
     await __t.view('Tests'); await __t.sleep(900);
     [...document.querySelectorAll('[role=tab]')].filter((x) => x.getClientRects().length && x.textContent.trim().startsWith('Runs')).pop()?.click(); await __t.sleep(1200);
     const ok = await __t.waitFor(() => dl('runs.overview'), 3000);
     return ok ? await save('runs.overview') : 'NO DOWNLOAD runs.overview (needs a run: ' + (await window.aps.invoke('runs.list', { limit: 1 })).total + ' runs)';`,
  ),
  file('runs-list-file', `const l = text.split('\\r\\n'); return 'header: ' + l[0].split(',').slice(0, 3).join(',');`),
  step(
    'diagnostics',
    `await __t.view('Settings'); await __t.sleep(800);
     vis('main [role=tab]').find((t) => t.textContent.trim() === 'About')?.click(); await __t.sleep(600);
     return await save('settings.diagnostics');`,
  ),
  file('diagnostics-file', `return 'first line: ' + /^TestPion /.test(text) + ' | home folder replaced: ' + !text.includes(require('node:os').homedir());`),

  // ---- one control, one look (the new controls too), and none left over
  step(
    'every-control-looks-the-same',
    `const all = [...document.querySelectorAll('[data-output-download]')];
     const shapes = new Set(all.map((b) => b.className + '|' + (b.querySelector('svg')?.getAttribute('class') ?? '')));
     const labels = all.every((b) => /^Download /.test(b.getAttribute('aria-label') ?? '') || /^Saving /.test(b.getAttribute('aria-label') ?? ''));
     return 'controls: ' + (all.length >= 1) + ' | one look: ' + (shapes.size === 1) + ' | labelled: ' + labels;`,
  ),
  [
    'clean-up',
    `(async () => { await window.aps.invoke('mock.stop', { collectionId: 'e2e-mocked' }).catch(() => undefined); await window.aps.invoke('col.delete', { id: 'e2e-mocked' }).catch(() => undefined); await window.aps.invoke('env.delete', { id: 'e2e-second' }).catch(() => undefined); return 'done'; })()`,
    false,
  ],
];

module.exports = withExpect(
  steps,
  {
    'history-har': /^saved: History saved to …\/output\.out/,
    'history-har-file': /^har 1\.2 \| entries: true \| key in a URL: false$/,
    'history-csv': /^saved: History saved/,
    'history-csv-file': /^header: time,kind,name,method,url,status,durationMs,size \| rows: true \| key leaked: false$/,
    'traces-otlp': /^saved: Traces saved/,
    'traces-otlp-file': /^resourceSpans: true$/,
    'traces-selected': /^saved: Traces saved/,
    'traces-selected-file': /^one trace: true$/,
    'debugger-exchange-text': /^saved: Exchange saved/,
    'debugger-exchange-text-file': /^request line: true \| status line: true \| token leaked: false$/,
    'debugger-exchange-har': /^saved: Exchange saved/,
    'debugger-exchange-har-file': /^status: 201 \| method: POST \| token leaked: false$/,
    'debugger-exchange-body': /^saved: Exchange saved/,
    'debugger-exchange-body-file': /^body: \{"id":7,"name":"Rex"\}$/,
    'mcp-resource': /^saved: Resource saved/,
    'mcp-resource-file': /^stations: Paris,London$/,
    'mcp-prompt': /^saved: Prompt saved/,
    'mcp-prompt-file': /^heading: true \| user: true$/,
    'mcp-trace': /^saved: Protocol trace saved/,
    'mcp-trace-file': /^messages: true \| methods: true$/,
    'ai-answer': /^saved: Answer saved/,
    'ai-answer-file': /^answer: true \| footer: true$/,
    'ai-comparison': /^saved: Model comparison saved/,
    'ai-comparison-file': /^header: model,latencyMs,firstTokenMs \| rows: true$/,
    'git-changes-patch': /^saved: Changes saved/,
    'git-changes-patch-file': /^diff: true \| the change: true$/,
    'git-changes-markdown': /^saved: Changes saved/,
    'git-changes-markdown-file': /^text: true$/,
    'api-lint-report': /^saved: Lint report saved/,
    'api-lint-report-file': /^document: true \| table: true$/,
    'api-lint-json': /^saved: Lint report saved/,
    'api-lint-json-file': /^problems: true \| counts: error,warning,info$/,
    'collection-docs-markdown': /^saved: Documentation saved/,
    'collection-docs-markdown-file': /^markdown: true$/,
    'collection-docs-html': /^saved: Documentation saved/,
    'collection-docs-html-file': /^html: true$/,
    'environment-matrix': /^saved: Environment matrix saved/,
    'environment-matrix-file': /^header: variable \| rows: true \| statuses only: true$/,
    'workspace-report': /^saved: Workspace report saved/,
    'workspace-report-file': /^html: true \| no script: true$/,
    'chart-png': /^saved: /,
    'chart-png-file': /^png: true \| size: true$/,
    'chart-svg': /^saved: /,
    'chart-svg-file': /^svg: true \| colours resolved: true$/,
    'runs-list': /^saved: Runs list saved/,
    'runs-list-file': /^header: id,name,startedAt$/,
    diagnostics: /^saved: Diagnostics saved/,
    'diagnostics-file': /^first line: true \| home folder replaced: true$/,
    'every-control-looks-the-same': /^controls: true \| one look: true \| labelled: true$/,
  },
  { env: (out) => ({ E2E_STUB_SAVE: join(out, 'output.out') }) },
);
