import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  McpManager,
  ProviderRegistry,
  Redactor,
  VariableScope,
  KafkaSession,
  normalizeTest,
  parseKafkaUrl,
  realtimeModeFor,
  runRealtimeExchange,
  runTests,
  type ExecServices,
  type KafkaMessage,
  type TestResult,
} from '../../packages/core/src/index.js';
import { startKafkaBroker } from '../../examples/servers/kafka-broker.mjs';

// Kafka as a realtime mode: a session (produce, read from the beginning or new messages, list topics), the scripted
// exchange (CLI, agents) and a `type: kafka` test file, against the in-process broker.
let broker: Awaited<ReturnType<typeof startKafkaBroker>>;
let url = '';

beforeAll(async () => {
  broker = await startKafkaBroker({ topics: { 'orders-seeded': 1 } });
  url = `kafka://${broker.url}`;
});
afterAll(async () => {
  await broker.close();
});

function services(vars = new VariableScope()): ExecServices {
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 15_000 };
}
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('Kafka', () => {
  it('reads broker lists from kafka:// URLs and picks the mode from the scheme', () => {
    expect(parseKafkaUrl('kafka://a:9093,b')).toEqual({ brokers: ['a:9093', 'b:9092'], tls: false });
    expect(parseKafkaUrl('kafkas://secure.example.com:9094')).toEqual({ brokers: ['secure.example.com:9094'], tls: true });
    expect(parseKafkaUrl('localhost:9092')).toEqual({ brokers: ['localhost:9092'], tls: false });
    expect(realtimeModeFor('kafka://localhost:9092')).toBe('kafka');
    expect(realtimeModeFor('mqtt://x')).toBe('mqtt');
  });

  it('produces with key and headers, reads from the beginning and new messages, lists topics', async () => {
    const s = new KafkaSession(url);
    const seen: KafkaMessage[] = [];
    s.onMessage((m) => seen.push(m));
    await s.connect();
    expect(s.status).toBe('open');
    const r1 = await s.produce('orders-seeded', '{"id":1}', { key: 'o-1', headers: { source: 'test' } });
    expect(r1).toEqual({ partition: 0, offset: '0' });
    await s.subscribe('orders-seeded', { fromBeginning: true });
    await waitFor(() => seen.some((m) => m.direction === 'received' && m.key === 'o-1'));
    await s.produce('orders-seeded', '{"id":2}', { key: 'o-2' });
    await waitFor(() => seen.some((m) => m.direction === 'received' && m.key === 'o-2'));
    const got = seen.filter((m) => m.direction === 'received');
    expect(got.map((m) => [m.topic, m.key, m.data, m.partition, m.offset])).toEqual([
      ['orders-seeded', 'o-1', '{"id":1}', 0, '0'],
      ['orders-seeded', 'o-2', '{"id":2}', 0, '1'],
    ]);
    expect(got[0]!.headers).toEqual({ source: 'test' });
    expect((await s.listTopics()).find((t) => t.name === 'orders-seeded')).toEqual({ name: 'orders-seeded', partitions: 1 });
    await s.closeAndWait();
    expect(s.status).toBe('closed');
    expect(seen.some((m) => m.direction === 'system' && /^Connected to 1 broker/.test(m.data))).toBe(true);
  });

  it('adding a topic does not read the topics already read again', async () => {
    const s = new KafkaSession(url);
    const seen: KafkaMessage[] = [];
    s.onMessage((m) => seen.push(m));
    await s.connect();
    await s.produce('first-topic', 'a1', { key: 'a1' });
    await s.produce('first-topic', 'a2', { key: 'a2' });
    await s.subscribe('first-topic', { fromBeginning: true });
    await waitFor(() => seen.filter((m) => m.direction === 'received').length >= 2);
    await s.produce('second-topic', 'b1', { key: 'b1' });
    await s.subscribe('second-topic', { fromBeginning: true });
    await waitFor(() => seen.some((m) => m.direction === 'received' && m.key === 'b1'));
    await new Promise((r) => setTimeout(r, 500));
    const keys = seen.filter((m) => m.direction === 'received').map((m) => m.key);
    expect(keys.filter((k) => k === 'a1')).toHaveLength(1);
    expect(keys.filter((k) => k === 'a2')).toHaveLength(1);
    await s.closeAndWait();
  });

  it('a topic added again reads what was asked: its history from the beginning, or only what comes after (new messages)', async () => {
    const s = new KafkaSession(url);
    const seen: KafkaMessage[] = [];
    s.onMessage((m) => seen.push(m));
    const got = (key: string) => seen.filter((m) => m.direction === 'received' && m.key === key).length;
    await s.connect();
    await s.produce('again-topic', 'c1', { key: 'c1' });
    await s.subscribe('again-topic', { fromBeginning: true });
    await waitFor(() => got('c1') === 1);
    await s.unsubscribe('again-topic');
    // from the beginning again: the history comes again
    await s.subscribe('again-topic', { fromBeginning: true });
    await waitFor(() => got('c1') === 2);
    await s.unsubscribe('again-topic');
    // produced while not read, then added for new messages: not replayed; one produced right after is read
    await s.produce('again-topic', 'c2', { key: 'c2' });
    await s.subscribe('again-topic', { fromBeginning: false });
    await s.produce('again-topic', 'c3', { key: 'c3' });
    await waitFor(() => got('c3') === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(got('c2')).toBe(0);
    expect(got('c1')).toBe(2);
    await s.closeAndWait();
  });

  it('reports a cluster that cannot be reached as a failed connection with what to check', async () => {
    const s = new KafkaSession('kafka://127.0.0.1:1', { timeoutMs: 1500 });
    await expect(s.connect()).rejects.toThrow(/Kafka connection failed/);
    expect(s.status).toBe('closed');
  });

  it('runs a scripted exchange: read new messages, produce, collect what came back', async () => {
    const out = await runRealtimeExchange(
      { url, subscribe: [{ topic: 'echo' }], send: [{ topic: 'echo', payload: { hello: 'kafka' }, key: 'k1', headers: { authorization: 'Bearer secret-token' } } as never], waitMs: 800 },
      { redactor: new Redactor() },
    );
    expect(out.mode).toBe('kafka');
    expect(out.connected).toBe(true);
    const received = out.messages.filter((m) => m.direction === 'received');
    expect(received.map((m) => [m.topic, m.key, m.data])).toEqual([['echo', 'k1', '{"hello":"kafka"}']]);
    // a header named like a secret is hidden in what agents and logs get
    expect(received[0]!.headers).toEqual({ authorization: '***' });
  });

  it('runs a type: kafka test file and checks what was received', async () => {
    const test = normalizeTest(
      {
        name: 'an order comes back',
        type: 'kafka',
        url: '{{brokers}}',
        subscribe: [{ topic: 'orders-test', fromBeginning: true }],
        send: [{ topic: 'orders-test', key: 'order-42', value: { id: 42 } }],
        waitMs: 800,
        assertions: [
          { type: 'equals', path: '$.received[0].key', expected: 'order-42' },
          { type: 'equals', path: '$.received[0].data.id', expected: 42 },
        ],
      },
      'kafka.yaml',
    );
    expect(test).toMatchObject({ type: 'websocket', mode: 'kafka' });
    const vars = new VariableScope();
    vars.set('brokers', url);
    const results: TestResult[] = [];
    await runTests({ name: 't', runId: 'r', tests: [test], services: services(vars), concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    expect(results[0]!.status).toBe('passed');
  });
});
