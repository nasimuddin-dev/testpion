// Bots with sources ▸ Start ▸ Try the sample (offline) (R-2): one click makes an offline bot (an MCP mock with four clinic
// documents), six questions and the evaluation with the offline demo model as the reviewer, runs it and opens the report
// under the Bots with sources strip: "4 of 6 passed", with the two seeded failures. No key, no network, no server.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'start-page',
    `await __t.view('Bots with sources'); await __t.sleep(1200);
     const tabs = [...document.querySelectorAll('[role=tablist][aria-label="Bots with sources"] [role=tab]')].filter((t) => t.offsetParent).map((t) => t.textContent.trim()).join(',');
     const cards = vis('[data-start-card]').map((c) => c.getAttribute('data-start-card')).join(',');
     return 'tabs: ' + tabs + ' | cards: ' + cards + ' | sample: ' + vis('[data-rag-start-sample]')[0]?.textContent.trim() + ' | recent: ' + document.querySelector('[data-rag-start-recent]')?.getAttribute('data-rag-start-recent');`,
  ),
  step(
    'sample-in-one-click',
    `let clicks = 0;
     await __t.real.click(vis('[data-rag-start-sample]')[0]); clicks++;
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 60000);
     const item = document.querySelector('nav[aria-label="Main navigation"] [aria-current=page]')?.getAttribute('aria-label') ?? '?';
     const strip = [...document.querySelectorAll('[role=tablist][aria-label="Bots with sources"] [role=tab]')].filter((t) => t.offsetParent).find((t) => t.getAttribute('aria-selected') === 'true')?.textContent.trim();
     const name = vis('main input[aria-label="Evaluation name"]')[0]?.value;
     return 'clicks: ' + clicks + ' | rail: ' + item + ' | tab: ' + strip + ' | name: ' + name + ' | headline: ' + (head ? head.textContent.trim() : 'NONE');`,
  ),
  step(
    'the-bot-and-its-mock-exist',
    `const targets = await window.aps.invoke('rag.targets');
     const servers = (await window.aps.invoke('mcp.servers').catch(() => ({ servers: [] })));
     const list = Array.isArray(servers) ? servers : (servers.servers ?? []);
     return 'target: ' + (targets.find((t) => t.name === 'Clinic bot (offline)')?.protocol ?? 'NONE') + ' | server: ' + (list.find((s) => s.id === 'clinic-bot')?.transport ?? 'NONE');`,
  ),
  step(
    'start-lists-the-run',
    `await __t.view('Home'); await __t.view('Bots with sources'); await __t.sleep(1200);
     const tb = [...document.querySelectorAll('[role=tablist][aria-label="Bots with sources"] [role=tab]')].find((t) => t.textContent.trim() === 'Start'); if (tb) { await __t.real.click(tb); await __t.sleep(800); }
     const row = await __t.waitFor(() => vis('[data-rag-start-run]')[0], 8000);
     return 'row: ' + (row ? row.textContent.replace(/\\s+/g, ' ').trim() : 'NONE');`,
  ),
];

module.exports = withExpect(steps, {
  'start-page': /^tabs: Start,Bots,Questions,Metrics,Checks \| cards: connect,questions,check,metrics \| sample: Try the sample \(offline\) \| recent: empty$/,
  'sample-in-one-click': /^clicks: 1 \| rail: Bots with sources \| tab: Checks \| name: Sample: clinic bot \| headline: 4 of 6 passed/,
  'the-bot-and-its-mock-exist': /^target: mcp \| server: mock$/,
  'start-lists-the-run': /^row: Sample: clinic bot.*4 of 6 passed/,
});
