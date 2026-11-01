import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { CONVENTIONS_FILE, conventionFindings, initConventions, readConventions, saveMonitor, workspaceAttention } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

const repos: TestRepo[] = [];
afterAll(() => repos.forEach((r) => r.cleanup()));

describe('team conventions (conventions.yaml)', () => {
  it('is nothing without the file; --init writes the explained template once, and every rule in it is off', async () => {
    const r = await makeRepo();
    repos.push(r);
    expect(readConventions(r.store)).toBeUndefined();
    expect(await conventionFindings(r.store)).toEqual([]);
    expect(initConventions(r.store)).toBe(true);
    expect(initConventions(r.store)).toBe(false);
    expect(existsSync(r.store.path(CONVENTIONS_FILE))).toBe(true);
    expect(readConventions(r.store)).toEqual({ collections: null, requests: null, environments: null, monitors: null });
    expect(await conventionFindings(r.store)).toEqual([]);
  });

  it('says which collection, request, environment or monitor breaks which rule, as a warning of Needs attention', async () => {
    const r = await makeRepo();
    repos.push(r);
    r.store.saveCollection({ schemaVersion: '1.0', id: 'payments-invoices', name: 'payments-invoices', version: 0, variables: [], updatedAt: '', items: [{ kind: 'request', id: 'r1', name: 'Create invoice', request: { method: 'POST', url: 'https://x/invoices', headers: [], params: [] } }] } as never);
    r.store.saveCollection({ schemaVersion: '1.0', id: 'scratch', name: 'Scratch', version: 0, variables: [], updatedAt: '', items: [{ kind: 'request', id: 'r2', name: 'try it', request: { method: 'GET', url: 'https://x/', headers: [], params: [] } }] } as never);
    r.store.saveEnvironment({ id: 'acme-staging', name: 'Staging', group: 'Acme', variables: [] });
    r.store.saveEnvironment({ id: 'local', name: 'Local', variables: [] });
    saveMonitor(r.store, { id: 'm1', name: 'Quiet', collectionId: 'scratch', everyMinutes: 60, enabled: true });
    r.write('CODEOWNERS', 'collections/payments-invoices.json @org/payments\n');
    writeFileSync(r.store.path(CONVENTIONS_FILE), ['collections:', '  name: "^[a-z]+-[a-z-]+$"', '  owner: required', 'requests:', '  name: "^[A-Z]"', 'environments:', '  group: required', 'monitors:', '  webhook: required', '  environment: required', ''].join('\n'));
    const all = await conventionFindings(r.store);
    // the fixture workspace (Kinds API, Development, Staging, Pets monitor) breaks the same rules: six more
    expect(all).toHaveLength(12);
    const f = all.filter((x) => /Scratch|Local|Quiet/.test(x.message));
    expect(f.map((x) => `${x.rule}: ${x.message}`).sort()).toEqual([
      "collections.name: Collection \"Scratch\" does not match the team's pattern ^[a-z]+-[a-z-]+$",
      'collections.owner: Collection "Scratch" has no owner in CODEOWNERS',
      'environments.group: Environment "Local" is in no group (a tenant, a customer, a deployment)',
      'monitors.environment: Monitor "Quiet" says no environment',
      'monitors.webhook: Monitor "Quiet" alerts nowhere: give it a webhook',
      "requests.name: Request \"Scratch › try it\" does not match the team's pattern ^[A-Z]",
    ]);
    expect(f.find((x) => x.rule === 'requests.name')!.ref).toEqual({ kind: 'request', collectionId: 'scratch', requestId: 'r2' });
    const attention = await workspaceAttention(r.store);
    expect(attention.filter((a) => a.kind === 'convention')).toHaveLength(12);
    expect(attention.find((a) => a.kind === 'convention')).toMatchObject({ group: 'Team conventions', type: 'warning', severity: 'low' });
    // a broken pattern is one error, not a crash
    writeFileSync(r.store.path(CONVENTIONS_FILE), 'collections:\n  name: "(["\n');
    expect(() => readConventions(r.store)).toThrow(/not a regular expression/);
    expect((await workspaceAttention(r.store)).filter((a) => a.kind === 'convention')).toEqual([expect.objectContaining({ type: 'error', message: expect.stringMatching(/conventions\.yaml can't be read/) })]);
    rmSync(r.store.path(CONVENTIONS_FILE));
    expect(readFileSync(r.ws + '/CODEOWNERS', 'utf8')).toContain('@org/payments');
  });
});
