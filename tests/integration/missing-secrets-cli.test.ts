import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/** `testpion secrets --missing` and the doctor: which secret variables have no value here, and which environment variable gives each one. */
describe('missing secrets from the command line', () => {
  it('lists them with their environment variable, exits 1, and goes quiet when they are given', async () => {
    const tmp = tempDir('tp-missing-secrets-cli-');
    try {
      const ws = join(tmp.dir, 'ws');
      const s = WorkspaceStore.create(ws, 'MSC');
      s.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'apiKey', value: '', secret: true, enabled: true }] } as never);
      s.close();
      const env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
      for (const k of Object.keys(env)) if (k.startsWith('TESTPION_SECRET_')) delete env[k];
      const r = await runCli(['secrets', '--missing', '-w', ws, '--json'], { env });
      expect(r.status).toBe(1);
      const data = cliData<{ count: number; items: Array<{ environment: string; key: string; envVar: string }> }>(r.out);
      expect(data.count).toBe(1);
      expect(data.items[0]).toMatchObject({ environment: 'Staging', key: 'apiKey' });
      expect(data.items[0]!.envVar).toMatch(/^TESTPION_SECRET_/);
      // the doctor says it as a warning with the same variable
      const doctor = await runCli(['doctor', '-w', ws, '--json'], { env });
      expect(JSON.stringify(cliData(doctor.out))).toContain(data.items[0]!.envVar);
      // giving the value takes it off the list
      const ok = await runCli(['secrets', '--missing', '-w', ws, '--json'], { env: { ...env, [data.items[0]!.envVar]: 'sk-test' } });
      expect(ok.status).toBe(0);
      expect(cliData<{ count: number }>(ok.out).count).toBe(0);
      expect((await runCli(['secrets', '-w', ws], { env })).status).toBe(2);
    } finally {
      tmp.cleanup();
    }
  }, 120_000);
});

describe('the Problems list and missing secrets', () => {
  it('lists an environment with secrets that have no value, as a warning that opens the environment', async () => {
    const tmp = tempDir('tp-missing-secrets-problems-');
    try {
      const ws = join(tmp.dir, 'ws');
      const s = WorkspaceStore.create(ws, 'MSP');
      s.saveEnvironment({ id: 'prod', name: 'Prod', variables: [{ key: 'one', value: '', secret: true, enabled: true }, { key: 'two', value: '', secret: true, enabled: true }] } as never);
      s.close();
      const env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
      for (const k of Object.keys(env)) if (k.startsWith('TESTPION_SECRET_')) delete env[k];
      const r = await runCli(['problems', '-w', ws, '--json'], { env });
      const items = cliData<Array<{ group: string; message: string; ref: { kind: string; environmentId?: string } }>>(r.out);
      const secret = items.find((i) => i.group === 'Secrets');
      expect(secret?.message).toBe('Environment "Prod" has 2 secrets with no value on this computer: one, two');
      expect(secret?.ref).toMatchObject({ kind: 'environment', environmentId: 'prod' });
    } finally {
      tmp.cleanup();
    }
  }, 120_000);
});
