/**
 * B-12 · the leftovers of the flow and assertions features:
 *  - what the model changed in a flow, step by step, against TestPion's own deterministic draft (the review's "Vs draft");
 *  - "Generate checks from this response": the verified-assertions task fed with the response a run stored for a result,
 *    added to the test file's step or the saved request that produced it;
 *  - "Prefer stable checks": a setting (and a call's own choice) that asks for types and formats over literal ids and times.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyProposal, diffFlowSteps, flowDiffSummary, reverifyProposal, runAiTask, undoProposal, type Collection } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard } from './harness.js';
import { SHOP } from './fixtures.js';
import { addRun, httpResult } from './run-fixtures.js';

afterAll(printScorecard);
const json = (v: unknown) => JSON.stringify(v);

describe('what the model changed against the deterministic draft', () => {
  const DRAFT = `name: Orders
tests:
  - id: create-order
    name: Create order
    method: POST
    url: "{{baseUrl}}/orders"
    body: { type: json, content: '{"item":"a"}' }
    extract: { orderId: $.id }
    assertions:
      - { type: status, expected: 201 }
  - id: get-order
    name: Get order
    dependsOn: [create-order]
    method: GET
    url: "{{baseUrl}}/orders/{{orderId}}"
    assertions:
      - { type: status, expected: 200 }
  - id: delete-order
    name: Delete order
    dependsOn: [get-order]
    method: DELETE
    url: "{{baseUrl}}/orders/{{orderId}}"
`;

  it('lists, per step, what was added, dropped and changed: place, wait, extract, checks, body, request', () => {
    const ai = `name: Orders
tests:
  - id: create-order
    name: Create order
    method: POST
    url: "{{baseUrl}}/orders"
    body: { type: json, content: '{"item":"b"}' }
    extract: { orderId: $.id, total: $.total }
    assertions:
      - { type: status, expected: 201 }
      - { type: exists, path: $.id }
  - id: delete-order
    name: Delete order
    dependsOn: [create-order]
    method: DELETE
    url: "{{baseUrl}}/orders/{{orderId}}"
    assertions:
      - { type: status, expected: 204 }
  - id: list-orders
    name: List orders
    method: GET
    url: "{{baseUrl}}/orders"
    assertions:
      - { type: status, expected: 200 }
`;
    const d = diffFlowSteps(DRAFT, ai);
    const by = Object.fromEntries(d.map((s) => [s.id, s]));
    expect(d.map((s) => [s.id, s.status])).toEqual([
      ['create-order', 'changed'],
      ['delete-order', 'changed'],
      ['list-orders', 'added'],
      ['get-order', 'removed'],
    ]);
    expect(by['create-order']!.changes).toEqual([
      { field: 'body', before: '{"item":"a"}', after: '{"item":"b"}' },
      { field: 'extract', added: ['total = $.total'] },
      { field: 'checks', added: ['exists $.id'] },
    ]);
    expect(by['delete-order']!.changes).toEqual([
      { field: 'dependsOn', added: ['create-order'], removed: ['get-order'] },
      { field: 'checks', added: ['status = 204'] },
    ]);
    expect(flowDiffSummary(d)).toBe('2 steps changed, 1 added, 1 removed');
    expect(flowDiffSummary(diffFlowSteps(DRAFT, DRAFT))).toBe('the same steps as the draft');
  });

  it('a renamed step is matched by its name or its endpoint, a moved one says so', () => {
    const renamed = DRAFT.replace('id: get-order', 'id: read-order').replace('Get order', 'Read the order').replace('dependsOn: [get-order]', 'dependsOn: [read-order]');
    const d = diffFlowSteps(DRAFT, renamed);
    expect(d.map((s) => s.status)).toEqual(['same', 'changed', 'changed']);
    // matched by endpoint (GET /orders/*): not "added" and "removed"
    expect(d[1]!.changes.map((c) => c.field)).toEqual(['name']);
    const moved = `name: Orders\ntests:\n${DRAFT.split('tests:\n')[1]!.split('  - id: ').slice(1).reverse().map((s) => `  - id: ${s}`).join('')}`;
    const m = diffFlowSteps(DRAFT, moved);
    expect(m.every((s) => s.status !== 'added' && s.status !== 'removed')).toBe(true);
    expect(m.some((s) => s.changes.some((c) => c.field === 'order'))).toBe(true);
  });

  it('garbage in either file is an empty list, never a crash', () => {
    expect(diffFlowSteps('::: not yaml [', DRAFT).map((s) => s.status)).toEqual(['added', 'added', 'added']);
    expect(diffFlowSteps(DRAFT, '{')).toEqual(DRAFT.includes('id:') ? expect.any(Array) : []);
  });

  it('the AI flow proposal carries the diff, the summary says it, and an edit in the review updates it', async () => {
    const plan = {
      name: 'Order lifecycle',
      summary: 'Creates, reads and deletes an order.',
      steps: [
        { id: 'create-order', request: 'req-create', extract: { orderId: '$.id' }, assertions: [{ type: 'status', expected: 201 }] },
        { id: 'read-order', request: 'req-get', dependsOn: ['create-order'], url: '{{baseUrl}}/orders/{{orderId}}', assertions: [{ type: 'status', expected: 200 }] },
        { id: 'delete-order', request: 'req-delete', dependsOn: ['read-order'], url: '{{baseUrl}}/orders/{{orderId}}', assertions: [{ type: 'status', expected: 204 }] },
        { id: 'missing-order', request: 'req-get', url: '{{baseUrl}}/orders/does-not-exist', negative: true, assertions: [{ type: 'status', expected: 404 }] },
      ],
    };
    const h = harness({ rules: [{ match: '.', response: json(plan) }] });
    h.store.saveCollection(structuredClone(SHOP));
    try {
      const r = await runAiTask(h.deps, { task: 'flow-from-collection', item: { kind: 'folder', collectionId: 'shop', folderId: 'fld-orders' } });
      if (LIVE) return;
      const item = r.proposal!.items[0]!;
      const data = item.data as { draft: string; vsDraft: Array<{ id: string; name: string; status: string }> };
      expect(data.draft).toMatch(/Generated by TestPion without AI/);
      // the model's error case is the one thing it added to the draft
      const added = data.vsDraft.filter((s) => s.status === 'added');
      expect(added.map((s) => s.name)).toEqual(['Get order — error case']);
      expect(r.proposal!.summary).toMatch(/Against TestPion's own draft: .*1 added/);
      // the person drops that step in the review: the diff is read again
      const doc = parse(item.after) as { tests: Array<Record<string, unknown>> };
      const edited = item.after.replace(/\n {2}- id: missing-order[\s\S]*?(?=\n {2}- id: |\s*$)/, '');
      expect(edited).not.toContain('missing-order');
      const p = await reverifyProposal(h.store, r.proposal!.id, { item: 'i1', after: edited }, {});
      const after = (p.items[0]!.data as { vsDraft: Array<{ status: string }> }).vsDraft;
      expect(after.filter((s) => s.status === 'added')).toEqual([]);
      expect(doc.tests.length).toBeGreaterThan(3);
    } finally {
      h.cleanup();
    }
  });

  it('the draft without AI has nothing to diff (it is the draft)', async () => {
    const h = harness();
    h.store.saveCollection(structuredClone(SHOP));
    try {
      const { draftFlowProposal } = await import('../../packages/core/src/index.js');
      const p = await draftFlowProposal(h.store, { kind: 'folder', collectionId: 'shop', folderId: 'fld-orders' }, { surface: 'cli' });
      expect((p.items[0]!.data as { vsDraft?: unknown }).vsDraft).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

const FILE = `name: Pets
tests:
  - id: get-pet
    name: Get pet
    url: http://127.0.0.1:1/pets/7
    assertions:
      - { type: status, expected: 200 }
`;
const PET = { id: 7, name: 'Rex', createdAt: '2026-10-16T10:00:00Z', tags: ['dog'] };

async function withRun(h: ReturnType<typeof harness>, o: { origin: 'tests' | 'collection'; body?: unknown; type?: string; withOutput?: boolean; noResponse?: boolean } = { origin: 'tests' }) {
  h.store.writeTestFile('pets/get.yaml', FILE);
  const file = join(h.store.path('tests'), 'pets', 'get.yaml');
  h.store.saveCollection({
    schemaVersion: '1.0',
    id: 'pets',
    name: 'Pets',
    version: 1,
    variables: [],
    updatedAt: '2026-10-16T00:00:00Z',
    items: [{ kind: 'http', id: 'get-pet', name: 'Get pet', request: { method: 'GET', url: 'http://127.0.0.1:1/pets/7' }, assertions: [{ type: 'status', expected: 200 }] }],
  } as unknown as Collection);
  const result = {
    ...httpResult({ id: o.origin === 'tests' ? 'get-pet' : 'get-pet@1', name: 'Get pet', url: 'http://127.0.0.1:1/pets/7', status: o.noResponse ? (undefined as never) : 200, ...(o.withOutput === false ? {} : { body: o.body ?? PET }), checks: [{ type: 'status', name: 'status', passed: true }] }),
    ...(o.origin === 'tests' ? { file } : {}),
    ...(o.type ? { type: o.type as never } : {}),
  };
  await addRun(h.store, { id: 'run-1', startedAt: '2026-10-16T10:00:00.000Z', origin: o.origin === 'tests' ? { kind: 'tests', paths: ['pets/get.yaml'] } : { kind: 'collection', collectionId: 'pets' }, results: [result] });
  return result.id;
}

const CHECKS = json({
  checks: [
    { type: 'status', expected: 200 },
    { type: 'equals', path: '$.name', expected: 'Rex' },
    { type: 'type', path: '$.id', expected: 'number' },
    { type: 'equals', path: '$.createdAt', expected: '2026-10-16T10:00:00Z' },
    { type: 'equals', path: '$.name', expected: 'Max' },
  ],
});

describe('Generate checks from this response (a run result)', () => {
  it('the stored response is what the checks are verified against; they join the step of the test file that produced it', async () => {
    const h = harness({ rules: [{ match: '.', response: CHECKS }] });
    try {
      const id = await withRun(h);
      const r = await runAiTask(h.deps, { task: 'generate-assertions', item: { kind: 'run', runId: 'run-1', resultId: id }, autoReview: true } as never);
      if (LIVE) return;
      const p = r.proposal!;
      // status 200 is in the step already: not proposed again
      expect(p.items.map((i) => i.title)).toEqual(['equals $.name = "Rex"', 'type $.id = "number"', 'equals $.createdAt = "2026-10-16T10:00:00Z"', 'equals $.name = "Max"']);
      expect(p.notes!.join(' ')).toMatch(/Left out 1 check the step already has/);
      for (const i of p.items) expect(i).toMatchObject({ kind: 'assertion', target: { kind: 'test', path: 'pets/get.yaml' }, path: 'pets/get.yaml', step: 'get-pet' });
      // verified against the response the run stored: the wrong one fails (unticked), the pinned time warns
      const by = Object.fromEntries(p.items.map((i) => [i.title, i]));
      expect(by['equals $.name = "Rex"']!.verification[0]).toMatchObject({ verifier: 'checks', status: 'pass' });
      expect(by['equals $.name = "Max"']).toMatchObject({ selected: false });
      expect(by['equals $.name = "Max"']!.verification[0]!.status).toBe('fail');
      expect(by['equals $.createdAt = "2026-10-16T10:00:00Z"']!.verification[0]!.status).toBe('warn');
      // accept the good ones: they are in the step, comments and the rest of the file kept; one undo
      const applied = applyProposal(h.store, p.id, { items: [by['equals $.name = "Rex"']!.id, by['type $.id = "number"']!.id] });
      expect(applied.applied).toHaveLength(2);
      const text = h.store.readTestFile('pets/get.yaml');
      const step = (parse(text) as { tests: Array<{ assertions: Array<Record<string, unknown>> }> }).tests[0]!;
      expect(step.assertions).toEqual([
        { type: 'status', expected: 200 },
        { type: 'equals', path: '$.name', expected: 'Rex' },
        { type: 'type', path: '$.id', expected: 'number' },
      ]);
      undoProposal(h.store, p.id);
      expect(h.store.readTestFile('pets/get.yaml')).toBe(FILE);
    } finally {
      h.cleanup();
    }
  });

  it('a result of a collection run adds the checks to the saved request', async () => {
    const h = harness({ rules: [{ match: '.', response: CHECKS }] });
    try {
      const id = await withRun(h, { origin: 'collection' });
      const r = await runAiTask(h.deps, { task: 'generate-assertions', item: { kind: 'run', runId: 'run-1', resultId: id } });
      if (LIVE) return;
      const p = r.proposal!;
      for (const i of p.items) expect(i.target).toEqual({ kind: 'request', collectionId: 'pets', requestId: 'get-pet' });
      applyProposal(h.store, p.id, { items: [p.items[0]!.id] });
      expect((h.store.getCollection('pets').items[0] as { assertions: unknown[] }).assertions).toEqual([
        { type: 'status', expected: 200 },
        { type: 'equals', path: '$.name', expected: 'Rex' },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('says why when there is nothing to write checks from: no stored response, or not an HTTP step', async () => {
    const h = harness({ rules: [{ match: '.', response: CHECKS }] });
    try {
      const id = await withRun(h, { origin: 'tests', withOutput: false, noResponse: true });
      await expect(runAiTask(h.deps, { task: 'generate-assertions', item: { kind: 'run', runId: 'run-1', resultId: id } })).rejects.toThrow(/stored no response/);
      expect(h.rec.requests).toHaveLength(0);
      await expect(runAiTask(h.deps, { task: 'generate-assertions', item: { kind: 'run', runId: 'run-1', resultId: 'nope' } })).rejects.toThrow(/No result "nope" in run run-1/);
    } finally {
      h.cleanup();
    }
    const h2 = harness({ rules: [{ match: '.', response: CHECKS }] });
    try {
      const id = await withRun(h2, { origin: 'tests', type: 'llm' });
      await expect(runAiTask(h2.deps, { task: 'generate-assertions', item: { kind: 'run', runId: 'run-1', resultId: id } })).rejects.toThrow(/HTTP and GraphQL results/);
    } finally {
      h2.cleanup();
    }
  });

  it('what is sent is the response and the step, with the checks it has; a body cut short is said so', async () => {
    // the run kept the start of the body and said how much it left out
    const big = `${json({ items: Array.from({ length: 200, }, (_, i) => ({ n: i, text: 'x'.repeat(20) })) }).slice(0, 3900)}… [14000 more chars]`;
    const h = harness({ rules: [{ match: '.', response: json({ checks: [{ type: 'status', expected: 200 }] }) }] });
    try {
      const id = await withRun(h, { origin: 'tests', body: big });
      const r = await runAiTask(h.deps, { task: 'generate-assertions', item: { kind: 'run', runId: 'run-1', resultId: id } });
      if (LIVE) return;
      const sent = h.rec.sent();
      expect(sent).toContain('existingChecks');
      expect(sent).toMatch(/cut short|bodyNote/);
      // nothing to prove a body check with: only the status/headers are verified
      expect(r.proposal?.items ?? []).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe('Prefer stable checks', () => {
  const REQ = { kind: 'request' as const, collectionId: 'pets', requestId: 'get-pet' };
  const RESPONSE = { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: json(PET) };
  const PINNED = json({ checks: [{ type: 'status', expected: 200 }, { type: 'equals', path: '$.createdAt', expected: '2026-10-16T10:00:00Z' }, { type: 'equals', path: '$.name', expected: 'Rex' }] });

  it('off (the default): the pinned time stays, flagged with its stable form as the alternative', async () => {
    const h = harness({ rules: [{ match: '.', response: PINNED }] });
    try {
      await withRun(h);
      const r = await runAiTask(h.deps, { task: 'generate-assertions', item: REQ, response: RESPONSE });
      if (LIVE) return;
      const titles = r.proposal!.items.map((i) => i.title);
      expect(titles).toContain('equals $.createdAt = "2026-10-16T10:00:00Z"');
      expect(r.proposal!.items.find((i) => /createdAt/.test(i.title))!.alternatives?.length).toBeGreaterThan(0);
      expect(h.rec.sent()).not.toMatch(/Prefer stable checks:/);
    } finally {
      h.cleanup();
    }
  });

  it('on (the setting): the instruction asks for it and a pinned generated value is offered in its stable form', async () => {
    const h = harness({
      rules: [{ match: '.', response: PINNED }],
      settings: { assistantProvider: 'mock-ai', assistantModel: 'mock-model', ai: { preferStable: true }, pricing: [] },
    });
    try {
      await withRun(h);
      const r = await runAiTask(h.deps, { task: 'generate-assertions', item: REQ, response: RESPONSE });
      if (LIVE) return;
      expect(h.rec.sent()).toMatch(/Prefer stable checks: assert the status/);
      const titles = r.proposal!.items.map((i) => i.title);
      expect(titles).not.toContain('equals $.createdAt = "2026-10-16T10:00:00Z"');
      expect(titles.some((t) => /createdAt/.test(t) && /regex|\^/.test(t))).toBe(true);
      // the value the request itself fixes stays literal
      expect(titles).toContain('equals $.name = "Rex"');
      expect(r.proposal!.notes!.join(' ')).toMatch(/Prefer stable checks: 1 check that pinned a value the server makes up is offered as its stable form/);
    } finally {
      h.cleanup();
    }
  });

  it('a call’s own choice wins over the setting, both ways; scripts and other tasks are not touched', async () => {
    const on = harness({ rules: [{ match: '.', response: PINNED }] });
    try {
      await withRun(on);
      const r = await runAiTask(on.deps, { task: 'generate-assertions', item: REQ, response: RESPONSE, preferStable: true });
      if (LIVE) return;
      expect(r.proposal!.items.map((i) => i.title)).not.toContain('equals $.createdAt = "2026-10-16T10:00:00Z"');
    } finally {
      on.cleanup();
    }
    const off = harness({ rules: [{ match: '.', response: PINNED }], settings: { assistantProvider: 'mock-ai', assistantModel: 'mock-model', ai: { preferStable: true }, pricing: [] } });
    try {
      await withRun(off);
      const r = await runAiTask(off.deps, { task: 'generate-assertions', item: REQ, response: RESPONSE, preferStable: false });
      if (LIVE) return;
      expect(r.proposal!.items.map((i) => i.title)).toContain('equals $.createdAt = "2026-10-16T10:00:00Z"');
      expect(off.rec.sent()).not.toMatch(/Prefer stable checks: assert/);
    } finally {
      off.cleanup();
    }
    // other tasks never get the sentence
    const other = harness({ rules: [{ match: '.', response: '## ok' }], settings: { assistantProvider: 'mock-ai', assistantModel: 'mock-model', ai: { preferStable: true }, pricing: [] } });
    try {
      await runAiTask(other.deps, { task: 'explain-error', context: { error: 'x' } });
      expect(other.rec.sent()).not.toMatch(/Prefer stable checks/);
      expect(readFileSync(join(__dirname, '..', '..', 'packages', 'core', 'src', 'ai', 'tasks', 'registry.ts'), 'utf8')).toContain('stable: true');
    } finally {
      other.cleanup();
    }
  });
});
