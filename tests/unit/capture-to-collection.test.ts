import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordingTools } from '../../packages/core/src/mcp-server/tools/recording-tools.js';
import { collectionFromExchanges, exchangesToHar, Redactor, WorkspaceStore, type FlowSourceExchange, type SavedHttpRequest, type CollectionFolder } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// WF-12 Save to collection: captured exchanges become saved requests — origins as collection variables, secrets as
// variables never saved, a value a later request took from a response kept by the script of the request that gave it.
const tmp = tempDir('tp-capture-col-');
afterAll(() => tmp.cleanup());

const TOKEN = 'tok-0123456789abcdef0123';
const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 9, 0, s)).toISOString();
const json = { 'content-type': 'application/json' };
const exchanges: FlowSourceExchange[] = [
  {
    id: 'e1',
    method: 'POST',
    url: 'https://api.example.com/auth/login',
    startedAt: at(1),
    requestHeaders: json,
    requestBody: JSON.stringify({ username: 'ann', password: 'pw-very-secret' }),
    status: 200,
    responseHeaders: json,
    responseBody: JSON.stringify({ access_token: TOKEN }),
    kind: 'http',
  },
  {
    id: 'e2',
    method: 'GET',
    url: 'https://api.example.com/pets?limit=5',
    startedAt: at(2),
    requestHeaders: { authorization: `Bearer ${TOKEN}` },
    status: 200,
    responseHeaders: json,
    responseBody: '[]',
    kind: 'http',
  },
  { id: 'e3', method: 'GET', url: 'https://cdn.example.com/logo.png', startedAt: at(3), requestHeaders: {}, status: 200, responseHeaders: { 'content-type': 'image/png' }, kind: 'http' },
  {
    id: 'e4',
    method: 'GET',
    url: 'https://billing.example.com/invoices',
    startedAt: at(4),
    requestHeaders: { 'x-api-key': 'key-live-99999999' },
    status: 200,
    responseHeaders: json,
    responseBody: '[]',
    kind: 'http',
  },
];

describe('captured exchanges as a collection', () => {
  it('a folder per host; origins are variables; secrets are never saved; a token flows through a collection variable', () => {
    const r = collectionFromExchanges(exchanges, { name: 'Shop capture', redactor: new Redactor() });
    expect(r.created).toBe(true);
    expect(r.collection.name).toBe('Shop capture');
    const folders = r.collection.items as CollectionFolder[];
    expect(folders.map((f) => f.name)).toEqual(['api.example.com', 'billing.example.com']);
    expect(r.dropped.map((d) => d.id)).toEqual(['e3']); // the logo is noise
    const [login, pets] = folders[0]!.items as SavedHttpRequest[];
    expect(login!.request.url).toMatch(/^\{\{baseUrl\}\}\/auth\/login$/);
    expect(login!.testScript).toMatch(/tp\.collectionVariables\.set\('accessToken', tp\.response\.json\(\)\?\.access_token\);/);
    expect(pets!.request.headers).toContainEqual({ key: 'Authorization', value: 'Bearer {{accessToken}}', enabled: true });
    expect(r.collection.variables.map((v) => v.key)).toContain('baseUrl');
    const text = JSON.stringify(r.collection);
    expect(text).not.toContain('pw-very-secret');
    expect(text).not.toContain('key-live-99999999');
    expect(text).not.toContain(TOKEN);
    expect(r.secrets.length).toBeGreaterThanOrEqual(2);
  });

  it('adds to an existing collection in a folder, by path or flat', () => {
    const existing = { schemaVersion: '1.0', id: 'c1', name: 'Mine', version: 1, updatedAt: '', variables: [{ key: 'baseUrl', value: 'https://keep.me', enabled: true }], items: [] } as never;
    const r = collectionFromExchanges(exchanges.slice(1, 2), { collection: existing, name: 'Captured', group: 'path' });
    expect(r.created).toBe(false);
    const top = r.collection.items[0] as CollectionFolder;
    expect(top.name).toBe('Captured');
    expect((top.items[0] as CollectionFolder).name).toBe('/pets');
    expect(r.collection.variables.find((v) => v.key === 'baseUrl')?.value).toBe('https://keep.me');
    const flat = collectionFromExchanges(exchanges.slice(1, 2), { group: 'none' });
    expect(flat.collection.items[0]?.kind).toBe('http');
  });

  it('debugger_save_to_collection saves into the workspace (from a HAR file too)', async () => {
    const root = join(tmp.dir, 'ws');
    const store = WorkspaceStore.create(root, 'Capture');
    writeFileSync(join(root, 'session.har'), JSON.stringify(exchangesToHar(exchanges as never, new Redactor(), '0')));
    const tool = recordingTools({ store, redactor: new Redactor(), session: [] }).find((t) => t.name === 'debugger_save_to_collection')!;
    const r = (await tool.run({ har: 'session.har', name: 'From HAR', group: 'none' })) as { collectionId: string; requests: unknown[]; created: boolean };
    expect(r.created).toBe(true);
    expect(store.getCollection(r.collectionId).items.length).toBe(r.requests.length);
    await expect(Promise.resolve().then(() => tool.run({ har: 'session.har', collection: 'nope' }))).rejects.toThrow(/No collection "nope"/);
    store.close();
  });
});
