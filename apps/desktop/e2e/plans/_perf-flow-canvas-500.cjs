// Not part of the suite (the _ prefix): how the flow designer's canvas holds up with a large flow — 500 steps in a
// branching chain, 40 sticky notes and 25 frames, with a layout (every step placed) and without (the automatic one).
// Measures opening the Flow tab (until the 500 nodes are painted), dragging a step (30 pointer moves, a frame each),
// zooming (20 wheel steps) and hovering. Run: npm run e2e -- --only _perf-flow-canvas-500
const { withExpect } = require('../lib.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function flowFile(n, placed) {
  const lines = ['name: Big flow', 'defaults:', '  type: http', 'tests:'];
  for (let i = 0; i < n; i++) {
    const deps = i === 0 ? '' : `, dependsOn: [s${Math.floor((i - 1) / 2)}]`;
    lines.push(`  - { id: s${i}, name: Step ${i}, url: "http://127.0.0.1:4010/health?i=${i}&t={{token}}"${deps}, extract: { token: $.status } }`);
  }
  lines.push('', 'layout:');
  if (placed) for (let i = 0; i < n; i++) lines.push(`  s${i}: [${(i % 25) * 280}, ${Math.floor(i / 25) * 110}]`);
  lines.push('  notes:');
  for (let i = 0; i < 40; i++) lines.push(`    - { id: note-${i}, x: ${(i % 10) * 700}, y: ${2300 + Math.floor(i / 10) * 160}, w: 220, h: 120, color: yellow, text: "**Note ${i}**: why step ${i * 10} is here" }`);
  lines.push('  frames:');
  for (let i = 0; i < 25; i++) lines.push(`    - { id: frame-${i}, title: Frame ${i}, color: blue, steps: [s${i * 20}, s${i * 20 + 1}, s${i * 20 + 2}] }`);
  return lines.join('\n') + '\n';
}
function prepare(ws) {
  mkdirSync(join(ws, 'tests', 'perf'), { recursive: true });
  writeFileSync(join(ws, 'tests', 'perf', 'flow-500-placed.yaml'), flowFile(500, true));
  writeFileSync(join(ws, 'tests', 'perf', 'flow-500-auto.yaml'), flowFile(500, false));
}

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
  const painted = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const nodes = () => document.querySelectorAll('[data-flow-designer] [data-flow-node]');
  const svg = () => document.querySelector('[data-flow-designer] [data-flow-diagram] svg');
  const treeRow = (name) => [...document.querySelectorAll('[data-tree-row]')].find((b) => b.offsetParent && b.textContent.trim().endsWith(name));
  const pointer = (el, type, at) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
  const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return 'mean ' + Math.round(s.reduce((a, b) => a + b, 0) / s.length) + ' p95 ' + Math.round(s[Math.floor(s.length * 0.95)]) + ' max ' + Math.round(s[s.length - 1]) + ' ms'; };
  const open = async (name) => {
    await __t.view('Tests'); await __t.sleep(600);
    const f = treeRow('perf'); if (f && f.getAttribute('aria-expanded') === 'false') { f.click(); await __t.sleep(400); }
    const r = treeRow(name); if (!r) return 'NO ROW ' + name;
    r.click(); await __t.sleep(1200);
    // a click on the Flow tab until its steps are painted (only those on screen are drawn: the count says how many)
    const tab = [...document.querySelectorAll('main [role=tab]')].find((x) => x.offsetParent && x.textContent.trim().startsWith('Flow')); if (!tab) return 'NO FLOW TAB';
    const t0 = performance.now();
    tab.click();
    const ok = await __t.waitFor(() => nodes().length > 0, 30000);
    await painted();
    return ok ? Math.round(performance.now() - t0) + ' (' + nodes().length + ' of 500 steps on screen)' : 'NO NODES';
  };
  const drag = async () => {
    // s200, or (when the view shows another part of the flow) the step nearest the middle of the view
    const v = svg().getBoundingClientRect(); const mid = (x) => { const b = x.getBoundingClientRect(); return Math.hypot(b.left + b.width / 2 - (v.left + v.width / 2), b.top + b.height / 2 - (v.top + v.height / 2)); };
    const n = [...nodes()].find((x) => x.dataset.flowNode === 's200') ?? [...nodes()].sort((a, b) => mid(a) - mid(b))[0]; const r = n.querySelector('rect').getBoundingClientRect();
    const at = { clientX: r.left + 40, clientY: r.top + 20 };
    pointer(n, 'pointerdown', at); await frame();
    const times = []; let last = await frame();
    for (let i = 1; i <= 30; i++) { pointer(svg(), 'pointermove', { clientX: at.clientX + i * 6, clientY: at.clientY + i * 3 }); const t = await frame(); times.push(t - last); last = t; }
    pointer(svg(), 'pointerup', { clientX: at.clientX + 180, clientY: at.clientY + 90 });
    return stats(times);
  };
  const zoom = async () => {
    const s = svg(); const r = s.getBoundingClientRect(); const times = []; let last = await frame();
    for (let i = 0; i < 60; i++) { s.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 20 < 10 ? -120 : 120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); const t = await frame(); times.push(t - last); last = t; }
    return stats(times);
  };
  const hover = async () => {
    const times = []; let last = await frame();
    for (const id of ['s10', 's11', 's12', 's13', 's14', 's15', 's16', 's17', 's18', 's19']) { const n = [...nodes()].find((x) => x.dataset.flowNode === id); n?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); const t = await frame(); times.push(t - last); last = t; n?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' })); }
    return stats(times);
  };
`;
// each measure starts once the canvas is idle (the save after a drag, a zoom's commit are not counted in the next one)
const step = (name, body) => [name, `(async () => { ${H} await __t.sleep(1500); ${body} })()`, false];

const steps = [
  step('open-placed', `const ms = await open('flow-500-placed.yaml'); return 'open ms: ' + ms + ' | dom nodes ' + document.getElementsByTagName('*').length;`),
  step('drag-placed', `return 'drag frame ' + (await drag());`),
  step('zoom-placed', `return 'zoom frame ' + (await zoom());`),
  step('hover-placed', `return 'hover frame ' + (await hover());`),
  step('open-auto', `const ms = await open('flow-500-auto.yaml'); return 'open ms: ' + ms;`),
  step('drag-auto', `return 'drag frame ' + (await drag());`),
  step('zoom-auto', `return 'zoom frame ' + (await zoom());`),
];

module.exports = withExpect(steps, {}, { prepare });
