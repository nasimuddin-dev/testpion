// B-01 / menus-uniform P0-1: the Collections sidebar never draws a row twice, never drops a row, and leaves no drag state
// behind. A workspace of 600+ rows (more than the tree draws at once) with two collections that share request ids
// (what an older import or a copied file leaves), driven with real input: expand, collapse, scroll, select, drag onto
// the tab strip, a drag held at the sidebar's bottom edge, a right-click while dragging. After every step: each
// `[data-node-id]` is unique and lies inside the tree's list, the rows drawn are the rows the list says it draws (and
// all of them for a small tree), no two rows share a place, and no row keeps a drop ring. Then the examples case: a
// second copy of "Live streams (SSE)" (an older version's leftover) shows each of its requests once.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, stepOf } = require('../lib.cjs');
const { copyFileSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const FOLDERS = 12;
const PER_FOLDER = 24; // 2 collections x 12 folders x 24 requests: 600 requests, 600+ rows open
const req = (id, name) => ({ kind: 'http', id, name, request: { method: 'GET', url: `https://example.test/${id}`, headers: [], params: [] } });
const bulk = () =>
  Array.from({ length: FOLDERS }, (_, f) => ({
    kind: 'folder',
    id: `ghost-f${f}`,
    name: `Folder ${String(f).padStart(2, '0')}`,
    items: Array.from({ length: PER_FOLDER }, (_, r) => req(`ghost-r${f}-${r}`, `Request ${f}-${r}`)),
  }));
function prepare(ws) {
  // the same node ids in both collections (only the collection ids differ)
  for (const [id, name] of [
    ['ghost-a', 'Ghost A'],
    ['ghost-b', 'Ghost B'],
  ])
    writeFileSync(join(ws, 'collections', `${id}.json`), JSON.stringify({ schemaVersion: '1.0', id, name, variables: [], items: bulk() }, null, 2));
  // an older version's second copy of the examples' SSE collection: same collection id, same request ids
  const streams = join(ws, 'collections', 'streams.json');
  if (existsSync(streams)) copyFileSync(streams, join(ws, 'collections', 'live-streams.json'));
}

const H = `
  const aside = () => document.querySelector('aside[aria-label="Collections explorer"]');
  const list = () => aside()?.querySelector('[data-virtual-list="CollectionTree"]');
  const scroller = () => aside()?.querySelector('.flex-1.overflow-auto');
  const tree = () => list()?.parentElement;
  const rowBtn = (name, scope) => [...(aside()?.querySelectorAll((scope ? '[data-node-id^="' + scope + ':"] ' : '') + '[data-tree-row]') ?? [])].find((b) => b.offsetParent && (b.textContent.trim().endsWith(name) || b.querySelector('.truncate')?.textContent.trim() === name));
  const colRow = (name) => [...(aside()?.querySelectorAll('[data-tree-row][aria-expanded]') ?? [])].find((b) => b.querySelector('.truncate')?.textContent.trim() === name);
  /** The invariants of the tree: '' when they hold, else what is wrong. */
  const check = () => {
    const l = list(); if (!l) return 'NO LIST';
    const lb = l.getBoundingClientRect();
    const nodes = [...l.querySelectorAll('[data-node-id]')];
    const ids = nodes.map((n) => n.getAttribute('data-node-id'));
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) return 'DUPLICATE ' + [...new Set(dup)].slice(0, 3).join(',');
    const outside = nodes.filter((n) => { const r = n.getBoundingClientRect(); return r.top < lb.top - 1 || r.bottom > lb.bottom + 1 || r.left < lb.left - 1 || r.right > lb.right + 1; });
    if (outside.length) return 'OUTSIDE ' + outside[0].getAttribute('data-node-id');
    const wrappers = [...l.children];
    const drawn = Number(l.getAttribute('data-vl-drawn'));
    if (wrappers.length !== drawn) return 'DRAWN ' + wrappers.length + ' != ' + drawn;
    if (nodes.length !== drawn) return 'ROWS ' + nodes.length + ' != ' + drawn;
    const keys = wrappers.map((w) => w.getAttribute('data-vl-key'));
    if (new Set(keys).size !== keys.length) return 'KEYS';
    const tops = wrappers.map((w) => w.style.top);
    if (new Set(tops).size !== tops.length) return 'OVERLAP';
    const model = Number(tree()?.getAttribute('data-tree-rows'));
    if (drawn > model || (model <= 300 && drawn !== model)) return 'MODEL ' + model + ' drawn ' + drawn;
    if (l.querySelector('.ring-accent') || l.querySelector('[class*="inset_0_2px"]')) return 'DROP RING LEFT';
    if (document.querySelector('[data-drag-chip]')) return 'DRAG CHIP LEFT';
    return '';
  };
  const ok = (label) => { const bad = check(); return bad ? label + ': ' + bad : label + ': ok rows ' + list().getAttribute('data-vl-drawn') + '/' + tree().getAttribute('data-tree-rows'); };
  /** A row brought on screen first (real input clicks where a user can: the virtual list draws only what is near the view). */
  const onScreen = async (el) => { if (!el) return el; el.scrollIntoView({ block: 'center' }); await __t.sleep(120); return el; };
  /** Scroll the tree from the top until the row is drawn, then bring it on screen. */
  const reach = async (name, scope) => {
    const s = scroller();
    const now = rowBtn(name, scope); if (now) return onScreen(now);
    for (let top = 0; top <= s.scrollHeight; top += Math.max(100, s.clientHeight / 2)) { s.scrollTop = top; await __t.sleep(80); const b = rowBtn(name, scope); if (b) return onScreen(b); }
    return undefined;
  };
  /** Expand every folder of one collection (real clicks), scrolling down as the list grows. */
  const expandAllIn = async (scope) => {
    const s = scroller(); s.scrollTop = 0; await __t.sleep(80);
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const b = [...(aside()?.querySelectorAll('[data-node-id^="' + scope + ':"] [data-tree-row][aria-expanded="false"]') ?? [])].find((x) => x.offsetParent);
      if (b) { await onScreen(b); await __t.real.click(b); await __t.sleep(120); n++; continue; }
      if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) break;
      s.scrollTop += Math.max(100, s.clientHeight / 2); await __t.sleep(80);
    }
    s.scrollTop = 0; await __t.sleep(120);
    return n;
  };
`;
const step = stepOf(H);

const steps = [
  step(
    'open-two-collections-sharing-ids',
    `await __t.requests(); await __t.sleep(600);
     for (const n of ['Ghost A', 'Ghost B']) { const b = colRow(n); if (!b) return 'NO COLLECTION ' + n; if (b.getAttribute('aria-expanded') === 'false') await __t.real.click(b); await __t.sleep(300); }
     return ok('open');`,
  ),
  step(
    'expand-every-folder',
    `const a = await expandAllIn('ghost-a'); const b = await expandAllIn('ghost-b');
     // the same request id in both collections, each drawn as its own row (the list draws what is near the view: reach each)
     const inA = !!(await reach('Request 0-0', 'ghost-a')) && !!aside().querySelector('[data-node-id="ghost-a:ghost-r0-0"]');
     const inB = !!(await reach('Request 0-0', 'ghost-b')) && !!aside().querySelector('[data-node-id="ghost-b:ghost-r0-0"]');
     const both = inA && inB;
     return ok('expanded') + ' | both copies: ' + both + ' | large: ' + (Number(tree().getAttribute('data-tree-rows')) > 600);`,
  ),
  step(
    'scroll-through-the-tree',
    `const s = scroller(); const bad = [];
     for (let i = 0; i < 12; i++) { await __t.real.wheel(s, 900); await __t.sleep(120); const r = check(); if (r) bad.push(i + ':' + r); }
     for (let i = 0; i < 12; i++) { await __t.real.wheel(s, -900); await __t.sleep(120); const r = check(); if (r) bad.push('up' + i + ':' + r); }
     return bad.length ? 'SCROLL ' + bad.slice(0, 3).join(' ; ') : ok('scrolled');`,
  ),
  step(
    'select-a-shared-id-in-the-second-collection',
    `const b = await reach('Request 0-1', 'ghost-b'); if (!b) return 'NO ROW';
     await __t.real.click(b); await __t.sleep(900);
     return ok('selected');`,
  ),
  step(
    'drag-a-request-onto-the-tab-strip',
    `const b = await reach('Request 0-2', 'ghost-a'); const strip = document.querySelector('[aria-label="New tab"]')?.parentElement; if (!b || !strip) return 'NO ROW OR STRIP';
     const r = strip.getBoundingClientRect();
     const d = await __t.real.dnd(b, { x: r.left + 40, y: r.top + r.height / 2 }); if (d !== 'ok') return 'DND ' + d;
     await __t.sleep(800); await __t.real.click({ x: 5, y: 5 }); await __t.sleep(200);
     return ok('dropped on the strip');`,
  ),
  step(
    'drag-held-at-the-bottom-edge',
    `const b = await reach('Request 1-0', 'ghost-a'); if (!b) return 'NO ROW';
     const s = scroller().getBoundingClientRect(); const edge = { x: s.left + s.width / 2, y: s.bottom - 4 };
     const d = await __t.real.dnd(b, { x: s.left + s.width / 2, y: s.bottom - 30 }, { over: Array.from({ length: 10 }, () => edge) }); if (d !== 'ok') return 'DND ' + d;
     await __t.sleep(600); await __t.real.click({ x: 5, y: 5 }); await __t.sleep(200);
     return ok('auto-scroll drag');`,
  ),
  step(
    'right-click-while-dragging',
    `const b = await reach('Request 2-0', 'ghost-b'); const target = rowBtn('Folder 02', 'ghost-b'); const other = rowBtn('Request 2-3', 'ghost-b'); if (!b || !target || !other) return 'NO ROW ' + !!b + ' ' + !!target + ' ' + !!other;
     const t = target.getBoundingClientRect();
     const drag = __t.real.dnd(b, { x: t.left + 30, y: t.top + t.height / 2 }, { steps: 10, over: Array.from({ length: 6 }, (_, i) => ({ x: t.left + 30, y: t.top + 40 + i * 10 })) });
     await __t.sleep(150); await __t.real.rightClick(other); await drag; await __t.sleep(500);
     await __t.esc(); await __t.real.key('Escape'); await __t.sleep(300);
     return ok('right-click during a drag');`,
  ),
  step(
    'collapse-and-expand-again',
    `scroller().scrollTop = 0; await __t.sleep(150);
     for (const n of ['Ghost A', 'Ghost B']) { const row = colRow(n); if (!row) return 'NO COLLECTION ROW ' + n; await onScreen(row); await __t.real.click(row); await __t.sleep(300); const r = check(); if (r) return 'COLLAPSE ' + n + ': ' + r; }
     for (const n of ['Ghost B']) { await __t.real.click(colRow(n)); await __t.sleep(300); }
     return ok('collapsed and reopened');`,
  ),
  step(
    'examples-second-copy-shows-each-request-once',
    `scroller().scrollTop = 0; await __t.sleep(150);
     for (const n of ['Ghost A', 'Ghost B']) { const b = colRow(n); if (b?.getAttribute('aria-expanded') === 'true') { await onScreen(b); await __t.real.click(b); await __t.sleep(200); } }
     const copies = [...aside().querySelectorAll('[data-tree-row][aria-expanded]')].filter((b) => b.querySelector('.truncate')?.textContent.trim() === 'Live streams (SSE)');
     for (const c of copies) { if (c.getAttribute('aria-expanded') === 'false') { await onScreen(c); await __t.real.click(c); } await __t.sleep(300); }
     for (let i = 0; i < 6; i++) { const cat = [...aside().querySelectorAll('[data-node-id$=":cat:rest"] [aria-expanded="false"]')][0]; if (!cat) break; await onScreen(cat); await __t.real.click(cat); await __t.sleep(200); }
     const wiki = [...list().querySelectorAll('[data-node-id$=":sse-wikimedia"]')].map((n) => n.getAttribute('data-node-id'));
     return ok('examples') + ' | copies: ' + copies.length + ' | wikipedia rows: ' + wiki.length + ' unique: ' + (new Set(wiki).size === wiki.length);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'open-two-collections-sharing-ids': /^open: ok rows \d+\/\d+$/,
    'expand-every-folder': /^expanded: ok rows \d+\/\d+ \| both copies: true \| large: true$/,
    'scroll-through-the-tree': /^scrolled: ok rows \d+\/\d+$/,
    'select-a-shared-id-in-the-second-collection': /^selected: ok rows \d+\/\d+$/,
    'drag-a-request-onto-the-tab-strip': /^dropped on the strip: ok rows \d+\/\d+$/,
    'drag-held-at-the-bottom-edge': /^auto-scroll drag: ok rows \d+\/\d+$/,
    'right-click-while-dragging': /^right-click during a drag: ok rows \d+\/\d+$/,
    'collapse-and-expand-again': /^collapsed and reopened: ok rows \d+\/\d+$/,
    // either the examples update merged the copy (1 collection) or the sidebar shows both, each request once
    'examples-second-copy-shows-each-request-once': /^examples: ok rows \d+\/\d+ \| copies: [12] \| wikipedia rows: [12] unique: true$/,
  },
  { prepare },
);
