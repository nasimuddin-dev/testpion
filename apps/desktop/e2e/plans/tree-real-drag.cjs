// Dragging in the Collections tree with the real mouse (the page's own dragstart, Chromium's drag, a real drop): a request
// from one folder into another, a request before another one, a folder into a folder, a request into another collection,
// and a gRPC call into a folder. The other tree plans dispatch drag events from the page, which does not show what a
// user's drop does: between the window's listeners and the row's handler the page may re-render.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const H = `
  const node = (id) => document.querySelector('aside [data-node-id="' + id + '"]');
  const toggleOf = (r) => (r?.hasAttribute('aria-expanded') ? r : r?.querySelector('[aria-expanded]'));
  const unfold = async (id) => { const r = await __t.waitFor(() => node(id), 4000); const t = toggleOf(r); if (t && t.getAttribute('aria-expanded') === 'false') { t.click(); await __t.sleep(400); } return r; };
  const col = async (id) => window.aps.invoke('col.get', { id });
  const names = (items) => items.map((i) => (i.kind === 'folder' ? i.name + '[' + names(i.items) + ']' : i.name)).join(',');
  const shape = async (id) => names((await col(id)).items);
  const drag = async (from, to, want, id = 'e2e-drag') => {
    const a = node(from); const b = node(to); if (!a || !b) return 'NO ROWS ' + !!a + '/' + !!b;
    a.scrollIntoView({ block: 'center' }); await __t.sleep(150);
    const r = await __t.real.dnd(a, b); if (r !== 'ok') return 'DND: ' + r;
    await __t.waitFor(async () => ((await shape(id)) === want ? true : null), 4000);
    await __t.sleep(300);
    return shape(id);
  };
`;

const steps = [
  step(
    'a-collection-with-two-folders',
    `${H}
     const http = (id, name) => ({ kind: 'http', id, name, request: { method: 'GET', url: 'https://example.test/' + id, headers: [], params: [] } });
     await window.aps.invoke('col.save', { id: 'e2e-drag', name: 'Drag here', items: [
       { kind: 'folder', id: 'e2e-da', name: 'A', items: [http('e2e-d1', 'One'), http('e2e-d2', 'Two'), http('e2e-d3', 'Three')] },
       { kind: 'folder', id: 'e2e-db', name: 'B', items: [http('e2e-d4', 'Four')] },
     ] });
     await window.aps.invoke('col.save', { id: 'e2e-drag2', name: 'Drag there', items: [{ kind: 'folder', id: 'e2e-dc', name: 'C', items: [] }] });
     await window.aps.invoke('lib.save', { kind: 'grpc', library: { folders: [], items: [{ id: 'e2e-dg', name: 'Call', collectionId: 'e2e-drag', folderId: 'e2e-da', data: { target: 'localhost:1', method: 'a.B/C', message: '{}', metadata: [], protoFiles: [] } }] } });
     await __t.requests(); await __t.sleep(800);
     await unfold('e2e-drag'); await unfold('e2e-drag:e2e-da'); await unfold('e2e-drag:e2e-db'); await unfold('e2e-drag2');
     await __t.waitFor(() => node('e2e-drag:e2e-d4') && node('e2e-drag:grpc:e2e-dg'), 4000);
     return shape('e2e-drag');`,
  ),
  step('a-request-dragged-onto-another-folder-moves-into-it', `${H} return drag('e2e-drag:e2e-d1', 'e2e-drag:e2e-db', 'A[Two,Three],B[Four,One]');`),
  step('a-request-dragged-onto-a-request-of-another-folder-goes-before-it', `${H} return drag('e2e-drag:e2e-d2', 'e2e-drag:e2e-d4', 'A[Three],B[Two,Four,One]');`),
  step('a-folder-dragged-onto-a-folder-moves-into-it', `${H} return drag('e2e-drag:e2e-db', 'e2e-drag:e2e-da', 'A[Three,B[Two,Four,One]]');`),
  step(
    'a-grpc-call-dragged-onto-a-folder-moves-into-it',
    `${H}
     await unfold('e2e-drag:e2e-db');
     const a = node('e2e-drag:grpc:e2e-dg'); const b = node('e2e-drag:e2e-db'); if (!a || !b) return 'NO ROWS ' + !!a + '/' + !!b;
     const r = await __t.real.dnd(a, b); if (r !== 'ok') return 'DND: ' + r;
     const where = async () => (await window.aps.invoke('lib.get', { kind: 'grpc' })).items.find((i) => i.id === 'e2e-dg')?.folderId;
     await __t.waitFor(async () => ((await where()) === 'e2e-db' ? true : null), 4000);
     return 'folder: ' + (await where());`,
  ),
  step(
    'a-request-dragged-onto-a-folder-of-another-collection-moves-there',
    `${H}
     const a = node('e2e-drag:e2e-d3'); const b = node('e2e-drag2:e2e-dc'); if (!a || !b) return 'NO ROWS ' + !!a + '/' + !!b;
     const r = await __t.real.dnd(a, b); if (r !== 'ok') return 'DND: ' + r;
     await __t.waitFor(async () => ((await shape('e2e-drag2')) === 'C[Three]' ? true : null), 5000);
     return (await shape('e2e-drag')) + ' | ' + (await shape('e2e-drag2'));`,
  ),
  step(
    'clean-up',
    `await window.aps.invoke('lib.save', { kind: 'grpc', library: { folders: [], items: [] } }).catch(() => undefined);
     await window.aps.invoke('col.delete', { id: 'e2e-drag' }).catch(() => undefined);
     await window.aps.invoke('col.delete', { id: 'e2e-drag2' }).catch(() => undefined);
     return 'done';`,
  ),
];

module.exports = withExpect(steps, {
  'a-collection-with-two-folders': /^A\[One,Two,Three\],B\[Four\]$/,
  'a-request-dragged-onto-another-folder-moves-into-it': /^A\[Two,Three\],B\[Four,One\]$/,
  'a-request-dragged-onto-a-request-of-another-folder-goes-before-it': /^A\[Three\],B\[Two,Four,One\]$/,
  'a-folder-dragged-onto-a-folder-moves-into-it': /^A\[Three,B\[Two,Four,One\]\]$/,
  'a-grpc-call-dragged-onto-a-folder-moves-into-it': /^folder: e2e-db$/,
  'a-request-dragged-onto-a-folder-of-another-collection-moves-there': /^A\[B\[Two,Four,One\]\] \| C\[Three\]$/,
  'clean-up': /^done$/,
});
