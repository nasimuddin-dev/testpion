import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTemplateAdditions, collectNodeIds, duplicateNodeIds, repairTemplateDuplicates, WorkspaceManager, type IdNode } from '@testpion/core';

// The examples workspace shows each collection once, and no request id twice: the sidebar keys rows by them, and a
// shared id drew one request at several places (B-01). The seed data, a fresh install, every later examples update
// and a copy left with a second file by an older version all keep it that way.
const examples = join(__dirname, '..', '..', 'examples', 'public-workspace');
const root = mkdtempSync(join(tmpdir(), 'tp-examples-ids-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Doc = { id: string; name: string; items: IdNode[] };
const collectionsOf = (ws: string): Doc[] =>
  readdirSync(join(ws, 'collections'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ws, 'collections', f), 'utf8')) as Doc);
const read = (ws: string, rel: string) => JSON.parse(readFileSync(join(ws, rel), 'utf8')) as Doc;
const write = (ws: string, rel: string, v: unknown) => writeFileSync(join(ws, rel), JSON.stringify(v, null, 2));

function expectUnique(ws: string) {
  const cols = collectionsOf(ws);
  expect(duplicateNodeIds(cols)).toEqual([]);
  const ids = cols.map((c) => c.id);
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  const names = cols.map((c) => c.name);
  expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
}

describe('examples workspace ids', () => {
  it('the seed data has every collection once and no request id twice', () => {
    expectUnique(examples);
    expect(collectionsOf(examples).flatMap((c) => collectNodeIds(c.items)).length).toBeGreaterThan(50);
  });

  it('a fresh install and every later update keep them unique (the update is idempotent)', () => {
    const info = new WorkspaceManager(join(root, 'app')).installTemplate(examples);
    expectUnique(info.path);
    expect(addTemplateAdditions(examples, info.path)).toEqual([]);
    expect(addTemplateAdditions(examples, info.path)).toEqual([]);
    expectUnique(info.path);
  });

  it('merges a second copy left by an older version back into one collection, keeping the user’s requests', () => {
    const info = new WorkspaceManager(join(root, 'app2')).installTemplate(examples);
    const ws = info.path;
    // what an older version left: streams.json (id live-streams) saved as live-streams.json with an edit and a new
    // request; graphql.json (id graphql-public) saved as graphql-public.json, and the original renamed by listing
    const streams = read(ws, 'collections/streams.json');
    const stray = structuredClone(streams);
    (stray.items[0] as IdNode & { name: string }).name = 'Edited in the copy';
    stray.items.push({ kind: 'http', id: 'req-mine', name: 'Mine', request: { method: 'GET', url: 'https://me' } } as IdNode);
    write(ws, 'collections/live-streams.json', stray);
    const gql = read(ws, 'collections/graphql.json');
    write(ws, 'collections/graphql-public.json', gql);
    write(ws, 'collections/graphql.json', { ...gql, id: 'graphql' });
    expect(duplicateNodeIds(collectionsOf(ws)).length).toBeGreaterThan(0);

    const notes = repairTemplateDuplicates(examples, ws);
    expect(notes).toHaveLength(2);
    expect(existsSync(join(ws, 'collections/live-streams.json'))).toBe(false);
    expect(existsSync(join(ws, 'collections/graphql-public.json'))).toBe(false);
    expectUnique(ws);
    const merged = read(ws, 'collections/streams.json');
    expect(merged.id).toBe('live-streams');
    expect(collectNodeIds(merged.items)).toContain('req-mine');
    // nothing lost: the stray files are in the trash
    expect(readdirSync(join(ws, 'trash', 'collections')).length).toBe(2);
    expect(read(ws, 'collections/graphql.json').id).toBe('graphql-public');
    // running again changes nothing
    expect(repairTemplateDuplicates(examples, ws)).toEqual([]);
    expect(addTemplateAdditions(examples, ws)).toEqual([]);
    expectUnique(ws);
  });

  it('a template collection whose file the copy lacks is merged into the file that holds its id, never copied twice', () => {
    const info = new WorkspaceManager(join(root, 'app3')).installTemplate(examples);
    const ws = info.path;
    // the user's copy keeps "live-streams" under another file name, and the ledger never saw streams.json
    cpSync(join(ws, 'collections/streams.json'), join(ws, 'collections/my-streams.json'));
    rmSync(join(ws, 'collections/streams.json'));
    const ledger = JSON.parse(readFileSync(join(ws, '.template-offered.json'), 'utf8')) as { keys: string[] };
    write(ws, '.template-offered.json', { keys: ledger.keys.filter((k) => !k.startsWith('file:collections/streams.json') && !k.startsWith('item:collections/streams.json')) });
    addTemplateAdditions(examples, ws);
    expect(existsSync(join(ws, 'collections/streams.json'))).toBe(false);
    expectUnique(ws);
  });

  it('a request the template gained whose id another collection already uses gets a fresh id', () => {
    const tpl = join(root, 'tpl');
    cpSync(examples, tpl, { recursive: true, filter: (s) => !/[\\/](runs|traces|payloads|reports|trash|baselines)([\\/]|$)|database\.sqlite/.test(s) });
    const info = new WorkspaceManager(join(root, 'app4')).installTemplate(tpl);
    const ws = info.path;
    // the user made a request with id "req-new" in httpbin; the next template adds "req-new" to petstore
    const hb = read(ws, 'collections/httpbin.json');
    hb.items.push({ kind: 'http', id: 'req-new', name: 'User', request: { method: 'GET', url: 'https://u' } } as IdNode);
    write(ws, 'collections/httpbin.json', hb);
    const ps = read(tpl, 'collections/petstore.json');
    ps.items.push({ kind: 'http', id: 'req-new', name: 'Template', request: { method: 'GET', url: 'https://t' } } as IdNode);
    write(tpl, 'collections/petstore.json', ps);
    expect(addTemplateAdditions(tpl, ws)).toEqual(['request "Template" in "Swagger Petstore (OpenAPI contract)"']);
    expectUnique(ws);
    expect(collectNodeIds(read(ws, 'collections/httpbin.json').items)).toContain('req-new');
  });
});
