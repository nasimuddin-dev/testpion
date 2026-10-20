/**
 * AI-8 · Security tests with the mock model: the model proposes which saved requests to probe and which variables hold
 * the two principals' credentials; TestPion writes the steps (saved requests only, read-only unless write / delete
 * probes are asked for, paced) and the verdicts are checks computed from the responses — run against a local clinic
 * API that is vulnerable (findings) and one that is secure (no findings). Production is refused.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applyProposal,
  createEngineContext,
  defaultSettings,
  draftSecurityProposal,
  lintTestFile,
  MemorySecretStore,
  runAiTask,
  runSecurityTests,
  undoProposal,
  verifyItems,
} from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { addClinic, clinicServer } from './security-fixtures.js';

afterAll(printScorecard);

const IDS = { owner: 'tokenA', other: 'tokenB' };
type Step = Record<string, any>;
const stepsOf = (yaml: string): Step[] => (parse(yaml) as { tests: Step[] }).tests;

describe('security tests without a model (TestPion’s own probes)', () => {
  it('read-only by default: bola, auth and bfla probes from the saved requests; writes and deletes are listed as not probed', async () => {
    const h = harness();
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const p = await draftSecurityProposal(h.store, { kind: 'collection', collectionId: 'clinic' }, { options: { identities: IDS, environment: 'staging' }, surface: 'cli' });
      const item = p.items[0]!;
      expect(item.kind).toBe('flow');
      expect(item.path).toBe('security/clinic.yaml');
      expect(item.verification.map((b) => [b.verifier, b.status])).toEqual([
        ['test-file', 'pass'],
        ['security-tests', 'pass'],
      ]);
      expect(lintTestFile(item.after).filter((x) => x.severity === 'error')).toEqual([]);
      const doc = parse(item.after) as { defaults: Record<string, unknown> };
      expect(doc.defaults).toEqual({ pace: '250ms', tags: ['security'], vars: { patientId: '7' } });
      const steps = stepsOf(item.after);
      const methods = new Set(steps.map((s) => s.request.method));
      expect([...methods].sort()).toEqual(['GET']);
      // BOLA: the owner reads, the other user is refused and must not see the owner's data (the marker is the example's email)
      const owner = steps.find((s) => /^sec-\d+-bola-owner$/.test(s.id))!;
      const n = /^sec-(\d+)-/.exec(owner.id)![1];
      const other = steps.find((s) => s.id === `sec-${n}-bola-other`)!;
      expect(owner.request.auth).toEqual({ type: 'bearer', token: '{{tokenA}}' });
      expect(owner.extract).toEqual({ [`secMarker${n}`]: '$.email' });
      expect(other.request.auth).toEqual({ type: 'bearer', token: '{{tokenB}}' });
      expect(other.dependsOn).toEqual([owner.id]);
      expect(other.assertions).toEqual([
        { type: 'status', expected: [401, 403, 404], name: expect.stringMatching(/^API1 BOLA: another user is refused/) },
        { type: 'not-contains', expected: `{{secMarker${n}}}`, name: expect.stringMatching(/does not see the owner's data/) },
      ]);
      // auth: no credentials and an invalid token
      expect(steps.filter((s) => /^sec-\d+-auth-none$/.test(s.id)).length).toBeGreaterThan(0);
      const none = steps.find((s) => /-auth-none$/.test(s.id))!;
      expect(none.request.auth).toBeUndefined();
      expect(steps.find((s) => /-auth-invalid$/.test(s.id))!.request.auth).toEqual({ type: 'bearer', token: 'tp-invalid-token' });
      // bfla: the admin path as the other user
      expect(steps.find((s) => /-bfla$/.test(s.id))!.request.url).toBe('{{baseUrl}}/admin/stats');
      expect(p.notes!.join('\n')).toMatch(/1 POST \/ PUT \/ PATCH request not probed: they change data/);
      expect(p.notes!.join('\n')).toMatch(/1 DELETE request not probed: they destroy data/);
    } finally {
      h.cleanup();
    }
  });

  it('write probes add mass assignment (privileged fields the response must not echo); delete probes are a separate opt-in', async () => {
    const h = harness();
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const ref = { kind: 'collection', collectionId: 'clinic' } as const;
      const w = await draftSecurityProposal(h.store, ref, { options: { identities: IDS, includeWrite: true }, surface: 'cli' });
      const mass = stepsOf(w.items[0]!.after).find((s) => /-mass-assignment$/.test(s.id))!;
      expect(mass.request.method).toBe('POST');
      expect(JSON.parse(mass.request.body.content)).toEqual({ name: 'Fido', role: 'admin', isAdmin: true, verified: true, balance: 999999 });
      expect(mass.assertions.map((c: Step) => [c.type, c.path, c.expected])).toEqual([
        ['not-equals', '$.role', 'admin'],
        ['not-equals', '$.isAdmin', true],
        ['not-equals', '$.verified', true],
        ['not-equals', '$.balance', 999999],
      ]);
      expect(stepsOf(w.items[0]!.after).some((s) => s.request.method === 'DELETE')).toBe(false);
      const d = await draftSecurityProposal(h.store, ref, { options: { identities: IDS, includeWrite: true, includeDelete: true }, surface: 'cli' });
      expect(stepsOf(d.items[0]!.after).some((s) => s.request.method === 'DELETE')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('without two principals the BOLA and BFLA probes are skipped, and the proposal says why', async () => {
    const h = harness();
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const p = await draftSecurityProposal(h.store, { kind: 'collection', collectionId: 'clinic' }, { surface: 'cli' });
      const ids = stepsOf(p.items[0]!.after).map((s) => s.id as string);
      expect(ids.some((i) => /bola|bfla/.test(i))).toBe(false);
      expect(ids.some((i) => /auth/.test(i))).toBe(true);
      expect(p.notes!.join('\n')).toMatch(/need two principals/);
    } finally {
      h.cleanup();
    }
  });

  it('a hand-edited file that adds a request, a destructive verb, a literal token or drops the pace fails its verification', async () => {
    const h = harness();
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const p = await draftSecurityProposal(h.store, { kind: 'collection', collectionId: 'clinic' }, { options: { identities: IDS }, surface: 'cli' });
      const item = p.items[0]!;
      const check = async (after: string) => {
        const copy = { ...item, after, verification: [], selected: true };
        await verifyItems([copy], ['security-tests'], {});
        return copy.verification[0]!;
      };
      const doc = parse(item.after) as { name: string; defaults: Record<string, unknown>; tests: Step[] };
      const yaml = (d: unknown) => JSON.stringify(d);
      const withDelete = await check(yaml({ ...doc, tests: [...doc.tests, { id: 'sec-9-bola-x', name: 'x', type: 'http', request: { method: 'DELETE', url: '{{baseUrl}}/patients/7' } }] }));
      expect(withDelete.status).toBe('fail');
      expect(withDelete.detail).toMatch(/not one of the probes TestPion built/);
      expect(withDelete.detail).toMatch(/DELETE destroys data/);
      const tokenized = item.after.replaceAll('{{tokenB}}', 'eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop');
      expect((await check(tokenized)).detail).toMatch(/literal credential/);
      const unpaced = await check(yaml({ ...doc, defaults: {} }));
      expect(unpaced.detail).toMatch(/not paced/);
      expect((await check(item.after)).status).toBe('pass');
    } finally {
      h.cleanup();
    }
  });
});

const PLAN = JSON.stringify({
  summary: 'Patients belong to the user of tokenA.',
  assumptions: ['The patient with id 7 belongs to the user of tokenA'],
  identities: { owner: 'tokenA', other: 'tokenB' },
  probes: [
    { kind: 'bola', request: 'r-get', ownerField: '$.email', why: 'reads one patient by id' },
    { kind: 'bola', request: 'r-list', why: 'a list names no object' },
    { kind: 'auth', request: 'r-list' },
    { kind: 'bfla', request: 'r-admin', why: 'an admin path' },
    // dropped: an invented request, a delete nobody asked for, a write nobody asked for
    { kind: 'bola', request: 'r-ghost' },
    { kind: 'bfla', request: 'r-delete' },
    { kind: 'mass-assignment', request: 'r-create', fields: ['role'] },
  ],
});

describe('security-tests task', () => {
  it('the model proposes what to probe; invented requests, other kinds and verbs nobody asked for are dropped with a reason', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const r = await runAiTask(h.deps, { task: 'security-tests', item: { kind: 'collection', collectionId: 'clinic' }, context: { options: { environment: 'staging' } } });
      const p = r.proposal!;
      score('security-tests', 'clinic', r, p.items.length === 1 && p.items[0]!.verification.every((b) => b.status !== 'fail'));
      if (LIVE) return;
      expect(r.problems).toEqual([]);
      expect(r.repairs).toBe(0);
      const item = p.items[0]!;
      expect(item.verification.map((b) => b.status)).toEqual(['pass', 'pass']);
      const ids = stepsOf(item.after).map((s) => s.id as string);
      // the identities came from the plan: both are variables of the staging environment
      expect(ids.filter((i) => /^sec-\d+-bola-(owner|other)$/.test(i))).toHaveLength(2);
      expect(ids.filter((i) => /^sec-\d+-auth-/.test(i)).length).toBe(2);
      expect(ids.some((i) => /ghost|delete|mass/.test(i))).toBe(false);
      expect(p.notes!.join('\n')).toMatch(/request "r-ghost" is not an HTTP request of Clinic/);
      expect(p.notes!.join('\n')).toMatch(/DELETE changes or destroys data and was not asked for/);
      expect(p.notes!.join('\n')).toMatch(/POST changes or destroys data and was not asked for/);
      expect(p.summary).toMatch(/probes \(/);
      expect(p.assumptions).toEqual(['The patient with id 7 belongs to the user of tokenA']);
      // what was sent: names of variables, never the credentials
      expect(h.rec.sent()).toContain('tokenA');
      expect(h.rec.sent()).not.toMatch(/tokA-owner/);
    } finally {
      h.cleanup();
    }
  });

  it('a probe kind outside the catalogue is a schema problem: the model is asked again, and the second answer is used', async () => {
    const bad = JSON.stringify({ probes: [{ kind: 'sql-injection', request: 'r-get' }] });
    const good = JSON.stringify({ probes: [{ kind: 'auth', request: 'r-list' }] });
    const h = harness({ rules: [{ match: '.', responses: [bad, good] }] });
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const r = await runAiTask(h.deps, { task: 'security-tests', item: { kind: 'collection', collectionId: 'clinic' } });
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(r.problems).toEqual([]);
      expect(stepsOf(r.proposal!.items[0]!.after).map((s) => s.id)).toEqual(['sec-1-auth-none', 'sec-1-auth-invalid']);
    } finally {
      h.cleanup();
    }
  });

  it('a variable the plan names that the workspace does not have is ignored (with a note), and the probes that need it are dropped', async () => {
    const plan = JSON.stringify({ identities: { owner: 'tokenA', other: 'invented' }, probes: [{ kind: 'bola', request: 'r-get' }, { kind: 'auth', request: 'r-list' }] });
    const h = harness({ rules: [{ match: '.', response: plan }] });
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const r = await runAiTask(h.deps, { task: 'security-tests', item: { kind: 'collection', collectionId: 'clinic' }, context: { options: { environment: 'staging' } } });
      if (LIVE) return;
      const p = r.proposal!;
      expect(p.notes!.join('\n')).toMatch(/named "invented" for the other, which is not a variable of this workspace/);
      expect(p.notes!.join('\n')).toMatch(/Dropped bola probe of GET \/patients\/\{\{patientId\}\}: it needs two principals/);
      expect(stepsOf(p.items[0]!.after).every((s) => /auth/.test(s.id))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a production environment before anything is sent, unless the caller allows it', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const ref = { kind: 'collection', collectionId: 'clinic' } as const;
      await expect(runAiTask(h.deps, { task: 'security-tests', item: ref, context: { options: { environment: 'prod', identities: IDS } } })).rejects.toThrow(/"prod" is a production environment: security tests are refused there/);
      expect(h.rec.requests).toHaveLength(0);
      await expect(draftSecurityProposal(h.store, ref, { options: { environment: 'prod' }, surface: 'cli' })).rejects.toThrow(/production environment/);
      const ok = await draftSecurityProposal(h.store, ref, { options: { environment: 'prod', allowProduction: true, identities: IDS }, surface: 'cli' });
      expect(ok.items).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('accept writes the file under tests/security (one undo); a dry run sends nothing', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      const dry = await runAiTask(h.deps, { task: 'security-tests', item: { kind: 'collection', collectionId: 'clinic' }, context: { options: { environment: 'staging' } }, dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(h.rec.requests).toHaveLength(0);
      expect(JSON.stringify(dry.preview.messages)).toContain('catalogue');
      const r = await runAiTask(h.deps, { task: 'security-tests', item: { kind: 'collection', collectionId: 'clinic' }, context: { options: { environment: 'staging' } } });
      if (LIVE) return;
      const applied = applyProposal(h.store, r.proposal!.id);
      expect(applied.applied[0]).toMatchObject({ path: 'security/clinic.yaml' });
      expect(h.store.readTestFile('security/clinic.yaml')).toMatch(/Security: Clinic/);
      undoProposal(h.store, r.proposal!.id);
      expect(() => h.store.readTestFile('security/clinic.yaml')).toThrow();
    } finally {
      h.cleanup();
    }
  });
});

describe('the verdicts are the runner’s, not the model’s', () => {
  const servicesFor = (h: ReturnType<typeof harness>) => async (environment?: string) => {
    const ctx = createEngineContext({ store: h.store, secrets: new MemorySecretStore(), settings: defaultSettings(), environment });
    return { services: ctx.services, dispose: () => ctx.dispose() };
  };

  it('a vulnerable API: every probe is a finding, with the checks that failed', async () => {
    const api = await clinicServer('vulnerable');
    const h = harness();
    try {
      addClinic(h.store, api.base);
      const p = await draftSecurityProposal(h.store, { kind: 'collection', collectionId: 'clinic' }, { options: { identities: IDS, includeWrite: true, environment: 'staging' }, surface: 'cli' });
      applyProposal(h.store, p.id);
      const report = await runSecurityTests({ store: h.store, path: 'security/clinic.yaml', environment: 'staging', servicesFor: servicesFor(h) });
      const by = Object.fromEntries(report.verdicts.map((v) => [v.step, v]));
      const bolaOwner = report.verdicts.find((v) => /-bola-owner$/.test(v.step))!;
      const bolaOther = report.verdicts.find((v) => /-bola-other$/.test(v.step))!;
      expect(bolaOwner.verdict).toBe('pass');
      expect(bolaOther.verdict).toBe('finding');
      expect(bolaOther.detail.join('\n')).toMatch(/does not see the owner's data/);
      expect(bolaOther).toMatchObject({ probe: 'bola', owasp: 'API1', status: 200 });
      for (const id of report.verdicts.map((v) => v.step).filter((s) => /-auth-|-bfla$|-mass-assignment$/.test(s))) expect(by[id]!.verdict, id).toBe('finding');
      expect(report.summary.findings).toBeGreaterThanOrEqual(5);
      expect(report.summary.inconclusive).toBe(0);
      // findings first
      expect(report.verdicts[0]!.verdict).toBe('finding');
    } finally {
      h.cleanup();
      await api.close();
    }
  });

  it('a secure API: nothing is a finding; the steps were paced and sequential', async () => {
    const api = await clinicServer('secure');
    const h = harness();
    try {
      addClinic(h.store, api.base);
      const p = await draftSecurityProposal(h.store, { kind: 'collection', collectionId: 'clinic' }, { options: { identities: IDS, includeWrite: true, environment: 'staging', rate: 20 }, surface: 'cli' });
      applyProposal(h.store, p.id);
      const started = Date.now();
      const report = await runSecurityTests({ store: h.store, path: 'security/clinic.yaml', environment: 'staging', servicesFor: servicesFor(h) });
      expect(report.summary.findings).toBe(0);
      expect(report.summary.pass).toBe(report.summary.steps);
      // 20 requests a second: no two requests started closer than ~50 ms, so the whole run took at least (steps - 1) * 50 ms
      expect(Date.now() - started).toBeGreaterThanOrEqual((report.summary.steps - 1) * 40);
      expect(api.hits.some((h) => /anonymous/.test(h))).toBe(true);
      expect(api.hits.some((h) => /DELETE/.test(h))).toBe(false);
    } finally {
      h.cleanup();
      await api.close();
    }
  });

  it('the owner’s setup failing makes the probe inconclusive, never a pass', async () => {
    const api = await clinicServer('secure');
    const h = harness();
    try {
      addClinic(h.store, api.base);
      // the owner's variable holds someone else's token: the owner cannot read patient 7, so nothing is proven about the other user
      h.store.saveEnvironment({
        id: 'staging',
        name: 'staging',
        variables: [
          { key: 'baseUrl', value: api.base, enabled: true },
          { key: 'tokenA', value: 'tokB-other-credential-2', enabled: true },
          { key: 'tokenB', value: 'tokB-other-credential-2', enabled: true },
        ],
      } as never);
      const p = await draftSecurityProposal(h.store, { kind: 'collection', collectionId: 'clinic' }, { options: { identities: IDS, environment: 'staging' }, surface: 'cli' });
      applyProposal(h.store, p.id);
      const report = await runSecurityTests({ store: h.store, path: 'security/clinic.yaml', environment: 'staging', servicesFor: servicesFor(h) });
      const owner = report.verdicts.find((v) => /-bola-owner$/.test(v.step))!;
      const other = report.verdicts.find((v) => /-bola-other$/.test(v.step))!;
      expect(owner.verdict).toBe('finding');
      expect(other.verdict).toBe('inconclusive');
      expect(other.detail[0]).toMatch(/not run: dependency did not pass/);
    } finally {
      h.cleanup();
      await api.close();
    }
  });

  it('refuses a production environment and any file that is not a generated security file', async () => {
    const h = harness();
    try {
      addClinic(h.store, 'http://127.0.0.1:1');
      h.store.writeTestFile('other.yaml', 'name: x\ntests:\n  - name: a\n    url: http://127.0.0.1:1/\n');
      await expect(runSecurityTests({ store: h.store, path: 'security/x.yaml', environment: 'prod', servicesFor: servicesFor(h) })).rejects.toThrow(/production environment: security tests are refused/);
      await expect(runSecurityTests({ store: h.store, path: 'other.yaml', environment: 'staging', servicesFor: servicesFor(h) })).rejects.toThrow(/not a generated security test file/);
      await expect(runSecurityTests({ store: h.store, path: 'missing.yaml', environment: 'staging', servicesFor: servicesFor(h) })).rejects.toThrow(/does not exist/);
    } finally {
      h.cleanup();
    }
  });
});
