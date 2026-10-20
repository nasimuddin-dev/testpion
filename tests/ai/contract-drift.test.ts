/**
 * AI-9 · Contract drift explained: the drift found deterministically (an undocumented field, a changed type, a missing
 * required field, a null, an enum value, a status, an endpoint) from History / a HAR file; the model explains it and
 * chooses the fix per finding; a spec patch is made by TestPion from what was observed and verified against the same
 * traffic (the drift gone, nothing new, the document linting no worse), applied to the file as it is (comments kept)
 * and undone in one step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyseDrift,
  applyPatchOps,
  applyProposal,
  contractDrift,
  draftDriftProposal,
  driftId,
  gatherExchanges,
  loadOpenApi,
  planPatch,
  runAiTask,
  undoProposal,
  type DriftSource,
} from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { addClinicSpec, addDriftedTraffic, addHistory, BASE, CLINIC_SPEC } from './drift-fixtures.js';

afterAll(printScorecard);

const HIST: DriftSource = { kind: 'history' };
const id = (kind: string, operation: string, status: string | undefined, pointer: string | undefined, expected?: string) => driftId({ kind, operation, status, pointer, expected } as never);

describe('the drift of traffic against a document (deterministic)', () => {
  it('finds each kind with its place, counts and the values seen', async () => {
    const h = harness();
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const r = await contractDrift(h.store, 'specs/clinic.yaml', HIST);
      expect(r.exchanges).toBe(9);
      expect(r.matched).toBe(8);
      const by = (kind: string, pointer?: string, op = 'GET /patients/{id}') => r.findings.find((f) => f.kind === kind && f.operation === op && (pointer === undefined || f.pointer === pointer));
      expect(by('undocumented-field', '$.nickname')).toMatchObject({ status: '200', observed: ['string'], count: 5, of: 6, id: id('undocumented-field', 'GET /patients/{id}', '200', '$.nickname') });
      expect(by('type-change', '$.age')).toMatchObject({ expected: 'integer', observed: ['string'], count: 2, of: 6 });
      expect(by('enum-value', '$.species')).toMatchObject({ expected: '"dog", "cat"', observed: ['bird'], count: 1 });
      expect(by('missing-required', '$.name')).toMatchObject({ count: 1 });
      expect(by('nullable', '$.age')).toMatchObject({ expected: 'integer', observed: ['null'], count: 1 });
      expect(by('undocumented-status')).toMatchObject({ status: '500', expected: '200, 404', count: 1 });
      expect(by('undocumented-field', '$[].nickname', 'GET /patients')).toMatchObject({ count: 1, of: 1 });
      expect(r.findings.find((f) => f.kind === 'undocumented-endpoint')).toMatchObject({ operation: 'GET /owners', count: 1 });
      // the saved request the traffic came from is kept for a test fix
      expect(by('undocumented-field', '$.nickname')!.requests).toEqual([{ collectionId: 'clinic', requestId: 'r-get' }]);
      // the most common drift first
      expect(r.findings[0]!.kind).toBe('undocumented-field');
      expect(r.patchable).toBe(6);
    } finally {
      h.cleanup();
    }
  });

  it('a document and traffic that agree have no drift; a body that is not JSON or has no schema is not compared', async () => {
    const h = harness();
    try {
      addClinicSpec(h.store);
      addHistory(h.store, { path: '/patients/7', status: 200, body: { id: 7, name: 'Rex', species: 'dog', age: 3 } });
      addHistory(h.store, { path: '/patients/9', status: 404, body: 'not found', contentType: 'text/plain' });
      const r = await contractDrift(h.store, 'specs/clinic.yaml', HIST);
      expect(r.findings).toEqual([]);
      expect(r.matched).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it('a HAR file is a source too', async () => {
    const h = harness();
    try {
      addClinicSpec(h.store);
      const har = { log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [{ startedDateTime: '2026-10-19T10:00:00Z', time: 5, request: { method: 'GET', url: `${BASE}/patients/7`, headers: [], queryString: [] }, response: { status: 200, headers: [], content: { size: 40, mimeType: 'application/json', text: '{"id":7,"name":"Rex","extra":true}' } } }] } };
      const ex = await gatherExchanges(h.store, { kind: 'har', text: JSON.stringify(har) });
      expect(ex).toHaveLength(1);
      const r = analyseDrift(loadOpenApi(CLINIC_SPEC), ex);
      expect(r.findings.map((f) => [f.kind, f.pointer])).toEqual([['undocumented-field', '$.extra']]);
      await expect(gatherExchanges(h.store, { kind: 'har', text: 'not json' })).rejects.toThrow(/not a HAR file/);
    } finally {
      h.cleanup();
    }
  });
});

describe('patches made from what was observed', () => {
  it('each finding has a patch (or a reason it has none); YAML keeps its comments; applying twice changes nothing', async () => {
    const h = harness();
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const doc = loadOpenApi(CLINIC_SPEC);
      const r = await contractDrift(h.store, 'specs/clinic.yaml', HIST);
      const plans = r.findings.map((f) => ({ f, plan: planPatch(doc, f, f.sample) }));
      const skipped = plans.filter((p) => 'skip' in p.plan).map((p) => p.f.kind);
      expect(skipped.sort()).toEqual(['type-change', 'undocumented-endpoint']);
      const ops = plans.flatMap((p) => ('ops' in p.plan ? p.plan.ops : []));
      const patched = applyPatchOps(CLINIC_SPEC, false, ops);
      expect(patched).toContain('# The clinic API (kept by the platform team)');
      expect(applyPatchOps(patched, false, ops)).toBe(patched);
      const after = loadOpenApi(patched);
      const schema = (after.components as any).schemas.Patient;
      expect(schema.properties.nickname).toEqual({ type: 'string' });
      expect(schema.properties.age).toMatchObject({ type: 'integer', nullable: true });
      expect(schema.properties.species.enum).toEqual(['dog', 'cat', 'bird']);
      expect(schema.required).toEqual(['id']);
      expect((after.paths as any)['/patients/{id}'].get.responses['500']).toMatchObject({ description: 'Observed in traffic', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, trace: { type: 'string' } } } } } });
      // the patched document agrees with the traffic it was made from (but for the endpoint nobody documented)
      const again = analyseDrift(after, await gatherExchanges(h.store, HIST));
      expect(again.findings.map((f) => f.kind).sort()).toEqual(['type-change', 'undocumented-endpoint']);
    } finally {
      h.cleanup();
    }
  });

  it('traffic that disagrees with itself, a choice and a missing endpoint are not patched blindly', () => {
    const doc = loadOpenApi(CLINIC_SPEC);
    expect(planPatch(doc, { kind: 'type-change', operation: 'GET /patients/{id}', status: '200', pointer: '$.age', observed: ['string', 'boolean'] })).toMatchObject({ skip: expect.stringMatching(/answers this field with string and boolean/) });
    expect(planPatch(doc, { kind: 'undocumented-field', operation: 'GET /nowhere', status: '200', pointer: '$.x', observed: ['string'] })).toMatchObject({ skip: expect.stringMatching(/not in the document/) });
    expect(planPatch(doc, { kind: 'undocumented-content-type', operation: 'GET /patients', status: '200', observed: ['text/html'] })).toMatchObject({ skip: expect.stringMatching(/decision about the API/) });
  });

  it('a JSON document is patched as JSON', () => {
    const doc = { openapi: '3.0.0', info: { title: 'x', version: '1' }, paths: { '/a': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } } } } } };
    const plan = planPatch(doc as never, { kind: 'undocumented-field', operation: 'GET /a', status: '200', pointer: '$.note', observed: ['string'] }, 'hello');
    expect('ops' in plan).toBe(true);
    const text = applyPatchOps(JSON.stringify(doc), true, 'ops' in plan ? plan.ops : []);
    expect(JSON.parse(text).paths['/a'].get.responses['200'].content['application/json'].schema.properties.note).toEqual({ type: 'string' });
  });
});

const finding = (v: Record<string, unknown>) => ({ confidence: 0.8, impact: 'A client that follows the document never sees it.', explanation: 'In 5 of 6 responses.', ...v });
const PLAN = () =>
  JSON.stringify({
    summary: 'The API grew a nickname and drifted on age.',
    findings: [
      finding({ id: id('undocumented-field', 'GET /patients/{id}', '200', '$.nickname'), verdict: 'spec-outdated', action: 'patch-spec' }),
      finding({ id: id('undocumented-status', 'GET /patients/{id}', '500', undefined, '200, 404'), verdict: 'api-bug', action: 'fix-api', explanation: 'A 500 with a trace is a bug.' }),
      finding({ id: id('type-change', 'GET /patients/{id}', '200', '$.age', 'integer'), verdict: 'api-bug', action: 'pin-test', impact: 'Clients parse age as a number.' }),
      finding({ id: id('enum-value', 'GET /patients/{id}', '200', '$.species', '"dog", "cat"'), verdict: 'spec-outdated', action: 'patch-spec', confidence: 0.3 }),
      // an invented finding is ignored; a patch the engine cannot make is a note
      finding({ id: 'd-nothing', verdict: 'unknown', action: 'patch-spec' }),
      finding({ id: id('undocumented-endpoint', 'GET /owners', undefined, undefined), verdict: 'spec-outdated', action: 'patch-spec' }),
    ],
  });

describe('contract-drift task', () => {
  it('explains the drift and proposes verified spec patches and a contract check; the rest stay findings', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN() }] });
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const r = await runAiTask(h.deps, { task: 'contract-drift', item: { kind: 'spec', path: 'specs/clinic.yaml' } });
      const p = r.proposal!;
      score('contract-drift', 'clinic', r, p.items.length > 0 && p.items.every((i) => i.verification.every((b) => b.status !== 'fail')));
      if (LIVE) return;
      expect(r.problems).toEqual([]);
      expect(r.repairs).toBe(0);
      expect(p.task).toBe('contract-drift');
      const spec = p.items.filter((i) => i.kind === 'spec');
      expect(spec.map((i) => i.title)).toEqual([
        'specs/clinic.yaml: add `nickname` (string) to the schema of GET /patients/{id} 200 (Patient)',
        expect.stringMatching(/add "bird" to the enum of `\$.species`/),
      ]);
      expect(spec[0]!.verification).toMatchObject([{ verifier: 'drift', status: 'pass', label: expect.stringMatching(/^drift gone on 5 of 6 responses/) }]);
      // a low-confidence patch is offered unticked
      expect(spec.map((i) => i.selected)).toEqual([true, false]);
      expect(spec[0]!.before).toBe(CLINIC_SPEC);
      expect(spec[0]!.after).toContain('nickname');
      expect(spec[0]!.after).toContain('# The clinic API');
      // the contract check pinned to the saved request fails on the response that drifted: it would have caught it
      const pin = p.items.find((i) => i.kind === 'assertion')!;
      expect(pin.target).toEqual({ kind: 'request', collectionId: 'clinic', requestId: 'r-get' });
      expect(pin.verification[0]).toMatchObject({ verifier: 'drift', status: 'pass', label: expect.stringMatching(/fails on the response that drifted/) });
      // findings: the model's, with evidence that links the exchange, then the drift it did not explain
      expect(p.findings!.find((f) => /status the document does not list/.test(f.title))).toMatchObject({ kind: 'api-bug', confidence: 0.8 });
      expect(p.findings!.some((f) => /not explained by the model/.test(f.title))).toBe(true);
      expect(p.findings![0]!.evidence[0]).toMatchObject({ text: expect.stringMatching(/Seen string in 5 of 6 responses/), ref: { kind: 'history' } });
      expect(p.notes!.join('\n')).toMatch(/GET \/owners: no patch — a whole endpoint is a decision/);
      expect(p.summary).toMatch(/kinds of drift in 9 responses/);
      // what was sent: findings and schemas, never the traffic (no patient name)
      expect(h.rec.sent()).toContain('nickname');
      expect(h.rec.sent()).not.toContain('Rex');
    } finally {
      h.cleanup();
    }
  });

  it('metadata privacy sends no example values; a dry run sends nothing', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN() }] });
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const dry = await runAiTask(h.deps, { task: 'contract-drift', item: { kind: 'spec', path: 'specs/clinic.yaml' }, privacy: 'metadata', dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(h.rec.requests).toHaveLength(0);
      expect(JSON.stringify(dry.preview.messages)).toContain('GET /patients/{id}');
    } finally {
      h.cleanup();
    }
  });

  it('accepting writes the patches into the file as it is now (comments kept) and one undo puts it back; patches compose', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN() }] });
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const r = await runAiTask(h.deps, { task: 'contract-drift', item: { kind: 'spec', path: 'specs/clinic.yaml' } });
      if (LIVE) return;
      const p = r.proposal!;
      const file = join(h.store.root, 'specs/clinic.yaml');
      // an edit made elsewhere between the proposal and accepting it is kept
      const edited = CLINIC_SPEC.replace('(kept by the platform team)', '(kept by the platform team, edited)');
      h.store.deleteTestFile; // (the workspace API has no spec writer; the file is the workspace's own)
      await import('node:fs').then((fs) => fs.writeFileSync(file, edited));
      const applied = applyProposal(h.store, p.id, { items: p.items.filter((i) => i.kind === 'spec').map((i) => i.id) });
      expect(applied.applied).toHaveLength(2);
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('edited');
      expect(text).toContain('nickname');
      expect(text).toMatch(/enum:[^\n]*bird/);
      undoProposal(h.store, p.id);
      expect(readFileSync(file, 'utf8')).toBe(edited);
    } finally {
      h.cleanup();
    }
  });

  it('a patch whose drift would remain, or that introduces other drift, fails its verification and starts unticked', async () => {
    const h = harness();
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const prop = await draftDriftProposal(h.store, 'specs/clinic.yaml', HIST, { surface: 'cli' });
      const item = prop.items.find((i) => /nickname/.test(i.title) && i.kind === 'spec')!;
      expect(item.verification[0]!.status).toBe('pass');
      // a hand-edited patch that sets a wrong type for a field the traffic also has
      const { verifyItems } = await import('../../packages/core/src/index.js');
      const bad = { ...item, verification: [], selected: true, data: { spec: { ...(item.data as any).spec, ops: [{ op: 'add-property', at: ['components', 'schemas', 'Patient'], name: 'nickname', schema: { type: 'integer' } }] } } };
      await verifyItems([bad as never], ['drift'], { store: h.store });
      expect(bad.verification[0]).toMatchObject({ verifier: 'drift', status: 'fail', label: expect.stringMatching(/still there|introduces/) });
      expect(bad.selected).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('without a model: additive drift is offered ticked, the rest listed (breaking changes are never ticked)', async () => {
    const h = harness();
    try {
      addClinicSpec(h.store);
      addDriftedTraffic(h.store);
      const p = await draftDriftProposal(h.store, 'specs/clinic.yaml', HIST, { surface: 'cli' });
      expect(p.taskVersion).toBe(0);
      expect(p.items.map((i) => [i.selected, i.title.replace('specs/clinic.yaml: ', '').slice(0, 40)])).toEqual(
        expect.arrayContaining([
          [true, expect.stringContaining('add `nickname`')],
          [false, expect.stringContaining('allow null for `$.age`')],
          [false, expect.stringContaining('make `name` optional')],
        ]),
      );
      expect(p.items.every((i) => i.verification.every((b) => b.status !== 'fail'))).toBe(true);
      expect(p.model).toBe('no AI (deterministic patches)');
    } finally {
      h.cleanup();
    }
  });

  it('no drift: nothing to explain, and no model is called', async () => {
    const h = harness({ rules: [{ match: '.', response: '{}' }] });
    try {
      addClinicSpec(h.store);
      addHistory(h.store, { path: '/patients/7', status: 200, body: { id: 7, name: 'Rex' } });
      await expect(runAiTask(h.deps, { task: 'contract-drift', item: { kind: 'spec', path: 'specs/clinic.yaml' } })).rejects.toThrow(/there is no drift to explain/);
      expect(h.rec.requests).toHaveLength(0);
      await expect(runAiTask(h.deps, { task: 'contract-drift', item: { kind: 'collection', collectionId: 'x' } })).rejects.toThrow(/not a collection|compares an API definition/);
    } finally {
      h.cleanup();
    }
  });
});
