/**
 * AI-4 golden cases (mock provider unless AI_EVAL_LIVE=1): the model adds negative / boundary / security ideas to the
 * deterministic cases for the gaps in the tests of an API definition. TestPion builds every request from the document's
 * valid example, drops what the document does not support (and says so), takes the checks from the document, validates
 * each test against it, and reports the coverage before → after.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyProposal, discardProposal, getProposal, runAiTask, undoProposal, aiUsageSummary, lintTestFile } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { addShopSpec } from './spec-fixtures.js';

afterAll(printScorecard);

const PLAN = JSON.stringify({
  summary: 'Quantity limits, a null item, a missing token and a duplicate.',
  assumptions: ['Creating an order twice with the same item is not refused (the document says nothing)'],
  cases: [
    // valid ideas
    { operation: 'POST /orders', category: 'negative', name: 'Quantity zero is refused', expectStatus: 422, why: 'qty minimum is 1', bodyPatch: [{ field: 'qty', value: 0 }] },
    { operation: 'createOrder', category: 'boundary', name: 'Quantity 11 is above the maximum', expectStatus: '4xx', why: 'qty maximum is 10', bodyPatch: [{ field: 'qty', value: 11 }] },
    { operation: 'POST /orders', category: 'positive', name: 'Quantity 5 is accepted', expectStatus: 201, why: 'qty 1 to 10', bodyPatch: [{ field: 'qty', value: 5 }] },
    { operation: 'GET /orders', category: 'security', name: 'Listing without a token is refused', expectStatus: 401, noAuth: true },
    // an undocumented status becomes its class (the document does not say 409)
    { operation: 'POST /orders', category: 'negative', name: 'Null item is refused', expectStatus: 409, bodyPatch: [{ field: 'item', value: null }] },
    // dropped: an operation the document does not have
    { operation: 'POST /invoices', category: 'negative', name: 'Invented endpoint', expectStatus: 400 },
    { operation: 'GET /orders/{id}/refunds', category: 'positive', name: 'Another invented endpoint', expectStatus: 200 },
    // dropped: a valid request that breaks the document is not a positive case
    { operation: 'POST /orders', category: 'positive', name: 'Quantity 99 is created', expectStatus: 201, bodyPatch: [{ field: 'qty', value: 99 }] },
    // dropped: DELETE destroys data
    { operation: 'DELETE /orders/{id}', category: 'negative', name: 'Delete twice', expectStatus: 404 },
    // dropped: a refused case cannot expect a 2xx
    { operation: 'POST /orders', category: 'negative', name: 'Wrong expectation', expectStatus: 200, bodyPatch: [{ field: 'qty', value: 0 }] },
  ],
});

describe('tests-from-spec', () => {
  it('draft ∪ the model’s valid cases; hallucinated, invalid and destructive ones dropped with a reason; coverage computed', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addShopSpec(h.store);
      const r = await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' } });
      const p = r.proposal!;
      expect(p).toBeDefined();
      const ok = p.items.length === 1 && p.items[0]!.verification.every((b) => b.status !== 'fail');
      score('tests-from-spec', 'shop gaps', r, ok);
      if (LIVE) return;
      expect(r.repairs).toBe(0);
      expect(p.task).toBe('tests-from-spec');
      const item = p.items[0]!;
      expect(item.kind).toBe('file');
      expect(item.path).toBe('shop/orders-gaps.yaml');
      expect(lintTestFile(item.after).filter((x) => x.severity === 'error')).toEqual([]);
      const steps = (parse(item.after) as { tests: Array<Record<string, any>> }).tests;
      const byName = Object.fromEntries(steps.map((s) => [s.name, s]));
      // the model's valid ideas are in, built from the document's example
      expect(byName['Quantity zero is refused']).toMatchObject({ method: 'POST', url: '{{baseUrl}}/orders', body: { qty: 0 }, assertions: [{ type: 'status', expected: 422 }] });
      expect(byName['Quantity zero is refused'].tags).toEqual(['spec-gap', 'negative', 'ai']);
      expect(byName['Quantity 11 is above the maximum'].assertions).toEqual([{ type: 'status', expected: '4xx' }]);
      expect(byName['Quantity 5 is accepted'].assertions.map((a: { type: string }) => a.type)).toEqual(['status', 'openapi', 'json-schema', 'latency']);
      expect(byName['Listing without a token is refused']).not.toHaveProperty('auth');
      expect(byName['Listing without a token is refused'].tags).toContain('security');
      // the undocumented 409 became its class
      expect(byName['Null item is refused'].assertions).toEqual([{ type: 'status', expected: '4xx' }]);
      // dropped: invented operations, an invalid "positive", DELETE, a wrong expectation
      for (const gone of ['Invented endpoint', 'Another invented endpoint', 'Quantity 99 is created', 'Delete twice', 'Wrong expectation']) expect(byName[gone]).toBeUndefined();
      const notes = (p.notes ?? []).join('\n');
      expect(notes).toContain('POST /invoices is not an operation');
      expect(notes).toContain('GET /orders/{id}/refunds is not an operation');
      expect(notes).toContain('"Quantity 99 is created"');
      expect(notes).toContain('DELETE operations are left out');
      expect(notes).toContain('does not fit a refused negative case');
      expect(notes).toContain('status 409 is not documented');
      // the deterministic cases are still there
      expect(steps.some((s) => s.tags.includes('spec-gap') && !s.tags.includes('ai'))).toBe(true);
      // verified against the document, summarised with the computed coverage and the model's assumptions
      expect(item.verification.map((b) => b.verifier)).toEqual(['test-file', 'spec-tests']);
      expect(item.verification.every((b) => b.status !== 'fail')).toBe(true);
      expect(p.summary).toContain('Quantity limits');
      expect(p.summary).toMatch(/Coverage of the document: 80% → 100%|Coverage of the document: \d+(\.\d+)?% → \d+(\.\d+)?% of operations called/);
      expect(p.assumptions).toEqual(['Creating an order twice with the same item is not refused (the document says nothing)']);
      // one call, counted in the ledger
      expect(aiUsageSummary(h.store).byTask[0]!.task).toBe('tests-from-spec');
    } finally {
      h.cleanup();
    }
  });

  it('sends the gaps and the draft, not the other operations’ noise; privacy and a dry run', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addShopSpec(h.store);
      const dry = await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' }, dryRun: true, context: { options: { operations: ['POST /orders'], categories: ['negative', 'boundary'] } } });
      expect(dry.dryRun).toBe(true);
      expect(h.rec.requests).toHaveLength(0);
      const sent = dry.preview.messages.map((m) => m.content).join(' ');
      expect(sent).toContain('"operation": "POST /orders"');
      expect(sent).toContain('minimum 1');
      expect(sent).toContain('negative: Create an order rejects');
      expect(sent).not.toContain('GET /health');
      expect(dry.preview.estimate.inputTokens).toBeGreaterThan(100);
    } finally {
      h.cleanup();
    }
  });

  it('a model that answers nothing usable still leaves TestPion’s own cases; categories narrow the draft', async () => {
    const h = harness({ rules: [{ match: '.', response: '{"cases": []}' }] });
    try {
      addShopSpec(h.store);
      const r = await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' }, context: { options: { categories: ['security'] } } });
      const steps = (parse(r.proposal!.items[0]!.after) as { tests: Array<Record<string, any>> }).tests;
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((s) => s.tags.includes('security'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('applies through the workspace writer (tests/…), once, and undoes', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addShopSpec(h.store);
      const r = await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' } });
      const id = r.proposal!.id;
      const file = join(h.store.root, 'tests', 'shop', 'orders-gaps.yaml');
      expect(existsSync(file)).toBe(false);
      applyProposal(h.store, id);
      expect(readFileSync(file, 'utf8')).toContain('# AI-generated by TestPion');
      expect(() => applyProposal(h.store, id)).toThrow(/applied already/);
      undoProposal(h.store, id);
      expect(existsSync(file)).toBe(false);
      // applied again, the tests cover the gaps: nothing left to generate; asked for everything, a free name (never over a file)
      applyProposal(h.store, (await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' } })).proposal!.id);
      await expect(runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' } })).rejects.toThrow(/Nothing to generate/);
      const again = await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' }, context: { options: { gapsOnly: false } } });
      expect(again.proposal!.items.map((i) => i.path)).toContain('shop/orders-gaps-2.yaml');
      discardProposal(h.store, again.proposal!.id);
      expect(getProposal(h.store, again.proposal!.id).status).toBe('discarded');
    } finally {
      h.cleanup();
    }
  });

  it('a file written to a path the person chose; a path outside tests/ is refused before anything is sent', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addShopSpec(h.store);
      const r = await runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' }, path: 'api/all.yaml' });
      expect(r.proposal!.items.map((i) => i.path)).toEqual(['api/all.yaml']);
      await expect(runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' }, path: '../evil.yaml' })).rejects.toThrow();
      expect(h.rec.requests).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('not a spec, or nothing to generate, is said before any call', async () => {
    const h = harness({ rules: [{ match: '.', response: PLAN }] });
    try {
      addShopSpec(h.store);
      await expect(runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'collection', collectionId: 'x' } })).rejects.toThrow(/API definition/);
      await expect(runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/missing.yaml' } })).rejects.toThrow(/Cannot read/);
      await expect(runAiTask(h.deps, { task: 'tests-from-spec', item: { kind: 'spec', path: 'specs/shop.yaml' }, context: { options: { operations: ['nope'] } } })).rejects.toThrow(/No operation/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});
