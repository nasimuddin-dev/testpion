import { describe, expect, it } from 'vitest';
import { runChecks, runScript, type CheckContext, ProviderRegistry, VariableScope } from '../../packages/core/src/index.js';

const http = (over: Partial<CheckContext> = {}): CheckContext => ({
  testType: 'http',
  status: 200,
  headers: [['content-type', 'application/json']],
  body: { data: { patient: { id: '123', name: 'Rex', tags: ['a', 'b'] } }, count: 3 },
  text: '{"data":{"patient":{"id":"123"}}}',
  latencyMs: 120,
  ...over,
});

async function one(cfg: Record<string, unknown>, ctx: CheckContext) {
  const [r] = await runChecks([cfg as never], ctx);
  return r!;
}

describe('deterministic assertions', () => {
  it('status', async () => {
    expect((await one({ type: 'http-status', expected: 200 }, http())).passed).toBe(true);
    expect((await one({ type: 'status', expected: '2xx' }, http({ status: 204 }))).passed).toBe(true);
    expect((await one({ type: 'status', expected: [200, 201] }, http({ status: 404 }))).passed).toBe(false);
    expect((await one({ type: 'status', expected: 'success' }, { testType: 'mcp', body: {}, text: '', isError: true })).passed).toBe(false);
  });

  it('exists / equals / contains / regex / type / length / threshold', async () => {
    const c = http();
    expect((await one({ type: 'exists', path: '$.data.patient.id' }, c)).passed).toBe(true);
    expect((await one({ type: 'not-exists', path: '$.data.nope' }, c)).passed).toBe(true);
    expect((await one({ type: 'equals', path: '$.data.patient.id', expected: '123' }, c)).passed).toBe(true);
    expect((await one({ type: 'equals', path: '$.data.patient.id', expected: '999' }, c)).passed).toBe(false);
    expect((await one({ type: 'contains', path: '$.data.patient.tags', expected: 'b' }, c)).passed).toBe(true);
    expect((await one({ type: 'contains', expected: 'patient' }, c)).passed).toBe(true);
    expect((await one({ type: 'not-contains', expected: 'password' }, c)).passed).toBe(true);
    expect((await one({ type: 'regex', path: '$.data.patient.name', expected: '^R.x$' }, c)).passed).toBe(true);
    expect((await one({ type: 'type', path: '$.count', expected: 'number' }, c)).passed).toBe(true);
    expect((await one({ type: 'length', path: '$.data.patient.tags', expected: 2 }, c)).passed).toBe(true);
    expect((await one({ type: 'threshold', path: '$.count', min: 1, max: 2 }, c)).passed).toBe(false);
    expect((await one({ type: 'latency', max: 100 }, c)).passed).toBe(false);
    expect((await one({ type: 'header', header: 'content-type', expected: 'json' }, c)).passed).toBe(true);
  });

  it('json-schema with explicit and inferred schema', async () => {
    const llm: CheckContext = { testType: 'llm', body: { category: 'cancellation' }, text: '{"category":"cancellation"}', expected: { category: 'x' } };
    expect((await one({ type: 'json-schema' }, llm)).passed).toBe(true);
    expect((await one({ type: 'json-schema', schema: { type: 'object', required: ['intent'] } }, llm)).passed).toBe(false);
    const bad: CheckContext = { testType: 'llm', body: 'not json', text: 'not json' };
    expect((await one({ type: 'json-schema' }, bad)).message).toMatch(/not valid JSON/);
  });

  it('graphql errors', async () => {
    expect((await one({ type: 'graphql-no-errors' }, http({ graphqlErrors: [{ message: 'Cannot query field' }] }))).passed).toBe(false);
    expect((await one({ type: 'graphql-errors', expected: 'Cannot query' }, http({ graphqlErrors: [{ message: 'Cannot query field' }] }))).passed).toBe(true);
  });

  it('unknown check types fail with a helpful message', async () => {
    const r = await one({ type: 'no-such-check' }, http());
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/unknown check type/);
  });
});

