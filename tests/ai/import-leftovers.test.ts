/**
 * AI-10b golden cases (mock provider unless AI_EVAL_LIVE=1): "Fix what the import left". TestPion finds the scripts with a
 * TODO(import) marker itself; the model rewrites them with tp.*; every rewrite is checked statically, run in the sandbox
 * against the request's saved example (else a stand-in) and refused when it throws; nothing is applied before the person agrees.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyProposal, convertScript, findLeftovers, importDocument, runAiTask, undoProposal, type Collection, type SavedHttpRequest } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';

afterAll(printScorecard);

/** A Postman collection whose scripts use APIs TestPion has no equivalent for (so the import leaves TODO(import) lines). */
const POSTMAN = JSON.stringify({
  info: { name: 'Leftovers', _postman_id: 'lo-1', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'List pets',
      request: { method: 'GET', url: 'https://api.test/pets' },
      event: [
        { listen: 'test', script: { exec: ["const rows = pm.datasets.query('select * from pets');", "pm.test('has rows', () => pm.expect(rows.length).to.be.above(0));", "pm.test('ok', () => pm.response.to.have.status(200));"] } },
      ],
      response: [{ name: 'Two pets', code: 200, status: 'OK', header: [{ key: 'Content-Type', value: 'application/json' }], body: '[{"id":1},{"id":2}]' }],
    },
    { name: 'Health', request: { method: 'GET', url: 'https://api.test/health' }, event: [{ listen: 'test', script: { exec: ["pm.test('up', () => pm.response.to.have.status(200));"] } }] },
  ],
});

const FIXED = "const rows = tp.response.json();\ntp.test('has rows', () => tp.expect(rows.length).to.be.above(0));\ntp.test('ok', () => tp.response.to.have.status(200));";
const answer = (script: string, id = 's1') => JSON.stringify({ summary: 'Read the rows from the response instead of a dataset query.', scripts: [{ id, script, explanation: 'The dataset query became a read of the response body.' }], assumptions: ['The pets list is the response body'] });

function workspaceWith(h: ReturnType<typeof harness>): Collection {
  const doc = importDocument(POSTMAN).document;
  return h.store.saveCollection(doc.collections[0]!);
}

describe('what TestPion finds without a model', () => {
  it('the scripts the converter marked, and only those', () => {
    const c = importDocument(POSTMAN).document.collections[0]!;
    const found = findLeftovers(c);
    expect(found.map((f) => `${f.node.name}:${f.phase}`)).toEqual(['List pets:test']);
    expect(found[0]!.script).toContain('TODO(import)');
    expect(convertScript(found[0]!.script, 'postman').status).toBe('unchanged');
  });
});

describe('import-leftovers task', () => {
  it('rewrites the marked script, verified in the sandbox on the saved example; applying is one undo step', async () => {
    const h = harness({ rules: [{ match: '.', response: answer(FIXED) }] });
    try {
      const c = workspaceWith(h);
      const r = await runAiTask(h.deps, { task: 'import-leftovers', item: { kind: 'collection', collectionId: c.id } });
      const p = r.proposal!;
      score('import-leftovers', 'postman datasets', r, p.items[0]!.verification.every((b) => b.status !== 'fail'));
      if (LIVE) return;
      expect(r.repairs).toBe(0);
      expect(p.items).toHaveLength(1);
      const item = p.items[0]!;
      expect(item).toMatchObject({ kind: 'script', title: 'List pets: post-response script', language: 'javascript', data: { phase: 'test', mode: 'replace' }, target: { kind: 'request', collectionId: c.id } });
      expect(item.before).toContain('TODO(import)');
      expect(item.after).not.toContain('TODO(import)');
      expect(item.verification[0]).toMatchObject({ verifier: 'import-leftovers', status: 'pass' });
      expect(item.verification[0]!.label).toContain('on the saved response');
      expect(item.selected).toBe(true);
      // the model saw the marker line, the saved response and the reference, not a secret
      const sent = h.rec.sent();
      expect(sent).toContain('pm.datasets');
      expect(sent).toContain('[{\\"id\\":1},{\\"id\\":2}]');
      expect(sent).toContain('TestPion script API');
      expect(p.summary).toContain('instead of a dataset query');
      // accept it
      applyProposal(h.store, p.id);
      const after = h.store.getCollection(c.id).items.find((n) => n.name === 'List pets') as SavedHttpRequest;
      expect(after.testScript).toBe(item.after);
      // and take it back
      undoProposal(h.store, p.id);
      const back = h.store.getCollection(c.id).items.find((n) => n.name === 'List pets') as SavedHttpRequest;
      expect(back.testScript).toContain('TODO(import)');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a rewrite that still uses another tool\'s API, one that throws, and an id it was not given', async () => {
    const pm = "const rows = pm.response.json();\npm.test('x', () => pm.expect(rows).to.be.an('array'));";
    const throws = 'const rows = missing.value;\ntp.test("x", () => tp.expect(rows).to.exist);';
    const h = harness({ rules: [{ match: '.', responses: [answer(pm), answer(throws), answer(FIXED, 's9')] }] });
    try {
      const c = workspaceWith(h);
      const r = await runAiTask(h.deps, { task: 'import-leftovers', item: { kind: 'collection', collectionId: c.id } });
      if (LIVE) return;
      // the first answer used pm.*: the repair turn was told, the second threw: told again, the third named an id that is not there
      expect(r.repairs).toBeGreaterThanOrEqual(1);
      const second = h.rec.requests[1]!.messages.map((m) => m.content).join('\n');
      expect(second).toMatch(/pm\.|tp\.\*/);
      const items = r.proposal?.items ?? [];
      // nothing ready is offered for a script that fails: it is unticked
      for (const i of items) if (i.verification.some((b) => b.status === 'fail')) expect(i.selected).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('keeps a marker honestly: a rewrite that still has the TODO line is a warning, not a pass', async () => {
    const kept = "// TODO(import): pm.datasets has no TestPion equivalent: query it another way\nconst rows = [];\ntp.test('ok', () => tp.response.to.have.status(200));";
    const h = harness({ rules: [{ match: '.', response: answer(kept) }] });
    try {
      const c = workspaceWith(h);
      const r = await runAiTask(h.deps, { task: 'import-leftovers', item: { kind: 'collection', collectionId: c.id } });
      if (LIVE) return;
      expect(r.proposal!.items[0]!.verification[0]).toMatchObject({ verifier: 'import-leftovers', status: 'warn', label: 'still has a TODO(import) line' });
    } finally {
      h.cleanup();
    }
  });

  it('a collection with nothing marked has nothing to fix, and says so', async () => {
    const h = harness({ rules: [{ match: '.', response: answer(FIXED) }] });
    try {
      const doc = importDocument(JSON.stringify({ info: { name: 'Clean', _postman_id: 'c', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'A', request: { method: 'GET', url: 'https://a.test' } }] })).document;
      const c = h.store.saveCollection(doc.collections[0]!);
      await expect(runAiTask(h.deps, { task: 'import-leftovers', item: { kind: 'collection', collectionId: c.id } })).rejects.toThrow(/Nothing in Clean is marked TODO\(import\)/);
    } finally {
      h.cleanup();
    }
  });

  it('is listed with its alias', async () => {
    const { listAiTasks } = await import('../../packages/core/src/index.js');
    const t = listAiTasks().find((x) => x.id === 'import-leftovers');
    expect(t).toBeTruthy();
  });
});
