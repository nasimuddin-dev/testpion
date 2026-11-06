import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';

// A `shared` entry of workspace.json that came with a pull is not read in the app until "Allow on this computer"
// (as a monitor's schedule and the Debugger's rules); one added in the app is read at once; the CLI reads every entry.
const home = mkdtempSync(join(tmpdir(), 'tp-shared-trust-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

type Shared = { waiting: Array<{ path: string }>; environments: Array<{ name: string }>; specs: string[] };

describe('shared entries that came with a pull', () => {
  const other = join(dirname(be.ws.root), 'pulled-platform');
  mkdirSync(join(other, 'environments'), { recursive: true });
  mkdirSync(join(other, 'specs'), { recursive: true });
  writeFileSync(join(other, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'pp', name: 'Pulled' }));
  writeFileSync(join(other, 'environments', 'pp-staging.json'), JSON.stringify({ id: 'pp-staging', name: 'Pulled staging', variables: [] }));
  writeFileSync(join(other, 'specs', 'pp.yaml'), 'openapi: 3.0.3\ninfo: { title: P, version: "1" }\npaths: {}\n');
  const rel = relative(be.ws.root, other).split('\\').join('/');

  it('waits, reads nothing of the folder, and is read once allowed', async () => {
    // as a pull writes it: workspace.json changed outside the app
    be.ws.updateWorkspace({ shared: [{ path: rel, kinds: ['environments', 'specs'] }] });
    const before = (await be.invoke('ws.shared', {})) as Shared;
    expect(before.waiting.map((w) => w.path)).toEqual([rel]);
    expect(before.environments).toEqual([]);
    expect(before.specs).toEqual([]);
    expect(((await be.invoke('env.list', {})) as Array<{ name: string }>).some((e) => e.name === 'Pulled staging')).toBe(false);
    expect((await be.invoke('openapi.specs', {})) as string[]).not.toContain(`${rel}/specs/pp.yaml`);
    await expect(be.invoke('openapi.spec.get', { path: `${rel}/specs/pp.yaml` })).rejects.toThrow(/Not an API definition/);
    expect(await be.invoke('ws.shareWaiting', {})).toHaveLength(1);
    // the CLI (a pipeline) reads what the repository says
    const cli = WorkspaceStore.open(be.ws.root);
    try {
      expect(cli.listEnvironments().some((e) => e.name === 'Pulled staging')).toBe(true);
    } finally {
      cli.close();
    }

    const after = (await be.invoke('ws.shareAllow', {})) as Shared;
    expect(after.waiting).toEqual([]);
    expect(after.environments.map((e) => e.name)).toEqual(['Pulled staging']);
    expect(after.specs).toEqual([`${rel}/specs/pp.yaml`]);
  });

  it('a pulled change to the entry (more kinds) waits again; one added in the app does not', async () => {
    be.ws.updateWorkspace({ shared: [{ path: rel, kinds: ['environments'] }] });
    expect(((await be.invoke('ws.shared', {})) as Shared).waiting).toHaveLength(1);
    await be.invoke('ws.shareAdd', { path: rel });
    const added = (await be.invoke('ws.shared', {})) as Shared;
    expect(added.waiting).toEqual([]);
    expect(added.environments.map((e) => e.name)).toEqual(['Pulled staging']);
  });

  it('Undo of removing an entry that waited puts it back waiting', async () => {
    be.ws.updateWorkspace({ shared: [{ path: rel, kinds: ['specs'] }] });
    expect(((await be.invoke('ws.shared', {})) as Shared).waiting).toHaveLength(1);
    await be.invoke('ws.shareRemove', { path: rel });
    const back = (await be.invoke('ws.shareAdd', { path: rel, kinds: ['specs'], waiting: true })) as Shared;
    expect(back.waiting.map((w) => w.path)).toEqual([rel]);
    expect(back.specs).toEqual([]);
  });
});