describe('agent / safety checks', () => {
  const agent: CheckContext = {
    testType: 'agent',
    body: 'done',
    text: 'Here is the key sk-abcdefghijklmnopqrstuv',
    toolCalls: [
      { name: 'search_customer', arguments: { customer_id: '123' } },
      { name: 'create_appointment', arguments: { customer_id: '123', date: 5 } },
    ],
    toolSchemas: { create_appointment: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] } },
  };
  it('tool assertions', async () => {
    expect((await one({ type: 'tool-called', tool: 'search_customer', arguments: { customer_id: '123' } }, agent)).passed).toBe(true);
    expect((await one({ type: 'tool-not-called', tool: 'delete_customer' }, agent)).passed).toBe(true);
    expect((await one({ type: 'allowed-tools', expected: ['search_customer'] }, agent)).passed).toBe(false);
    expect((await one({ type: 'max-tool-calls', expected: 1 }, agent)).passed).toBe(false);
    expect((await one({ type: 'tool-sequence', expected: ['search_customer', 'create_appointment'] }, agent)).passed).toBe(true);
    expect((await one({ type: 'tool-args-valid' }, agent)).passed).toBe(false);
  });
  it('leak detection is labelled heuristic', async () => {
    const r = await one({ type: 'no-leak' }, agent);
    expect(r.passed).toBe(false);
    expect(r.source).toBe('heuristic');
    expect((await one({ type: 'no-leak', values: ['CANARY-42'] }, { ...agent, text: 'clean output' })).passed).toBe(true);
  });
  it('refusal', async () => {
    expect((await one({ type: 'refusal' }, { testType: 'llm', body: '', text: "Sorry, but I can't help with that." })).passed).toBe(true);
  });
});

describe('semantic, RAG and judge evaluators', () => {
  const rag: CheckContext = {
    testType: 'rag',
    question: 'What are the clinic opening hours?',
    expected: 'The clinic opens at 8am and closes at 6pm.',
    contexts: [
      { id: 'doc-1', text: 'Happy Paws clinic opens at 8am and closes at 6pm on weekdays.' },
      { id: 'doc-2', text: 'Parking is available behind the building.' },
    ],
    body: 'The clinic opens at 8am and closes at 6pm [doc-1].',
    text: 'The clinic opens at 8am and closes at 6pm [doc-1].',
  };
  it('RAG heuristics', async () => {
    const [precision, recall, grounded, cite] = await runChecks(
      [{ type: 'context-precision' }, { type: 'context-recall' }, { type: 'groundedness' }, { type: 'citation' }],
      rag,
    );
    expect(precision!.score).toBe(1);
    expect(recall!.passed).toBe(true);
    expect(grounded!.score).toBe(1);
    expect(grounded!.source).toBe('heuristic');
    expect(cite!.passed).toBe(true);
    const halluc = await one({ type: 'groundedness' }, { ...rag, text: 'The clinic is open 24 hours and offers free lunch for pets.' });
    expect(halluc.passed).toBe(false);
    expect(halluc.metadata?.hallucinationIndicator).toBeGreaterThan(0.5);
    const badCite = await one({ type: 'citation' }, { ...rag, text: 'Opens 8am [doc-9].' });
    expect(badCite.passed).toBe(false);
  });

  it('lexical and embedding similarity', async () => {
    const vars = new VariableScope();
    const providers = new ProviderRegistry([], vars);
    const ctx: CheckContext = { testType: 'llm', body: 'cancel my appointment please', text: 'cancel my appointment please', services: { providers } };
    const lex = await one({ type: 'similarity', expected: 'please cancel the appointment', threshold: 0.5 }, ctx);
    expect(lex.passed).toBe(true);
    expect(lex.source).toBe('heuristic');
    const emb = await one({ type: 'similarity', method: 'embedding', provider: 'mock', expected: 'cancel my appointment please', threshold: 0.99 }, ctx);
    expect(emb.source).toBe('semantic');
    expect(emb.score).toBeCloseTo(1, 3);
  });

  it('LLM judge results are marked ai-judge with reproducible config', async () => {
    const vars = new VariableScope();
    const providers = new ProviderRegistry(
      [{ id: 'judge', name: 'Judge', kind: 'mock', baseUrl: '', headers: [{ key: 'x-mock-rules', value: JSON.stringify([{ match: 'CRITERIA', response: '{"score": 0.8, "reasoning": "mostly correct"}' }]) }] }],
      vars,
    );
    const r = await one({ type: 'llm-judge', judge: { provider: 'judge', name: 'judge-model' }, criteria: 'Is polite', threshold: 0.7 }, { testType: 'llm', body: 'hi', text: 'hi', services: { providers } });
    expect(r).toMatchObject({ passed: true, score: 0.8, source: 'ai-judge', explanation: 'mostly correct' });
    expect((r.metadata!.judge as { configHash: string }).configHash).toHaveLength(12);
  });
});

