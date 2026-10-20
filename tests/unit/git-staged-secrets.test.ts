import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// scripted repositories spawn many git processes: slow machines (CI, parallel runs) need room
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { commitVerdict, runGit, scanFileText, scanStagedSecrets } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * The commit's secret scan reads what is STAGED (the blobs in the index), with the detector the exports use, kind by kind:
 * a high-confidence secret blocks, a probable one needs a confirmation, a variable reference is clean.
 */

let r: TestRepo;
beforeAll(async () => {
  r = await makeRepo();
});
afterAll(() => r.cleanup());

const KEY = 'sk-' + 'a1b2c3d4e5f6a7b8c9d0e1f2'; // shaped like a provider key
const servers = (headers: unknown) => JSON.stringify({ schemaVersion: '1.0', servers: [{ id: 'weather', name: 'Weather', transport: 'http', url: 'https://w.example.com/mcp', headers }] }, null, 2) + '\n';

describe('the scan reads the staged content, not the working folder', () => {
  it('a secret in a staged file blocks, naming the item and the variable to use', async () => {
    r.write('mcp-servers.json', servers([{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }]));
    await runGit(r.ws, ['add', 'mcp-servers.json']);
    const scan = await scanStagedSecrets(r.ws);
    expect(scan.staged).toEqual(['mcp-servers.json']);
    expect(scan.blocking).toHaveLength(1);
    expect(scan.blocking[0]).toMatchObject({ kind: 'mcp-server', item: 'MCP server Weather', field: 'headers.Authorization', variable: '{{WEATHER_AUTHORIZATION}}', confidence: 'high', ref: { kind: 'mcp-server', serverId: 'weather' } });
    expect(scan.blocking[0]!.message).toContain('MCP server Weather');
    expect(scan.blocking[0]!.message).toContain('{{WEATHER_AUTHORIZATION}}');
    expect(JSON.stringify(scan)).not.toContain('abcdef0123456789');
    expect(commitVerdict(scan)).toEqual({ allowed: false, reason: 'blocked' });
    // even confirmed: a high-confidence secret is never "commit anyway"
    expect(commitVerdict(scan, true).allowed).toBe(false);
  });

  it('fixing the working file is not enough until the fix is staged; unstaging clears the scan', async () => {
    r.write('mcp-servers.json', servers([{ key: 'Authorization', value: '{{WEATHER_AUTHORIZATION}}' }]));
    expect((await scanStagedSecrets(r.ws)).blocking).toHaveLength(1); // the index still holds the old blob
    await runGit(r.ws, ['add', 'mcp-servers.json']);
    const clean = await scanStagedSecrets(r.ws);
    expect(clean.blocking).toEqual([]);
    expect(commitVerdict(clean)).toEqual({ allowed: true });
    await runGit(r.ws, ['reset', '-q']);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
  });

  it('a probable secret (medium) needs a confirmation; nothing staged is nothing scanned', async () => {
    expect((await scanStagedSecrets(r.ws)).staged).toEqual([]);
    r.write('mcp-servers.json', servers([{ key: 'X-Team', value: 'platform-blue' }]));
    await runGit(r.ws, ['add', 'mcp-servers.json']);
    const scan = await scanStagedSecrets(r.ws);
    expect(scan.blocking).toEqual([]);
    expect(scan.confirm.map((s) => s.field)).toEqual(['headers.X-Team']);
    expect(commitVerdict(scan)).toEqual({ allowed: false, reason: 'confirm' });
    expect(commitVerdict(scan, true)).toEqual({ allowed: true });
    await runGit(r.ws, ['reset', '-q']);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
  });
});

describe('every kind is read', () => {
  it('names the item for each kind of file', () => {
    const col = JSON.stringify({ id: 'api', name: 'API', variables: [], items: [{ kind: 'http', id: 'r1', name: 'Login', request: { method: 'GET', url: 'https://x', headers: [{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789', enabled: true }] } }] });
    expect(scanFileText('collections/api.json', col)[0]).toMatchObject({ kind: 'collection', confidence: 'high', ref: { kind: 'collection', collectionId: 'api' } });
    const env = JSON.stringify({ id: 'staging', name: 'Staging', variables: [{ key: 'password', value: 'hunter2hunter2', enabled: true }, { key: 'token', value: '', secret: true, enabled: true }] });
    const e = scanFileText('environments/staging.json', env);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'environment', item: 'environment Staging', variable: '{{password}}', confidence: 'high' });
    const prov = JSON.stringify({ providers: [{ id: 'oa', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com', apiKey: KEY }] });
    expect(scanFileText('providers.json', prov)[0]).toMatchObject({ kind: 'provider', confidence: 'high', ref: { kind: 'provider', providerId: 'oa' } });
    const lib = JSON.stringify({ folders: [], items: [{ id: 'g1', name: 'Greeter', data: { metadata: [{ key: 'authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] } }] });
    expect(scanFileText('library/grpc.json', lib)[0]).toMatchObject({ kind: 'library', ref: { kind: 'saved', library: 'grpc', itemId: 'g1' } });
    const test = 'name: T\ntests:\n  - name: a\n    request:\n      headers:\n        Authorization: ' + KEY + '\n';
    expect(scanFileText('tests/a.yaml', test)[0]).toMatchObject({ kind: 'test', confidence: 'high' });
    expect(scanFileText('specs/x.yaml', `servers:\n  - url: postgres://u:${'p'.repeat(10)}@db.example.com/x\n`)[0]).toMatchObject({ kind: 'file', confidence: 'high' });
    expect(scanFileText('datasets/db.csv', 'id,password\n1,hunter2hunter2\n')[0]).toMatchObject({ kind: 'file', field: 'password (row 2)' });
    expect(scanFileText('datasets/ok.csv', 'id,name\n1,Ada\n')).toEqual([]);
    expect(scanFileText('mcp-servers.json', servers([{ key: 'Authorization', value: '{{TOKEN}}' }]))).toEqual([]);
  });
});
