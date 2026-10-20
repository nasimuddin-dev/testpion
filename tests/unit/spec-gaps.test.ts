/**
 * AI-4, the part that needs no model: the gap report of an API definition against the tests and collections that exist,
 * the deterministic cases that close the gaps, the validation of a case by the document alone, and the coverage that
 * the proposed files add (computed, never claimed).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  analyseSpec,
  caseIssues,
  coverageAfter,
  draftSpecTestsProposal,
  lintTestFile,
  loadOpenApi,
  normalizeExpect,
  specGapMarkdown,
  specOperations,
  viewOfStep,
  WorkspaceStore,
  workspaceSpecGaps,
  buildSpecFiles,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';
import { addShopSpec, SHOP_SPEC } from '../ai/spec-fixtures.js';

const t = tempDir('tp-spec-gaps-');
afterAll(() => t.cleanup());

function workspace(name: string, tests = true) {
  const store = WorkspaceStore.create(join(t.dir, name), name);
  addShopSpec(store, { tests });
  return store;
}

describe('gap report', () => {
  it('matches the tests that exist to operations and says what each proves', () => {
    const store = workspace('gaps');
    try {
      store.saveCollection({
        schemaVersion: '1.0',
        id: 'shop',
        name: 'Shop',
        version: 1,
        variables: [],
        updatedAt: '2026-10-19T00:00:00Z',
        items: [{ kind: 'http', id: 'list', name: 'List orders', request: { method: 'GET', url: '{{baseUrl}}/orders?limit=5' }, assertions: [{ type: 'status', expected: 200 }] }],
      } as never);
      const r = workspaceSpecGaps(store, 'specs/shop.yaml');
      const by = Object.fromEntries(r.operations.map((o) => [o.operation, o]));
      expect(r.summary).toMatchObject({ operations: 5, covered: 4, existingRequests: 4, unmatched: 0 });
      // health: called, 200 asserted with the contract; nothing to add
      expect(by['GET /health']!.gaps).toEqual([]);
      expect(by['GET /health']!.contractChecked).toBe(true);
      // create: 201 asserted, but no negative/boundary/security test, the 400/401/422 are never asserted, no contract check
      const create = by['POST /orders']!;
      expect(create.assertedStatuses).toEqual(['201']);
      expect(create.untestedStatuses).toEqual(['400', '401', '422']);
      expect(create.gaps.map((g) => g.kind)).toEqual(expect.arrayContaining(['status', 'negative', 'boundary', 'security', 'contract']));
      // the list is a saved request: it sends limit, never status
      expect(by['GET /orders']!.untestedParams).toEqual(['query status']);
      expect(by['GET /orders']!.calls).toBe(1);
      // delete is not called at all
      expect(by['DELETE /orders/{id}']!.covered).toBe(false);
      expect(by['DELETE /orders/{id}']!.gaps[0]).toMatchObject({ kind: 'no-test', category: 'positive' });
      expect(by['DELETE /orders/{id}']!.destructive).toBe(true);
      expect(specGapMarkdown(r)).toContain('`POST /orders`');
    } finally {
      store.close();
    }
  });

  it('an empty workspace has every operation as a gap', () => {
    const store = workspace('empty', false);
    try {
      const r = workspaceSpecGaps(store, 'specs/shop.yaml');
      expect(r.summary).toMatchObject({ covered: 0, operationPct: 0, existingRequests: 0 });
      expect(r.operations.every((o) => o.gaps.some((g) => g.kind === 'no-test'))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('deterministic cases', () => {
  it('close the gaps by category, from the document: statuses, contract, limits, no credentials, unknown id', () => {
    const store = workspace('cases');
    try {
      const { local } = analyseSpec(store, 'specs/shop.yaml');
      const names = local.draft.map((c) => `${c.operation} | ${c.category} | ${c.mutation}`);
      // create has a body with limits: negative + boundary (beyond and at the limit) + security
      expect(names).toEqual(expect.arrayContaining(['POST /orders | negative | missing-required', 'POST /orders | security | no-auth', 'POST /orders | boundary | at-limit']));
      expect(local.draft.some((c) => c.operation === 'POST /orders' && c.category === 'boundary' && c.mutation === 'too-long')).toBe(true);
      // get documents a 404 and has a path id: an unknown uuid
      const nf = local.draft.find((c) => c.mutation === 'not-found')!;
      expect(nf.request.url).toBe('{{baseUrl}}/orders/00000000-0000-4000-8000-000000000000');
      expect(nf.expect).toEqual([404]);
      // health has no gaps: no case; DELETE is left out unless asked
      expect(local.draft.some((c) => c.operation === 'GET /health')).toBe(false);
      expect(local.draft.some((c) => c.operation.startsWith('DELETE'))).toBe(false);
      // a case that is accepted checks the contract and a shallow schema from the document; a refused one only the status
      const create = local.draft.find((c) => c.operation === 'POST /orders' && c.mutation === 'at-limit')!;
      const file = buildSpecFiles([create], local, loadOpenApi(SHOP_SPEC), { by: 'TestPion', ai: false })[0]!;
      const step = (parse(file.yaml) as { tests: Array<Record<string, any>> }).tests[0]!;
      expect(step.tags).toEqual(['spec-gap', 'boundary']);
      expect(step.assertions).toEqual([
        { type: 'status', expected: 201 },
        { type: 'openapi', spec: 'specs/shop.yaml' },
        { type: 'json-schema', schema: { type: 'object', required: ['id', 'item', 'qty'], properties: { id: { type: 'string' }, item: { type: 'string' }, qty: { type: 'integer' }, note: { type: ['string', 'null'] } } } },
        { type: 'latency', max: 2000 },
      ]);
      const refused = local.draft.find((c) => c.mutation === 'missing-required')!;
      const rf = buildSpecFiles([refused], local, loadOpenApi(SHOP_SPEC), { by: 'TestPion', ai: false })[0]!;
      expect((parse(rf.yaml) as { tests: Array<Record<string, any>> }).tests[0]!.assertions).toEqual([{ type: 'status', expected: '4xx' }]);
    } finally {
      store.close();
    }
  });

  it('gapsOnly: false adds every category for every operation; includeDelete adds DELETE; categories narrow it', () => {
    const store = workspace('all');
    try {
      const gaps = analyseSpec(store, 'specs/shop.yaml').local.draft.length;
      const all = analyseSpec(store, 'specs/shop.yaml', { gapsOnly: false }).local;
      expect(all.draft.length).toBeGreaterThan(gaps);
      expect(all.draft.some((c) => c.operation === 'GET /health' && c.category === 'positive')).toBe(true);
      expect(analyseSpec(store, 'specs/shop.yaml', { gapsOnly: false, includeDelete: true }).local.draft.some((c) => c.operation.startsWith('DELETE'))).toBe(true);
      const sec = analyseSpec(store, 'specs/shop.yaml', { categories: ['security'] }).local.draft;
      expect(sec.length).toBeGreaterThan(0);
      expect(sec.every((c) => c.category === 'security' && c.request.auth === undefined)).toBe(true);
      expect(analyseSpec(store, 'specs/shop.yaml', { operations: ['getOrder'] }).local.scope).toEqual(['GET /orders/{id}']);
    } finally {
      store.close();
    }
  });
});

describe('the document judges a case', () => {
  const doc = loadOpenApi(SHOP_SPEC);
  const step = (s: Record<string, unknown>) => viewOfStep({ id: 'x', name: 'x', method: 'POST', url: '{{baseUrl}}/orders', auth: { type: 'bearer', token: 't' }, ...s })!;

  it('an operation the document does not have fails', () => {
    expect(caseIssues(doc, step({ url: '{{baseUrl}}/invoices', assertions: [{ type: 'status', expected: '4xx' }] })).issues[0]).toMatchObject({ level: 'fail', message: expect.stringContaining('not an operation') });
  });

  it('an accepted request must satisfy the schema; a refused one must break something', () => {
    const ok = caseIssues(doc, step({ body: { item: 'a', qty: 3 }, assertions: [{ type: 'status', expected: 201 }] }));
    expect(ok.issues).toEqual([]);
    const bad = caseIssues(doc, step({ body: { item: 'a', qty: 99 }, assertions: [{ type: 'status', expected: 201 }] }));
    expect(bad.issues[0]).toMatchObject({ level: 'fail', message: expect.stringContaining('breaks the document') });
    const refused = caseIssues(doc, step({ body: { item: 'a', qty: 99 }, assertions: [{ type: 'status', expected: '4xx' }], tags: ['negative'] }));
    expect(refused.issues).toEqual([]);
    const fine = caseIssues(doc, step({ body: { item: 'a', qty: 3 }, assertions: [{ type: 'status', expected: 409 }], tags: ['negative'] }));
    expect(fine.issues[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('satisfies the document') });
  });

  it('a refused case that sends no credentials is a security case; with credentials it fails', () => {
    expect(caseIssues(doc, step({ auth: undefined, body: { item: 'a', qty: 3 }, assertions: [{ type: 'status', expected: [401, 403] }], tags: ['security'] })).issues).toEqual([]);
    expect(caseIssues(doc, step({ body: { item: 'a', qty: 3 }, assertions: [{ type: 'status', expected: 401 }], tags: ['security'] })).issues[0]).toMatchObject({ level: 'fail' });
  });

  it('an undocumented status becomes its class; a status that does not fit the category is refused', () => {
    const op = specOperations(doc).find((o) => o.key === 'POST /orders')!;
    expect(normalizeExpect(422, op, false)).toEqual({ expect: [422] });
    expect(normalizeExpect(409, op, false)).toMatchObject({ expect: ['4xx'], note: expect.stringContaining('not documented') });
    expect(normalizeExpect('4xx', op, false)).toEqual({ expect: ['4xx'], note: undefined });
    expect(normalizeExpect(200, op, false)).toBeUndefined();
    expect(normalizeExpect(404, op, true)).toBeUndefined();
  });
});

describe('the draft proposal (no model)', () => {
  it('files that lint, validate against the document, and raise the coverage', async () => {
    const store = workspace('draft');
    try {
      const p = await draftSpecTestsProposal(store, 'specs/shop.yaml', { surface: 'cli' });
      expect(p).toMatchObject({ task: 'tests-from-spec', taskVersion: 0, model: expect.stringContaining('no AI'), status: 'open' });
      expect(p.items.map((i) => i.path)).toEqual(['shop/orders-gaps.yaml']);
      for (const i of p.items) {
        expect(lintTestFile(i.after).filter((x) => x.severity === 'error')).toEqual([]);
        expect(i.verification.map((b) => [b.verifier, b.status !== 'fail'])).toEqual([['test-file', true], ['spec-tests', true]]);
        expect(i.selected).toBe(true);
      }
      expect(p.summary).toContain('Coverage of the document');
      const cov = (p.items[0]!.data as { coverage: ReturnType<typeof coverageAfter> }).coverage;
      expect(cov.after.operationPct).toBe(80);
      expect(cov.after.gaps).toBeLessThan(cov.before.gaps);
    } finally {
      store.close();
    }
  });

  it('refuses when nothing is left to generate', async () => {
    const store = workspace('nothing');
    try {
      await expect(draftSpecTestsProposal(store, 'specs/shop.yaml', { surface: 'cli', operations: ['health'] })).rejects.toThrow(/already cover|Nothing to generate/);
    } finally {
      store.close();
    }
  });
});
