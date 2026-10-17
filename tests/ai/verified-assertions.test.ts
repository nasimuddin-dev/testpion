/**
 * AI-3 · Verified assertions and tp tests: every suggested check and test runs against the response it was written for
 * (and the one before it) before it is offered. Unstable values are flagged with a safer form, pm.* is repaired to tp.*,
 * a failing test is shown unticked, only the accepted items are applied, and undo puts the request back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyProposal, getProposal, reverifyProposal, runAiTask, saferChecks, undoProposal, verifyCheck, verifyScript, type Collection } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';

const NOW = {
  status: 201,
  headers: [['content-type', 'application/json']] as Array<[string, string]>,
  body: JSON.stringify({ id: 42, name: 'Rex', createdAt: '2026-10-16T10:00:00Z', token: 'abc' }),
};
const BEFORE = { ...NOW, body: JSON.stringify({ id: 41, name: 'Rex', createdAt: '2026-10-15T09:00:00Z', token: 'xyz' }) };
const PETS: Collection = {
  schemaVersion: '1.0',
  id: 'pets',
  name: 'Pets',
  version: 1,
  variables: [],
  updatedAt: '2026-10-16T00:00:00Z',
  items: [{ kind: 'http', id: 'create-pet', name: 'Create pet', request: { method: 'POST', url: '{{baseUrl}}/pets' }, testScript: "tp.test('own', () => {});" }],
} as unknown as Collection;
const REQ = { kind: 'request' as const, collectionId: 'pets', requestId: 'create-pet' };
const json = (v: unknown) => JSON.stringify(v);

afterAll(printScorecard);

/** Live: something passed, and every failing item is unticked with its reason. */
const honest = (items: Array<{ selected: boolean; verification: Array<{ status: string; label: string }> }>) =>
  items.some((i) => i.verification.some((b) => b.status === 'pass')) && items.every((i) => i.verification.every((b) => b.status !== 'fail') || (!i.selected && i.verification.some((b) => !!b.label)));

describe('checks verified against the stored responses', () => {
  it('a pinned id that changed since the previous response fails, with safer forms', async () => {
    const b = await verifyCheck({ type: 'equals', path: '$.id', expected: 42 }, NOW, BEFORE);
    expect(b).toMatchObject({ status: 'fail', label: 'passes now but failed on the previous response: the value changes' });
    expect(b.safer).toEqual([
      { type: 'type', path: '$.id', expected: 'number' },
      { type: 'exists', path: '$.id' },
    ]);
  });

  it('a pinned timestamp is risky even without a previous response; its safer form is a format check', async () => {
    const b = await verifyCheck({ type: 'equals', path: '$.createdAt', expected: '2026-10-16T10:00:00Z' }, NOW);
    expect(b.status).toBe('warn');
    expect(saferChecks({ type: 'equals', path: '$.createdAt', expected: '2026-10-16T10:00:00Z' })[0]).toMatchObject({ type: 'regex', path: '$.createdAt' });
    expect((await verifyCheck({ type: 'equals', path: '$.name', expected: 'Rex' }, NOW, BEFORE)).status).toBe('pass');
  });

  it('a script using pm.* fails; a test that passes now but failed before is flagged', async () => {
    expect((await verifyScript("pm.test('x', () => pm.response.to.have.status(201));", NOW)).label).toBe('uses pm.* / postman.*');
    expect((await verifyScript("tp.test('id', () => tp.expect(tp.response.json().id).to.eql(42));", NOW, BEFORE)).status).toBe('fail');
    expect((await verifyScript("tp.test('id', () => tp.expect(tp.response.json().id).to.be.a('number'));", NOW, BEFORE)).status).toBe('pass');
  });
});

