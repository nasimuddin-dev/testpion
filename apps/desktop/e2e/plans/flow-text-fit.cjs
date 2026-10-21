// Text fits its box on the flow canvas at every zoom (the owner saw step names run out of their boxes when zoomed out).
// A flow with long names, URLs, a condition, a loop, a parallel group, a Finally lane, a frame and a note: real Ctrl+wheel
// zooms out notch by notch to the farthest zoom and back in; at each level (mid-gesture, then settled) every text of every
// step, frame title, lane label and the Start node lies inside its box (1 px tolerance), and nothing is drawn wider.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');

const FILE = 'rest/text-fit.yaml';
const LONG = 'https://api.example.com/v2/organisations/{{orgId}}/projects/{{projectId}}/environments/production/deployments?include=all';
const TEXT = [
  'name: Text fit',
  'defaults:',
  '  type: http',
  'tests:',
  `  - { id: login, name: Log in with the service account and keep the bearer token for every later step, method: POST, url: "${LONG}", extract: { token: $.access_token, refresh: $.refresh_token, expires: $.expires_in } }`,
  `  - { id: list, name: List every project of the organisation with its environments and deployments, url: "${LONG}", dependsOn: [login], parallel: reads }`,
  `  - { id: count, name: Count the deployments per environment, url: "${LONG}", dependsOn: [login], parallel: reads }`,
  '  - { id: check, name: Every environment has at least one healthy deployment running right now, type: condition, if: "status == 200 && json.items.length > 0 && json.items.every(i => i.healthy)", dependsOn: [list] }',
  `  - { id: each, name: Read each deployment in turn, url: "${LONG}", dependsOn: [check], when: true, forEach: "{{deployments}}" }`,
  `  - { id: cleanup, name: Clean up the temporary tokens and sessions created by this flow, url: "${LONG}", finally: true }`,
  'layout:',
  '  notes:',
  '    - { id: note-1, x: 40, y: -260, w: 240, h: 110, text: "**Why** this flow exists: a very long note that keeps going and going so that it has to wrap and be clipped by its own paper rather than spill over" }',
  '  frames:',
  '    - { id: frame-1, title: The reads that run together in parallel against the production organisation, color: blue, steps: [list, count] }',
  '',
].join('\n');

const H = `
  const R = __t.real;
  const sleep = __t.sleep;
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const scale = () => Number(/scale\\(([\\d.]+)\\)/.exec(svg().querySelector('g[transform]').getAttribute('transform'))?.[1]);
  /** Texts outside their box: "<what>: <text>" for each (1 px tolerance); boxes off screen are skipped. */
  const outside = () => {
    const bad = [];
    const view = svg().getBoundingClientRect();
    const inside = (r, b) => r.width === 0 || (r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1);
    const onScreen = (b) => b.right > view.left && b.left < view.right && b.bottom > view.top && b.top < view.bottom;
    const check = (what, box, texts) => { const b = box.getBoundingClientRect(); if (!onScreen(b)) return; for (const t of texts) { const r = t.getBoundingClientRect(); if (!inside(r, b)) bad.push(what + ': ' + (t.textContent || t.value || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + '>' + Math.round(b.width)); } };
    for (const n of vis('[data-flow-designer] [data-flow-node]')) {
      const box = [...n.children].find((c) => c.tagName === 'rect' && !c.hasAttribute('x'));
      // the step's own texts (the true / false port labels sit at its edge, inside too)
      check('step ' + n.dataset.flowNode, box, [...n.querySelectorAll(':scope > text, :scope > g > text:not([data-flow-pin] text)')].filter((t) => !t.closest('[data-flow-pin], [data-flow-problem-mark], [data-flow-unresolved]')));
    }
    for (const f of vis('[data-flow-designer] [data-flow-frame]')) check('frame title', f.querySelector('[data-flow-frame-handle] rect'), [...f.querySelectorAll('text')]);
    // a lane's label lies in its pill (the rect drawn just before it)
    for (const t of vis('[data-flow-designer] [data-flow-group-title]')) check('lane ' + t.closest('[data-flow-group]').dataset.flowGroup, t.previousElementSibling, [t]);
    for (const s of vis('[data-flow-designer] [data-flow-start]')) check('start', s.querySelector('rect'), [...s.querySelectorAll('span, input, button')].filter((x) => x.getClientRects().length));
    for (const n of vis('[data-flow-designer] [data-flow-note]')) check('note', n.querySelector('[data-flow-note-paper]'), [...n.querySelectorAll('foreignObject > div')]);
    return bad;
  };
`;
const step = stepOf(H);

