/**
 * AI-2 · Failed-run triage with the mock model: deterministic grouping (no model), the evidence (the failing check as
 * written, the last passing run and what changed), fixes verified before they are offered (a stale value updated, a fix
 * that still fails or accepts anything refused and repaired, a check that follows an API change said so), one cause for
 * many failures (an expired token), a bug report for an API that regressed, a variable fix (never a secret), a test-file
 * patch with undo, privacy (secrets never sent; metadata sends no body values) and a 500-failure run within its budget.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  appendTriageToReports,
  applyProposal,
  deterministicFindings,
  endpointTemplate,
  runAiTask,
  runEvidence,
  staleCheckUpdate,
  triageMarkdown,
  triageRun,
  undoProposal,
  verifyCheckChange,
  type Collection,
  type TestResult,
} from '../../packages/core/src/index.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { addRun, httpResult } from './run-fixtures.js';

afterAll(printScorecard);

const API = 'http://127.0.0.1:4010';
const HEALTH: Collection = {
  schemaVersion: '1.0',
  id: 'svc',
  name: 'Service',
  version: 1,
  variables: [],
  updatedAt: '2026-10-16T00:00:00Z',
  items: [
    {
      kind: 'http',
      id: 'health',
      name: 'Health',
      request: { method: 'GET', url: `${API}/health` },
      assertions: [
        { type: 'status', expected: 200 },
        { type: 'equals', path: '$.status', expected: 'up' },
      ],
    },
    { kind: 'http', id: 'orders', name: 'Orders', request: { method: 'GET', url: `${API}/orders` }, assertions: [{ type: 'status', expected: 200 }] },
  ],
} as unknown as Collection;
const ORIGIN = { kind: 'collection' as const, collectionId: 'svc' };

const passedHealth = (body = { status: 'up' }) =>
  httpResult({
    id: 'health@1',
    name: 'Health',
    url: `${API}/health`,
    status: 200,
    body,
    checks: [
      { type: 'status', name: 'status', passed: true },
      { type: 'equals', name: 'equals $.status', passed: true },
    ],
  });
const failedHealth = (body: unknown = { status: 'ok', time: '2026-10-16T10:00:00Z' }) =>
  httpResult({
    id: 'health@1',
    name: 'Health',
    url: `${API}/health`,
    status: 200,
    body,
    checks: [
      { type: 'status', name: 'status', passed: true },
      { type: 'equals', name: 'equals $.status', passed: false, message: 'expected "up", got "ok"', expected: 'up', actual: 'ok' },
    ],
  });

const answer = (v: unknown) => JSON.stringify(v);
const staleFix = (newCheck: unknown) =>
  answer({
    summary: 'The health endpoint now says ok.',
    causes: [
      {
        groups: ['g1'],
        kind: 'stale-test',
        title: 'Health answers "ok" now',
        explanation: 'The last passing run had "up"; now "ok".',
        confidence: 0.8,
        evidence: ['$.status changed'],
        fix: { type: 'check', check: { type: 'equals', path: '$.status', expected: 'up' }, newCheck },
      },
    ],
  });

async function staleWorkspace(rules: Parameters<typeof harness>[0]['rules']) {
  const h = harness({ rules });
  h.store.saveCollection(structuredClone(HEALTH));
  await addRun(h.store, { id: 'run-a', startedAt: '2026-10-15T10:00:00.000Z', origin: ORIGIN, results: [passedHealth()] });
  await addRun(h.store, { id: 'run-b', startedAt: '2026-10-16T10:00:00.000Z', origin: ORIGIN, results: [failedHealth()] });
  return h;
}

describe('grouping and evidence without a model', () => {
  it('endpoints are templated: ids, numbers and hashes become {id}, the query goes', () => {
    expect(endpointTemplate('get', 'http://api.test/orders/123/items/9f8e7d6c5b4a3f2e1d0c?x=1')).toBe('GET api.test/orders/{id}/items/{id}');
    expect(endpointTemplate('POST', '{{baseUrl}}/users/550e8400-e29b-41d4-a716-446655440000')).toBe('POST {{baseUrl}}/users/{id}');
  });

  it('the same failed check, status and endpoint is one group; its evidence has the check as written and what changed since the last pass', async () => {
    const h = await staleWorkspace([]);
    try {
      const ev = await runEvidence(h.store, 'last');
      expect(ev.runId).toBe('run-b');
      expect(ev.groups).toHaveLength(1);
      const g = ev.groups[0]!;
      expect(g).toMatchObject({ id: 'g1', count: 1, signature: 'equals $.status · 200 · GET 127.0.0.1:4010/health' });
      expect(g.samples[0]!.failedAssertions).toEqual([{ index: 1, check: { type: 'equals', path: '$.status', expected: 'up' } }]);
      expect(g.samples[0]!.refs).toEqual([
        { kind: 'run', runId: 'run-b', resultId: 'health@1' },
        { kind: 'request', collectionId: 'svc', requestId: 'health' },
      ]);
      expect(g.lastPassing?.runId).toBe('run-a');
      expect(g.lastPassing?.changed?.body.map((c) => `${c.path} ${c.kind}`)).toEqual(expect.arrayContaining(['$.status changed', '$.time added']));
      const [f] = deterministicFindings(ev);
      expect(f).toMatchObject({ kind: 'stale-test', count: 1, groups: ['g1'] });
    } finally {
      h.cleanup();
    }
  });

  it('headers are compared only when both results stored them: a passing result without them adds no "header … added"', async () => {
    const h = harness({ rules: [] });
    try {
      h.store.saveCollection(structuredClone(HEALTH));
      // the failing result kept its trace (status, headers, body); the passing one kept only its body
      const at = Date.parse('2026-10-16T10:00:00.000Z');
      const span = { spanId: 's1', name: 'GET /health', kind: 'http', startTime: at, endTime: at + 5, status: 'ok', output: { status: 200, headers: [['content-type', 'application/json'], ['connection', 'keep-alive']], body: JSON.stringify({ status: 'ok' }) } };
      h.store.saveTrace({ traceId: 'tr-fail', name: 'Health', startTime: at, endTime: at + 5, status: 'error', spans: [span] } as never, 'test', 'run-b');
      await addRun(h.store, { id: 'run-a', startedAt: '2026-10-15T10:00:00.000Z', origin: ORIGIN, results: [passedHealth()] });
      await addRun(h.store, { id: 'run-b', startedAt: '2026-10-16T10:00:00.000Z', origin: ORIGIN, results: [{ ...failedHealth({ status: 'ok' }), traceId: 'tr-fail' }] });
      const ev = await runEvidence(h.store, 'last');
      const changed = ev.groups[0]!.lastPassing!.changed!;
      expect(changed.headers).toEqual([]);
      expect(changed.headersNotStored).toBe('passing');
      expect(changed.body.map((c) => `${c.path} ${c.kind}`)).toEqual(['$.status changed']);
      const md = triageMarkdown(await triageRun(h.deps, { runId: 'last', noAi: true }));
      expect(md).not.toMatch(/header (content-type|connection) added/);
      expect(md).toContain('$.status changed; headers not stored for the passing run');
      // said once per sentence, never per header
      for (const line of md.split('\n')) expect(line.split('headers not stored').length).toBeLessThanOrEqual(2);
    } finally {
      h.cleanup();
    }
  });

  it('twelve 401s on four endpoints are four groups and one cause (auth) without a model', async () => {
    const h = harness();
    h.store.saveCollection(structuredClone(HEALTH));
    const results: TestResult[] = [];
    for (const ep of ['orders', 'users', 'pets', 'invoices'])
      for (let i = 1; i <= 3; i++)
        results.push(
          httpResult({
            id: `${ep}@${i}`,
            name: ep,
            url: `${API}/${ep}/${i}`,
            status: 401,
            body: { error: 'token expired' },
            checks: [{ type: 'status', name: 'status', passed: false, message: 'expected status 200, got 401' }],
          }),
        );
    await addRun(h.store, { id: 'run-auth', startedAt: '2026-10-16T11:00:00.000Z', origin: ORIGIN, results });
    try {
      const ev = await runEvidence(h.store, 'run-auth');
      expect(ev.groups.map((g) => [g.count, g.hint])).toEqual([
        [3, 'auth'],
        [3, 'auth'],
        [3, 'auth'],
        [3, 'auth'],
      ]);
      const f = deterministicFindings(ev);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ kind: 'auth', count: 12 });
      expect(f[0]!.resultIds).toHaveLength(12);
    } finally {
      h.cleanup();
    }
  });
});

describe('fixes are verified before they are offered', () => {
  const FAILING = { status: 200, headers: [] as Array<[string, string]>, body: '{"status":"ok"}' };
  const BEFORE = { status: 200, headers: [] as Array<[string, string]>, body: '{"status":"up"}' };
  it('a check that still fails, one that accepts anything, one that follows an API change, a stable one', async () => {
    const cases = [{ resultId: 'r', failing: FAILING, lastPassing: BEFORE }];
    expect((await verifyCheckChange({ type: 'equals', path: '$.status', expected: 'fine' }, cases)).status).toBe('fail');
    expect(await verifyCheckChange({ type: 'exists', path: '$' }, cases)).toMatchObject({ status: 'fail', label: 'accepts any response' });
    expect(await verifyCheckChange({ type: 'equals', path: '$.status', expected: 'ok' }, cases)).toMatchObject({ status: 'warn', label: expect.stringMatching(/follows an API change/) });
    expect(await verifyCheckChange({ type: 'type', path: '$.status', expected: 'string' }, cases)).toMatchObject({
      status: 'pass',
      label: 'passes on the failing response and on the last passing one',
    });
    expect((await verifyCheckChange({ type: 'type', path: '$.status', expected: 'string' }, [{ resultId: 'r' }])).status).toBe('skip');
    // a check type the runner does not have: the repair turn gets the right shape and the allowed types
    expect(await verifyCheckChange({ type: 'equal-to', path: '$.status', expected: 'ok' }, cases)).toMatchObject({ status: 'fail', detail: expect.stringMatching(/Types for a response: .*equals/) });
  });

  it('a stale expected value: the model updates the check, a fix that accepts anything goes back once, apply and undo', async () => {
    const h = await staleWorkspace([{ match: '.', responses: [staleFix({ type: 'exists', path: '$' }), staleFix({ type: 'equals', path: '$.status', expected: 'ok' })] }]);
    try {
      const r = await runAiTask(h.deps, { task: 'triage-run', item: { kind: 'run', runId: 'last' } });
      // live: the cause is found and at least one change verifies (pass, or warn: it follows the API change)
      score(
        'triage-run',
        'stale expected value',
        r,
        !!r.proposal?.items.some((i) => i.kind !== 'text' && i.verification.length > 0 && i.verification.every((b) => b.status === 'pass' || b.status === 'warn')),
      );
      if (LIVE) return;
      expect(r.repairs).toBe(1);
      expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/accepts any response/);
      const p = r.proposal!;
      expect(p.findings![0]).toMatchObject({ id: 'c1', kind: 'stale-test', confidence: 0.8, count: 1, groups: ['g1'] });
      expect(p.findings![0]!.evidence.map((e) => e.text).join('\n')).toMatch(/Last passed in run run-a/);
      const [item] = p.items;
      expect(item).toMatchObject({ kind: 'assertion', finding: 'c1', title: 'Health: equals $.status = "up" → equals $.status = "ok"', selected: true });
      expect(item!.verification[0]).toMatchObject({ verifier: 'fix', status: 'warn' });
      applyProposal(h.store, p.id);
      const node = h.store.getCollection('svc').items[0] as { assertions: unknown[] };
      expect(node.assertions).toEqual([
        { type: 'status', expected: 200 },
        { type: 'equals', path: '$.status', expected: 'ok' },
      ]);
      undoProposal(h.store, p.id);
      expect((h.store.getCollection('svc').items[0] as { assertions: unknown[] }).assertions[1]).toEqual({ type: 'equals', path: '$.status', expected: 'up' });
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('a fix that still fails after the repairs is shown unticked with its reason, never hidden', async () => {
    const h = await staleWorkspace([{ match: '.', response: staleFix({ type: 'equals', path: '$.status', expected: 'fine' }) }]);
    try {
      const r = await runAiTask(h.deps, { task: 'triage-run', item: { kind: 'run', runId: 'run-b' } });
      if (LIVE) return;
      expect(r.repairs).toBe(2);
      expect(r.proposal!.items[0]).toMatchObject({ selected: false, verification: [{ status: 'fail', label: 'still fails on the failing response' }] });
      expect(r.proposal!.problems?.[0]).toMatch(/still fails/);
    } finally {
      h.cleanup();
    }
  });
});

describe('causes the model merges, explanations without a change, variables', () => {
  it.skipIf(LIVE)('one expired token behind four endpoints: one cause, what to do, no change to the tests', async () => {
    const results: TestResult[] = [];
    for (const ep of ['orders', 'users', 'pets', 'invoices'])
      results.push(httpResult({ id: `${ep}@1`, name: ep, url: `${API}/${ep}`, status: 401, body: { error: 'expired' }, checks: [{ type: 'status', name: 'status', passed: false }] }));
    const h = harness({
      rules: [
        {
          match: '"groups"',
          response: answer({
            causes: [
              {
                groups: ['g1', 'g2', 'g3', 'g4'],
                kind: 'auth',
                title: 'The token expired',
                explanation: 'Every request got 401.',
                confidence: 0.9,
                fix: { type: 'none', note: 'Renew the token in the environment, then run again.' },
              },
            ],
          }),
        },
      ],
    });
    h.store.saveCollection(structuredClone(HEALTH));
    await addRun(h.store, { id: 'run-401', startedAt: '2026-10-16T12:00:00.000Z', origin: ORIGIN, results });
    try {
      const t = await triageRun(h.deps, { runId: 'run-401' });
      if (LIVE) return;
      expect(t.ai).toBe(true);
      expect(t.findings).toHaveLength(1);
      expect(t.findings[0]).toMatchObject({ kind: 'auth', count: 4, groups: ['g1', 'g2', 'g3', 'g4'] });
      expect(t.proposal!.items).toEqual([expect.objectContaining({ kind: 'text', title: 'What to do: The token expired' })]);
      const md = triageMarkdown(t);
      expect(md).toMatch(/### The token expired/);
      expect(md).toMatch(/\*\*auth\*\* · 4 failures · 90% sure/);
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('an API that regressed (200 → 500): a bug report with the evidence, verified by the change since the last pass', async () => {
    const h = harness({
      rules: [
        {
          match: '"groups"',
          response: answer({ causes: [{ groups: ['g1'], kind: 'api-regression', title: 'Health fails with 500', explanation: 'It passed yesterday.', confidence: 0.7, fix: { type: 'none' } }] }),
        },
      ],
    });
    h.store.saveCollection(structuredClone(HEALTH));
    await addRun(h.store, { id: 'run-1', startedAt: '2026-10-15T10:00:00.000Z', origin: ORIGIN, results: [passedHealth()] });
    await addRun(h.store, {
      id: 'run-2',
      startedAt: '2026-10-16T10:00:00.000Z',
      origin: ORIGIN,
      results: [
        httpResult({
          id: 'health@1',
          name: 'Health',
          url: `${API}/health?key=sk-live-abcdefabcdefabcdef1234`,
          status: 500,
          body: { error: 'boom' },
          checks: [{ type: 'status', name: 'status', passed: false, message: 'expected status 200, got 500' }],
        }),
      ],
    });
    try {
      const t = await triageRun(h.deps, { runId: 'last' });
      if (LIVE) return;
      const report = t.proposal!.items[0]!;
      expect(report).toMatchObject({ kind: 'text', title: 'Bug report: Health fails with 500', language: 'markdown' });
      expect(report.after).toMatch(/\*\*Last passed:\*\* run run-1/);
      expect(report.after).toMatch(/status 200 → 500/);
      expect(report.after).not.toMatch(/sk-live-abcdef/);
      expect(report.verification[0]).toMatchObject({ status: 'pass', label: expect.stringMatching(/the response changed since the last passing run: status 200 → 500/) });
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('a variable the steps could not resolve is set in the run environment; a secret one is refused', async () => {
    const results = [
      httpResult({ id: 'orders@1', name: 'Orders', url: '{{baseUrl}}/orders', status: 0, error: { kind: 'ValidationError', message: 'Invalid URL {{baseUrl}}/orders' }, unresolved: ['baseUrl'] }),
    ];
    const fix = (name: string, value: string) =>
      answer({ causes: [{ groups: ['g1'], kind: 'environment', title: 'baseUrl is not set', explanation: 'unresolved', confidence: 0.95, fix: { type: 'variable', name, value } }] });
    const h = harness({ rules: [{ match: '.', responses: [fix('apiToken', 'abc123secretvalue'), fix('baseUrl', API), fix('baseUrl', API)] }] });
    h.store.saveCollection(structuredClone(HEALTH));
    h.store.saveEnvironment({ id: 'dev', name: 'dev', variables: [] } as never);
    await addRun(h.store, { id: 'run-v', startedAt: '2026-10-16T13:00:00.000Z', origin: ORIGIN, environment: 'dev', results });
    try {
      const t = await triageRun(h.deps, { runId: 'run-v' });
      if (LIVE) return;
      expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/looks like a secret/);
      const item = t.proposal!.items[0]!;
      expect(item).toMatchObject({ kind: 'variable', title: 'Set {{baseUrl}} in dev', before: 'baseUrl: (not set)', after: `baseUrl: ${API}`, selected: true });
      expect(item.verification[0]).toMatchObject({ status: 'pass', label: expect.stringMatching(/resolves \{\{baseUrl\}\}/) });
      applyProposal(h.store, t.proposal!.id);
      expect(h.store.listEnvironments().find((e) => e.name === 'dev')!.variables).toEqual([expect.objectContaining({ key: 'baseUrl', value: API })]);
      undoProposal(h.store, t.proposal!.id);
      expect(h.store.listEnvironments().find((e) => e.name === 'dev')!.variables).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe('a test file: the patch is a diff, lints, and is refused when the file changed since', () => {
  it.skipIf(LIVE)('updates the step check in place (comments kept), and refuses to overwrite a changed file', async () => {
    const FILE =
      '# smoke checks\nname: Smoke\ntests:\n  - id: health\n    name: Health\n    url: http://127.0.0.1:4010/health\n    assertions:\n      - { type: status, expected: 200 }\n      - { type: equals, path: $.status, expected: up }\n';
    const h = harness({ rules: [{ match: '"groups"', response: staleFix({ type: 'equals', path: '$.status', expected: 'ok' }) }] });
    h.store.writeTestFile('smoke/health.yaml', FILE);
    const file = join(h.store.path('tests'), 'smoke', 'health.yaml');
    const r = (passed: boolean) => ({
      ...(passed ? passedHealth() : failedHealth()),
      id: 'health',
      file,
    });
    await addRun(h.store, { id: 'run-f1', startedAt: '2026-10-15T10:00:00.000Z', origin: { kind: 'tests', paths: ['smoke/health.yaml'] }, results: [r(true)] });
    await addRun(h.store, { id: 'run-f2', startedAt: '2026-10-16T10:00:00.000Z', origin: { kind: 'tests', paths: ['smoke/health.yaml'] }, results: [r(false)] });
    try {
      const t = await triageRun(h.deps, { runId: 'run-f2' });
      if (LIVE) return;
      const item = t.proposal!.items[0]!;
      expect(item).toMatchObject({ kind: 'file', path: 'smoke/health.yaml', title: 'tests/smoke/health.yaml: equals $.status = "up" → equals $.status = "ok"' });
      expect(item.after).toMatch(/^# smoke checks/);
      expect(item.after).toMatch(/expected: ok/);
      expect(item.verification[0]!.status).toBe('warn');
      // the file changed after the proposal was made: nothing is overwritten
      h.store.writeTestFile('smoke/health.yaml', FILE.replace('Smoke', 'Smoke (edited)'));
      expect(() => applyProposal(h.store, t.proposal!.id)).toThrow(/changed since the proposal was made/);
      expect(h.store.readTestFile('smoke/health.yaml')).toMatch(/Smoke \(edited\)/);
    } finally {
      h.cleanup();
    }
  });
});

describe('privacy and size', () => {
  const SECRET = 'sk-live-TRIAGE-0123456789abcdef';
  const PII = 'jane.doe@example.org';

  it.skipIf(LIVE)('secrets are never sent; at metadata, no body values and no failure messages', async () => {
    const h = harness({ secrets: { apiKey: SECRET }, rules: [{ match: '"groups"', response: answer({ causes: [] }) }] });
    h.store.saveCollection(structuredClone(HEALTH));
    await addRun(h.store, {
      id: 'run-p',
      startedAt: '2026-10-16T10:00:00.000Z',
      origin: ORIGIN,
      results: [
        httpResult({
          id: 'health@1',
          name: 'Health',
          url: `${API}/health?api_key=${SECRET}`,
          status: 200,
          body: { status: 'down', owner: PII, token: SECRET },
          checks: [{ type: 'equals', name: 'equals $.status', passed: false, message: `expected "up", got "down" (${PII})`, actual: 'down' }],
        }),
      ],
    });
    try {
      await triageRun(h.deps, { runId: 'run-p' });
      await triageRun(h.deps, { runId: 'run-p', privacy: 'metadata' });
      await triageRun(h.deps, { runId: 'run-p', privacy: 'names' });
      if (LIVE) return;
      const sent = h.rec.requests.map((r) => r.messages.map((m) => m.content).join('\n'));
      expect(sent).toHaveLength(3);
      // at every privacy level: never the secret, nor the PII the redactor masks
      for (const text of sent) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(PII);
      }
      const [full, meta, names] = sent;
      expect(names).not.toContain('"down"');
      expect(full).not.toContain(SECRET);
      expect(full).not.toContain(PII);
      expect(full).toContain('down');
      expect(meta).not.toContain(SECRET);
      expect(meta).not.toContain('"down"');
      expect(meta).not.toContain('got');
      expect(meta).toContain('equals $.status');
    } finally {
      h.cleanup();
    }
  });

  it('a run with 500 failures over 60 endpoints: 40 groups sent (the rest counted), within the context budget', async () => {
    const h = harness({ rules: [{ match: '"groups"', response: answer({ causes: [{ groups: ['g1'], kind: 'unknown', title: 'x', explanation: 'x', confidence: 0.3, fix: { type: 'none' } }] }) }] });
    h.store.saveCollection(structuredClone(HEALTH));
    const results: TestResult[] = [];
    for (let i = 0; i < 500; i++) {
      const ep = `res${i % 60}`;
      results.push(
        httpResult({
          id: `${ep}@${i}`,
          name: ep,
          url: `${API}/${ep}/items/${i}`,
          status: 500,
          body: { error: 'x'.repeat(2000), i },
          checks: [{ type: 'status', name: 'status', passed: false, message: 'expected status 200, got 500' }],
        }),
      );
    }
    await addRun(h.store, { id: 'run-500', startedAt: '2026-10-16T10:00:00.000Z', origin: ORIGIN, results });
    try {
      const dry = await triageRun(h.deps, { runId: 'run-500', dryRun: true });
      expect(dry.failures).toBe(500);
      expect(dry.groups).toHaveLength(40);
      expect(dry.omitted.groups).toBe(20);
      expect(dry.preview!.context.tokens).toBeLessThanOrEqual(10_000);
      expect(dry.preview!.estimate.inputTokens).toBeLessThanOrEqual(13_000);
      if (LIVE) return;
      const t = await triageRun(h.deps, { runId: 'run-500' });
      expect(t.findings.filter((f) => f.id.startsWith('d'))).toHaveLength(39);
      expect(t.proposal!.notes?.join(' ')).toMatch(/20 more groups/);
    } finally {
      h.cleanup();
    }
  });
});

describe('without a model, and in reports', () => {
  it('no model set up: the grouping is the answer, with why; reports get the section', async () => {
    const h = await staleWorkspace([]);
    try {
      // no model, whatever the environment says (a live run sets TESTPION_AI_*)
      const t = await triageRun({ ...h.deps, settings: { pricing: [] }, env: {} }, { runId: 'last' });
      expect(t.ai).toBe(false);
      expect(t.fallback).toMatch(/No AI model is set up/);
      expect(t.findings[0]!.kind).toBe('stale-test');
      const dir = h.store.runDir('run-b');
      const paths = { junit: join(dir, 'junit.xml'), html: join(dir, 'report.html'), markdown: join(dir, 'report.md') };
      writeFileSync(paths.junit, '<testsuites>\n  <testsuite name="x">\n  </testsuite>\n</testsuites>\n');
      writeFileSync(paths.html, '<html><body><p class="muted">Generated by TestPion</p></body></html>');
      writeFileSync(paths.markdown, '# x\n');
      expect(appendTriageToReports(paths, t)).toHaveLength(3);
      expect(readFileSync(paths.junit, 'utf8')).toMatch(/<system-out><!\[CDATA\[## Triage/);
      expect(readFileSync(paths.html, 'utf8')).toMatch(/<section id="triage">/);
      expect(existsSync(paths.markdown) && readFileSync(paths.markdown, 'utf8')).toMatch(/## Triage\n/);
    } finally {
      h.cleanup();
    }
  });
});

describe('fixes that cannot mismatch, TestPion’s own update of a stale value, and repairs that say why', () => {
  const editFix = answer({
    causes: [{ groups: ['g1'], kind: 'stale-test', title: 'Health answers "ok" now', explanation: 'was up', confidence: 0.9, fix: { type: 'edit', find: 'expected: up', replace: 'expected: ok' } }],
  });
  const refFix = (replacement: unknown) =>
    answer({
      causes: [
        { groups: ['g1'], kind: 'stale-test', title: 'Health answers "ok" now', explanation: 'was up', confidence: 0.9, fix: { type: 'check', result: 'health@1', checkIndex: 1, replacement } },
      ],
    });

  it.skipIf(LIVE)('the live finding: an edit whose text is not there goes back naming the check by result and checkIndex; the answer that names it recovers in one repair', async () => {
    const h = await staleWorkspace([{ match: '.', responses: [editFix, refFix({ type: 'equals', path: '$.status', expected: 'ok' })] }]);
    try {
      const r = await runAiTask(h.deps, { task: 'triage-run', item: { kind: 'run', runId: 'last' } });
      expect(r.taskVersion).toBe(2);
      // the evidence numbers the failing checks, so a fix can name one
      expect(h.rec.requests[0]!.messages.at(-1)!.content).toMatch(/"checkIndex": 1/);
      expect(r.repairs).toBe(1);
      const repair = h.rec.requests[1]!.messages.at(-1)!.content;
      expect(repair).toMatch(/the text to change is not in "Health"/);
      expect(repair).toMatch(/result "health@1" checkIndex 1 \(equals \$\.status = "up"\)/);
      const [item] = r.proposal!.items;
      expect(item).toMatchObject({ kind: 'assertion', title: 'Health: equals $.status = "up" → equals $.status = "ok"', selected: true });
      expect(item!.data).toMatchObject({ replace: { index: 1 } });
      expect(r.proposal!.problems).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('a model that never makes a usable fix: TestPion’s own update of the stale value stands in (verified, flagged), never an empty proposal', async () => {
    const h = await staleWorkspace([{ match: '.', response: editFix }]);
    try {
      const r = await runAiTask(h.deps, { task: 'triage-run', item: { kind: 'run', runId: 'last' } });
      expect(r.repairs).toBe(2);
      const p = r.proposal!;
      expect(p.items).toHaveLength(1);
      expect(p.items[0]).toMatchObject({ kind: 'assertion', finding: 'c1', title: 'Health: equals $.status = "up" → equals $.status = "ok" (TestPion: the value the API answers now)' });
      expect(p.items[0]!.verification[0]).toMatchObject({ verifier: 'fix', status: 'warn', label: expect.stringMatching(/follows an API change/) });
      expect(p.notes?.join(' ')).toMatch(/TestPion's own update of the stale value is offered instead/);
      expect(p.problems?.[0]).toMatch(/no change could be made/);
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('a stale test the model gives no change for gets TestPion’s update; a different model check gets it as an alternative', async () => {
    const none = answer({ causes: [{ groups: ['g1'], kind: 'stale-test', title: 'Stale', explanation: 'x', confidence: 0.6, fix: { type: 'none', note: 'update the check' } }] });
    const h = await staleWorkspace([{ match: '.', responses: [none] }]);
    try {
      const r = await runAiTask(h.deps, { task: 'triage-run', item: { kind: 'run', runId: 'last' } });
      expect(r.proposal!.items.map((i) => i.title)).toEqual(['Health: equals $.status = "up" → equals $.status = "ok" (TestPion: the value the API answers now)']);
    } finally {
      h.cleanup();
    }
    const h2 = await staleWorkspace([{ match: '.', responses: [refFix({ type: 'type', path: '$.status', expected: 'string' })] }]);
    try {
      const r = await runAiTask(h2.deps, { task: 'triage-run', item: { kind: 'run', runId: 'last' } });
      const [item] = r.proposal!.items;
      expect(item!.title).toBe('Health: equals $.status = "up" → type $.status = "string"');
      expect(item!.alternatives?.map((a) => a.label)).toEqual(['TestPion: equals $.status = "ok"']);
    } finally {
      h2.cleanup();
    }
  });

  it('staleCheckUpdate: the value the API answers now, its stable form for a made-up value, nothing for an error or a check that never held', () => {
    const ok = { status: 200, headers: [] as Array<[string, string]>, body: '{"status":"ok","id":"9f1c2b7e-1d2c-4b3a-8f00-123456789abc"}' };
    expect(staleCheckUpdate({ type: 'equals', path: '$.status', expected: 'up' }, ok)).toEqual({ type: 'equals', path: '$.status', expected: 'ok' });
    expect(staleCheckUpdate({ type: 'equals', path: '$.id', expected: 'x' }, ok)).toMatchObject({ type: 'regex', path: '$.id' });
    expect(staleCheckUpdate({ type: 'status', expected: 200 }, { ...ok, status: 201 })).toEqual({ type: 'status', expected: 201 });
    expect(staleCheckUpdate({ type: 'status', expected: 200 }, { ...ok, status: 500 })).toBeUndefined();
    expect(staleCheckUpdate({ type: 'equals', path: '$.status', expected: 'up' }, { ...ok, status: 401 })).toBeUndefined();
    expect(staleCheckUpdate({ type: 'equals', path: '$.status', expected: 'up' }, ok, { status: 200, body: '{"status":"down"}' })).toBeUndefined();
    expect(staleCheckUpdate({ type: 'equals', path: '$.status', expected: 'up' }, ok, { status: 200, body: '{"status":"up"}' })).toEqual({ type: 'equals', path: '$.status', expected: 'ok' });
  });
});

describe('damaged run data', () => {
  it('a damaged summary is a normalised error; result lines that are not results are skipped by every reader', async () => {
    const h = harness({ rules: [{ match: '.', response: answer({ causes: [] }) }] });
    h.store.saveCollection(structuredClone(HEALTH));
    try {
      await addRun(h.store, { id: 'run-d1', startedAt: '2026-10-16T10:00:00.000Z', origin: ORIGIN, results: [failedHealth()] });
      for (const text of ['{ not json', 'null', '[1,2]', '{}']) {
        writeFileSync(join(h.store.runDir('run-d1'), 'summary.json'), text);
        await expect(triageRun(h.deps, { runId: 'run-d1' })).rejects.toMatchObject({ kind: 'ConfigurationError', message: expect.stringMatching(/summary of run run-d1 cannot be read/) });
      }
      // run:last passes over it
      await expect(triageRun(h.deps, { runId: 'last' })).rejects.toMatchObject({ kind: 'ValidationError' });
      await addRun(h.store, { id: 'run-d2', startedAt: '2026-10-16T11:00:00.000Z', origin: ORIGIN, results: [failedHealth()] });
      const good = JSON.stringify({ ...failedHealth(), startedAt: '2026-10-16T11:00:00.000Z' });
      writeFileSync(
        join(h.store.runDir('run-d2'), 'results.jsonl'),
        ['null', '42', '"x"', '[]', '{}', '{"id":7,"status":"failed"}', '{"id":"y","status":"failed","checks":"no"}', good, '{"id":"cut'].join('\n') + '\n',
      );
      for (const noAi of [true, false]) {
        const r = await triageRun(h.deps, { runId: 'run-d2', noAi });
        expect(r.failures).toBe(1);
      }
      const { flakyTests, runResults } = await import('../../packages/core/src/index.js');
      await expect(flakyTests(h.store)).resolves.toEqual([]);
      const read: TestResult[] = [];
      for await (const x of runResults(h.store, 'run-d2')) read.push(x);
      expect(read.map((x) => x.id)).toEqual(['health@1']);
      // no history at all for a test: a normalised error
      const { analyzeFlaky } = await import('../../packages/core/src/index.js');
      await expect(analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'nope' }, noAi: true })).rejects.toMatchObject({
        kind: 'ValidationError',
        message: expect.stringMatching(/No run has a result of "nope"/),
      });
      await expect(triageRun(h.deps, { runId: 'no-such-run' })).rejects.toMatchObject({ kind: 'ValidationError' });
    } finally {
      h.cleanup();
    }
  });
});
