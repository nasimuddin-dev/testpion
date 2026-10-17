/**
 * The tp.* script API reference (AI-3, prompt tuning after the live finding): read from the sandbox (never a hand list),
 * small enough for every prompt, its example runs, and the static check of a generated script names the right member
 * for the mistakes models make (tp.response.body as JSON, pm.*, Jest style, invented members, a method used as a flag).
 */
import { describe, expect, it } from 'vitest';
import { JEST_TO_CHAI, loadScriptApi, MEMBER_NOTES, SCRIPT_EXAMPLE, scriptApiProblems, scriptReference, scriptReferenceTokens } from '../../packages/core/src/ai/script-reference.js';
import { runScript } from '../../packages/core/src/scripts/sandbox.js';
import { LIVE } from './harness.js';

describe('the script API, read from the sandbox', () => {
  it('lists what tp, tp.response, its assertions and a tp.expect chain really have', async () => {
    const api = await loadScriptApi();
    const names = (l: Array<{ name: string }>) => l.map((m) => m.name);
    expect(names(api.tp)).toEqual(expect.arrayContaining(['test', 'expect', 'response', 'variables', 'environment']));
    const response = Object.fromEntries(api.response.map((m) => [m.name, m]));
    expect(response.json!.kind).toBe('method');
    expect(response.body).toMatchObject({ kind: 'value', type: 'string' });
    expect(response.code).toMatchObject({ kind: 'value', type: 'number' });
    const to = Object.fromEntries(api.responseTo.map((m) => [m.name, m.kind]));
    expect(to).toMatchObject({ status: 'method', jsonBody: 'method', have: 'word', ok: 'flag', success: 'flag', json: 'flag', serverError: 'flag', not: 'modifier' });
    const ex = Object.fromEntries(api.expect.map((m) => [m.name, m.kind]));
    expect(ex).toMatchObject({ to: 'word', be: 'word', not: 'modifier', equal: 'method', a: 'method', property: 'method', ok: 'flag', true: 'flag', exist: 'flag', lengthOf: 'modifier' });
  });

  it('every Jest alias the sandbox accepts has its chai form, and every note names a real member', async () => {
    const api = await loadScriptApi();
    const jest = api.expect.filter((m) => /^to[A-Z]/.test(m.name)).map((m) => m.name);
    expect(jest.length).toBeGreaterThan(5);
    expect(jest.filter((n) => !JEST_TO_CHAI[n])).toEqual([]);
    for (const [obj, notes] of Object.entries(MEMBER_NOTES))
      for (const k of Object.keys(notes))
        expect(
          api[obj as 'response'].some((m) => m.name === k),
          `${obj}.${k}`,
        ).toBe(true);
  });

  it('the reference is small, never names pm.* or Jest style, and its example passes in the sandbox', async () => {
    const api = await loadScriptApi();
    const text = scriptReference(api);
    expect(scriptReferenceTokens(api)).toBeLessThanOrEqual(520);
    expect(text).not.toMatch(/\bpm\.|postman\.|toBeTruthy|toEqual/);
    expect(text).toMatch(/json\(\) \(the parsed body\)/);
    expect(text).toMatch(/body \(the raw text, a string\)/);
    const out = await runScript(SCRIPT_EXAMPLE, { variables: {}, response: { status: 200, headers: [], body: '{"id":7,"name":"Rex"}' } }, { maxRequests: 0 });
    expect(out.error).toBeUndefined();
    expect(out.tests).toEqual([{ name: 'returns the pet', passed: true }]);
    expect(scriptApiProblems(SCRIPT_EXAMPLE, api)).toEqual([]);
  });
});