const steps = [
  step(
    'open-a-flow-with-long-texts',
    `await window.aps.invoke('tests.write', { path: ${JSON.stringify(FILE)}, content: ${JSON.stringify(TEXT)} });
     await __t.view('Tests'); await sleep(800);
     const r = await __t.waitFor(() => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith('text-fit.yaml')), 5000); if (!r) return 'NO ROW';
     r.scrollIntoView({ block: 'center' }); await R.click(r); await sleep(1200); await __t.tab('Flow');
     const ok = await __t.waitFor(() => vis('[data-flow-designer] [data-flow-node]').length === 6, 8000);
     await R.click(vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit')); await sleep(400);
     return 'steps: ' + (ok ? 6 : vis('[data-flow-designer] [data-flow-node]').length) + ' | frame: ' + !!vis('[data-flow-frame]')[0] + ' | lanes: ' + vis('[data-flow-group]').length + ' | outside at fit: ' + (outside().join('; ') || 'none');`,
  ),
  step(
    'zoom-out-to-the-farthest-and-back-texts-stay-inside',
    `const c = R.pt(svg());
     // from 100% (the longest texts are cut there)
     await R.click(document.querySelector('[data-flow-zoom-level]') ?? vis('[data-flow-toolbar] button').find((b) => b.textContent.trim() === 'Fit')); await sleep(400);
     const levels = []; const bad = [];
     const look = (when) => { const k = scale(); const o = outside(); if (o.length) bad.push(when + ' ' + k.toFixed(2) + ': ' + o.slice(0, 3).join('; ')); };
     let last = scale();
     for (let i = 0; i < 40; i++) {
       await R.wheel(c, 120, { ctrl: true });
       look('mid-gesture'); await sleep(260); look('settled');
       const k = scale(); levels.push(k.toFixed(2));
       if (k >= last - 0.0001) break;
       last = k;
     }
     const farthest = scale();
     for (let i = 0; i < 40 && scale() < 1.2; i++) { await R.wheel(c, -120, { ctrl: true }); look('mid-gesture'); await sleep(260); look('settled'); }
     return 'levels: ' + levels.length + ' | farthest: ' + farthest.toFixed(2) + ' | back to: ' + scale().toFixed(2) + ' | outside: ' + (bad.slice(0, 4).join(' / ') || 'none');`,
  ),
  step(
    'long-names-are-cut-with-an-ellipsis-and-shown-whole-on-hover',
    `const n = vis('[data-flow-designer] [data-flow-node="login"]')[0];
     const name = n.querySelector(':scope > text').textContent;
     const title = n.querySelector(':scope > title').textContent;
     return 'cut: ' + name.endsWith('…') + ' | title has it all: ' + title.startsWith('Log in with the service account and keep the bearer token for every later step');`,
  ),
];

module.exports = withExpect(steps, {
  'open-a-flow-with-long-texts': /^steps: 6 \| frame: true \| lanes: 2 \| outside at fit: none$/,
  'zoom-out-to-the-farthest-and-back-texts-stay-inside': (r) => {
    const m = /^levels: (\d+) \| farthest: ([\d.]+) \| back to: ([\d.]+) \| outside: (.*)$/.exec(r);
    if (!m) return 'no result';
    if (+m[1] < 5) return 'expected several zoom levels';
    if (+m[2] > 0.1) return 'expected to reach the farthest zoom';
    return m[4] === 'none' ? true : `texts outside their boxes: ${m[4]}`;
  },
  'long-names-are-cut-with-an-ellipsis-and-shown-whole-on-hover': /^cut: true \| title has it all: true$/,
});
