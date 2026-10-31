// RAG bots ▸ Start ▸ Try the sample (offline) (R-2): one click makes an offline bot (an MCP mock with four clinic
// documents), six questions and the evaluation with the offline demo model as the reviewer, runs it and opens the report
// under the RAG bots strip: "4 of 6 passed", with the two seeded failures. No key, no network, no server.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'start-page',
    `await __t.view('RAG bots'); await __t.sleep(1200);
     const tabs = [...document.querySelectorAll('[role=tablist][aria-label="RAG bots"] [role=tab]')].filter((t) => t.offsetParent).map((t) => t.textContent.trim()).join(',');
     const cards = vis('[data-start-card]').map((c) => c.getAttribute('data-start-card')).join(',');
     return 'tabs: ' + tabs + ' | cards: ' + cards + ' | sample: ' + vis('[data-rag-start-sample]')[0]?.textContent.trim() + ' | recent: ' + document.querySelector('[data-rag-start-recent]')?.getAttribute('data-rag-start-recent');`,
  ),
  step(
    'sample-in-one-click',
    `let clicks = 0;
     await __t.real.click(vis('[data-rag-start-sample]')[0]); clicks++;
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 60000);
     const item = document.querySelector('nav[aria-label="Main navigation"] [aria-current=page]')?.getAttribute('aria-label') ?? '?';
     const strip = [...document.querySelectorAll('[role=tablist][aria-label="RAG bots"] [role=tab]')].filter((t) => t.offsetParent).find((t) => t.getAttribute('aria-selected') === 'true')?.textContent.trim();
     const name = vis('main input[aria-label="Evaluation name"]')[0]?.value;
     return 'clicks: ' + clicks + ' | rail: ' + item + ' | tab: ' + strip + ' | name: ' + name + ' | headline: ' + (head ? head.textContent.trim() : 'NONE');`,
  ),
  step(
    'the-report-opens-on-the-two-goals-and-the-causes',
    `const goals = await __t.waitFor(() => document.querySelector('[data-eval-goals]'), 15000); if (!goals) return 'NO GOALS';
     const backed = document.querySelector('[data-eval-goal=backed]')?.textContent.trim();
     const found = document.querySelector('[data-eval-goal=found]')?.textContent.trim();
     const chips = [...document.querySelectorAll('[data-eval-causes] [data-chip]')].map((c) => c.textContent.trim().replace(/\\s+/g, ' ')).sort().join(' | ');
     const before = document.querySelectorAll('[data-eval-failure]').length;
     const chip = document.querySelector('[data-eval-causes] [data-chip=unfaithful]'); if (!chip) return 'NO CHIP unfaithful: ' + chips;
     await __t.real.click(chip); await __t.sleep(400);
     const only = [...document.querySelectorAll('[data-eval-failure]')].map((r) => r.getAttribute('data-eval-failure')).join(',');
     const pressed = chip.getAttribute('aria-pressed');
     await __t.real.click(chip); await __t.sleep(300);
     return backed + ' | ' + found + ' | chips: ' + chips + ' | failures: ' + before + ' → ' + only + ' (pressed ' + pressed + ') → ' + document.querySelectorAll('[data-eval-failure]').length;`,
  ),
  step(
    'a-sample-opens-by-stage',
    `const seg = vis('main [role=radio]').find((b) => b.textContent.trim() === 'Metrics'); if (!seg) return 'NO METRICS SWITCH';
     await __t.real.click(seg);
     const cell = await __t.waitFor(() => document.querySelector('[data-rag-cell*="booster|context-recall-ids"]'), 10000); if (!cell) return 'NO CELL';
     cell.scrollIntoView({ block: 'center' }); await __t.sleep(300);
     await __t.real.click(cell);
     const strip = await __t.waitFor(() => document.querySelector('[data-rag-stages]'), 8000); if (!strip) return 'NO STAGES';
     const stages = [...strip.querySelectorAll('[data-rag-stage]')].map((s) => s.getAttribute('data-rag-stage') + ':' + s.getAttribute('data-state')).join(',');
     const retrieved = strip.querySelector('[data-rag-stage=retrieved]')?.textContent.replace(/\\s+/g, ' ').trim();
     const start = strip.getAttribute('data-rag-stages');
     const missed = !!document.querySelector('[data-rag-missed]');
     const rightBtn = document.querySelector('[data-rag-chunk-labels] [data-chunk-label=relevant]');
     let marked = 'NO BUTTON'; if (rightBtn) { rightBtn.scrollIntoView({ block: 'center' }); await __t.sleep(300); await __t.real.click(rightBtn); await __t.waitFor(() => document.querySelector('[data-rag-chunk-labels] [data-chunk-label=relevant]')?.getAttribute('aria-pressed') === 'true', 3000); const again = document.querySelector('[data-rag-chunk-labels] [data-chunk-label=relevant]'); marked = again.getAttribute('aria-pressed') + ' / add row: ' + !!document.querySelector('[data-rag-add-right]'); }
     const cl = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close'); for (const b of cl.reverse()) { await __t.real.click(b); await __t.sleep(300); }
     return 'stages: ' + stages + ' | start here: ' + start + ' | ' + retrieved + ' | missed row: ' + missed + ' | marked right: ' + marked;`,
  ),
  // the questions and documents of the run placed by meaning (the offline demo model embeds): a plot, a sentence and the two findings
  step(
    'map-by-meaning',
    `const open = await __t.waitFor(() => vis('[data-rag-map-open]')[0], 6000); if (!open) return 'NO BUTTON';
     await __t.real.click(open);
     const draw = await __t.waitFor(() => vis('[data-embedding-draw]')[0], 5000); if (!draw) return 'NO DIALOG';
     await __t.real.click(draw);
     const plot = await __t.waitFor(() => document.querySelector('[data-embedding-plot]'), 15000); if (!plot) return 'NO PLOT: ' + (document.querySelector('[role=dialog]')?.innerText ?? '').slice(0, 200);
     const q = document.querySelectorAll('[data-embedding-point=question]').length;
     const docs = document.querySelectorAll('[data-embedding-point=right],[data-embedding-point=retrieved]').length;
     const text = document.querySelector('[data-embedding-text]')?.textContent ?? '';
     const findings = !!document.querySelector('[data-embedding-findings]');
     const cl = vis('[role=dialog] button').filter((x) => x.textContent.trim() === 'Close'); for (const b of cl.reverse()) { await __t.real.click(b); await __t.sleep(300); }
     return 'questions: ' + q + ' | documents: ' + (docs > 0) + ' | sentence: ' + /6 questions and \\d+ documents placed by meaning/.test(text) + ' | findings: ' + findings;`,
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
    `await __t.view('Home'); await __t.view('RAG bots'); await __t.sleep(1200);
     const tb = [...document.querySelectorAll('[role=tablist][aria-label="RAG bots"] [role=tab]')].find((t) => t.textContent.trim() === 'Start'); if (tb) { await __t.real.click(tb); await __t.sleep(800); }
     const row = await __t.waitFor(() => vis('[data-rag-start-run]')[0], 8000);
     return 'row: ' + (row ? row.textContent.replace(/\\s+/g, ' ').trim() : 'NONE');`,
  ),
];

module.exports = withExpect(steps, {
  'start-page': /^tabs: Start,Bots,Questions,Metrics,Checks \| cards: connect,questions,check,metrics \| sample: Try the sample \(offline\) \| recent: empty$/,
  'sample-in-one-click': /^clicks: 1 \| rail: RAG bots \| tab: Checks \| name: Sample: clinic bot \| headline: 4 of 6 passed/,
  'the-report-opens-on-the-two-goals-and-the-causes': /^Backed by the sources: 5 of 6 \| Right documents found: 5 of 6 \| chips: claim not backed by the sources1 \| right document not found1 \| failures: 2 → parking \(pressed true\) → 2$/,
  'a-sample-opens-by-stage': /^stages: question:info,retrieved:bad,used:info,answer:bad \| start here: retrieved \| 2Retrievedstart here1 document · right documents found 0 of 1 \| missed row: true \| marked right: true \/ add row: true$/,
  'map-by-meaning': /^questions: 6 \| documents: true \| sentence: true \| findings: true$/,
  'the-bot-and-its-mock-exist': /^target: mcp \| server: mock$/,
  'start-lists-the-run': /^row: Sample: clinic bot.*4 of 6 passed/,
});
