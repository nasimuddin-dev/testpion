import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, exportCollectionPackage, writeZip } from '../../packages/core/src/index.js';
import { readZip, ZIP_LIMITS } from '../../packages/core/src/transfer/zip.js';
import { tempDir } from '../helpers.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const tmp = tempDir('tp-package-', { alias: true });
afterAll(() => tmp.cleanup());

let n = 0;
const source = (): WorkspaceStore => {
  const s = WorkspaceStore.create(join(tmp.dir, `ws-${++n}`), 'Source');
  cpSync(FIXTURE, s.root, { recursive: true });
  return s;
};
const FAKE_TOKEN = ['gh', 'p_', 'Ab3'.repeat(12)].join('');

describe('a collection package for Postman and Bruno, with what the collection uses', () => {
  it('Postman: the collection, the environments it uses, the globals, API definitions, data files and an .mcp.json; no secret value', () => {
    const src = source();
    const col = src.getCollection('api');
    col.items.push({
      kind: 'http',
      id: 'sec1',
      name: 'Uses a spec and a dataset',
      request: { method: 'GET', url: '{{baseUrl}}/pets', headers: [{ key: 'Authorization', value: `Bearer ${FAKE_TOKEN}`, enabled: true }], body: { type: 'none' } },
      assertions: [],
      // the request names a spec, a dataset and an MCP server by their workspace paths and name
      description: 'see specs/petstore.yaml and datasets/users.csv',
      server: 'weather',
    } as unknown as Collection['items'][number]);
    src.saveCollection(col);
    src.updateWorkspace({ variables: [{ key: 'region', value: 'eu', enabled: true }] });
    writeFileSync(src.path('mcp-servers.json'), JSON.stringify({ schemaVersion: '1.0', servers: [{ id: 'weather', name: 'weather', transport: 'stdio', command: 'node', args: ['w.js'], env: { API_KEY: FAKE_TOKEN } }] }));
    const pkg = exportCollectionPackage(src, 'api', 'postman');
    const paths = pkg.files.map((f) => f.path);
    expect(paths).toContain('Kinds API.postman_collection.json');
    expect(paths.some((p) => p.startsWith('environments/') && p.endsWith('.postman_environment.json'))).toBe(true);
    expect(paths).toContain('globals.postman_globals.json');
    expect(paths).toContain('specs/petstore.yaml');
    expect(paths).toContain('data/users.csv');
    expect(paths).toContain('.mcp.json');
    expect(paths).toContain('README.md');
    const globals = JSON.parse(pkg.files.find((f) => f.path === 'globals.postman_globals.json')!.data.toString('utf8'));
    expect(globals._postman_variable_scope).toBe('globals');
    expect(globals.values).toEqual([{ key: 'region', value: 'eu', type: 'default', enabled: true }]);
    // no secret value anywhere in any file
    for (const f of pkg.files) expect(f.data.toString('utf8'), f.path).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(pkg.files.find((f) => f.path === '.mcp.json')!.data.toString('utf8')).mcpServers.weather.command).toBe('node');
    expect(pkg.replaced.length).toBeGreaterThan(0);
    expect(pkg.notes.join(' ')).toMatch(/Replaced \d+ secrets? with variables/);
    // it is a zip a person can open, with the same file list
    const zip = readZip(writeZip(pkg.files.map((f) => ({ name: f.path, data: f.data }))), ZIP_LIMITS);
    expect(zip.map((f) => f.name).sort()).toEqual([...paths].sort());
  });

  it('Bruno: the folder files plus API definitions, data files and an .mcp.json; the Globals are named as not carried', () => {
    const src = source();
    src.updateWorkspace({ variables: [{ key: 'region', value: 'eu', enabled: true }] });
    const col = src.getCollection('api');
    (col.items[1] as { request: { query: string } }).request.query = 'query { pets { id } } # see specs/petstore.yaml and datasets/users.csv';
    src.saveCollection(col);
    const pkg = exportCollectionPackage(src, 'api', 'bruno');
    const paths = pkg.files.map((f) => f.path);
    expect(paths).toContain('bruno.json');
    expect(paths).toContain('specs/petstore.yaml');
    expect(paths).toContain('datasets/users.csv');
    expect(paths.some((p) => p.startsWith('Pets/') && p.endsWith('.bru'))).toBe(true);
    expect(pkg.notes.join(' ')).toMatch(/workspace variable \(the Globals\) have no place in a Bruno collection|workspace variable.*no place in a Bruno collection/);
  });

  it('lists what the other tool cannot hold, and refuses a collection that is not there', () => {
    const src = source();
    mkdirSync(src.path('tests'), { recursive: true });
    const col = src.getCollection('api');
    col.testScript = '';
    col.items.push({ kind: 'http', id: 'r9', name: 'x', request: { method: 'GET', url: 'http://x' }, assertions: [] } as unknown as Collection['items'][number]);
    src.saveCollection(col);
    // a test file that names the collection, a monitor that belongs to it
    writeFileSync(src.path('tests', 'uses-api.yaml'), 'name: t\ncollection: api\ntests: []\n');
    const pkg = exportCollectionPackage(src, 'api', 'postman');
    expect(pkg.notes.join('\n')).toMatch(/test or flow files? .* not in the Postman package/);
    expect(() => exportCollectionPackage(src, 'ghost', 'postman')).toThrow(/No collection "ghost"/);
  });
});

type Collection = import('../../packages/core/src/index.js').Collection;
