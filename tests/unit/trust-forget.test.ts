import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, forgetHost, forgetSecretReads, forgetTrustedCommands, trustCommand, trustHost, trustSecretReads, trustSummary } from '../../packages/core/src/index.js';
import { cliData, runCliSync } from '../helpers.js';

describe('forgetting trust decisions', () => {
  it('one host, the secret reads, or everything', () => {
    const s = WorkspaceStore.create(mkdtempSync(join(tmpdir(), 'tp-forget-')), 'w');
    trustCommand(s, 'node', ['a.js']);
    trustHost(s, 'a.example');
    trustHost(s, 'b.example');
    trustSecretReads(s);
    expect(trustSummary(s)).toMatchObject({ commands: [{ command: 'node' }], hosts: [{ host: 'a.example' }, { host: 'b.example' }], secretReads: { at: expect.any(String) } });
    forgetHost(s, 'A.example');
    expect(trustSummary(s).hosts.map((h) => h.host)).toEqual(['b.example']);
    forgetSecretReads(s);
    expect(trustSummary(s).secretReads).toBeNull();
    expect(trustSummary(s).commands).toHaveLength(1);
    forgetTrustedCommands(s);
    expect(trustSummary(s)).toEqual({ commands: [], hosts: [], secretReads: null });
  });

  it('testpion trust list and forget work on the command line', () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-forget-cli-'));
    const s = WorkspaceStore.create(join(root, 'ws'), 'w');
    const home = process.env.TESTPION_HOME;
    trustHost(s, 'c.example');
    trustSecretReads(s);
    s.close();
    const list = cliData<{ hosts: Array<{ host: string }>; secretReads: unknown }>(runCliSync(['trust', 'list', '-w', join(root, 'ws'), '--json'], { home }).out);
    expect(list.hosts.map((h) => h.host)).toEqual(['c.example']);
    expect(list.secretReads).toBeTruthy();
    const after = cliData<{ hosts: unknown[]; secretReads: unknown }>(runCliSync(['trust', 'forget', '--host', 'c.example', '--secrets', '-w', join(root, 'ws'), '--json'], { home }).out);
    expect(after.hosts).toEqual([]);
    expect(after.secretReads).toBeNull();
  });
});