describe('script sandbox (QuickJS/WASM)', () => {
  it('runs tests, sets variables and captures logs', async () => {
    const out = await runScript(
      `const j = aps.response.json();
       aps.test('status is 200', () => aps.expect(aps.response.code).toBe(200));
       aps.test('has id', () => aps.expect(j).toHaveProperty('id'));
       aps.test('fails', () => aps.expect(j.id).toBe('nope'));
       aps.variables.set('patientId', j.id);
       console.log('id is', j.id, aps.crypto.sha256('a').slice(0, 8));`,
      { variables: {}, response: { status: 200, body: '{"id":"42"}' } },
    );
    expect(out.error).toBeUndefined();
    expect(out.tests.map((t) => t.passed)).toEqual([true, true, false]);
    expect(out.vars).toEqual({ patientId: '42' });
    expect(out.logs[0]).toBe('id is 42 ca978112');
  });

  it('can modify the outgoing request in pre-request scripts', async () => {
    const out = await runScript(`aps.request.headers.push({ key: 'x-sig', value: aps.crypto.hmacSha256('k', aps.request.body) });`, {
      variables: {},
      request: { method: 'POST', url: 'http://x', headers: [], body: 'payload' },
    });
    expect(out.request?.headers[0]?.key).toBe('x-sig');
  });

  it('has no access to Node, the filesystem or processes', async () => {
    const out = await runScript(
      `aps.variables.set('types', [(function(){ try { require('fs'); return 'loaded'; } catch (e) { return 'blocked'; } })(), typeof process, typeof fetch, typeof globalThis.Buffer].join(','));
       aps.variables.set('escape', (function(){ try { return typeof aps.test.constructor.constructor('return process')(); } catch (e) { return 'blocked'; } })());`,
      { variables: {} },
    );
    expect(out.vars.types).toBe('blocked,undefined,undefined,undefined');
    expect(out.vars.escape).not.toBe('object');
  });

  it('enforces CPU time limits', async () => {
    const out = await runScript('while (true) {}', { variables: {} }, { timeoutMs: 100 });
    expect(out.error).toMatch(/timed out|interrupted/i);
  });
});

describe('one label of a check, wherever it is shown (AI proposals, verification, the Checks tab)', () => {
  it('names the header a header check reads', async () => {
    const { checkLabel } = await import('../../packages/shared/src/index.js');
    expect(checkLabel({ type: 'header', header: 'content-type', expected: 'json' })).toBe('header content-type = "json"');
    expect(checkLabel({ type: 'status', expected: 201 })).toBe('status = 201');
    expect(checkLabel({ type: 'matches', path: '$.email', pattern: '@' })).toBe('matches $.email /@/');
    expect((await one({ type: 'header', header: 'content-type', expected: 'json' }, http())).name).toBe('header content-type');
  });
});

describe('money and counts for people (shared by the app, the CLI and reports)', () => {
  it('formats dollars with sensible decimals and counts with the right plural', async () => {
    const { formatUsd, plural } = await import('../../packages/shared/src/index.js');
    expect(`${formatUsd(2)} left of ${formatUsd(2)}`).toBe('$2.00 left of $2.00');
    expect([0, 0.5, 0.0123, 0.00015, 1234.5, undefined].map(formatUsd)).toEqual(['$0', '$0.50', '$0.0123', '$0.00015', '$1,234.50', '–']);
    expect([plural(1, 'call'), plural(3, 'call'), plural(2, 'entry', 'entries')]).toEqual(['1 call', '3 calls', '2 entries']);
  });
});
