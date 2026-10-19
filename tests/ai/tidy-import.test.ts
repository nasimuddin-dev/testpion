/**
 * AI-10 golden cases (mock provider unless AI_EVAL_LIVE=1): "Tidy this import". TestPion finds the hosts, tokens, noise,
 * duplicates and the chains a saved example confirms without a model; the model names and groups. Every change is
 * verified: the result is a valid collection and every request that remains sends exactly what it sent before (variables
 * resolved). Nothing is applied before the person agrees, and applying is one undo step.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyProposal,
  applyTidyOps,
  chainScript,
  collectionProblems,
  draftGroups,
  draftTidyProposal,
  flatRequests,
  idCandidates,
  importHar,
  runAiTask,
  sendDifferences,
  undoProposal,
  verifyItems,
  type Collection,
  type ProposalItem,
  type TidyOp,
} from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { IMPORTED, TIDY_PLAN, TOKEN } from './tidy-fixtures.js';

afterAll(printScorecard);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ref = { kind: 'collection' as const, collectionId: 'imp' };
const find = (c: Collection, id: string) => flatRequests(c).find((r) => r.node.id === id)!;

describe('what TestPion finds without a model', () => {
  it('hosts, a repeated token, tracking and static requests, duplicates, an id a saved response returns', () => {
    const { groups, candidates } = draftGroups(IMPORTED);
    const by = (k: string) => groups.filter((g) => g.kind === k);
    expect(groups.map((g) => g.kind)).toEqual(['drop', 'dedupe', 'names', 'host', 'token', 'chain']);
    expect(by('drop')[0]!.ops).toEqual([{ op: 'drop', id: 'r-ga' }, { op: 'drop', id: 'r-js' }]);
    expect(by('drop')[0]!.reason).toContain('google-analytics.com');
    // the duplicate GET keeps the first
    expect(by('dedupe')[0]!.ops).toEqual([{ op: 'drop', id: 'r-get2' }]);
    // a request named by its URL gets METHOD /path
    expect(by('names')[0]!.ops).toEqual([{ op: 'rename', id: 'r-create', name: 'POST /orders' }]);
    expect(by('host')[0]!.ops).toEqual([{ op: 'host', origin: 'https://api.shop.example.com', variable: 'baseUrl' }]);
    expect(by('token')[0]!.ops).toEqual([{ op: 'token', variable: 'token', value: TOKEN, header: 'Authorization', prefix: 'Bearer ' }]);
    // the id the first response returns, confirmed by its saved example
    expect(by('chain')[0]!.ops).toEqual([{ op: 'chain', variable: 'orderId', from: 'r-create', to: ['r-get', 'r-delete'], path: '$.id', literal: 'ord-77' }]);
    expect(by('chain')[0]!.evidence).toMatchObject({ confirmed: true, example: 'Captured 201' });
    // the id nothing returns is a candidate without evidence
    expect(candidates.find((k) => k.literal === 'u-5')).toMatchObject({ usedBy: ['r-user'], suggestedVariable: 'userId' });
    expect(candidates.find((k) => k.literal === 'u-5')!.found).toBeUndefined();
    expect(idCandidates(flatRequests(IMPORTED)).map((k) => k.literal)).toContain('ord-77');
  });

  it('the operations, applied, leave every remaining request sending what it sent', () => {
    const { groups } = draftGroups(IMPORTED);
    const ops = groups.flatMap((g) => g.ops);
    const after = applyTidyOps(IMPORTED, ops);
    const dropped = new Set(ops.flatMap((o) => (o.op === 'drop' ? [o.id] : [])));
    expect(collectionProblems(after)).toEqual([]);
    expect(sendDifferences(IMPORTED, after, dropped)).toEqual([]);
    expect(flatRequests(after).map((r) => r.node.id)).toEqual(['r-create', 'r-get', 'r-delete', 'r-users', 'r-user']);
    expect(Object.fromEntries(after.variables.map((v) => [v.key, v.value]))).toEqual({ baseUrl: 'https://api.shop.example.com', token: TOKEN, orderId: 'ord-77' });
    const get = find(after, 'r-get').node;
    expect(get.kind === 'http' && get.request.url).toBe('{{baseUrl}}/orders/{{orderId}}');
    expect(get.kind === 'http' && get.request.headers).toEqual([{ key: 'Authorization', value: 'Bearer {{token}}' }]);
    // the earlier request passes the id on with a tp.* script, never pm.*
    const create = find(after, 'r-create').node;
    expect(create.testScript).toContain("tp.variables.set('orderId', String(orderIdValue))");
    expect(create.testScript).toContain('tp.response.json()?.id');
    expect(create.testScript).not.toMatch(/\bpm\./);
    expect(chainScript('orderId', '$.data.items[0].id')).toContain('?.data?.items?.[0]?.id');
    // the original is untouched
    expect(IMPORTED.variables).toEqual([]);
  });

  it('sendDifferences names a request that would send something else, or vanish', () => {
    const after = applyTidyOps(IMPORTED, [{ op: 'host', origin: 'https://api.shop.example.com', variable: 'baseUrl' }]);
    const tampered = clone(after);
    (find(tampered, 'r-users').node as { request: { url: string } }).request.url = '{{baseUrl}}/accounts';
    expect(sendDifferences(IMPORTED, tampered, new Set())).toEqual(['"GET /users" would send something different (url)']);
    tampered.items = tampered.items.filter((n) => n.id !== 'r-user');
    expect(sendDifferences(IMPORTED, tampered, new Set())).toContain('"GET /users/u-5" is gone and was not dropped on purpose');
    expect(sendDifferences(IMPORTED, tampered, new Set(['r-user'])).some((x) => x.includes('u-5'))).toBe(false);
    // a variable whose value is not the origin it replaced would change the URL
    const wrong = clone(after);
    wrong.variables = [{ key: 'baseUrl', value: 'https://elsewhere.example.com' }];
    expect(sendDifferences(IMPORTED, wrong, new Set()).length).toBeGreaterThan(0);
  });

  it('refuses an operation that cannot be applied', () => {
    expect(() => applyTidyOps(IMPORTED, [{ op: 'rename', id: 'nope', name: 'x' }])).toThrow(/no longer in/);
    expect(() => applyTidyOps({ ...clone(IMPORTED), variables: [{ key: 'baseUrl', value: 'other' }] }, [{ op: 'host', origin: 'https://api.shop.example.com', variable: 'baseUrl' }])).toThrow(/already has another value/);
    expect(() => applyTidyOps(IMPORTED, [{ op: 'chain', variable: 'x', from: 'r-create', to: ['r-get'], path: '$..id', literal: 'ord-77' }])).toThrow(/plain keys/);
  });

  it('moves requests into folders and removes the folders it empties', () => {
    const c = clone(IMPORTED);
    c.items = [{ kind: 'folder', id: 'f-old', name: 'Old', items: [c.items[0]!] } as never, ...c.items.slice(1)];
    const after = applyTidyOps(c, [{ op: 'move', id: 'r-create', folder: ['Orders'] }]);
    expect(after.items.some((n) => n.id === 'f-old')).toBe(false);
    expect(after.items.find((n) => n.kind === 'folder')).toMatchObject({ name: 'Orders', items: [{ id: 'r-create' }] });
  });

  it('a HAR import keeps the recorded response as a saved example, so a tidy can confirm a chain', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          { request: { method: 'POST', url: 'https://api.x.test/orders', headers: [] }, response: { status: 201, content: { mimeType: 'application/json', text: '{"id":"o-9"}' } } },
          { request: { method: 'GET', url: 'https://api.x.test/orders/o-9', headers: [] }, response: { status: 200, content: { mimeType: 'image/png', encoding: 'base64', text: 'AAAA' } } },
        ],
      },
    });
    const c = importHar(har).collection;
    const [a, b] = c.items as Array<{ examples?: Array<{ status: number; body: string }> }>;
    expect(a!.examples).toMatchObject([{ status: 201, body: '{"id":"o-9"}' }]);
    expect(b!.examples).toBeUndefined();
    expect(draftGroups(c).groups.find((g) => g.kind === 'chain')!.ops[0]).toMatchObject({ variable: 'orderId', path: '$.id', literal: 'o-9' });
  });
});

describe('the verifier', () => {
  it('passes a change that keeps what is sent; fails one that does not; unticks a chain nothing confirms', async () => {
    const h = harness();
    try {
      h.store.saveCollection(clone(IMPORTED));
      const mk = (ops: TidyOp[], group: string, extra: object = {}): ProposalItem => ({ id: 'i1', kind: 'collection', title: 't', after: '', verification: [], selected: true, data: { collectionId: 'imp', ops, group, ...extra } });
      const good = mk([{ op: 'host', origin: 'https://api.shop.example.com', variable: 'baseUrl' }], 'host');
      const bad = mk([{ op: 'rename', id: 'missing', name: 'x' }], 'names');
      // a hand-edited proposal: a drop that is not listed would be caught, a chain whose literal the example does not return is not confirmed
      const chain = mk([{ op: 'chain', variable: 'userId', from: 'r-users', to: ['r-user'], path: '$.items[0].id', literal: 'u-5' }], 'chain');
      const confirmed = mk([{ op: 'chain', variable: 'orderId', from: 'r-create', to: ['r-get'], path: '$.id', literal: 'ord-77' }], 'chain', { evidence: { confirmed: true, example: 'Captured 201' } });
      const wrongPath = mk([{ op: 'chain', variable: 'orderId', from: 'r-create', to: ['r-get'], path: '$.item', literal: 'ord-77' }], 'chain');
      const optIn = mk([{ op: 'drop', id: 'r-users' }], 'drop', { optIn: true });
      await verifyItems([good, bad, chain, confirmed, wrongPath, optIn], ['tidy-import'], { store: h.store });
      expect(good.verification[0]).toMatchObject({ status: 'pass', label: expect.stringContaining('send exactly what they sent') });
      expect(good.selected).toBe(true);
      expect(bad.verification[0]).toMatchObject({ status: 'fail', label: expect.stringContaining('cannot be applied') });
      expect(bad.selected).toBe(false);
      expect(chain.selected).toBe(false);
      expect(chain.verification.map((b) => b.status)).toEqual(['warn', 'pass']);
      expect(confirmed.selected).toBe(true);
      expect(confirmed.verification.map((b) => b.label)).toEqual([expect.stringContaining('the script sets orderId = ord-77'), expect.stringContaining('send exactly')]);
      // $.item reads nothing: the script sets no variable, so the chain is not confirmed
      expect(wrongPath.selected).toBe(false);
      expect(wrongPath.verification[0]!.status).toBe('warn');
      expect(optIn.selected).toBe(false);
      expect(optIn.verification[0]!.label).toContain('opt in');
    } finally {
      h.cleanup();
    }
  });
});

describe('tidy-import task', () => {
  it('finds TestPion’s changes, adds the model’s names, folders, a variable name and chains; drops what is invented; opt-in for what is not confirmed', async () => {
    const h = harness({ rules: [{ match: '.', response: TIDY_PLAN }], secrets: {} });
    try {
      h.store.saveCollection(clone(IMPORTED));
      const r = await runAiTask(h.deps, { task: 'tidy-import', item: ref });
      const p = r.proposal!;
      score('tidy-import', 'har import', r, !!p && p.items.every((i) => i.verification.every((b) => b.status !== 'fail')));
      if (LIVE) return;
      expect(r.repairs).toBe(0);
      const title = (k: string) => p.items.filter((i) => (i.data as { group: string }).group === k);
      expect(p.items.every((i) => i.kind === 'collection')).toBe(true);
      expect(p.items.every((i) => i.verification.some((b) => b.verifier === 'tidy-import' && b.status !== 'fail'))).toBe(true);
      // names and folders: the model's, over TestPion's
      const names = title('names')[0]!;
      expect((names.data as { ops: TidyOp[] }).ops).toEqual(
        expect.arrayContaining([
          { op: 'rename', id: 'r-create', name: 'Create order' },
          { op: 'move', id: 'r-create', folder: ['Orders'] },
          { op: 'rename', id: 'r-users', name: 'List users' },
        ]),
      );
      expect(names.before).toContain('https://api.shop.example.com/orders');
      expect(names.after).toContain('Orders / Create order');
      // the model’s variable name for the host
      expect((title('host')[0]!.data as { ops: TidyOp[] }).ops).toEqual([{ op: 'host', origin: 'https://api.shop.example.com', variable: 'apiUrl' }]);
      // the confirmed chain is TestPion's own, named by the model; the unconfirmed one is the model's and opt-in
      const chains = title('chain');
      expect(chains.map((c) => (c.data as { ops: Array<{ variable: string }> }).ops[0]!.variable).sort()).toEqual(['orderId', 'userId']);
      const user = chains.find((c) => (c.data as { ops: Array<{ variable: string }> }).ops[0]!.variable === 'userId')!;
      expect(user.selected).toBe(false);
      expect(chains.find((c) => c !== user)!.selected).toBe(true);
      // the model’s extra drop is opt-in; its analytics drop was TestPion's already
      const drops = title('drop');
      expect(drops.map((d) => [(d.data as { ops: TidyOp[] }).ops.map((o) => (o as { id: string }).id), d.selected])).toEqual([[['r-ga', 'r-js'], true], [['r-users'], false]]);
      const notes = (p.notes ?? []).join('\n');
      expect(notes).toContain('Skipped a name for "r-ghost"');
      expect(notes).toContain('"$..id" is not a path of plain keys');
      expect(notes).toContain('Skipped dropping "r-missing"');
      expect(p.assumptions).toEqual(['The order id is returned by Create order in $.id']);
      // nothing sensitive was sent: the token is typed into headers, which the context does not include
      expect(h.rec.sent()).not.toContain(TOKEN);
      expect(h.rec.sent()).toContain('"origin": "https://api.shop.example.com"');
      // nothing changed until the person agrees
      expect(h.store.getCollection('imp').variables).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('applies the ticked changes in one go, the unticked stay, and Undo puts the collection back exactly', async () => {
    const h = harness({ rules: [{ match: '.', response: TIDY_PLAN }] });
    try {
      h.store.saveCollection(clone(IMPORTED));
      const before = h.store.getCollection('imp');
      const p = (await runAiTask(h.deps, { task: 'tidy-import', item: ref })).proposal!;
      const res = applyProposal(h.store, p.id);
      expect(res.skipped).toEqual([]);
      expect(res.applied.length).toBe(p.items.filter((i) => i.selected).length);
      const after = h.store.getCollection('imp');
      const ids = flatRequests(after).map((r) => r.node.id);
      // dropped: analytics, the static file, the duplicate; kept: users (the model's drop was opt-in)
      expect(ids.sort()).toEqual(['r-create', 'r-delete', 'r-get', 'r-user', 'r-users']);
      expect(after.variables.map((v) => v.key).sort()).toEqual(['apiUrl', 'orderId', 'token']);
      expect(after.items.map((n) => n.name)).toEqual(['GET /users/u-5', 'Orders', 'Users']);
      const get = flatRequests(after).find((r) => r.node.id === 'r-get')!.node;
      expect(get.kind === 'http' && get.request.url).toBe('{{apiUrl}}/orders/{{orderId}}');
      // every remaining request sends what it sent
      expect(sendDifferences(before, after, new Set(['r-ga', 'r-js', 'r-get2']))).toEqual([]);
      undoProposal(h.store, p.id);
      const restored = h.store.getCollection('imp');
      expect({ ...restored, version: 0, updatedAt: '' }).toEqual({ ...before, version: 0, updatedAt: '' });
    } finally {
      h.cleanup();
    }
  });

  it('a change that no longer applies is skipped with the reason, the others apply', async () => {
    const h = harness({ rules: [{ match: '.', response: TIDY_PLAN }] });
    try {
      h.store.saveCollection(clone(IMPORTED));
      const p = (await runAiTask(h.deps, { task: 'tidy-import', item: ref })).proposal!;
      // the person deleted a request meanwhile
      const c = h.store.getCollection('imp');
      c.items = c.items.filter((n) => n.id !== 'r-delete');
      h.store.saveCollection(c);
      const res = applyProposal(h.store, p.id);
      expect(res.skipped.length).toBeGreaterThan(0);
      expect(res.skipped.every((s) => /no longer in/.test(s.reason))).toBe(true);
      expect(res.applied.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('options.flow adds a flow over the tidied requests; an invented step is dropped', async () => {
    const plan = JSON.parse(TIDY_PLAN) as Record<string, unknown>;
    plan.flow = {
      name: 'Order lifecycle',
      steps: [
        { id: 'create', request: 'r-create', extract: { orderId: '$.id' }, assertions: [{ type: 'status', expected: 201 }] },
        { id: 'read', request: 'r-get', dependsOn: ['create'], assertions: [{ type: 'status', expected: 200 }] },
        { id: 'ghost', request: 'r-nope' },
      ],
    };
    const h = harness({ rules: [{ match: '.', response: JSON.stringify(plan) }] });
    try {
      h.store.saveCollection(clone(IMPORTED));
      const p = (await runAiTask(h.deps, { task: 'tidy-import', item: ref, context: { options: { flow: true } } })).proposal!;
      const flow = p.items.find((i) => i.kind === 'flow')!;
      expect(flow.path).toBe('flows/har-import-2026-10-19-tidied.yaml');
      expect(flow.after).toContain('url: "{{apiUrl}}/orders/{{orderId}}"');
      expect(flow.after).not.toContain('r-nope');
      expect(flow.verification.map((b) => b.verifier)).toEqual(['test-file', 'flow-vars']);
      expect(flow.verification.every((b) => b.status !== 'fail')).toBe(true);
      expect((p.notes ?? []).join('\n')).toContain('r-nope');
      // without the option the plan's flow is ignored
      const none = (await runAiTask(h.deps, { task: 'tidy-import', item: ref })).proposal!;
      expect(none.items.some((i) => i.kind === 'flow')).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('draft proposal without a model; a collection with nothing to tidy says so', async () => {
    const h = harness();
    try {
      h.store.saveCollection(clone(IMPORTED));
      const p = await draftTidyProposal(h.store, ref, { surface: 'cli' });
      expect(p).toMatchObject({ task: 'tidy-import', taskVersion: 0, model: expect.stringContaining('no AI') });
      expect(p.items.length).toBe(6);
      expect(p.items.every((i) => i.verification.every((b) => b.status !== 'fail'))).toBe(true);
      h.store.saveCollection({ ...clone(IMPORTED), id: 'clean', name: 'Clean', variables: [], items: [{ kind: 'http', id: 'a', name: 'List things', request: { method: 'GET', url: '{{baseUrl}}/things' } }] } as never);
      await expect(draftTidyProposal(h.store, { kind: 'collection', collectionId: 'clean' }, { surface: 'cli' })).rejects.toThrow(/nothing TestPion can tidy/);
      await expect(runAiTask(h.deps, { task: 'tidy-import', item: { kind: 'request', collectionId: 'imp', requestId: 'r-get' } })).rejects.toThrow(/as a collection/);
    } finally {
      h.cleanup();
    }
  });
});
