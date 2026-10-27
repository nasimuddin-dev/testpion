import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';

const root = join(__dirname, '..', '..', 'apps', 'desktop', 'backend');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The save calls that run for a user's action in the app must not pause the Electron main thread on a busy file (D-2). */
describe('backend handlers save without blocking the thread', () => {
  const handlers = readdirSync(join(root, 'handlers')).filter((f) => f.endsWith('.ts'));
  const SYNC = /\bbe\.ws\.(writeTestFile|saveProviders|saveMcpServers|saveBaseline|saveScriptPackage|saveCollection)\(/;

  it('no handler for a user action calls the synchronous twin', () => {
    const offenders: string[] = [];
    for (const f of handlers) {
      readFileSync(join(root, 'handlers', f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (SYNC.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    // what remains is a one-time import / first-launch write, kept synchronous on purpose (the CLI and tests use the sync twins too)
    expect(offenders.filter((o) => !/^(workspace|collections)\.ts:/.test(o))).toEqual([]);
    expect(offenders.length).toBeLessThanOrEqual(2);
  });
});

describe('the asynchronous twins write the same files', () => {
  it('test files, providers, MCP servers, baselines and script packages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-async-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'w', name: 'W', variables: [] }));
    const ws = WorkspaceStore.open(dir);
    await ws.writeTestFileAsync('a/flow.yaml', 'name: x\r\nsteps: []\r\n');
    expect(ws.readTestFile('a/flow.yaml')).not.toContain('\r');
    await ws.saveProvidersAsync([{ id: 'p', name: 'P', kind: 'mock', baseUrl: 'http://x' } as never]);
    expect(ws.getProviders().map((p) => p.id)).toEqual(['p']);
    await expect(ws.saveProvidersAsync([{ id: 'q', name: 'Q', kind: 'openai', baseUrl: 'http://x', apiKey: 'sk-literal' } as never])).rejects.toThrow(/literal API key/);
    await ws.saveMcpServersAsync([{ id: 's', name: 'S', transport: 'stdio', command: 'x' } as never]);
    expect(ws.getMcpServers().map((s) => s.id)).toEqual(['s']);
    await ws.saveBaselineAsync({ name: 'Main base', createdAt: 'now', runId: 'r', tests: {} } as never);
    expect(ws.getBaseline('Main base').runId).toBe('r');
    await ws.saveScriptPackageAsync('util', 'module.exports = 1');
    expect(ws.readScriptPackage('util')).toContain('module.exports');
    // no temp file is left behind
    const leftovers = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    ws.close();
  });
});
