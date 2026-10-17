/**
 * Golden cases of TestPion's own AI tasks (AIB-9). With the mock provider (the default, in `npm test`) every answer is
 * scripted: the cases prove the shape of each task's output, its verifiers, the repair loop, truncation, redaction,
 * proposals and the usage ledger. With AI_EVAL_LIVE=1 and TESTPION_AI_PROVIDER / TESTPION_AI_MODEL set, the same
 * cases run against that model (`npx vitest run tests/ai`) and a scorecard is printed; never in CI by default.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AI_TASKS, applyProposal, getProposal, listAiTasks, listProposals, runAiTask, undoProposal, aiUsageSummary, discardProposal } from '../../packages/core/src/index.js';
import { harness, LIVE, LOCAL_MODEL, printScorecard, score } from './harness.js';

const RESPONSE = {
  status: 201,
  headers: [['content-type', 'application/json']] as Array<[string, string]>,
  body: JSON.stringify({ id: 42, name: 'Rex', species: 'dog', createdAt: '2026-10-16T10:00:00Z' }),
  // the time is known (as in the editor and History): a timing test can be proven
  latencyMs: 120,
};

/** Live: at least one item passes its verifier, and every item that does not is unticked with its reason (never offered as if it held). */
const honest = (items: Array<{ selected: boolean; verification: Array<{ verifier: string; status: string; label: string }> }>, verifier: string) =>
  items.some((i) => i.verification.some((b) => b.verifier === verifier && b.status === 'pass')) &&
  items.every((i) => i.verification.every((b) => b.status !== 'fail') || (!i.selected && i.verification.some((b) => b.status === 'fail' && !!b.label)));

const FLOW = `name: Pets CRUD
tests:
  - id: create-pet
    name: Create a pet
    type: http
    method: POST
    url: "{{baseUrl}}/pets"
    body: { type: json, content: '{"name":"Rex"}' }
    extract:
      petId: $.id
    assertions:
      - { type: status, expected: 201 }
  - id: get-pet
    name: Get the pet
    type: http
    method: GET
    url: "{{baseUrl}}/pets/{{petId}}"
    dependsOn: [create-pet]
    assertions:
      - { type: status, expected: 200 }
`;

afterAll(printScorecard);

describe('the task registry', () => {
  it('has every task the app used, each with an instruction, a version and a tier', () => {
    const ids = AI_TASKS.map((t) => t.id);
    for (const id of [
      'explain-error',
      'generate-assertions',
      'generate-test',
      'generate-query',
      'generate-args',
      'generate-mock-data',
      'design-toolset',
      'design-flow',
      'analyze',
      'explain-response',
      'generate-request',
      'generate-pm-tests',
      'explain-api-changes',
      'fix-security',
      'explain-fuzz',
      'fix-openapi-lint',
      'analyze-load',
      'explain-test-failure',
      'suggest-coverage-tests',
      'explain-exchange',
      'explain-timing',
      'explain-test-history',
      'explain-monitor',
      'triage-attention',
      'write-commit-message',
      'free',
    ])
      expect(ids).toContain(id);
    for (const t of AI_TASKS) {
      expect(t.instruction.length).toBeGreaterThan(20);
      expect(t.version).toBeGreaterThanOrEqual(1);
      // TestPion's prompts say tp.*, never pm.* (Postman's)
      expect(t.instruction).not.toMatch(/\bpm\.(test|expect|response)\b/);
    }
    expect(listAiTasks().find((t) => t.id === 'design-flow')).toMatchObject({ tier: 'large', proposes: true, verifiers: ['test-file', 'flow-refs', 'flow-mock'] });
  });
});

