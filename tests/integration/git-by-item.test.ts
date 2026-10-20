import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, runGit } from '../../packages/core/src/index.js';
import { cliData, cliPath, gitIdentity, runCliSync, tempDir } from '../helpers';

/**
 * Release A of "Everything under Git": `testpion git status --by-item --json` and the MCP tool `git_changes` return the
 * rows of the Git view, named by item, filtered by kind; the same rows from both.
 */
const t = tempDir('tp-git-items-');
let ws: string;
const cli = (...args: string[]) => runCliSync([...args, '-w', ws], { home: join(t.dir, 'home') });

beforeAll(async () => {
  const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Kinds');
  ws = store.root;
  cpSync(join(__dirname, '..', 'fixtures', 'kinds', 'workspace'), ws, { recursive: true });
  await runGit(ws, ['init', '-b', 'main']);
  await gitIdentity(ws);
  await runGit(ws, ['add', '.']);
  await runGit(ws, ['commit', '-m', 'base']);
  store.saveMcpServers([
    { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' },
    { id: 'search', name: 'Search', transport: 'http', url: 'https://search.example.com/mcp' },
  ] as never);
  writeFileSync(join(ws, 'datasets', 'users.csv'), 'id,name\n1,Ada\n2,Grace\n');
  store.close();
});
afterAll(() => t.cleanup());

describe('git status --by-item', () => {
  it('lists the changed items by name, with kind, details, ref and file', () => {
    const r = cli('git', 'status', '--by-item', '--json');
    expect(r.status, r.err).toBe(0);
    const data = cliData<{ repository: boolean; branch: string; items: Array<{ kind: string; title: string; change: string; details: string[]; ref: { kind: string }; link: string; file: string }> }>(
      r.out,
    );
    expect(data).toMatchObject({ repository: true, branch: 'main' });
    expect(data.items.map((i) => [i.kind, i.title, i.change])).toEqual(
      expect.arrayContaining([
        ['mcp-server', 'MCP server Search', 'added'],
        ['dataset', 'Dataset users.csv', 'changed'],
      ]),
    );
    const search = data.items.find((i) => i.title === 'MCP server Search')!;
    expect(search).toMatchObject({ file: 'mcp-servers.json', ref: { kind: 'mcp-server', serverId: 'search' } });
    expect(search.link).toMatch(/^testpion:\/\/open\?kind=mcp-server&serverId=search/);
    expect(data.items.find((i) => i.title === 'Dataset users.csv')!.details).toEqual(['1 row added']);
  }, 120_000);

  it('--kind keeps the kinds asked for (ids or aliases); an unknown kind says what is valid', () => {
    const r = cli('git', 'status', '--by-item', '--kind', 'mcp-server', '--json');
    const items = cliData<{ items: Array<{ kind: string }> }>(r.out).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === 'mcp-server')).toBe(true);
    const text = cli('git', 'status', '--by-item');
    expect(text.out).toMatch(/A MCP server Search/);
    expect(text.out).toMatch(/M Dataset users\.csv/);
    const bad = cli('git', 'status', '--by-item', '--kind', 'nope');
    expect(bad.status).not.toBe(0);
    expect(bad.err + bad.out).toMatch(/Unknown kind "nope"/);
  }, 120_000);

  it('the MCP tool git_changes returns the same rows', async () => {
    const s = new McpSession({ id: 'gi', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws], env: { TESTPION_HOME: join(t.dir, 'home') } });
    await s.connect(20_000);
    try {
      const all = JSON.parse(mcpResultBody(await s.callTool('git_changes', {})).text) as { items?: Array<{ title: string; kind: string }> } & Array<{ title: string; kind: string }>;
      const rows = Array.isArray(all) ? all : (all.items ?? []);
      expect(rows.map((r) => r.title)).toEqual(expect.arrayContaining(['MCP server Search', 'Dataset users.csv']));
      const only = JSON.parse(mcpResultBody(await s.callTool('git_changes', { kind: 'dataset' })).text) as { items?: Array<{ kind: string }> } & Array<{ kind: string }>;
      const filtered = Array.isArray(only) ? only : (only.items ?? []);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((r) => r.kind === 'dataset')).toBe(true);
    } finally {
      await s.close();
    }
  }, 120_000);
});
