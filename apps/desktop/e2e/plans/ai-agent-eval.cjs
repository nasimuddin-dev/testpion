// AU-19 · Agent checks in the UI: the Start page's "An agent uses tools" card opens the wizard with the agent kind chosen. Step 1 has
// the instructions and the tools editor (the example tools, MCP servers), step 2 the case table with Should call / Should not call
// columns, step 3 the ways to judge a run (the case columns are always checked; Try on case shows how each tool check did). Run saves
// the SAME evaluations file with type agent (tools, mcpServers) and runs it on the offline demo model: 2 of 3 pass when one case
// forbids the tool the task names.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const wiz = () => vis('[data-wizard]')[0];
  const stepId = () => wiz()?.getAttribute('data-wizard-step');
`;

const steps = [
  step(
    'the-agent-card-opens-the-wizard-as-an-agent',
    `${H} await __t.view('AI Lab'); await __t.sleep(1000);
     await __t.real.click(vis('[data-start-go=agent]')[0]);
     const w = await __t.waitFor(() => wiz(), 8000); if (!w) return 'NO WIZARD';
     await __t.sleep(800);
     const title = vis('[data-wizard-title]')[0]?.textContent.replace(/\\s+/g, ' ').trim();
     return 'title: ' + title + ' | step: ' + stepId() + ' | name: ' + vis('[data-wizard-name]')[0]?.value + ' | prompt box: ' + !!vis('[data-wizard-prompt]')[0] + ' | instructions: ' + !!vis('[data-wizard-instructions]')[0] + ' | tools editor: ' + !!vis('[data-agent-tools]')[0];`,
  ),
  step(
    'no-tools-says-what-to-do',
    `${H} const empty = vis('[data-agent-tools]')[0]?.innerText ?? '';
     return 'says: ' + /No tools yet/.test(empty) + ' | example button: ' + /Add the example tools/.test(empty) + ' | tool rows: ' + vis('[data-agent-tool]').length;`,
  ),
  step(
    'add-the-example-tools',
    `${H} const b = [...vis('[data-agent-tools] button')].find((x) => x.textContent.trim() === 'Add the example tools');
     await __t.real.click(b); await __t.sleep(500);
     return 'tools: ' + vis('[data-agent-tool]').map((r) => r.getAttribute('data-agent-tool')).join(',') + ' | add a tool: ' + !!vis('[data-agent-tool-add]')[0];`,
  ),
  step(
    'step-two-is-the-case-table-with-tool-columns',
    `${H} setValue(vis('[data-wizard-name]')[0], 'Agent tools'); await __t.sleep(300);
     await __t.real.click(vis('[data-wizard-next]')[0]);
     await __t.waitFor(() => stepId() === 'cases' && wiz().querySelector('[data-case-table]'), 6000);
     const heads = [...wiz().querySelectorAll('[role=columnheader]')].map((h) => h.textContent.trim()).join('|');
     return 'step: ' + stepId() + ' | cases: ' + wiz().querySelector('[data-case-table]')?.getAttribute('data-case-count') + ' | headings: ' + heads + ' | generate with AI: ' + !!wiz().querySelector('[data-cases-generate]');`,
  ),
  step(
    'one-case-forbids-the-tool-its-task-names',
    `${H} const cell = wiz().querySelector('[data-case="3"] [data-case-cell=should_not_call]');
     setValue(cell, 'search_docs'); await __t.sleep(500);
     return 'case 3 should not call: ' + wiz().querySelector('[data-case="3"] [data-case-cell=should_not_call]').value + ' | run label: ' + vis('[data-wizard-run]')[0]?.textContent.trim().replace(/\\s+/g, ' ');`,
  ),
  step(
    'step-three-judges-the-tools',
    `${H} await __t.real.click(vis('[data-wizard-next]')[0]);
     await __t.waitFor(() => stepId() === 'good' && wiz().querySelector('[data-pick]'), 6000);
     const picks = [...wiz().querySelectorAll('[data-pick]')].map((p) => p.getAttribute('data-pick') + (p.getAttribute('data-picked') === 'true' ? '+' : '-')).join(',');
     const always = wiz().querySelector('[data-pick=case-tools] input[type=checkbox]');
     await __t.real.click(wiz().querySelector('[data-pick=case-tools] [data-pick-try]'));
     const r = await __t.waitFor(() => wiz().querySelector('[data-pick=case-tools] [data-pick-result]'), 20000);
     const checks = [...wiz().querySelectorAll('[data-pick-case-check]')].map((c) => c.getAttribute('data-pick-case-check')).join(',');
     return 'picks: ' + picks + ' | always on and locked: ' + (always?.checked && always?.disabled) + ' | try case 1: ' + r?.getAttribute('data-pick-result') + ' | tool checks: ' + checks;`,
  ),
  step(
    'try-on-the-failing-case-shows-which-check-failed',
    `${H} const num = wiz().querySelector('input[aria-label="Case to try"]'); setValue(num, '3'); await __t.sleep(300);
     await __t.real.click(wiz().querySelector('[data-pick=case-tools] [data-pick-try]'));
     await __t.waitFor(() => [...wiz().querySelectorAll('[data-pick-case-check=failed]')].length > 0, 20000);
     return 'checks: ' + [...wiz().querySelectorAll('[data-pick-case-check]')].map((c) => c.getAttribute('data-pick-case-check') + ':' + c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40)).join(' || ');`,
  ),
  step(
    'run-saves-an-agent-evaluation-and-runs-it',
    `${H} await __t.real.click(vis('[data-wizard-run]')[0]);
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 60000);
     const item = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.name === 'Agent tools');
     const d = item?.data ?? {};
     const known = ['name', 'type', 'provider', 'model', 'temperature', 'system', 'prompt', 'format', 'datasetFormat', 'dataset', 'expectedField', 'evaluators', 'concurrency', 'limit', 'retries', 'tools', 'mcpServers', 'maxSteps'];
     return 'headline: ' + (head ? head.textContent.trim() : 'NONE') + ' | type: ' + d.type + ' | tools: ' + (d.tools ?? []).map((t) => t.name).join(',') + ' | prompt: ' + d.prompt + ' | columns: ' + Object.keys(JSON.parse(String(d.dataset).split('\\n')[0])).join(',') + ' | extra fields: ' + (Object.keys(d).filter((k) => !known.includes(k)).join(',') || 'none') + ' | wizard closed: ' + !wiz();`,
  ),
  step(
    'the-failed-case-shows-the-steps-the-agent-took',
    `${H} const open = await __t.waitFor(() => document.querySelector('[data-eval-trajectory-open]'), 8000); if (!open) return 'NO BUTTON Show the steps';
     await __t.real.click(open);
     const tl = await __t.waitFor(() => document.querySelector('[data-eval-trajectory] [data-step-timeline]'), 8000); if (!tl) return 'NO TIMELINE';
     const tools = tl.querySelectorAll('[data-step-kind=tool]');
     const redAtATool = [...tl.querySelectorAll('[data-step-kind=tool] [data-pin=bad]')].length;
     const kinds = [...tl.querySelectorAll('[data-step]')].map((s) => s.getAttribute('data-step-kind') ?? 'end').join(',');
     const text = document.querySelector('[data-eval-trajectory] p')?.textContent.trim();
     return 'tool steps: ' + (tools.length > 0) + ' | red pin on a call: ' + (redAtATool > 0) + ' | starts with the question: ' + kinds.startsWith('input') + ' | ends with the answer: ' + /answer(,end)?$/.test(kinds) + ' | ' + text;`,
  ),
  step(
    'the-full-editor-shows-the-agent-setup',
    `${H} const tb = [...vis('main [role=tab]')].find((t) => t.textContent.trim().startsWith('Tools'));
     if (!tb) return 'NO TOOLS TAB: ' + [...vis('main [role=tab]')].map((t) => t.textContent.trim()).join(',');
     await __t.real.click(tb); await __t.sleep(600);
     const type = vis('main select[aria-label="Evaluation type"]')[0];
     return 'type select: ' + type?.value + ' | tool rows: ' + vis('[data-agent-tool]').length + ' | instructions box: ' + !!vis('main textarea[aria-label="Instructions for the agent"]')[0];`,
  ),
  step(
    'the-estimate-reads-the-agent-evaluation',
    `${H} const item = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.name === 'Agent tools');
     const r = await window.aps.invoke('eval.estimate', { draft: item.data });
     return 'cases: ' + r.cases + ' | offline: ' + r.offline + ' | summary: ' + r.summary;`,
  ),
];
module.exports = withExpect(steps, {
  'the-agent-card-opens-the-wizard-as-an-agent': /^title: The agent uses the right tools\s*Step 1 of 3 \| step: what \| name: New agent evaluation \| prompt box: false \| instructions: true \| tools editor: true$/,
  'no-tools-says-what-to-do': /^says: true \| example button: true \| tool rows: 0$/,
  'add-the-example-tools': /^tools: search_docs,delete_record \| add a tool: true$/,
  'step-two-is-the-case-table-with-tool-columns': /^step: cases \| cases: 3 \| headings: Task for the agent\|Should call\|Should not call \| generate with AI: false$/,
  'one-case-forbids-the-tool-its-task-names': /^case 3 should not call: search_docs \| run label: Run 3 cases/,
  'step-three-judges-the-tools': /^picks: case-tools\+,tool-not-called-,max-tool-calls-,tool-args-valid-,contains- \| always on and locked: true \| try case 1: passed \| tool checks: passed,passed$/,
  'try-on-the-failing-case-shows-which-check-failed': /checks: passed:Should call: passed.* \|\| failed:Should not call: failed/,
  'run-saves-an-agent-evaluation-and-runs-it': /^headline: 2 of 3 passed \| type: agent \| tools: search_docs,delete_record \| prompt: \{\{input\}\} \| columns: input,should_call,should_not_call \| extra fields: none \| wizard closed: true$/,
  'the-failed-case-shows-the-steps-the-agent-took': /^tool steps: true \| red pin on a call: true \| starts with the question: true \| ends with the answer: true \| \d+ tool calls? .* in \d+ model calls?\.$/,
  'the-full-editor-shows-the-agent-setup': /^type select: agent \| tool rows: 2 \| instructions box: true$/,
  'the-estimate-reads-the-agent-evaluation': /^cases: 3 \| offline: true \| summary: 3 cases/,
});
