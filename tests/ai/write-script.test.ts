/**
 * AI-6 · Write a tp.* script with the mock model: the description becomes a pre-request or post-response script that is
 * parsed and run in the sandbox before it is offered (what it did is the badge), pm.* names and members that do not
 * exist are named with the right ones and repaired, a script that throws is repaired, a test that fails on the response
 * it was written for is not offered as ready; "fix" sends the error and the logs with the script.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyProposal, runAiTask, undoProposal, type Collection } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';

afterAll(printScorecard);

const answer = (script: string, extra: Record<string, unknown> = {}) => JSON.stringify({ script, explanation: 'Does what was asked.', assumptions: ['The token is in a variable'], ...extra });
const REQUEST = { method: 'GET', url: 'https://api.test/pets', headers: [{ key: 'Accept', value: 'application/json' }] };
const PRE = "const nonce = tp.uuid();\ntp.variables.set('nonce', nonce);\ntp.request.headers.upsert({ key: 'X-Nonce', value: nonce });";
const RESPONSE = { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: JSON.stringify({ id: 7, name: 'Rex', token: 'abc' }), latencyMs: 30 };

describe('write-script task', () => {
  it('a pre-request script is run on the request it is for; the badge says what it did', async () => {
    const h = harness({ rules: [{ match: '.', response: answer(PRE) }] });
    try {
      const r = await runAiTask(h.deps, { task: 'write-script', question: 'send a fresh nonce in an X-Nonce header and keep it in a variable', context: { phase: 'pre', request: REQUEST } });
      const p = r.proposal!;
      score('write-script', 'pre-request nonce', r, p.items[0]!.verification[0]!.status === 'pass');
      if (LIVE) return;
      expect(r.repairs).toBe(0);
      const item = p.items[0]!;
      expect(item).toMatchObject({ kind: 'script', title: 'Pre-request script', language: 'javascript', data: { phase: 'pre', mode: 'replace' } });
      expect(item.after).toContain('// AI-generated script');
      expect(item.after).toContain("tp.request.headers.upsert({ key: 'X-Nonce'");
      expect(item.verification).toEqual([{ verifier: 'script-dry-run', status: 'pass', label: 'parsed · ran in the sandbox: sets nonce; adds the X-Nonce header' }]);
      expect(p.summary).toBe('Does what was asked.');
      expect(p.assumptions).toEqual(['The token is in a variable']);
      // the tp.* reference was in the system prompt, and the request in the context
      const sent = h.rec.sent();
      expect(sent).toContain('TestPion script API');
      expect(sent).toContain('https://api.test/pets');
    } finally {
      h.cleanup();
    }
  });

  it('pm.* names and invented members are repaired with the right ones', async () => {
    const pm = "pm.environment.set('nonce', pm.variables.replaceIn('{{$guid}}'));";
    const h = harness({ rules: [{ match: '.', responses: [answer(pm), answer(PRE)] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'write-script', question: 'set a nonce', context: { phase: 'pre', request: REQUEST } });
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(r.proposal!.items[0]!.verification[0]!.status).toBe('pass');
      // what the repair turn was told
      const second = h.rec.requests[1]!.messages.map((m) => m.content).join('\n');
      expect(second).toMatch(/pm\.environment\.set\(\) is Postman's name: TestPion scripts use tp\.environment\.set\(\)/);
    } finally {
      h.cleanup();
    }
  });

  it('a script that throws is repaired; async code the synchronous sandbox cannot run is refused', async () => {
    const throws = 'const x = missing.value;\ntp.variables.set("x", x);';
    const asyncy = "const r = await fetch('https://x.test');\ntp.variables.set('x', r.status);";
    const ok = "tp.variables.set('x', 1);";
    const h = harness({ rules: [{ match: '.', responses: [answer(throws), answer(asyncy), answer(ok)] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'write-script', question: 'set x', context: { phase: 'pre', request: REQUEST } });
      if (LIVE) return;
      expect(r.repairs).toBe(2);
      expect(r.proposal!.items[0]!.after).toContain("tp.variables.set('x', 1);");
      const told = h.rec.requests.map((q) => q.messages.map((m) => m.content).join('\n'));
      expect(told[1]).toMatch(/the script throws — .*missing/s);
      expect(told[2]).toMatch(/uses something the sandbox does not have/);
    } finally {
      h.cleanup();
    }
  });

  it('a post-response script is run on the response on screen: a test that fails there is not offered as ready', async () => {
    const good = "tp.test('has an id', () => {\n  const json = tp.response.json();\n  tp.expect(json.id).to.be.a('number');\n});\ntp.variables.set('petId', tp.response.json().id);";
    const bad = "tp.test('is created', () => tp.response.to.have.status(201));";
    const h = harness({ rules: [{ match: '.', responses: [answer(bad), answer(good)] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'write-script', question: 'check there is an id and keep it', context: { phase: 'test', request: REQUEST }, response: RESPONSE });
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      const item = r.proposal!.items[0]!;
      expect(item.title).toBe('Post-response script');
      expect(item.verification[0]).toMatchObject({ status: 'pass', label: 'parsed · ran in the sandbox: sets petId; runs 1 test' });
      expect(h.rec.requests[1]!.messages.map((m) => m.content).join('\n')).toMatch(/1 of 1 tests fail on the response — is created: .*201/s);
    } finally {
      h.cleanup();
    }
  });

  it('a test that passes on this response but failed on the one before it pins a value that changes', async () => {
    const pinned = "tp.test('has the token', () => tp.expect(tp.response.json().token).to.equal('abc'));";
    const stable = "tp.test('has a token', () => tp.expect(tp.response.json().token).to.be.a('string'));";
    const h = harness({ rules: [{ match: '.', responses: [answer(pinned), answer(stable)] }] });
    try {
      const previous = { ...RESPONSE, body: JSON.stringify({ id: 6, name: 'Max', token: 'xyz' }) };
      const r = await runAiTask(h.deps, { task: 'write-script', question: 'check the token', context: { phase: 'test', request: REQUEST }, response: RESPONSE, previous });
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(r.proposal!.items[0]!.after).toContain("to.be.a('string')");
      expect(h.rec.requests[1]!.messages.map((m) => m.content).join('\n')).toMatch(/passes now but failed on the previous response/);
    } finally {
      h.cleanup();
    }
  });

  it('fix: the script on screen, its error and its logs are what the model gets (secrets masked)', async () => {
    const h = harness({ rules: [{ match: '.', response: answer("tp.variables.set('token', tp.response.json().token);") }], secrets: { apiKey: 'sk-live-ZZZ-4242-secretvalue' } });
    try {
      const broken = "tp.variables.set('token', tp.response.body.token);";
      const r = await runAiTask(h.deps, {
        task: 'write-script',
        question: 'fix this script',
        context: { phase: 'test', script: broken, error: "TypeError: cannot read property 'token' of undefined at line 1", logs: ['key sk-live-ZZZ-4242-secretvalue'], request: REQUEST },
        response: RESPONSE,
      });
      if (LIVE) return;
      const sent = h.rec.sent();
      expect(sent).toContain('tp.response.body.token');
      expect(sent).toContain('cannot read property');
      expect(sent).not.toContain('sk-live-ZZZ-4242-secretvalue');
      const item = r.proposal!.items[0]!;
      expect(item.before).toBe(broken);
      expect(item.verification[0]!.status).toBe('pass');
    } finally {
      h.cleanup();
    }
  });

  it('for a saved request: its request and latest response are the context, Accept adds the script (append) and Undo takes it back', async () => {
    const h = harness({ rules: [{ match: '.', response: answer("tp.test('ok', () => tp.response.to.have.status(200));") }] });
    try {
      const c: Collection = {
        schemaVersion: '1.0',
        id: 'pets',
        name: 'Pets',
        version: 1,
        variables: [],
        updatedAt: '2026-10-19T00:00:00Z',
        items: [{ kind: 'http', id: 'r1', name: 'List pets', request: { method: 'GET', url: 'https://api.test/pets' }, testScript: "tp.test('exists', () => tp.expect(1).to.equal(1));" }],
      } as unknown as Collection;
      h.store.saveCollection(c);
      const r = await runAiTask(h.deps, { task: 'write-script', item: { kind: 'request', collectionId: 'pets', requestId: 'r1' }, question: 'check the status', context: { phase: 'test', mode: 'append' }, response: RESPONSE });
      if (LIVE) return;
      const item = r.proposal!.items[0]!;
      expect(item.target).toEqual({ kind: 'request', collectionId: 'pets', requestId: 'r1' });
      expect(item.before).toContain("tp.test('exists'");
      applyProposal(h.store, r.proposal!.id);
      const saved = h.store.getCollection('pets').items[0] as { testScript?: string };
      expect(saved.testScript).toContain("tp.test('exists'");
      expect(saved.testScript).toContain("tp.test('ok'");
      undoProposal(h.store, r.proposal!.id);
      expect((h.store.getCollection('pets').items[0] as { testScript?: string }).testScript).toBe("tp.test('exists', () => tp.expect(1).to.equal(1));");
    } finally {
      h.cleanup();
    }
  });

  it('explain-script is prose with the script reference', async () => {
    const h = harness({ rules: [{ match: '.', response: '## What it does\nIt sets a nonce.' }] });
    try {
      const r = await runAiTask(h.deps, { task: 'explain-script', context: { phase: 'pre', script: PRE } });
      if (LIVE) return;
      expect(r.text).toContain('sets a nonce');
      expect(r.proposal).toBeUndefined();
      expect(h.rec.sent()).toContain('TestPion script API');
    } finally {
      h.cleanup();
    }
  });
});
