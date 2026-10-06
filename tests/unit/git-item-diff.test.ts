import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, describeItemDiff, gitBranches, gitDeleteBranch, gitRenameBranch, gitSwitch, runGit } from '@testpion/core';

// GIT-205: one changed item side by side, part by part (last commit vs now).
const ws = mkdtempSync(join(tmpdir(), 'tp-itemdiff-'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const col = (url: string, header: string) =>
  JSON.stringify(
    {
      schemaVersion: '1.0',
      id: 'api',
      name: 'API',
      variables: [],
      items: [{ kind: 'folder', id: 'f', name: 'Orders', items: [{ kind: 'http', id: 'r1', name: 'Create', request: { method: 'POST', url, headers: [{ key: 'X-Mode', value: header }] } }] }],
    },
    null,
    2,
  );
const env = (value: string) =>
  JSON.stringify(
    {
      id: 'staging',
      name: 'Staging',
      variables: [
        { key: 'baseUrl', value },
        { key: 'token', value: '', secret: true },
      ],
    },
    null,
    2,
  );

describe('a changed item side by side', () => {
  it('shows a request, an environment and new or deleted items part by part', async () => {
    mkdirSync(join(ws, 'collections'));
    mkdirSync(join(ws, 'environments'));
    writeFileSync(join(ws, 'collections', 'api.json'), col('https://x/orders', 'a'));
    writeFileSync(join(ws, 'environments', 'staging.json'), env('https://staging'));
    await runGit(ws, ['init', '-b', 'main']);
    await runGit(ws, ['add', '.']);
    await runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'base']);
    writeFileSync(join(ws, 'collections', 'api.json'), col('https://x/orders/v2', 'a'));
    writeFileSync(join(ws, 'environments', 'staging.json'), env('https://staging-2'));

    const req = await describeItemDiff(ws, 'collections/api.json', 'r1');
    expect(req.title).toBe('API ▸ Create');
    expect(req.parts.filter((p) => p.differs)).toEqual([{ part: 'Request', before: 'POST https://x/orders', after: 'POST https://x/orders/v2', differs: true }]);
    expect(req.parts.find((p) => p.part === 'Headers')).toMatchObject({ before: 'X-Mode: a', after: 'X-Mode: a', differs: false });

    const e = await describeItemDiff(ws, 'environments/staging.json');
    expect(e.title).toBe('environment Staging');
    expect(e.parts.find((p) => p.part === '{{baseUrl}}')).toMatchObject({ before: 'https://staging', after: 'https://staging-2', differs: true });
    expect(e.parts.find((p) => p.part === '{{token}}')!.after).toMatch(/secret/);

    const missing = await describeItemDiff(ws, 'collections/api.json', 'nope');
    expect(missing.parts).toEqual([]);
    const settings = await describeItemDiff(ws, 'collections/api.json');
    expect(settings.title).toBe('collection API');
    expect(settings.parts.every((p) => !p.differs)).toBe(true);
  });
});

describe('branches (GIT-207)', () => {
  it('renames the current branch and deletes another, refusing an unmerged one unless forced', async () => {
    await runGit(ws, ['add', '.']);
    await runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'second']);
    await gitRenameBranch(ws, 'main', 'trunk');
    expect((await gitBranches(ws)).current).toBe('trunk');
    await gitSwitch(ws, 'feature/x', { create: true });
    writeFileSync(join(ws, 'notes.md'), 'x');
    await runGit(ws, ['add', '.']);
    await runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'on feature']);
    await gitSwitch(ws, 'trunk');
    await expect(gitDeleteBranch(ws, 'feature/x')).rejects.toThrow(/not fully merged/);
    await gitDeleteBranch(ws, 'feature/x', true);
    expect((await gitBranches(ws)).local).toEqual(['trunk']);
    await expect(gitRenameBranch(ws, 'trunk', '--evil')).rejects.toThrow(/Not a valid git/);
  });
});

describe('environment files (GIT-209)', () => {
  it('finds the file of an environment by id, by name, and when the file is named differently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-envfile-'));
    try {
      const store = WorkspaceStore.create(dir, 'Envs');
      store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [] });
      writeFileSync(join(dir, 'environments', 'legacy-file.json'), JSON.stringify({ id: 'prod-1', name: 'Production', variables: [] }));
      expect(store.environmentFileOf('staging')).toBe('environments/staging.json');
      expect(store.environmentFileOf('Production')).toBe('environments/legacy-file.json');
      expect(store.environmentFileOf('prod-1')).toBe('environments/legacy-file.json');
      expect(() => store.environmentFileOf('nope')).toThrow(/No environment/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
