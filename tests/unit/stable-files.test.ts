import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { KIND_INFO, liveKinds } from '@testpion/shared';
import { WorkspaceStore, canonicalText, mergeWorkspaceTexts, normalizeText, type Collection } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * Stable files (planning/git-everything.md §4b), release A: for every kind the app writes, saving twice leaves the same
 * bytes, saving the same content with its keys in another order leaves the same bytes, and nothing volatile (a save
 * time, a counter) is in the file. An older file still loads with all of its content.
 */

const t = tempDir('tp-stable-');
afterAll(() => t.cleanup());

type Json = unknown;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The same value with every object's keys in the opposite order (arrays keep theirs). */
const reversed = (v: Json): Json =>
  Array.isArray(v)
    ? v.map(reversed)
    : isObj(v)
      ? Object.fromEntries(
          Object.keys(v)
            .reverse()
            .map((k) => [k, reversed(v[k])]),
        )
      : v;
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

const collection = (): Collection =>
  ({
    schemaVersion: '1.0',
    id: 'shop',
    name: 'Shop',
    version: 0,
    variables: [{ key: 'host', value: 'x', enabled: true }],
    updatedAt: '',
    items: [{ kind: 'http', id: 'r1', name: 'List', request: { url: 'https://x/items', method: 'GET', headers: [{ value: 'a', key: 'X-A' }] } }],
  }) as Collection;

