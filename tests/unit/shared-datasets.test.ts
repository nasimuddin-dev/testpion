import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { listWorkspaceDatasets, readWorkspaceDataset, sharedDataSource } from '../../packages/core/src/index.js';

// Datasets shared from another workspace (workspace.json `shared` with kind datasets): listed after the workspace's own
// as ../platform-shared/datasets/x.csv, previewed and opened read-only, never written, renamed or deleted here.
const home = mkdtempSync(join(tmpdir(), 'tp-shared-data-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('datasets shared from another workspace', () => {
  const other = join(dirname(be.ws.root), 'platform-data');
  mkdirSync(join(other, 'datasets', 'users'), { recursive: true });
  writeFileSync(join(other, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'pd', name: 'Platform data' }));
  const CSV = 'id,name\n1,Ana\n2,Bo\n';
  writeFileSync(join(other, 'datasets', 'users', 'people.csv'), CSV);
  writeFileSync(join(other, 'secret.csv'), 'token\nabc\n');
  const rel = relative(be.ws.root, other).split('\\').join('/');
  const name = `${rel}/datasets/users/people.csv`;

  it('is listed after the own ones and read (preview, open, the ref)', async () => {
    const added = (await be.invoke('ws.shareAdd', { path: rel })) as { shared: Array<{ kinds: string[] }> };
    expect(added.shared[0]!.kinds).toEqual(['datasets']);
    expect(listWorkspaceDatasets(be.ws)).not.toContainEqual(expect.objectContaining({ path: name })); // only when asked for
    const list = (await be.invoke('datasets.list', {})) as Array<{ name: string; shared?: string; rows?: number }>;
    expect(list.find((d) => d.name === name)).toMatchObject({ shared: 'platform-data' });
    expect(((await be.invoke('datasets.preview', { name })) as { count: number }).count).toBe(2);
    expect(await readWorkspaceDataset(be.ws, name)).toMatchObject({ count: 2 });
    expect(await be.invoke('datasets.open', { name })).toMatchObject({ text: CSV, shared: 'platform-data' });
    expect(await be.invoke('ref.resolve', { ref: { kind: 'dataset', name } })).toMatchObject({ ok: true });
  });

  it('is never written, renamed or deleted here, and nothing else of the folder is read', async () => {
    await expect(be.invoke('datasets.write', { name, text: 'x' })).rejects.toThrow(/shared from platform-data: change it there/);
    await expect(be.invoke('datasets.rename', { name, to: 'mine.csv' })).rejects.toThrow(/shared from platform-data/);
    await expect(be.invoke('datasets.delete', { name })).rejects.toThrow(/shared from platform-data/);
    expect(readFileSync(join(other, 'datasets', 'users', 'people.csv'), 'utf8')).toBe(CSV);
    for (const p of [`${rel}/secret.csv`, `${rel}/datasets/../secret.csv`]) {
      expect(sharedDataSource(be.ws, p)).toBeUndefined();
      await expect(be.invoke('datasets.preview', { name: p })).rejects.toThrow(/No shared dataset/);
      await expect(be.invoke('datasets.open', { name: p })).rejects.toThrow();
    }
    await be.invoke('ws.shareRemove', { path: rel });
    expect(((await be.invoke('datasets.list', {})) as Array<{ name: string }>).some((d) => d.name === name)).toBe(false);
  });
});
