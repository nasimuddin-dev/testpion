import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createTestPionMcpServer,
  datasetColumns,
  EnvSecretStore,
  listTrash,
  moveToTrash,
  readWorkspaceDataset,
  restoreFromTrash,
  WorkspaceManager,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { copyExample, runCliSync, tempDir } from '../helpers.js';

// Datasets as the app's sidebar, `testpion datasets show` and the read_dataset MCP tool read them: the first rows with
// the columns and their kinds of value, the record count, and a deleted dataset in the workspace's trash.
const tmp = tempDir('tp-datasets-');
const ws = copyExample('public-workspace', join(tmp.dir, 'ws'));
let store: WorkspaceStore;
let client: Client;

beforeAll(async () => {
  mkdirSync(join(ws, 'datasets', 'nested'), { recursive: true });
  writeFileSync(join(ws, 'datasets', 'users.csv'), 'id,name,active,score\n1,Ann,true,9.5\n2,Bob,false,7\n3,"Cy, Jr.",true,\n');
  writeFileSync(
    join(ws, 'datasets', 'nested', 'mixed.json'),
    JSON.stringify([
      { id: 1, tags: ['a'], meta: { k: 1 } },
      { id: 'two', tags: [] },
    ]),
  );
  const mgr = new WorkspaceManager(join(tmp.dir, 'home'));
  store = mgr.open(ws);
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
  store.close();
  tmp.cleanup();
});

const text = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: !!r.isError, data: r.isError ? t : JSON.parse(t) };
};

describe('datasets: columns and the first rows', () => {
  it('names each column with the kind of value it holds (CSV numbers and booleans included)', () => {
    expect(
      datasetColumns([
        { a: '1', b: 'true', c: 'x', d: null },
        { a: '2.5', b: 'false', c: 3, d: null },
      ]),
    ).toEqual([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'boolean' },
      { name: 'c', type: 'mixed' },
      { name: 'd', type: 'null' },
    ]);
    expect(datasetColumns([{ tags: ['a'], meta: { k: 1 }, n: 1 }, { n: 2 }])).toEqual([
      { name: 'tags', type: 'array' },
      { name: 'meta', type: 'object' },
      { name: 'n', type: 'number' },
    ]);
  });

  it('reads a dataset by its name under datasets/, with the count of all records and only the first rows', async () => {
    const d = await readWorkspaceDataset(store, 'users.csv', { limit: 2 });
    expect(d).toMatchObject({ path: 'datasets/users.csv', name: 'users.csv', format: 'csv', count: 3 });
    expect(d.rows).toEqual([
      { id: 1, name: 'Ann', active: true, score: 9.5 },
      { id: 2, name: 'Bob', active: false, score: 7 },
    ]);
    expect(d.columns).toEqual([
      { name: 'id', type: 'number' },
      { name: 'name', type: 'string' },
      { name: 'active', type: 'boolean' },
      { name: 'score', type: 'number' },
    ]);
    // a folder inside datasets/, with or without the datasets/ prefix; JSON with mixed values
    const n = await readWorkspaceDataset(store, 'datasets/nested/mixed.json');
    expect(n).toMatchObject({ path: 'datasets/nested/mixed.json', name: 'nested/mixed.json', format: 'json', count: 2 });
    expect(n.columns).toEqual([
      { name: 'id', type: 'mixed' },
      { name: 'tags', type: 'array' },
      { name: 'meta', type: 'object' },
    ]);
    const j = await readWorkspaceDataset(store, 'intents.jsonl', { limit: 1 });
    expect(j.count).toBe(7);
    expect(j.rows).toHaveLength(1);
    expect(j.columns.map((c) => c.name)).toEqual(['id', 'message', 'expected']);
  });

  it('refuses a missing dataset and a path outside datasets/', async () => {
    await expect(readWorkspaceDataset(store, 'nope.csv')).rejects.toThrow(/No dataset datasets\/nope\.csv/);
    await expect(readWorkspaceDataset(store, '../workspace.json')).rejects.toThrow(/escapes/);
    await expect(readWorkspaceDataset(store, '')).rejects.toThrow(/name is needed/);
  });
});