/** One sample file of each kind the app writes, as the editors would build the object (any key order). */
const SAMPLES: Record<string, Json> = {
  'collections/shop.json': collection(),
  'environments/staging.json': {
    variables: [
      { value: 'https://s', key: 'baseUrl', enabled: true },
      { secret: true, value: '', key: 'token' },
    ],
    name: 'Staging',
    id: 'staging',
    isProduction: false,
  },
  'workspace.json': { updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', variables: [{ value: 'K', key: 'app' }], name: 'Kinds', id: 'ws-1', schemaVersion: '1.0' },
  'library/grpc.json': {
    items: [{ data: { method: 'Greeter/Hello', target: 'localhost:50051' }, collectionId: 'api', name: 'Say hello', id: 'g1', updatedAt: '2026-02-02T00:00:00.000Z' }],
    folders: ['b', 'a'],
    schemaVersion: '1.0',
  },
  'library/websocket.json': { items: [{ data: { url: 'ws://x', protocols: ['a'] }, name: 'Echo', id: 'w1', updatedAt: 'now' }], folders: [], schemaVersion: '1.0' },
  'library/ai-prompts.json': { items: [{ data: { text: 'hi', model: { provider: 'demo' } }, folder: 'f', name: 'Greet', id: 'p1', updatedAt: 'now' }], folders: ['f'], schemaVersion: '1.0' },
  'library/load-tests.json': { items: [{ data: { vus: 5, duration: '10s' }, name: 'Pets', id: 'lt1', updatedAt: 'now' }], folders: [], schemaVersion: '1.0' },
  'library/evaluations.json': { items: [{ data: { cases: [] }, name: 'Tone', id: 'ev1', updatedAt: 'now' }], folders: [], schemaVersion: '1.0' },
  'library/monitors.json': { items: [{ data: { every: '5m' }, name: 'Pets', id: 'mon1', updatedAt: 'now' }], folders: [], schemaVersion: '1.0' },
  'mcp-servers.json': { servers: [{ env: { Z: '1', A: '2' }, args: ['--x'], command: 'npx', transport: 'stdio', name: 'Weather', id: 'weather' }], schemaVersion: '1.0' },
  'providers.json': {
    providers: [{ defaultModel: 'm', baseUrl: 'https://api', kind: 'openai-compatible', name: 'OpenAI', id: 'openai', apiKey: '{{$secret.provider.openai.apiKey}}' }],
    schemaVersion: '1.0',
  },
  'debugger/rules.json': { profiles: { Default: [{ enabled: true, id: 'r1' }] }, active: 'Default' },
};

describe('every kind of JSON file has one stable form', () => {
  for (const [path, sample] of Object.entries(SAMPLES)) {
    it(`${path}: the same bytes from any key order, saved again, with LF and one final newline`, () => {
      const text = JSON.stringify(sample);
      const once = canonicalText(path, text)!;
      expect(once, 'is a stable kind').toBeTypeOf('string');
      expect(canonicalText(path, JSON.stringify(reversed(sample)))).toBe(once);
      expect(canonicalText(path, once)).toBe(once);
      // a CRLF copy (a Windows checkout) is the same file
      expect(canonicalText(path, once.replace(/\n/g, '\r\n'))).toBe(once);
      expect(once.endsWith('}\n') && !once.endsWith('\n\n') && !once.includes('\r')).toBe(true);
      // nothing volatile
      if (path.startsWith('library/')) expect(once).not.toContain('updatedAt');
      if (path.startsWith('collections/')) expect(once).not.toMatch(/"version"|"updatedAt"/);
    });
  }

  it('a test file is the user’s text: only LF line endings and a final newline', () => {
    const yaml = '# keep me\r\nname: Login\r\ntests:\r\n  - id: a  # a comment\r\n\r\n\r\n';
    expect(canonicalText('tests/smoke/login.yaml', yaml)).toBe('# keep me\nname: Login\ntests:\n  - id: a  # a comment\n');
    expect(normalizeText('﻿a\r\nb')).toBe('a\nb\n');
    expect(normalizeText('')).toBe('');
  });

  it('a raw document or a broken file has no stable form (it is never rewritten)', () => {
    expect(canonicalText('specs/petstore.yaml', 'openapi: 3.0.0')).toBeUndefined();
    expect(canonicalText('datasets/users.csv', 'a,b')).toBeUndefined();
    expect(canonicalText('packages/helpers.js', 'x')).toBeUndefined();
    expect(canonicalText('mcp-servers.json', '{ not json')).toBeUndefined();
  });

  it('library items keep their order and the folders come out sorted', () => {
    const out = JSON.parse(canonicalText('library/grpc.json', JSON.stringify(SAMPLES['library/grpc.json']))!);
    expect(out.folders).toEqual(['a', 'b']);
    expect(Object.keys(out.items[0])).toEqual(['id', 'name', 'collectionId', 'data']);
    const servers = JSON.parse(canonicalText('mcp-servers.json', JSON.stringify(SAMPLES['mcp-servers.json']))!);
    expect(Object.keys(servers.servers[0])).toEqual(['id', 'name', 'transport', 'command', 'args', 'env']);
    expect(Object.keys(servers.servers[0].env)).toEqual(['A', 'Z']);
  });

  it('every kind the app writes as JSON has a stable form, and every raw document has none (enumerated from the registry)', () => {
    const root = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
    const json = new Set(['file-per-item', 'items-in-file', 'single-file', 'library']);
    const checked: string[] = [];
    for (const k of liveKinds()) {
      const sample = k.sample ?? (k.variantOf ? KIND_INFO[k.variantOf].sample : undefined);
      if (!sample || !existsSync(join(root, sample)) || /\.(har)$/.test(sample)) continue;
      const text = readFileSync(join(root, sample), 'utf8');
      const stable = canonicalText(sample, text);
      if (json.has(k.storage.layout)) {
        expect(stable, `${k.id} (${sample}) is a JSON file the app writes: it needs a stable form`).toBeTypeOf('string');
        expect(canonicalText(sample, stable!), k.id).toBe(stable);
        checked.push(k.id);
      } else if (k.id === 'test' || k.id === 'flow')
        expect(stable, k.id).toBeTypeOf('string'); // text normalised
      else if (k.storage.layout === 'raw-document') expect(stable, `${k.id} is the user's own document: never rewritten`).toBeUndefined();
    }
    // the JSON kinds: collection, environment, workspace, MCP servers, providers, rules, the six library kinds
    expect(checked.sort()).toEqual(
      expect.arrayContaining(['collection', 'debugger-rules', 'environment', 'evaluation', 'grpc-call', 'load-test', 'mcp-server', 'monitor', 'prompt', 'provider', 'workspace', 'ws-connection']),
    );
  });

  it('every file of the kinds fixture workspace that has a stable form is stable', () => {
    const root = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    let stable = 0;
    for (const f of walk(root)) {
      const p = relative(root, f).split(sep).join('/');
      const once = canonicalText(p, readFileSync(f, 'utf8'));
      if (once === undefined) continue;
      stable++;
      expect(canonicalText(p, once), p).toBe(once);
    }
    expect(stable).toBeGreaterThan(8);
  });
});

describe('the store writes the stable form, and writes it once', () => {
  it('environments, workspace settings, library files, MCP servers and providers: saved twice, or from another key order, are the same bytes', () => {
    const store = WorkspaceStore.create(join(t.dir, 'ws-save'), 'Save');
    const root = store.root;
    const saves: Array<[string, (reverse: boolean) => void]> = [
      ['environments/staging.json', (r) => store.saveEnvironment((r ? reversed : (x: Json) => x)(SAMPLES['environments/staging.json']) as never)],
      ['mcp-servers.json', (r) => store.saveMcpServers(((r ? reversed : (x: Json) => x)(SAMPLES['mcp-servers.json']) as { servers: never[] }).servers)],
      ['providers.json', (r) => store.saveProviders(((r ? reversed : (x: Json) => x)(SAMPLES['providers.json']) as { providers: never[] }).providers)],
      ['library/grpc.json', (r) => store.saveLibrary('grpc', (r ? reversed : (x: Json) => x)(SAMPLES['library/grpc.json']) as never)],
      ['library/monitors.json', (r) => store.saveLibrary('monitors', (r ? reversed : (x: Json) => x)(SAMPLES['library/monitors.json']) as never)],
      ['collections/shop.json', (r) => store.saveCollection((r ? reversed : (x: Json) => x)(collection()) as never)],
    ];
    for (const [path, save] of saves) {
      save(false);
      const first = read(root, path);
      save(false);
      expect(read(root, path), `${path} saved again`).toBe(first);
      save(true);
      expect(read(root, path), `${path} from another key order`).toBe(first);
      // the file on disk is its own stable form
      expect(canonicalText(path, first), path).toBe(first);
    }
    store.updateWorkspace({ description: 'd' });
    const ws1 = read(root, 'workspace.json');
    store.updateWorkspace({ description: 'd' });
    expect(read(root, 'workspace.json')).toBe(ws1);
    expect(canonicalText('workspace.json', ws1)).toBe(ws1);
    // no save time in a library item, a test file is LF with one final newline
    expect(read(root, 'library/grpc.json')).not.toContain('updatedAt');
    store.writeTestFile('smoke/a.yaml', 'name: a\r\n\r\n');
    expect(read(root, 'tests/smoke/a.yaml')).toBe('name: a\n');
    store.close();
  });

  it('an older file (CRLF, other key order, a save time in the items) still loads with all its content, and is untouched until its item is saved', () => {
    const store = WorkspaceStore.create(join(t.dir, 'ws-old'), 'Old');
    const root = store.root;
    mkdirSync(join(root, 'library'), { recursive: true });
    const lib =
      '{\r\n  "items": [\r\n    { "updatedAt": "2026-01-01T00:00:00.000Z", "data": { "z": 1, "a": 2 }, "name": "Hello", "id": "g1" }\r\n  ],\r\n  "folders": ["z", "a"],\r\n  "schemaVersion": "1.0"\r\n}';
    const servers = '{ "servers": [ { "name": "Old", "id": "s1", "transport": "http", "url": "https://x", "headers": [ { "key": "A", "value": "1" } ] } ] }';
    const providers = '{ "providers": [ { "baseUrl": "https://api", "kind": "ollama", "name": "Local", "id": "local" } ] }';
    writeFileSync(join(root, 'library', 'grpc.json'), lib);
    writeFileSync(join(root, 'mcp-servers.json'), servers);
    writeFileSync(join(root, 'providers.json'), providers);
    // read: all content is there (the old save time too: it is dropped when the item is saved, not when it is read)
    const got = store.getLibrary<{ z: number; a: number }>('grpc');
    expect(got.items).toEqual([{ updatedAt: '2026-01-01T00:00:00.000Z', data: { z: 1, a: 2 }, name: 'Hello', id: 'g1' }]);
    expect(got.folders).toEqual(['z', 'a']);
    expect(store.getMcpServers()).toEqual([{ name: 'Old', id: 's1', transport: 'http', url: 'https://x', headers: [{ key: 'A', value: '1' }] }]);
    expect(store.getProviders()).toEqual([{ baseUrl: 'https://api', kind: 'ollama', name: 'Local', id: 'local' }]);
    expect(read(root, 'library/grpc.json')).toBe(lib);
    expect(read(root, 'mcp-servers.json')).toBe(servers);
    // saving writes the stable form and keeps everything that was in them
    store.saveLibrary('grpc', got);
    store.saveMcpServers(store.getMcpServers());
    store.saveProviders(store.getProviders());
    const after = store.getLibrary<{ z: number; a: number }>('grpc');
    expect(after.items).toEqual([{ id: 'g1', name: 'Hello', data: { a: 2, z: 1 } }]);
    expect(after.folders).toEqual(['a', 'z']);
    expect(store.getMcpServers()).toEqual([{ id: 's1', name: 'Old', transport: 'http', url: 'https://x', headers: [{ key: 'A', value: '1' }] }]);
    expect(store.getProviders()).toEqual([{ id: 'local', name: 'Local', kind: 'ollama', baseUrl: 'https://api' }]);
    store.close();
  });

  it('the generated .gitignore keeps the migration copy of workspace.json out, and .gitattributes merges the lists by item', () => {
    const store = WorkspaceStore.create(join(t.dir, 'ws-ignore'), 'Ignore');
    expect(read(store.root, '.gitignore')).toMatch(/^workspace\.json\.bak-\*$/m);
    expect(read(store.root, '.gitattributes')).toMatch(/^mcp-servers\.json merge=testpion diff=testpion$/m);
    expect(read(store.root, '.gitattributes')).toMatch(/^providers\.json merge=testpion diff=testpion$/m);
    expect(existsSync(join(store.root, '.gitattributes'))).toBe(true);
    store.close();
  });
});

describe('MCP servers and providers merge by item', () => {
  const file = (servers: unknown[]) => JSON.stringify({ schemaVersion: '1.0', servers }, null, 2) + '\n';
  const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), transport: 'http', url: `https://${id}`, ...extra });

  it('two people changing different servers get both changes; the same server changed differently conflicts', () => {
    const base = file([s('a'), s('b')]);
    const ours = file([s('a', { url: 'https://a2' }), s('b')]);
    const theirs = file([s('a'), s('b', { url: 'https://b2' }), s('c')]);
    const merged = mergeWorkspaceTexts(base, ours, theirs, {}, 'mcp-servers.json')!;
    expect(merged.conflicts).toEqual([]);
    expect(JSON.parse(merged.text).servers.map((x: { id: string; url: string }) => [x.id, x.url])).toEqual([
      ['a', 'https://a2'],
      ['b', 'https://b2'],
      ['c', 'https://c'],
    ]);
    const clash = mergeWorkspaceTexts(base, file([s('a', { url: 'https://one' }), s('b')]), file([s('a', { url: 'https://two' }), s('b')]), {}, 'mcp-servers.json')!;
    expect(clash.conflicts.length).toBe(1);
    expect(clash.items[0]!.where).toMatch(/A/);
  });

  it('providers merge the same way', () => {
    const f = (providers: unknown[]) => JSON.stringify({ schemaVersion: '1.0', providers });
    const p = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, kind: 'mock', baseUrl: `mock://${id}`, ...extra });
    const merged = mergeWorkspaceTexts(f([p('x'), p('y')]), f([p('x', { defaultModel: 'm' }), p('y')]), f([p('x'), p('y'), p('z')]), {}, 'providers.json')!;
    expect(merged.conflicts).toEqual([]);
    expect(JSON.parse(merged.text).providers.map((x: { id: string }) => x.id)).toEqual(['x', 'y', 'z']);
    // the merged file is in the stable form
    expect(canonicalText('providers.json', merged.text)).toBe(merged.text);
  });
});