describe('scriptApiProblems: each mistake with what to write instead', () => {
  const check = async (code: string) => scriptApiProblems(code, await loadScriptApi()).join('\n');

  it('a field read from the raw text', async () => {
    expect(await check('tp.test("id", () => { tp.expect(tp.response.body.id).to.exist; });')).toMatch(/tp\.response\.body is the response text.*tp\.response\.json\(\)\.id/);
    // the text's own members are fine
    expect(await check('tp.test("t", () => { tp.expect(tp.response.body.length).to.be.above(0); tp.expect(tp.response.body.includes("x")).to.be.ok; });')).toBe('');
  });

  it("Postman's names, with the tp.* member", async () => {
    expect(await check('pm.test("s", () => { const j = pm.response.json(); pm.expect(j.id).to.exist; });')).toMatch(
      /pm\.response\.json\(\) is Postman's name: TestPion scripts use tp\.response\.json\(\)/,
    );
    expect(await check('postman.setNextRequest("x")')).toMatch(/tp\.execution\.setNextRequest/);
  });

  it('Jest style and the bare global', async () => {
    const p = await check('tp.test("ok", () => { expect(tp.response.json().id).toBeTruthy(); });');
    expect(p).toMatch(/write tp\.expect\(value\)/);
    expect(await check('tp.test("ok", () => { tp.expect(tp.response.json().id).toBeTruthy(); });')).toMatch(/toBeTruthy\(\) is Jest style.*to\.be\.ok/);
  });

  it('invented members with the closest real one, and methods used as flags (and back)', async () => {
    expect(await check('tp.response.to.have.statusCode(200)')).toMatch(/did you mean status\(\)/);
    expect(await check('tp.expect(1).to.be.a.number')).toMatch(/a is a method: call it/);
    expect(await check('tp.response.to.be.ok()')).toMatch(/ok is a flag, not a method/);
    expect(await check('tp.response.jsonBody()')).toMatch(/did you mean tp\.response\.json\(\)/);
    expect(await check('tp.responce.code')).toMatch(/tp\.responce is not part.*did you mean tp\.response/);
    expect(await check('const t = tp.response.headers.get("content-type"); tp.expect(t).to.include("json"); tp.expect([1]).to.have.lengthOf.at.least(1);')).toBe('');
  });
});

describe('generate-tests: the prompt carries the reference, and a misuse is repaired by naming the right member', () => {
  const NOW = { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: JSON.stringify({ id: 7, name: 'Rex' }) };
  const PETS = {
    schemaVersion: '1.0',
    id: 'pets',
    name: 'Pets',
    version: 1,
    variables: [],
    updatedAt: '2026-10-16T00:00:00Z',
    items: [{ kind: 'http', id: 'get-pet', name: 'Get pet', request: { method: 'GET', url: '{{baseUrl}}/pets/7' } }],
  };
  const REQ = { kind: 'request' as const, collectionId: 'pets', requestId: 'get-pet' };
  const answer = (code: string) => JSON.stringify({ tests: [{ name: 'the pet', code }] });
  const GOOD = answer('tp.response.to.have.status(200);\nconst json = tp.response.json();\ntp.expect(json.id).to.be.a("number");');

  for (const [mistake, code, named] of [
    ['a field of the raw text', 'tp.expect(tp.response.body.id).to.exist;', /tp\.response\.json\(\)\.id/],
    ["Postman's pm.response.json()", 'const json = pm.response.json(); pm.expect(json.id).to.be.a("number");', /use tp\.response\.json\(\)/],
    ['Jest style on the bare expect', 'expect(tp.response.json().id).toBeTruthy();', /write tp\.expect\(value\)/],
    ['Jest style on tp.expect', 'tp.expect(tp.response.json().id).toBeTruthy();', /toBeTruthy\(\) is Jest style.*to\.be\.ok/],
    ['an invented assertion', 'tp.response.to.have.statusCode(200);', /did you mean status\(\)/],
  ] as const)
    // scripted answers: the mock's case (a live model makes its own mistakes, scored by the golden cases)
    it.skipIf(LIVE)(`${mistake}: one repair, and the repair turn names the right member`, async () => {
      const { harness } = await import('./harness.js');
      const { runAiTask } = await import('../../packages/core/src/index.js');
      const h = harness({ rules: [{ match: '.', responses: [answer(code), GOOD] }] });
      h.store.saveCollection(structuredClone(PETS) as never);
      try {
        const r = await runAiTask(h.deps, { task: 'generate-tests', item: REQ, response: NOW });
        expect(r.taskVersion).toBe(4);
        // the reference, read from the sandbox, is in the system prompt
        expect(h.rec.requests[0]!.messages[0]!.content).toMatch(/TestPion script API \(read from the sandbox/);
        expect(r.repairs).toBe(1);
        expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(named);
        expect(r.proposal!.items.map((i) => [i.title, i.selected])).toEqual([['the pet', true]]);
      } finally {
        h.cleanup();
      }
    });
});
