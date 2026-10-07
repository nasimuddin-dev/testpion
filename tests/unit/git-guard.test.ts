import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, findCommittableSecrets, fixCommittableSecrets, installPreCommitHook, type Collection } from '@testpion/core';

// GIT-104: secrets typed into a workspace are found before a commit would publish them.
const root = mkdtempSync(join(tmpdir(), 'tp-guard-'));
// best effort: on Windows git can still hold a file for a moment (the temp folder is cleaned up anyway)
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});

describe('secret guard', () => {
  it('finds typed-in secrets, and not secret variables or {{references}}', () => {
    const store = WorkspaceStore.create(join(root, 'ws'), 'Guard');
    store.saveCollection({
      schemaVersion: '1.0',
      id: 'api',
      name: 'API',
      version: 0,
      updatedAt: '',
      variables: [{ key: 'apiKey', value: 'k-123', enabled: true }],
      items: [
        { kind: 'http', id: 'r1', name: 'Typed', request: { method: 'GET', url: 'https://x', headers: [{ key: 'Authorization', value: 'Bearer abc', enabled: true }] } },
        { kind: 'http', id: 'r2', name: 'Referenced', request: { method: 'GET', url: 'https://x', headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }] } },
      ],
    } as Collection);
    store.saveEnvironment({ id: 'dev', name: 'Dev', variables: [{ key: 'password', value: 'p', enabled: true }, { key: 'token', value: '', enabled: true, secret: true }, { key: 'baseUrl', value: 'https://x', enabled: true }] });
    const found = findCommittableSecrets(store);
    const where = found.map((f) => f.where);
    expect(where.some((w) => w.includes('Typed'))).toBe(true);
    expect(where.some((w) => w.includes('Referenced'))).toBe(false);
    expect(where).toContain('collection API, variable apiKey');
    expect(where).toContain('environment Dev, variable password');
    expect(where.some((w) => /token|baseUrl/.test(w))).toBe(false);
    store.close();
  });

  it('installs a pre-commit hook, never over someone else’s', () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    const ws = join(repo, 'api-tests');
    mkdirSync(ws);
    expect(installPreCommitHook(join(root, 'no-repo'))).toMatchObject({ installed: false });
    const r = installPreCommitHook(ws, '"node" "/x/testpion.js"');
    expect(r.installed).toBe(true);
    const hook = readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toMatch(/testpion-secret-guard/);
    expect(hook).toMatch(/git check -w 'api-tests'/);
    expect(hook).toMatch(/"node" "\/x\/testpion\.js"/);
    // again: TestPion's own hook is updated
    expect(installPreCommitHook(ws).installed).toBe(true);
    // someone else's hook is left alone
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm test\n');
    const other = installPreCommitHook(ws);
    expect(other.installed).toBe(false);
    expect(other.message).toMatch(/already exists/);
    expect(readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('#!/bin/sh\nnpm test\n');
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });
});

describe('secret guard: fix in one click', () => {
  it('moves typed values to secret variables of an environment and references them', async () => {
    const store = WorkspaceStore.create(join(root, 'fix'), 'Fix');
    const secrets = new MemorySecretStore();
    store.saveEnvironment({ id: 'dev', name: 'Dev', variables: [{ key: 'password', value: 'plain-pw', enabled: true }, { key: 'demoToken', value: 'demo-1', enabled: true }, { key: 'dummyPassword', value: 'dummy-2', enabled: true }] });
    store.saveCollection({
      schemaVersion: '1.0',
      id: 'api',
      name: 'API',
      version: 0,
      updatedAt: '',
      variables: [],
      auth: { type: 'bearer', token: 'col-token' },
      items: [
        {
          kind: 'http',
          id: 'r1',
          name: 'Create',
          request: {
            method: 'POST',
            url: 'https://x',
            headers: [{ key: 'X-Api-Key', value: 'k-111', enabled: true }],
            auth: { type: 'basic', username: 'u', password: 'typed-pw' },
            body: { type: 'json', content: JSON.stringify({ user: 'bob', continuationToken: 'tok-222', nested: { client_secret: 'sec-333' } }) },
          },
        },
      ],
    } as Collection);
    const found = findCommittableSecrets(store);
    const kinds = found.map((f) => `${f.kind}:${f.field}`).sort();
    expect(kinds).toEqual(['collection-auth:token', 'environment-variable:demoToken', 'environment-variable:dummyPassword', 'environment-variable:password', 'request:X-Api-Key', 'request:client_secret', 'request:continuationToken', 'request:password']);
    expect(found.find((f) => f.field === 'X-Api-Key')!.variable).toBe('apiKey');
    expect(found.find((f) => f.field === 'client_secret')!.variable).toBe('clientSecret');

    const r = await fixCommittableSecrets(store, secrets, found, { environmentId: 'dev' });
    expect(r.skipped).toEqual([]);
    expect(r.fixed).toHaveLength(8);
    // the files hold references only
    const c = store.getCollection('api');
    const req = (c.items[0] as { request: { headers: Array<{ value: string }>; auth: { password: string }; body: { content: string } } }).request;
    expect(req.headers[0]!.value).toBe('{{apiKey}}');
    expect(JSON.parse(req.body.content)).toEqual({ user: 'bob', continuationToken: '{{continuationToken}}', nested: { client_secret: '{{clientSecret}}' } });
    expect((c.auth as { token: string }).token).toBe('{{token}}');
    const env = store.listEnvironments().find((e) => e.id === 'dev')!;
    const byKey = Object.fromEntries(env.variables.map((v) => [v.key, v]));
    // every plain variable of the environment became secret, not only the last one fixed
    for (const k of ['apiKey', 'continuationToken', 'clientSecret', 'token', 'password', 'demoToken', 'dummyPassword']) {
      expect(byKey[k]?.secret, k).toBe(true);
      expect(byKey[k]?.value, k).toBe('');
    }
    // the values are in the secret store; the environment's own plain password moved there too
    expect(secrets.get('env.dev.apiKey')).toBe('k-111');
    expect(secrets.get('env.dev.continuationToken')).toBe('tok-222');
    expect(secrets.get('env.dev.clientSecret')).toBe('sec-333');
    expect(secrets.get('env.dev.token')).toBe('col-token');
    expect(secrets.get('env.dev.password')).toBe('plain-pw');
    expect(secrets.get('env.dev.demoToken')).toBe('demo-1');
    expect(secrets.get('env.dev.dummyPassword')).toBe('dummy-2');
    // the request's basic password ("typed-pw") shares the name with the environment's; it becomes password2
    expect(secrets.get('env.dev.password2')).toBe('typed-pw');
    expect(req.auth.password).toBe('{{password2}}');
    expect(findCommittableSecrets(store)).toEqual([]);
    store.close();
  });
});