describe('suggest-assertions / generate-tests (mock provider unless AI_EVAL_LIVE=1)', () => {
  it('unstable values are flagged and unticked, with a safer form to switch to; only accepted checks are applied', async () => {
    const answer = json({
      checks: [
        { type: 'status', expected: 201 },
        { type: 'equals', path: '$.id', expected: 42 },
        { type: 'equals', path: '$.name', expected: 'Rex' },
      ],
    });
    const h = harness({ rules: [{ match: '.', response: answer }] });
    h.store.saveCollection(structuredClone(PETS));
    try {
      // the alias the CLI and MCP document
      const r = await runAiTask(h.deps, { task: 'suggest-assertions', item: REQ, response: NOW, previous: BEFORE, context: { status: 201, body: NOW.body } });
      const p = r.proposal!;
      score('suggest-assertions', 'pet with a previous response', r, !!p && honest(p.items));
      expect(r.task).toBe('generate-assertions');
      if (LIVE) return;
      const [status, id, name] = p.items;
      expect(status!.selected && name!.selected).toBe(true);
      expect(id!.selected).toBe(false);
      expect(id!.alternatives?.map((a) => a.label)).toEqual(['type $.id = "number"', 'exists $.id']);
      // switch the id check to its safer form: checked again, ticked
      const after = await reverifyProposal(h.store, p.id, { item: id!.id, after: id!.alternatives![0]!.after, data: id!.alternatives![0]!.data, response: NOW, previous: BEFORE });
      const switched = after.items.find((i) => i.id === id!.id)!;
      expect(switched).toMatchObject({ selected: true, title: 'type $.id = "number"' });
      expect(switched.verification[0]!.status).toBe('pass');
      // only the accepted items are applied
      applyProposal(h.store, p.id, { items: [status!.id, id!.id] });
      const node = h.store.getCollection('pets').items[0] as { assertions?: unknown[] };
      expect(node.assertions).toEqual([
        { type: 'status', expected: 201 },
        { type: 'type', path: '$.id', expected: 'number' },
      ]);
      undoProposal(h.store, p.id);
      expect((h.store.getCollection('pets').items[0] as { assertions?: unknown[] }).assertions).toBeUndefined();
      expect(getProposal(h.store, p.id).applied?.undone).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it('pm.* is sent back and repaired to tp.*; a failing test stays unticked; accepted tests are appended to the script', async () => {
    const pm = json({ tests: [{ name: 'created', code: 'pm.response.to.have.status(201);' }] });
    const tp = json({
      tests: [
        { name: 'created', code: 'tp.response.to.have.status(201);' },
        { name: 'is ok', code: 'tp.response.to.have.status(200);' },
        { name: 'has a name', code: "tp.expect(tp.response.json().name).to.be.a('string');" },
      ],
    });
    const h = harness({ rules: [{ match: '.', responses: [pm, tp, tp] }] });
    h.store.saveCollection(structuredClone(PETS));
    try {
      const r = await runAiTask(h.deps, { task: 'generate-tests', item: REQ, response: NOW });
      score('generate-tests', 'pet, tp only', r, !!r.proposal && honest(r.proposal.items) && r.proposal.items.every((i) => !/\bpm\./.test(i.after)));
      if (LIVE) return;
      expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/uses pm\.\* \/ postman\.\*/);
      expect(r.repairs).toBe(2);
      const items = r.proposal!.items;
      expect(items.map((i) => [i.title, i.selected])).toEqual([
        ['created', true],
        ['is ok', false],
        ['has a name', true],
      ]);
      expect(items[1]!.verification[0]!.label).toBe('1 of 1 tests fail on the current response');
      expect(items.every((i) => !/\bpm\./.test(i.after))).toBe(true);
      applyProposal(h.store, r.proposal!.id);
      const script = (h.store.getCollection('pets').items[0] as { testScript: string }).testScript;
      expect(script).toMatch(/^tp\.test\('own'/);
      expect(script).toContain('tp.test("created"');
      expect(script).toContain('tp.test("has a name"');
      expect(script).not.toContain('is ok');
      undoProposal(h.store, r.proposal!.id);
      expect((h.store.getCollection('pets').items[0] as { testScript: string }).testScript).toBe("tp.test('own', () => {});");
    } finally {
      h.cleanup();
    }
  });
});
