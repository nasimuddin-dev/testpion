import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The first rename of a write finds the file busy (an indexer, a virus scanner): the write waits and retries. A later save of the
// same file must not land first and then be overwritten by the older bytes (review 2026-10-27, robustness 3.5).
const busy = vi.hoisted(() => ({ left: 0, marker: '' }));
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  const fs = await import('node:fs');
  const fail = async (from: unknown, to: unknown, f: (a: never, b: never) => Promise<void>) => {
    if (busy.left > 0 && busy.marker && typeof from === 'string' && fs.readFileSync(from, 'utf8').includes(busy.marker)) {
      busy.left--;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return f(from as never, to as never);
  };
  return { ...actual, rename: (a: never, b: never) => fail(a, b, actual.rename), copyFile: (a: never, b: never) => fail(a, b, actual.copyFile) };
});

import { WorkspaceStore } from '../../packages/core/src/index.js';
import { WriteQueue } from '../../packages/core/src/storage/serial-writes.js';

const dirs: string[] = [];
afterEach(() => {
  busy.left = 0;
  busy.marker = '';
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 }); // the database may still be open on Windows: the system's temp cleanup takes it
    } catch {
      /* left */
    }
  }
});
function open(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'tp-serial-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'w', name: 'W', variables: [] }));
  return WorkspaceStore.open(dir);
}

describe('WriteQueue', () => {
  it('runs writes of one file in the order they were started, writes of different files independently, and a failure is its own', async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    const slow = q.run('a', async () => (await new Promise((r) => setTimeout(r, 60)), log.push('a1')));
    const fail = q.run('a', async () => Promise.reject(new Error('boom')));
    const last = q.run('a', async () => void log.push('a3'));
    const other = q.run('b', async () => void log.push('b1'));
    await Promise.all([slow, other, last]);
    await expect(fail).rejects.toThrow('boom');
    expect(log).toEqual(['b1', 'a1', 'a3']);
    await new Promise((r) => setImmediate(r));
    expect(q.pending).toBe(0);
  });
});

describe('the asynchronous writers keep the order of their saves', () => {
  it('test file: the first save meets a busy file, the second is started meanwhile; the file ends with the second', async () => {
    const ws = open();
    await ws.writeTestFileAsync('t.yaml', 'v0: 1\n');
    busy.marker = 'v1';
    busy.left = 4; // the rename and the copy fallback of the first write fail, then its retries wait 50 ms
    const a = ws.writeTestFileAsync('t.yaml', 'v1: 1\n');
    const b = ws.writeTestFileAsync('t.yaml', 'v2: 1\n');
    await Promise.all([a, b]);
    expect(ws.readTestFile('t.yaml')).toBe('v2: 1\n');
  });

  it('providers, MCP servers, baselines and script packages end with the latest save', async () => {
    const ws = open();
    busy.marker = 'first';
    busy.left = 4;
    await Promise.all([ws.saveProvidersAsync([{ id: 'p', name: 'first' } as never]), ws.saveProvidersAsync([{ id: 'p', name: 'second' } as never])]);
    expect(JSON.stringify(ws.getProviders())).toContain('second');
    busy.marker = 'first';
    busy.left = 4;
    await Promise.all([ws.saveMcpServersAsync([{ id: 'm', name: 'first', transport: 'stdio' } as never]), ws.saveMcpServersAsync([{ id: 'm', name: 'second', transport: 'stdio' } as never])]);
    expect(JSON.stringify(ws.getMcpServers())).toContain('second');
    busy.marker = 'first';
    busy.left = 4;
    const base = (note: string) => ({ name: 'b', createdAt: 'now', runId: 'r', tests: {}, note }) as never;
    await Promise.all([ws.saveBaselineAsync(base('first')), ws.saveBaselineAsync(base('second'))]);
    expect(readFileSync(join(ws.root, 'baselines', 'b.json'), 'utf8')).toContain('second');
    busy.marker = 'first';
    busy.left = 4;
    await Promise.all([ws.saveScriptPackageAsync('lib', '// first\n'), ws.saveScriptPackageAsync('lib', '// second\n')]);
    expect(ws.readScriptPackage?.('lib') ?? readFileSync(join(ws.root, 'packages', 'lib.js'), 'utf8')).toContain('second');
  });
});