describe('golden cases (mock provider unless AI_EVAL_LIVE=1)', () => {
  it('explain-error: prose, recorded in the usage ledger, secrets never sent', async () => {
    const h = harness({ rules: [{ match: 'ECONNREFUSED', response: '## What happened\nThe server refused the connection.' }], secrets: { apiToken: 'tok-very-secret-123456' } });
    try {
      const r = await runAiTask(h.deps, {
        task: 'explain-error',
        context: {
          error: { kind: 'NetworkError', message: 'connect ECONNREFUSED 127.0.0.1:3000' },
          request: { url: 'http://127.0.0.1:3000/x?key=tok-very-secret-123456', headers: [{ key: 'Authorization', value: 'Bearer tok-very-secret-123456' }] },
        },
      });
      const ok = /refused|connection|server/i.test(r.text);
      score('explain-error', 'connection refused', r, ok);
      expect(ok).toBe(true);
      expect(h.rec.sent()).not.toContain('tok-very-secret-123456');
      expect(r.proposal).toBeUndefined();
      const usage = aiUsageSummary(h.store);
      expect(usage.today.calls).toBe(1);
      expect(usage.byTask[0]!.task).toBe('explain-error');
      expect(usage.bySurface[0]!.surface).toBe('cli');
    } finally {
      h.cleanup();
    }
  });

  it('generate-assertions: each check verified against the response; a wrong one is repaired, or shown unticked', async () => {
    const checks = (species: string) =>
      JSON.stringify({
        checks: [
          { type: 'status', expected: 201 },
          { type: 'equals', path: '$.name', expected: 'Rex' },
          { type: 'equals', path: '$.species', expected: species },
          { type: 'exists', path: '$.id' },
        ],
      });
    const wrong = checks('cat');
    const fixed = checks('dog');
    const ctx = { request: { method: 'POST', url: '/pets' }, status: RESPONSE.status, headers: RESPONSE.headers, body: RESPONSE.body };
    const h = harness({ rules: [{ match: '.', responses: [wrong, fixed] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'generate-assertions', context: ctx, response: RESPONSE });
      const items = r.proposal?.items ?? [];
      score('generate-assertions', 'pet response', r, items.length >= 2 && honest(items, 'checks'));
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(items.map((i) => i.selected)).toEqual([true, true, true, true]);
      expect(items[0]!.verification[0]).toMatchObject({ verifier: 'checks', status: 'pass', label: 'passes on the current response' });
    } finally {
      h.cleanup();
    }
    if (LIVE) return;
    // the model keeps the wrong value: the best attempt is shown with the failing check unticked, never hidden
    const h2 = harness({ rules: [{ match: '.', response: wrong }] });
    try {
      const r = await runAiTask(h2.deps, { task: 'generate-assertions', context: ctx, response: RESPONSE });
      expect(r.repairs).toBe(2);
      expect(r.proposal!.items.map((i) => i.selected)).toEqual([true, true, false, true]);
      expect(r.proposal!.items[2]!.verification[0]).toMatchObject({ status: 'fail' });
      expect(r.problems.join(' ')).toMatch(/fails on the current response/);
    } finally {
      h2.cleanup();
    }
  });

  it('design-flow: a flow file, linted, variables checked; applied as a file, then undone', async () => {
    const h = harness({ rules: [{ match: 'create a pet', response: `Here is the flow.\n\n\`\`\`yaml\n${FLOW}\`\`\`` }] });
    try {
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'create a pet then read it back', path: 'ai/pets-crud.yaml' });
      const item = r.proposal?.items[0];
      const ok = !!item && item.verification.some((b) => b.verifier === 'test-file' && b.status !== 'fail');
      score('design-flow', 'create then read', r, ok);
      expect(ok).toBe(true);
      if (LIVE) return;
      expect(item!.verification.map((b) => [b.verifier, b.status])).toEqual([
        ['test-file', 'pass'],
        ['flow-refs', 'pass'],
      ]);
      expect(listProposals(h.store)[0]).toMatchObject({ id: r.proposal!.id, status: 'open', items: 1 });
      const applied = applyProposal(h.store, r.proposal!.id);
      expect(applied.applied[0]).toMatchObject({ kind: 'flow', path: 'ai/pets-crud.yaml' });
      expect(h.store.readTestFile('ai/pets-crud.yaml')).toContain('create-pet');
      expect(getProposal(h.store, r.proposal!.id).status).toBe('applied');
      expect(() => applyProposal(h.store, r.proposal!.id)).toThrow(/applied already/);
      undoProposal(h.store, r.proposal!.id);
      expect(() => h.store.readTestFile('ai/pets-crud.yaml')).toThrow();
    } finally {
      h.cleanup();
    }
  });

  it('design-flow: a lint error is sent back and repaired', async () => {
    const broken = FLOW.replace('dependsOn: [create-pet]', 'dependsOn: [no-such-step]').replace('type: status', 'type: statuss');
    const h = harness({ rules: [{ match: '.', responses: [`\`\`\`yaml\n${broken}\`\`\``, `\`\`\`yaml\n${FLOW}\`\`\``] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'design-flow', question: 'pets' });
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(r.calls).toBe(2);
      expect(r.problems).toEqual([]);
      expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/found problems/);
      expect(r.proposal!.items[0]!.selected).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('design-flow: an answer cut at the output limit fails clearly instead of being used', async () => {
    if (LIVE) return;
    const h = harness({ rules: [{ match: '.', response: '```yaml\nname: x\ntests:\n  - id: a', finishReason: 'length' }] });
    try {
      await expect(runAiTask(h.deps, { task: 'design-flow', question: 'big' })).rejects.toThrow(/cut at the output limit/);
      // the failed call is in the ledger too
      expect(aiUsageSummary(h.store).recent[0]).toMatchObject({ task: 'design-flow', outcome: 'error' });
    } finally {
      h.cleanup();
    }
  });

  it('generate-pm-tests: the script runs once in the sandbox against the response', async () => {
    const script = JSON.stringify({
      tests: [
        { name: 'created', code: 'tp.response.to.have.status(201);' },
        { name: 'has an id', code: "tp.expect(tp.response.json().id).to.be.a('number');" },
      ],
    });
    const h = harness({ rules: [{ match: '.', response: script }] });
    try {
      const r = await runAiTask(h.deps, { task: 'generate-pm-tests', context: { request: { method: 'POST', url: '/pets' }, response: { ...RESPONSE, timeMs: RESPONSE.latencyMs } }, response: RESPONSE });
      const items = r.proposal?.items ?? [];
      // the scripted mock: every test passes; a live model: at least one passes and a failing one is unticked with its reason
      const ok = LIVE ? honest(items, 'script') : items.length > 0 && items.every((i) => i.verification.some((b) => b.verifier === 'script' && b.status === 'pass'));
      score('generate-pm-tests', 'pet response', r, ok);
      expect(ok).toBe(true);
      if (LIVE) return;
      // one item per test, each a self-contained tp.test run on its own
      expect(items.map((i) => i.title)).toEqual(['created', 'has an id']);
      expect(items[0]!.after).toContain(`tp.test("created", () => {`);
      expect(items[0]!.verification[0]!.label).toBe('1/1 tests pass on the current response');
    } finally {
      h.cleanup();
    }
  });

  it('generate-request: structured JSON, repaired when the schema is not met', async () => {
    const h = harness({ rules: [{ match: '.', responses: ['{"name":"List pets"}', '{"name":"List pets","method":"GET","url":"{{baseUrl}}/pets"}'] }] });
    h.vars.set('baseUrl', 'http://localhost:3000', 'environment');
    try {
      const r = await runAiTask(h.deps, { task: 'generate-request', question: 'list all pets' });
      const item = r.proposal?.items[0];
      const ok = !!item && /pets/i.test(JSON.stringify(item.data));
      score('generate-request', 'list pets', r, ok);
      expect(ok).toBe(true);
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(r.value).toMatchObject({ method: 'GET' });
      // variable names go with the context, never their values
      expect(h.rec.sent()).toContain('baseUrl');
      expect(h.rec.sent()).not.toContain('localhost:3000');
    } finally {
      h.cleanup();
    }
  });

  it('generate-args: JSON checked against the tool schema', async () => {
    const h = harness({ rules: [{ match: '.', response: '```json\n{"city":"Paris","days":3}\n```' }] });
    try {
      const schema = { type: 'object', required: ['city'], properties: { city: { type: 'string' }, days: { type: 'number' } } };
      const r = await runAiTask(h.deps, { task: 'generate-args', context: { tool: { name: 'forecast' }, schema } });
      const ok = r.proposal!.items[0]!.verification[0]!.status === 'pass';
      score('generate-args', 'forecast', r, ok);
      expect(ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('dry run: the preview of what would be sent, nothing sent, nothing recorded', async () => {
    const h = harness({ secrets: { pw: 'pa55word-xyz' } });
    try {
      const r = await runAiTask(h.deps, {
        task: 'explain-response',
        privacy: 'metadata',
        context: { request: { method: 'GET', url: 'https://api.example.com/me?token=pa55word-xyz' }, status: 200, body: '{"email":"ann@example.org","plan":"pro"}' },
        dryRun: true,
      });
      expect(r.dryRun).toBe(true);
      expect(h.rec.requests).toHaveLength(0);
      expect(r.preview.privacy).toBe('metadata');
      // the mock / a local model stays on this computer; a cloud model's preview says the data leaves it
      expect(r.preview.local).toBe(LOCAL_MODEL);
      expect(r.preview.estimate.inputTokens).toBeGreaterThan(50);
      // the test harness prices the mock model; a live run has no price table
      if (!LIVE) expect(r.preview.estimate.priceKnown).toBe(true);
      const sent = r.preview.messages!.map((m) => m.content).join('\n');
      expect(sent).not.toContain('pa55word-xyz');
      expect(sent).not.toContain('ann@example.org');
      expect(sent).not.toContain('"pro"');
      expect(aiUsageSummary(h.store).today.calls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('a discarded proposal cannot be applied; its ledger row says discarded', async () => {
    if (LIVE) return;
    const h = harness({ rules: [{ match: '.', response: '{"checks":[{"type":"status","expected":201}]}' }] });
    try {
      const r = await runAiTask(h.deps, { task: 'generate-assertions', context: { status: 201 }, response: RESPONSE });
      discardProposal(h.store, r.proposal!.id);
      expect(() => applyProposal(h.store, r.proposal!.id)).toThrow(/discarded/);
      expect(aiUsageSummary(h.store).recent[0]).toMatchObject({ task: 'generate-assertions', outcome: 'discarded', proposalId: r.proposal!.id });
    } finally {
      h.cleanup();
    }
  });
});
