import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kafka, logLevel } from 'kafkajs';
import type { Admin, Consumer, EachMessagePayload, Producer } from 'kafkajs';
import { startKafkaBroker } from '../../examples/servers/kafka-broker.mjs';

type Broker = Awaited<ReturnType<typeof startKafkaBroker>>;
type Seen = { key: string | null; value: string | null; headers: Record<string, string>; offset: string };

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('in-process Kafka broker', () => {
  let broker: Broker;
  let kafka: Kafka;
  let producer: Producer;
  let consumer: Consumer;
  let admin: Admin;
  const seen: Seen[] = [];

  beforeAll(async () => {
    broker = await startKafkaBroker({ topics: { preset: 2 } });
    kafka = new Kafka({ clientId: 'kafka-broker-test', brokers: [broker.url], logLevel: logLevel.NOTHING, retry: { retries: 3, initialRetryTime: 50 } });
    producer = kafka.producer({ allowAutoTopicCreation: true });
    admin = kafka.admin();
    await Promise.all([producer.connect(), admin.connect()]);
  });

  afterAll(async () => {
    await consumer?.disconnect().catch(() => {});
    await producer?.disconnect().catch(() => {});
    await admin?.disconnect().catch(() => {});
    await broker?.close();
  });

  it('accepts produced messages with keys, values and headers', async () => {
    const [res] = await producer.send({
      topic: 'orders',
      messages: [
        { key: 'k1', value: 'first', headers: { trace: 't-1', kind: 'create' } },
        { key: 'k2', value: 'second', headers: { trace: 't-2' } },
        { key: null, value: 'third' },
      ],
    });
    expect(res).toMatchObject({ topicName: 'orders', partition: 0, errorCode: 0, baseOffset: '0' });
    expect(broker.topics.get('orders')?.partitions[0].records).toHaveLength(3);
  });

  it('delivers them in order to a consumer group from the beginning, then delivers later messages too', async () => {
    consumer = kafka.consumer({ groupId: 'orders-readers', maxWaitTimeInMs: 100, heartbeatInterval: 500 });
    await consumer.connect();
    await consumer.subscribe({ topic: 'orders', fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(message.headers ?? {})) headers[k] = String(v);
        seen.push({ key: message.key?.toString() ?? null, value: message.value?.toString() ?? null, headers, offset: message.offset });
      },
    });

    await waitFor(() => seen.length >= 3);
    expect(seen).toEqual([
      { key: 'k1', value: 'first', headers: { trace: 't-1', kind: 'create' }, offset: '0' },
      { key: 'k2', value: 'second', headers: { trace: 't-2' }, offset: '1' },
      { key: null, value: 'third', headers: {}, offset: '2' },
    ]);

    await producer.send({
      topic: 'orders',
      messages: [
        { key: 'k4', value: 'fourth', headers: { trace: 't-4' } },
        { key: 'k5', value: 'fifth' },
      ],
    });
    await waitFor(() => seen.length >= 5);
    expect(seen.slice(3)).toEqual([
      { key: 'k4', value: 'fourth', headers: { trace: 't-4' }, offset: '3' },
      { key: 'k5', value: 'fifth', headers: {}, offset: '4' },
    ]);

    // the group commits what it consumed
    const committed = await (async () => {
      const until = Date.now() + 10_000;
      for (;;) {
        const [t] = await admin.fetchOffsets({ groupId: 'orders-readers', topics: ['orders'] });
        if (t.partitions[0].offset === '5' || Date.now() > until) return t.partitions[0].offset;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    expect(committed).toBe('5');
  });

  it('answers admin topic listing and metadata', async () => {
    const topics = await admin.listTopics();
    expect(topics.sort()).toEqual(['orders', 'preset']);
    const { topics: meta } = await admin.fetchTopicMetadata({ topics: ['orders', 'preset'] });
    const byName = Object.fromEntries(meta.map((t) => [t.name, t.partitions.map((p) => ({ id: p.partitionId, leader: p.leader }))]));
    expect(byName).toEqual({
      orders: [{ id: 0, leader: 0 }],
      preset: [
        { id: 0, leader: 0 },
        { id: 1, leader: 0 },
      ],
    });
    await admin.createTopics({ topics: [{ topic: 'made-by-admin', numPartitions: 3 }] });
    expect((await admin.listTopics()).sort()).toEqual(['made-by-admin', 'orders', 'preset']);
  });

  it('reports the high watermark per partition', async () => {
    const offsets = await admin.fetchTopicOffsets('orders');
    expect(offsets).toEqual([{ partition: 0, offset: '5', high: '5', low: '0' }]);
    const empty = await admin.fetchTopicOffsets('preset');
    expect(empty.map((p) => p.high)).toEqual(['0', '0']);
  });
});
