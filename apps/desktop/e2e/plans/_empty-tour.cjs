// Not part of the suite (the _ prefix): screenshots of every view in a new, empty workspace — what a person meets first.
const { withExpect, step } = require('../lib.cjs');

const view = (label) =>
  step(`empty-${label.toLowerCase().replace(/\W+/g, '-')}`, `await __t.view(${JSON.stringify(label)}); await __t.sleep(900); return short(document.querySelector('main')?.innerText, 260);`);

const steps = [
  step('new-workspace', `const w = await window.aps.invoke('ws.create', { name: 'Empty tour' }); await __t.sleep(1500); return 'workspace: ' + w.name;`),
  ...['Home', 'Collections', 'Tests', 'Monitors', 'Load', 'AI Lab', 'Evaluations', 'Environments', 'History', 'Traces', 'Git', 'Debugger'].map(view),
];

module.exports = withExpect(steps, { 'new-workspace': /^workspace: Empty tour$/ });
