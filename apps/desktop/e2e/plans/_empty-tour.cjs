// Not part of the suite (the _ prefix): screenshots of every view in a new, empty workspace — what a person meets first.
const { withExpect } = require('../lib.cjs');

const short = (s, n = 260) => `String(${s} ?? '').replace(/\\s+/g, ' ').trim().slice(0, ${n})`;
const view = (label) => [
  `empty-${label.toLowerCase().replace(/\\W+/g, '-')}`,
  `(async () => { await __t.view(${JSON.stringify(label)}); await __t.sleep(900); return ${short("document.querySelector('main')?.innerText")}; })()`,
];

const steps = [
  ['new-workspace', `(async () => { const w = await window.aps.invoke('ws.create', { name: 'Empty tour' }); await __t.sleep(1500); return 'workspace: ' + w.name; })()`],
  view('Home'),
  view('Collections'),
  view('Tests'),
  view('Monitors'),
  view('Load'),
  view('AI Lab'),
  view('Evaluations'),
  view('Environments'),
  view('History'),
  view('Traces'),
  view('Git'),
  view('Debugger'),
];

module.exports = withExpect(steps, { 'new-workspace': /^workspace: Empty tour$/ });
