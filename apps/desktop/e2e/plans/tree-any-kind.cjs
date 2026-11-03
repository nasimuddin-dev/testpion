// Any kind of request in any folder: in the Collections tree a folder holds REST, GraphQL, gRPC and WebSocket requests side
// by side (gRPC calls and connections are kept in the library and placed by folderId / after); a folder's New request ▸ offers
// every kind into that folder; a call dropped on a folder moves into it.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const node = (id) => document.querySelector('aside [data-node-id="' + id + '"]');
  const shown = () => [...document.querySelectorAll('aside [data-tree-rows] [data-node-id]')].map((r) => r.getAttribute('data-node-id')).filter((id) => id.startsWith('e2e-mixed'));
  const toggleOf = (r) => (r?.hasAttribute('aria-expanded') ? r : r?.querySelector('[aria-expanded]'));
  const unfold = async (id) => { const r = await __t.waitFor(() => node(id), 4000); const t = toggleOf(r); if (t && t.getAttribute('aria-expanded') === 'false') { t.click(); await __t.sleep(400); } return r; };
`;

const steps = [
  step(
    'a-folder-holds-every-kind',
    `${H}
     await window.aps.invoke('col.save', { id: 'e2e-mixed', name: 'Mixed kinds', items: [
       { kind: 'folder', id: 'e2e-pay', name: 'Payments', items: [{ kind: 'http', id: 'e2e-list', name: 'List payments', request: { method: 'GET', url: 'https://example.test/payments', headers: [], params: [] } }, { kind: 'graphql', id: 'e2e-gql', name: 'Payment graph', request: { endpoint: 'https://example.test/graphql', query: '{ a }', headers: [] } }] },
       { kind: 'folder', id: 'e2e-other', name: 'Other', items: [] },
     ] });
     await window.aps.invoke('lib.save', { kind: 'grpc', library: { folders: [], items: [{ id: 'e2e-pay-grpc', name: 'Pay over gRPC', collectionId: 'e2e-mixed', folderId: 'e2e-pay', after: 'e2e-list', data: { target: 'localhost:1', method: 'pay.Payments/Pay', message: '{}', metadata: [], protoFiles: [] } }] } });
     await window.aps.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [{ id: 'e2e-feed', name: 'Payment feed', collectionId: 'e2e-mixed', folderId: 'e2e-pay', data: { url: 'wss://example.test/feed', mode: 'websocket', message: '', headers: [], protocols: '' } }] } });
     await __t.requests(); await __t.sleep(800);
     await unfold('e2e-mixed'); await unfold('e2e-mixed:e2e-pay');
     await __t.waitFor(() => node('e2e-mixed:websocket:e2e-feed'), 4000);
     return 'rows: ' + shown().join(', ');`,
  ),
  step(
    'new-request-in-a-folder-offers-every-kind',
    `${H}
     const f = node('e2e-mixed:e2e-pay'); if (!f) return 'NO FOLDER';
     f.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
     const sub = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith('New request') && m.getAttribute('aria-haspopup')), 3000);
     if (!sub) { const all = [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).join(' | '); await __t.esc(); return 'NO SUBMENU: ' + all; }
     sub.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })); sub.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })); sub.click();
     const items = await __t.waitFor(() => { const l = [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).filter((t) => /^New .* request$/.test(t)); return l.length >= 4 ? l : null; }, 3000);
     await __t.esc();
     return 'kinds: ' + (items ? items.join(' | ') : 'NONE');`,
  ),
  step(
    'a-call-dropped-on-a-folder-moves-into-it',
    `${H}
     await unfold('e2e-mixed:e2e-other');
     const from = node('e2e-mixed:websocket:e2e-feed'); const to = node('e2e-mixed:e2e-other'); if (!from || !to) return 'NO ROWS';
     const dt = new DataTransfer(); dt.setData('application/x-testpion-saved-item', JSON.stringify({ kind: 'websocket', id: 'e2e-feed', from: 'e2e-mixed' }));
     to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
     to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
     await __t.waitFor(async () => ((await window.aps.invoke('lib.get', { kind: 'websocket' })).items.find((i) => i.id === 'e2e-feed')?.folderId === 'e2e-other') || null, 4000);
     const saved = (await window.aps.invoke('lib.get', { kind: 'websocket' })).items.find((i) => i.id === 'e2e-feed');
     await __t.sleep(600);
     return 'folder: ' + saved?.folderId + ' | rows: ' + shown().join(', ');`,
  ),
  // opened from elsewhere (search, a link), a call in a folded folder is revealed: its folders open and its row shows
  step(
    'opening-a-call-reveals-it-in-its-folder',
    `${H}
     const pay = node('e2e-mixed:e2e-pay'); const t = toggleOf(pay); if (t?.getAttribute('aria-expanded') === 'true') { t.click(); await __t.sleep(400); }
     const folded = !node('e2e-mixed:grpc:e2e-pay-grpc');
     // Quick Open (Ctrl+P), as from anywhere in the app
     window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
     const box = await __t.waitFor(() => document.querySelector('[role=dialog] input'), 3000); if (!box) return 'NO QUICK OPEN';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, 'Pay over gRPC'); box.dispatchEvent(new Event('input', { bubbles: true }));
     await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] [role=option]')].find((o) => /Pay over gRPC/.test(o.textContent)), 4000);
     box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     const row = await __t.waitFor(() => node('e2e-mixed:grpc:e2e-pay-grpc'), 4000);
     return 'folded before: ' + folded + ' | shown after: ' + !!row;`,
  ),
  step(
    'clean-up',
    `await window.aps.invoke('lib.save', { kind: 'grpc', library: { folders: [], items: [] } }); await window.aps.invoke('lib.save', { kind: 'websocket', library: { folders: [], items: [] } });
     await window.aps.invoke('col.delete', { id: 'e2e-mixed' }).catch(() => undefined);
     return 'done';`,
  ),
];

module.exports = withExpect(steps, {
  'a-folder-holds-every-kind': /^rows: e2e-mixed, e2e-mixed:e2e-pay, e2e-mixed:e2e-list, e2e-mixed:grpc:e2e-pay-grpc, e2e-mixed:e2e-gql, e2e-mixed:websocket:e2e-feed, e2e-mixed:e2e-other$/,
  'new-request-in-a-folder-offers-every-kind': /^kinds: .*New GraphQL request.*New SOAP request.*New gRPC request.*New WebSocket & MQTT request/,
  'a-call-dropped-on-a-folder-moves-into-it': /^folder: e2e-other \| rows: .*e2e-mixed:e2e-other, e2e-mixed:websocket:e2e-feed$/,
  'opening-a-call-reveals-it-in-its-folder': /^folded before: true \| shown after: true$/,
  'clean-up': /^done$/,
});
