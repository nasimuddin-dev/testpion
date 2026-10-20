import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';

// The Import dialog's RPC: import.preview (nothing written) → import.apply → import.undo, with the report kept.
const home = mkdtempSync(join(tmpdir(), 'tp-import-rpc-'));
const events: string[] = [];
const be = new Backend({ appDir: home, emit: (c) => void events.push(c) });
const call = (method: string, params: unknown = {}) => be.handlers[method]!(params);
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const postman = JSON.stringify({
  info: { _postman_id: 'x', name: 'Dropped', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{ name: 'Get', request: { method: 'GET', url: 'https://x.test/a', auth: { type: 'asap', asap: [] } } }],
});

describe('import RPC', () => {
  it('previews dropped files without writing, imports them, and undoes the import', async () => {
    const files = [
      { path: 'dropped.postman_collection.json', text: postman },
      { path: 'notes.md', text: '# not an API' },
    ];
    const p = (await call('import.preview', { files })) as { sessionId: string; inputs: Array<{ plan?: { report: { summary: { items: number } } } }>; skipped: Array<{ path: string }>; totals: { requests: number } };
    expect(p.totals.requests).toBe(1);
    expect(p.inputs[0]!.plan!.report.summary.items).toBe(2);
    expect(p.skipped.map((s) => s.path)).toEqual(['notes.md']);
    expect(await call('col.list')).toEqual([]);
    const r = (await call('import.apply', { sessionId: p.sessionId })) as { receipts: string[]; imported: Array<{ result?: { collection?: { name: string } } }> };
    expect(r.imported[0]!.result!.collection!.name).toBe('Dropped');
    expect((await call('col.list')) as unknown[]).toHaveLength(1);
    expect(events).toContain('data.changed');
    // the same preview cannot be applied twice
    await expect(Promise.resolve().then(() => call('import.apply', { sessionId: p.sessionId }))).rejects.toThrow(/expired/);
    const list = (await call('import.list')) as Array<{ id: string }>;
    expect(list.map((i) => i.id)).toEqual(r.receipts);
    const md = (await call('import.reportMarkdown', { report: ((await call('import.report', { id: r.receipts[0] })) as { report: unknown }).report })) as string;
    expect(md).toContain('# Import report');
    const u = (await call('import.undo', { receipts: r.receipts })) as Array<{ trashed: unknown[] }>;
    expect(u[0]!.trashed).toHaveLength(1);
    expect(await call('col.list')).toEqual([]);
  });

  it('keeps the Postman API key in the secret store and says only whether it is set', async () => {
    expect(await call('import.postmanKey')).toEqual({ set: false });
    expect(await call('import.setPostmanKey', { key: 'PMAK-123' })).toEqual({ set: true });
    expect(await call('import.postmanKey')).toEqual({ set: true });
    await expect(Promise.resolve().then(() => call('import.preview', { url: 'postman:collection/1-abc' }))).rejects.not.toThrow(/PMAK-123/);
    expect(await call('import.setPostmanKey', { key: '' })).toEqual({ set: false });
  });

  it('refuses an empty preview with the reason', async () => {
    await expect(Promise.resolve().then(() => call('import.preview', { files: [{ path: 'a.png', text: 'x' }] }))).rejects.toThrow(/Nothing to import/);
  });
});
