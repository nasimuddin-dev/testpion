import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, createEngineContext } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-ctxvars-'));
const stores: WorkspaceStore[] = [];
afterAll(async () => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the built-in variables of the environment in use', () => {
  it('{{$environment}} is its name and {{$group}} its tenant group (empty without one); without an environment they stay placeholders', async () => {
    const store = WorkspaceStore.create(join(dir, 'ws'), 'Tenants');
    stores.push(store);
    const acme = store.saveEnvironment({ id: 'acme-staging', name: 'Staging', group: 'Acme', variables: [{ key: 'tenant', value: '{{$group}}' }] });
    const lone = store.saveEnvironment({ id: 'local', name: 'Local', variables: [] });
    const a = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never, environment: acme.id });
    expect(a.vars.resolve('{{$environment}} / {{$group}} / {{tenant}}')).toBe('Staging / Acme / Acme');
    const l = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never, environment: lone.id });
    expect(l.vars.resolve('{{$environment}}:{{$group}}')).toBe('Local:');
    const none = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });
    expect(none.vars.resolve('{{$environment}}')).toBe('{{$environment}}');
    await Promise.all([a, l, none].map((c) => c.dispose()));
  });
});
