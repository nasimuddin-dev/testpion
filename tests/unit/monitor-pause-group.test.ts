import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { listMonitors, monitorStatus, saveMonitor, WorkspaceStore } from '../../packages/core/src/index.js';
import { runCliSync, tempDir } from '../helpers.js';

// A tenant's deploy: `testpion monitor pause --group Acme --for 30m` pauses every monitor running in an environment of
// Acme (a monitor of every tenant pauses for Acme only), and `monitor resume --group Acme` ends those pauses.
const tmp = tempDir('tp-pause-group-');
afterAll(() => tmp.cleanup());

describe('monitor pause --group', () => {
  it("pauses and resumes a tenant's monitors, and only those", () => {
    const root = join(tmp.dir, 'ws');
    const s = WorkspaceStore.create(root, 'Tenants');
    s.writeTestFile('smoke.yaml', 'tests:\n  - { id: a, name: A, url: "http://127.0.0.1:9/a" }\n');
    for (const [id, name, group] of [['acme-stg', 'Staging', 'Acme'], ['acme-prod', 'Production', 'Acme'], ['globex-stg', 'Staging', 'Globex']] as const)
      s.saveEnvironment({ id, name, group, variables: [] });
    saveMonitor(s, { name: 'Every tenant', testFile: 'smoke.yaml', everyMinutes: 15, enabled: true, environmentGroup: 'Acme' } as never);
    saveMonitor(s, { name: 'Globex only', testFile: 'smoke.yaml', everyMinutes: 15, enabled: true, environment: 'globex-stg' } as never);
    s.close();
    const cli = (args: string[]) => runCliSync([...args, '-w', root, '--json', '--non-interactive'], { home: join(tmp.dir, 'home'), cwd: tmp.dir, env: { CI: '1' } });
    const paused = cli(['monitor', 'pause', '--group', 'acme', '--for', '30m', '--why', 'deploy']);
    expect(paused.status, paused.out + paused.err).toBe(0);
    expect((JSON.parse(paused.out).data.monitors as Array<{ paused: string }>).map((m) => m.paused).sort()).toEqual(['Every tenant · Acme ▸ Production', 'Every tenant · Acme ▸ Staging']);
    const state = () => {
      const st = WorkspaceStore.open(root);
      try {
        return Object.fromEntries(listMonitors(st).map((m) => [m.name, monitorStatus(st, m).paused]));
      } finally {
        st.close();
      }
    };
    expect(state()).toEqual({ 'Every tenant · Acme ▸ Staging': true, 'Every tenant · Acme ▸ Production': true, 'Globex only': false });
    const resumed = cli(['monitor', 'resume', '--group', 'Acme']);
    expect(resumed.status, resumed.out + resumed.err).toBe(0);
    expect((JSON.parse(resumed.out).data.monitors as unknown[]).length).toBe(2);
    expect(Object.values(state())).toEqual([false, false, false]);
    expect(cli(['monitor', 'pause', '--group', 'Nobody']).status).toBe(2);
    expect(cli(['monitor', 'pause']).status).toBe(2);
  });
});
