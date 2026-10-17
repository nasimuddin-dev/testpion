/**
 * AI-5 · Flaky-test analysis with the mock model: the signals read from the history (pass rate, flips, latency of
 * passes and failures, statuses), the pattern with evidence, a fix that never hides a failure (skip / quarantine refused,
 * a retry only with a caution), and "Attempt to fix": the fix applied, the test run 5 times against a local server,
 * the verdict kept on the proposal (passed 5/5 → stable) — plus CLI-less parity through analyzeFlaky without a model.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeFlaky, attemptFix, createEngineContext, defaultSettings, flakyEvidence, flakyTestId, MemorySecretStore, undoProposal, type TestResult } from '../../packages/core/src/index.js';
import { join } from 'node:path';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { addRun, httpResult } from './run-fixtures.js';

afterAll(printScorecard);

// a job that is "running" on every other read, then "done": a test that reads it once is flaky
let server: Server;
let base = '';
let reads = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    reads++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 7, status: reads % 2 ? 'running' : 'done' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const FILE = (url: string) =>
  `name: Jobs\ntests:\n  - id: job-done\n    name: Job is done\n    url: ${url}/jobs/7\n    assertions:\n      - { type: status, expected: 200 }\n      - { type: equals, path: $.status, expected: done }\n`;

async function flakyWorkspace(rules: Parameters<typeof harness>[0]['rules']) {
  const h = harness({ rules });
  h.store.writeTestFile('flaky/jobs.yaml', FILE(base));
  const file = join(h.store.path('tests'), 'flaky', 'jobs.yaml');
  const result = (ok: boolean, latencyMs: number): TestResult => ({
    ...httpResult({
      id: 'job-done',
      name: 'Job is done',
      url: `${base}/jobs/7`,
      status: 200,
      body: { id: 7, status: ok ? 'done' : 'running' },
      latencyMs,
      checks: [
        { type: 'status', name: 'status', passed: true },
        ok ? { type: 'equals', name: 'equals $.status', passed: true } : { type: 'equals', name: 'equals $.status', passed: false, message: 'expected "done", got "running"' },
      ],
    }),
    file,
  });
  const pattern = [true, false, true, false, false, true];
  for (let i = 0; i < pattern.length; i++)
    await addRun(h.store, { id: `run-${i}`, startedAt: `2026-10-1${i}T0${i}:00:00.000Z`, origin: { kind: 'tests', paths: ['flaky/jobs.yaml'] }, results: [result(pattern[i]!, pattern[i] ? 40 : 12)] });
  return h;
}

const answer = (fix: unknown) =>
  JSON.stringify({
    pattern: 'timing',
    title: 'Reads the job before it is done',
    explanation: 'It fails when the job still runs (runs 1, 3, 4).',
    confidence: 0.85,
    evidence: ['failed runs saw "running"'],
    fix,
  });

describe('the evidence of a flaky test', () => {
  it('names it by test-case or test file, and reads the signals', async () => {
    const h = await flakyWorkspace([]);
    try {
      expect(await flakyTestId(h.store, { kind: 'test', path: 'flaky/jobs.yaml' })).toBe('job-done');
      expect(await flakyTestId(h.store, { kind: 'test', path: 'flaky/jobs.yaml', step: 'job-done' })).toBe('job-done');
      const ev = await flakyEvidence(h.store, 'job-done');
      expect(ev.signals).toMatchObject({ runs: 6, passed: 3, failed: 3, flips: 4, medianPassMs: 40, medianFailMs: 12 });
      expect(ev.runs.map((r) => r.status[0]).join('')).toBe('pfpffp');
      expect(ev.failing?.failedAssertions).toEqual([{ index: 1, check: { type: 'equals', path: '$.status', expected: 'done' } }]);
      expect(ev.rerun).toMatchObject({ kind: 'tests', path: 'flaky/jobs.yaml', testId: 'job-done' });
    } finally {
      h.cleanup();
    }
  });
});

describe('the fix: stable, never hiding a failure', () => {
  it('a wait (until:) is proposed and lints; skip is refused with a note; Attempt to fix runs it 5 times: stable', async () => {
    const until = { until: { if: "$.status == 'done'", every: '20ms', timeout: '3s' }, skip: true };
    const h = await flakyWorkspace([{ match: '.', response: answer({ type: 'step', set: until }) }]);
    try {
      const r = await analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'job-done' } });
      // live: timing (or ordering, read the same way) counts only when its fix verifies
      const fixed = !!r.proposal?.items.some((i) => i.kind !== 'text' && i.verification.every((b) => b.status !== 'fail'));
      score(
        'analyze-flaky',
        'timing: wait until done',
        { calls: 1 + (r.repairs ?? 0), repairs: r.repairs ?? 0, usage: r.usage ?? { totalTokens: 0 } },
        ['timing', 'ordering'].includes(r.finding.kind) && fixed,
      );
      if (LIVE) return;
      expect(r.ai).toBe(true);
      expect(r.finding).toMatchObject({ kind: 'timing', confidence: 0.85, count: 3 });
      expect(r.finding.evidence.map((e) => e.text).join('\n')).toMatch(/Passed 3 of 6 runs; its result changed 4 times/);
      const p = r.proposal!;
      expect(p.notes?.join(' ')).toMatch(/Not offered: skip would hide/);
      const item = p.items[0]!;
      expect(item).toMatchObject({ kind: 'file', path: 'flaky/jobs.yaml', selected: true, verification: [{ verifier: 'fix', status: 'pass' }] });
      expect(item.after).toMatch(/until:/);
      expect(item.after).not.toMatch(/skip/);

      const settings = { ...defaultSettings() };
      const tried = await attemptFix({
        store: h.store,
        proposalId: p.id,
        times: 5,
        servicesFor: async () => {
          const ctx = createEngineContext({ store: h.store, secrets: new MemorySecretStore(), settings });
          return { services: ctx.services, dispose: () => ctx.dispose() };
        },
      });
      expect(tried.attempt).toMatchObject({ runs: 5, passed: 5, verdict: 'stable', items: ['i1'] });
      expect(tried.proposal.attempts).toHaveLength(1);
      expect(h.store.readTestFile('flaky/jobs.yaml')).toMatch(/until:/);
      undoProposal(h.store, p.id);
      expect(h.store.readTestFile('flaky/jobs.yaml')).not.toMatch(/until:/);
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('a retry carries a caution (at most 2); quarantine is never offered', async () => {
    const h = await flakyWorkspace([{ match: '.', responses: [answer({ type: 'retry', retries: 5 }), answer({ type: 'quarantine' })] }]);
    try {
      const retry = await analyzeFlaky(h.deps, { item: { kind: 'test', path: 'flaky/jobs.yaml' } });
      if (LIVE) return;
      const item = retry.proposal!.items[0]!;
      expect(item.after).toMatch(/retries: 2/);
      expect(item.verification.map((b) => b.status)).toEqual(['warn']);
      expect(item.verification[0]!.label).toMatch(/last resort/);
      const q = await analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'job-done' } });
      expect(q.proposal?.items ?? []).toEqual([]);
      expect(q.proposal?.notes?.join(' ')).toMatch(/Not offered: skipping or quarantining/);
    } finally {
      h.cleanup();
    }
  });

  it('no model set up: the signals with a likely pattern, and why', async () => {
    const h = await flakyWorkspace([]);
    try {
      // no model, whatever the environment says (a live run sets TESTPION_AI_*)
      const r = await analyzeFlaky({ ...h.deps, settings: { pricing: [] }, env: {} }, { item: { kind: 'test-case', testId: 'job-done' } });
      expect(r.ai).toBe(false);
      expect(r.fallback).toMatch(/No AI model is set up/);
      expect(r.finding.evidence[0]!.text).toMatch(/Passed 3 of 6 runs/);
    } finally {
      h.cleanup();
    }
  });
});

describe('the live findings: repairs say what is wrong, and the signature points to timing', () => {
  const invalid = answer({ type: 'edit', find: 'expected: done', replace: "expected: 'done' or 'running'" });
  const until = answer({ type: 'step', set: { until: { if: "$.status == 'done'", every: '20ms', timeout: '3s' } } });

  it.skipIf(LIVE)('a fix that breaks the YAML goes back with the lint explanation and recovers in one repair', async () => {
    const h = await flakyWorkspace([{ match: '.', responses: [invalid, until] }]);
    try {
      const r = await analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'job-done' } });
      expect(r.repairs).toBe(1);
      const repair = h.rec.requests[1]!.messages.at(-1)!.content;
      expect(repair).toMatch(/lint error/);
      expect(repair).toMatch(/line \d+/);
      expect(r.proposal!.items[0]).toMatchObject({ kind: 'file', selected: true, verification: [{ verifier: 'fix', status: 'pass' }] });
      expect(r.proposal!.items[0]!.after).toMatch(/until:/);
    } finally {
      h.cleanup();
    }
  });

  it.skipIf(LIVE)('a fix that cannot be made (text not in the file) goes back naming the check by checkIndex', async () => {
    const missing = answer({ type: 'edit', find: 'expected: finished', replace: 'expected: done' });
    const h = await flakyWorkspace([{ match: '.', responses: [missing, until] }]);
    try {
      const r = await analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'job-done' } });
      expect(r.repairs).toBe(1);
      expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/checkIndex 1 \(equals \$\.status = "done"\)/);
    } finally {
      h.cleanup();
    }
  });

  it('the signature is computed from the responses: the state field differs, so the likely pattern is timing; the prompt has the format reference and the guide', async () => {
    const h = await flakyWorkspace([{ match: '.', response: until }]);
    try {
      const ev = await flakyEvidence(h.store, 'job-done');
      expect(ev.signals.likely).toBe('timing');
      expect(ev.signals.signature).toBe('Failing responses differ from passing ones in: $.status: "done" when it passes, "running" when it fails');
      if (LIVE) return;
      const r = await analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'job-done' } });
      const sent = h.rec.requests[0]!.messages;
      expect(sent[0]!.content).toMatch(/TestPion test file format/);
      expect(sent[0]!.content).toMatch(/state field that differs between passes and failures, the pattern is timing/);
      expect(sent.at(-1)!.content).toMatch(/"likely": "timing"/);
      expect(r.proposal!.taskVersion).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe('the signature names the telling fields first', () => {
  it('the asserted field first, then state-like fields; ids, times and counters left out unless asserted', async () => {
    const h = harness({ rules: [] });
    try {
      h.store.writeTestFile('flaky/jobs.yaml', FILE(base));
      const file = join(h.store.path('tests'), 'flaky', 'jobs.yaml');
      // the made-up fields come first in the body; the asserted $.status comes last
      const body = (ok: boolean, n: number) => ({ id: `job-${n}`, updatedAt: `2026-10-1${n}T00:00:00Z`, attempts: n, ready: ok, phase: ok ? 'finished' : 'working', status: ok ? 'done' : 'running' });
      const result = (ok: boolean, n: number): TestResult => ({
        ...httpResult({
          id: 'job-done',
          name: 'Job is done',
          url: `${base}/jobs/7`,
          status: 200,
          body: body(ok, n),
          checks: [ok ? { type: 'equals', name: 'equals $.status', passed: true } : { type: 'equals', name: 'equals $.status', passed: false, message: 'expected "done", got "running"' }],
        }),
        file,
      });
      const pattern = [true, false, true, false];
      for (let i = 0; i < pattern.length; i++) await addRun(h.store, { id: `run-${i}`, startedAt: `2026-10-1${i}T0${i}:00:00.000Z`, origin: { kind: 'tests', paths: ['flaky/jobs.yaml'] }, results: [result(pattern[i]!, i + 5)] });
      const ev = await flakyEvidence(h.store, 'job-done');
      const sig = ev.signals.signature!;
      expect(sig).toMatch(/^Failing responses differ from passing ones in: \$\.status: "done" when it passes, "running" when it fails; \$\.ready: true when it passes, false when it fails; \$\.phase: "finished" when it passes, "working" when it fails/);
      expect(sig).not.toMatch(/\$\.id|updatedAt|\$\.attempts:/);
      expect(sig).toMatch(/3 more fields differ$/);
      expect(ev.signals.likely).toBe('timing');
    } finally {
      h.cleanup();
    }
  });
});

describe('privacy', () => {
  it.skipIf(LIVE)('the evidence never sends a secret, at any privacy level', async () => {
    const SECRET = 'sk-live-FLAKY-0123456789abcdef';
    const none = JSON.stringify({ pattern: 'timing', title: 'Reads too early', explanation: 'x', confidence: 0.6, fix: { type: 'none', note: 'Wait for the job.' } });
    const h = harness({ secrets: { apiKey: SECRET }, rules: [{ match: '.', response: none }] });
    h.store.writeTestFile('flaky/jobs.yaml', FILE(base));
    const file = join(h.store.path('tests'), 'flaky', 'jobs.yaml');
    const result = (ok: boolean): TestResult => ({
      ...httpResult({
        id: 'job-done',
        name: 'Job is done',
        url: `${base}/jobs/7?api_key=${SECRET}`,
        status: 200,
        body: { id: 7, status: ok ? 'done' : 'running', token: SECRET },
        checks: [ok ? { type: 'equals', name: 'equals $.status', passed: true } : { type: 'equals', name: 'equals $.status', passed: false, message: `expected "done", got "running" (${SECRET})` }],
      }),
      file,
    });
    try {
      for (const [i, ok] of [true, false, true, false].entries())
        await addRun(h.store, { id: `run-s${i}`, startedAt: `2026-10-1${i}T0${i}:00:00.000Z`, origin: { kind: 'tests', paths: ['flaky/jobs.yaml'] }, results: [result(ok)] });
      for (const privacy of [undefined, 'metadata', 'names']) await analyzeFlaky(h.deps, { item: { kind: 'test-case', testId: 'job-done' }, privacy });
      const sent = h.rec.requests.map((r) => r.messages.map((m) => m.content).join('\n'));
      expect(sent.length).toBeGreaterThanOrEqual(3);
      for (const text of sent) expect(text).not.toContain(SECRET);
    } finally {
      h.cleanup();
    }
  });
});