describe('MCP: list_datasets and read_dataset', () => {
  it('lists the datasets and reads the first rows of one', async () => {
    const list = await text('list_datasets', {});
    expect(list.data.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['datasets/users.csv', 'datasets/intents.jsonl', 'datasets/nested/mixed.json']));
    const r = await text('read_dataset', { name: 'users.csv', limit: 1 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ name: 'users.csv', format: 'csv', count: 3, rows: [{ id: 1, name: 'Ann' }] });
    expect(r.data.columns).toEqual([
      { name: 'id', type: 'number' },
      { name: 'name', type: 'string' },
      { name: 'active', type: 'boolean' },
      { name: 'score', type: 'number' },
    ]);
    const missing = await text('read_dataset', { name: 'nope.csv' });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatch(/No dataset/);
  });
});

describe('CLI: datasets show', () => {
  it('prints the columns with their kinds, the rows, and the rest as a count; --json gives it all', () => {
    const r = runCliSync(['datasets', 'show', 'users.csv', '--limit', '2'], { cwd: ws, home: join(tmp.dir, 'home') });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/datasets\/users\.csv\s+csv, .* 3 records, 4 columns/);
    expect(r.out).toMatch(/id\s+name\s+active\s+score/);
    expect(r.out).toMatch(/number\s+string\s+boolean\s+number/);
    expect(r.out).toMatch(/1\s+Ann\s+true\s+9\.5/);
    expect(r.out).toMatch(/… 1 more/);
    const j = runCliSync(['datasets', 'show', 'intents.jsonl', '--json', '-n', '1'], { cwd: ws, home: join(tmp.dir, 'home') });
    expect(j.status, j.err).toBe(0);
    const d = JSON.parse(j.out);
    expect(d).toMatchObject({ path: 'datasets/intents.jsonl', format: 'jsonl', count: 7 });
    expect(d.rows).toHaveLength(1);
    expect(d.columns).toEqual([
      { name: 'id', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'expected', type: 'string' },
    ]);
    const bad = runCliSync(['datasets', 'show', 'nope.csv'], { cwd: ws, home: join(tmp.dir, 'home') });
    expect(bad.status).not.toBe(0);
    expect(bad.err).toMatch(/No dataset datasets\/nope\.csv/);
    // the plain listing still works beside the subcommand
    const list = runCliSync(['datasets'], { cwd: ws, home: join(tmp.dir, 'home') });
    expect(list.status, list.err).toBe(0);
    expect(list.out).toMatch(/datasets\/users\.csv/);
  });
});

describe('a deleted dataset in the trash', () => {
  it('keeps the file with its name, lists it, and restores it beside a newer file of the same name', () => {
    const file = join(ws, 'datasets', 'users.csv');
    const before = readFileSync(file, 'utf8');
    moveToTrash(store, 'dataset', file);
    expect(existsSync(file)).toBe(false);
    const entry = listTrash(store).find((t) => t.kind === 'dataset');
    expect(entry).toMatchObject({ name: 'users.csv', itemId: 'users.csv', size: before.length });
    const back = restoreFromTrash(store, entry!.id);
    expect(back).toEqual({ kind: 'dataset', id: 'users.csv', name: 'users.csv' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    // deleted again while a new users.csv exists: restored as users-restored.csv
    moveToTrash(store, 'dataset', file);
    writeFileSync(file, 'id\n9\n');
    const again = listTrash(store).find((t) => t.kind === 'dataset')!;
    expect(restoreFromTrash(store, again.id).name).toBe('users-restored.csv');
    expect(readFileSync(join(ws, 'datasets', 'users-restored.csv'), 'utf8')).toBe(before);
  });
});
