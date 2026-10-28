import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  SETTING_SPECS,
  createTestPionMcpServer,
  defaultSettings,
  describeSecurityChanges,
  EnvSecretStore,
  exportSettings,
  importSettings,
  isSecuritySetting,
  securityChangesForCall,
  securityChangesOf,
  securitySettingKeys,
  showSettingValue,
  WorkspaceManager,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { tempDir } from '../helpers.js';

// Security review 2026-10-27 (P2): set_settings and settings.import could retarget the proxy, widen {{$env}} or shrink redaction behind a
// confirmation that named keys only. SECURITY settings now show old -> new (masked) in the confirmation.
describe('security settings', () => {
  it('the proxy, TLS, {{$env}} access and redaction keys are security settings; ordinary ones are not', () => {
    for (const k of ['proxy.mode', 'proxy.url', 'proxy.bypass', 'proxy.username', 'tls.systemCa', 'tls.extraCa', 'envVariables', 'redactFields', 'scriptTrust', 'updateFeedUrl', 'telemetryEndpoint']) expect(isSecuritySetting(k), k).toBe(true);
    for (const k of ['theme', 'fontSize', 'defaultTimeoutMs', 'ai.dailyBudgetUsd', 'git.autoFetchMinutes', 'checkForUpdates']) expect(isSecuritySetting(k), k).toBe(false);
    expect(securitySettingKeys().sort()).toEqual(['envVariables', 'proxy.bypass', 'proxy.mode', 'proxy.url', 'proxy.username', 'redactFields', 'tls.systemCa']);
    // every key of the specs is classified one way or the other by the pattern: none throws
    for (const k of Object.keys(SETTING_SPECS)) expect(typeof isSecuritySetting(k)).toBe('boolean');
  });

  it('values are masked for display: credentials in a URL, secret-looking keys, long text', () => {
    expect(showSettingValue('proxy.url', 'http://bob:hunter2@proxy.example:8080')).toBe('http://bob:***@proxy.example:8080');
    expect(showSettingValue('proxy.password', 'x')).toBe('***');
    expect(showSettingValue('envVariables', ['A', 'B'])).toBe('A, B');
    expect(showSettingValue('envVariables', [])).toBe('(none)');
    expect(showSettingValue('proxy.url', undefined)).toBe('(not set)');
    expect(showSettingValue('redactFields', 'x'.repeat(500)).length).toBeLessThanOrEqual(160);
  });

  it('a call is checked against the settings as they are now (old -> new), resets included', () => {
    const cur = { ...defaultSettings(), proxy: { mode: 'custom' as const, url: 'http://old:1' }, envVariables: ['HOME'] };
    const s = securityChangesForCall(cur, { settings: { 'proxy.url': 'http://attacker:8080', defaultTimeoutMs: 5, envVariables: ['AWS_SECRET_ACCESS_KEY'] } });
    expect(s).toEqual([
      { key: 'proxy.url', before: 'http://old:1', after: 'http://attacker:8080' },
      { key: 'envVariables', before: 'HOME', after: 'AWS_SECRET_ACCESS_KEY' },
    ]);
    expect(describeSecurityChanges(s)).toBe('proxy.url: http://old:1 -> http://attacker:8080; envVariables: HOME -> AWS_SECRET_ACCESS_KEY');
    expect(securityChangesForCall(cur, { settings: { defaultTimeoutMs: 9 } })).toEqual([]);
    expect(securityChangesForCall(cur, { reset: ['envVariables'] }).map((c) => c.key)).toEqual(['envVariables']);
    expect(securityChangesForCall(cur, { reset: 'all' }).map((c) => c.key)).toEqual(expect.arrayContaining(['proxy.url', 'envVariables']));
    // a call that does not parse is not a security change (the tool refuses it when it runs)
    expect(securityChangesForCall(cur, { settings: { 'nope.key': 1 } })).toEqual([]);
    // setting a value to what it already is changes nothing
    expect(securityChangesForCall(cur, { settings: { 'proxy.url': 'http://old:1' } })).toEqual([]);
  });

  it('an imported file lists its security changes', () => {
    const cur = defaultSettings();
    const doc = exportSettings({ ...cur, proxy: { mode: 'custom', url: 'http://attacker:8080' }, envVariables: ['TOKEN_X'], defaultTimeoutMs: 1234 });
    const r = importSettings(cur, doc);
    expect(securityChangesOf(r.changed).map((c) => c.key).sort()).toEqual(['envVariables', 'proxy.mode', 'proxy.url']);
  });
});

describe('set_settings confirmation (MCP)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-set-sec-'));
  let store: WorkspaceStore;
  let client: Client;
  beforeAll(async () => {
    const ws = join(dir, 'ws');
    cpSync(join(process.cwd(), 'examples', 'veterinary-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\\/](runs|traces|payloads)([\\/]|$)/.test(p) });
    const mgr = new WorkspaceManager(join(dir, 'home'));
    store = mgr.open(ws);
    const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
    client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('without the confirmation nothing changes, and the question names the old and the new value of a security key', async () => {
    const r = await client.callTool({ name: 'set_settings', arguments: { settings: { 'proxy.url': 'http://bob:pw@attacker.example:8080', defaultTimeoutMs: 4321 } } });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('confirmationRequired');
    expect(text).toContain('SECURITY SETTINGS');
    expect(text).toContain('proxy.url');
    expect(text).toContain('http://bob:***@attacker.example:8080');
    expect(text).not.toContain('pw@');
  });

  it('an ordinary setting carries no security warning', async () => {
    const r = await client.callTool({ name: 'set_settings', arguments: { settings: { defaultTimeoutMs: 4321 } } });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    expect(text).toContain('confirmationRequired');
    expect(text).not.toContain('SECURITY SETTINGS');
  });
});

describe('settings.import (window and bridge)', () => {
  const tmp = tempDir('tp-imp-sec-');
  let be: Backend;
  beforeAll(() => {
    be = new Backend({ appDir: join(tmp.dir, 'a'), emit: () => {}, noMonitors: true });
  });
  afterAll(async () => {
    await be.dispose();
    tmp.cleanup();
  });
  const doc = () => exportSettings({ ...be.settings, proxy: { mode: 'custom', url: 'http://attacker:8080' }, defaultTimeoutMs: 4321 });

  it('a dry run reports the security changes and applies nothing', async () => {
    const r = (await be.invoke('settings.import', { doc: doc(), dryRun: true })) as { applied: boolean; security: Array<{ key: string }> };
    expect(r.applied).toBe(false);
    expect(r.security.map((c) => c.key)).toEqual(expect.arrayContaining(['proxy.url']));
    expect(be.settings.proxy?.url).not.toBe('http://attacker:8080');
  });

  it('without the confirmation the file is refused, nothing is imported, and the message shows the values', async () => {
    await expect(be.invoke('settings.import', { doc: doc() })).rejects.toMatchObject({ kind: 'ValidationError', message: expect.stringContaining('proxy.url:') });
    expect(be.settings.defaultTimeoutMs).not.toBe(4321);
  });

  it('with the confirmation it is applied; a file without security changes needs none', async () => {
    const r = (await be.invoke('settings.import', { doc: doc(), confirmSecurity: true })) as { applied: boolean };
    expect(r.applied).toBe(true);
    expect(be.settings.proxy?.url).toBe('http://attacker:8080');
    const plain = exportSettings({ ...be.settings, defaultTimeoutMs: 999 });
    await expect(be.invoke('settings.import', { doc: plain })).resolves.toMatchObject({ applied: true, security: [] });
    expect(be.settings.defaultTimeoutMs).toBe(999);
  });
});
