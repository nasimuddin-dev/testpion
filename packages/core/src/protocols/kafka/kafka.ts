import type { Admin, Consumer, Kafka, Producer, SASLOptions } from 'kafkajs';
import { ApsError } from '../../errors.js';
import { assertUrlAllowed } from '../../net/policy.js';
import { shortId } from '../../util/ids.js';
import { flattenHeaders } from '../../util/headers.js';

/**
 * Kafka client session: connect to a cluster (one or more bootstrap brokers), produce messages (key, value, headers),
 * consume topics (from the beginning or only new messages) in a consumer group of its own, list topics. Messages are
 * reported like WebSocket and MQTT messages, with the topic (and the key, partition and offset), so the same message
 * log shows them.
 */
export interface KafkaMessage {
  id: string;
  time: number;
  direction: 'sent' | 'received' | 'system';
  topic?: string;
  /** Value as UTF-8 text (or the system message). */
  data: string;
  size: number;
  key?: string;
  partition?: number;
  offset?: string;
  headers?: Record<string, string>;
}

export interface KafkaOptions {
  clientId?: string;
  /** Consumer group (default: one of its own per session, so it never takes messages from a real consumer). */
  groupId?: string;
  /** SASL: plain, scram-sha-256 or scram-sha-512 with username and password (over TLS: kafkas://). */
  mechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username?: string;
  password?: string;
  /** Accept self-signed certificates with kafkas://. */
  insecure?: boolean;
  timeoutMs?: number;
}

const MAX_TEXT = 256 * 1024;

/** `kafka://host:9092,host2:9092` (or kafkas:// for TLS, or a bare host:port list) as broker addresses. */
export function parseKafkaUrl(url: string): { brokers: string[]; tls: boolean } {
  const raw = url.trim();
  const m = /^(kafkas?):\/\/(.+)$/i.exec(raw);
  const tls = !!m && m[1]!.toLowerCase() === 'kafkas';
  const list = (m ? m[2]! : raw).replace(/\/.*$/, '');
  const brokers = list
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (/:\d+$/.test(b) ? b : `${b}:9092`));
  if (!brokers.length) throw new ApsError('ConfigurationError', 'Give the Kafka brokers: kafka://host:9092 (several separated by commas)');
  return { brokers, tls };
}

// the client library loads on the first connection (not at startup)
let kafkaMod: Promise<typeof import('kafkajs')> | undefined;
const kafkajs = () => (kafkaMod ??= import('kafkajs'));

export class KafkaSession {
  readonly id = shortId('kafka-');
  private kafka?: Kafka;
  private producer?: Producer;
  private admin?: Admin;
  /**
   * One consumer per topic read. Adding or removing a topic starts or stops only its own consumer: with one consumer for
   * every topic, a restart read the other topics again (their messages came twice), and keeping its group instead made
   * a topic added again resume from old offsets. Each topic's consumer has a group of its own (or the group asked for),
   * so "from the beginning" and "new messages" mean what they say every time a topic is added.
   */
  private consumers = new Map<string, Consumer>();
  private messageListeners: Array<(m: KafkaMessage) => void> = [];
  private statusListeners: Array<(s: 'connecting' | 'open' | 'closed') => void> = [];
  status: 'connecting' | 'open' | 'closed' = 'closed';

  constructor(
    readonly url: string,
    private readonly opts: KafkaOptions = {},
  ) {}

  onMessage(l: (m: KafkaMessage) => void): void {
    this.messageListeners.push(l);
  }
  onStatus(l: (s: 'connecting' | 'open' | 'closed') => void): void {
    this.statusListeners.push(l);
  }
  private emitMessage(direction: KafkaMessage['direction'], data: string, extra: Partial<KafkaMessage> = {}): void {
    const m: KafkaMessage = {
      id: shortId('m-'),
      time: Date.now(),
      direction,
      data: data.length > MAX_TEXT ? data.slice(0, MAX_TEXT) + '… [truncated]' : data,
      size: Buffer.byteLength(data),
      ...extra,
    };
    for (const l of this.messageListeners) l(m);
  }
  private setStatus(s: KafkaSession['status']): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  async connect(): Promise<void> {
    const { brokers, tls } = parseKafkaUrl(this.url);
    for (const b of brokers) await assertUrlAllowed(new URL(`${tls ? 'https' : 'http'}://${b}`));
    this.setStatus('connecting');
    const sasl: SASLOptions | undefined = this.opts.username
      ? ({ mechanism: this.opts.mechanism ?? 'plain', username: this.opts.username, password: this.opts.password ?? '' } as SASLOptions)
      : undefined;
    const { Kafka, logLevel } = await kafkajs();
    this.kafka = new Kafka({
      clientId: this.opts.clientId || 'testpion',
      brokers,
      ssl: tls ? { rejectUnauthorized: !this.opts.insecure } : false,
      sasl,
      connectionTimeout: this.opts.timeoutMs ?? 10_000,
      requestTimeout: Math.max(this.opts.timeoutMs ?? 10_000, 10_000),
      retry: { retries: 1, initialRetryTime: 200 },
      logLevel: logLevel.NOTHING,
    });
    try {
      this.admin = this.kafka.admin();
      await this.admin.connect();
      const cluster = await this.admin.describeCluster();
      this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
      await this.producer.connect();
      this.setStatus('open');
      this.emitMessage(
        'system',
        `Connected to ${cluster.brokers.length} broker${cluster.brokers.length === 1 ? '' : 's'} (cluster ${cluster.clusterId || 'unnamed'}, controller ${cluster.controller ?? '?'})`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      this.emitMessage('system', `Error: ${msg}`);
      this.setStatus('closed');
      await this.disconnectAll();
      throw new ApsError('NetworkError', `Kafka connection failed: ${msg}`, {
        suggestions: [
          /ECONNREFUSED|ENOTFOUND|timeout|Connection/i.test(msg)
            ? 'Check the broker addresses (kafka://host:9092) and that the brokers are running and reachable.'
            : 'Check the SASL mechanism, username and password.',
          'A broker that advertises an address you cannot reach (advertised.listeners) connects and then fails: ask for the external listener.',
          'TLS listeners need kafkas://.',
        ],
      });
    }
  }

  private requireOpen(): Kafka {
    if (!this.kafka || this.status !== 'open') throw new ApsError('ProtocolError', 'Kafka is not connected');
    return this.kafka;
  }

  /** The topics of the cluster (internal ones left out), with their partition counts. */
  async listTopics(): Promise<Array<{ name: string; partitions: number }>> {
    this.requireOpen();
    const names = (await this.admin!.listTopics()).filter((t) => !t.startsWith('__')).sort();
    if (!names.length) return [];
    const meta = await this.admin!.fetchTopicMetadata({ topics: names });
    return meta.topics.map((t) => ({ name: t.name, partitions: t.partitions.length }));
  }

  /** Read a topic: from the beginning, or only messages produced from now on (its own consumer; the others go on). */
  async subscribe(topic: string, opts: { fromBeginning?: boolean } = {}): Promise<void> {
    this.requireOpen();
    const name = topic.trim();
    if (!name) throw new ApsError('ValidationError', 'Give the topic to read');
    await this.stopConsumer(name);
    await this.startConsumer(name, !!opts.fromBeginning);
    this.emitMessage('system', `Reading "${name}" ${opts.fromBeginning ? 'from the beginning' : '(new messages)'}`);
  }

  async unsubscribe(topic: string): Promise<void> {
    await this.stopConsumer(topic.trim());
    this.emitMessage('system', `Stopped reading "${topic.trim()}"`);
  }

  private async stopConsumer(topic: string): Promise<void> {
    const c = this.consumers.get(topic);
    if (!c) return;
    this.consumers.delete(topic);
    await c.disconnect().catch(() => undefined);
  }

  private async startConsumer(topic: string, fromBeginning: boolean): Promise<void> {
    const kafka = this.requireOpen();
    const consumer = kafka.consumer({
      groupId: this.opts.groupId || `testpion-${shortId('g-')}`,
      sessionTimeout: 10_000,
      heartbeatInterval: 1_000,
      maxWaitTimeInMs: 300,
      allowAutoTopicCreation: true,
    });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning });
    // "new messages" means from now: the end of each partition when asked (a consumer works out "latest" itself only
    // when it first fetches, and a message produced in between was skipped)
    const ends = fromBeginning ? undefined : await this.admin?.fetchTopicOffsets(topic).catch(() => undefined);
    // resolves once the consumer fetches (its partitions assigned and its starting offsets known), so a message
    // produced right after is read, also when only new messages were asked for
    const joined = new Promise<void>((resolve) => {
      const off = consumer.on(consumer.events.FETCH_START, () => (off(), resolve()));
      setTimeout(resolve, 8_000);
    });
    await consumer.run({
      eachMessage: async ({ topic: t, partition, message }) => {
        const headers = message.headers ? flattenHeaders(message.headers) : undefined;
        this.emitMessage('received', message.value?.toString('utf8') ?? '', {
          topic: t,
          partition,
          offset: message.offset,
          ...(message.key ? { key: message.key.toString('utf8') } : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}),
        });
      },
    });
    for (const p of ends ?? []) consumer.seek({ topic, partition: p.partition, offset: p.high });
    this.consumers.set(topic, consumer);
    await joined;
  }

  /** Produce one message (a text value, an optional key, headers and partition). */
  async produce(topic: string, value: string, opts: { key?: string; headers?: Record<string, string>; partition?: number } = {}): Promise<{ partition: number; offset: string }> {
    this.requireOpen();
    if (!topic.trim()) throw new ApsError('ValidationError', 'Give the topic to produce to');
    this.emitMessage('sent', value, { topic: topic.trim(), ...(opts.key ? { key: opts.key } : {}), ...(opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : {}) });
    const [r] = await this.producer!.send({ topic: topic.trim(), messages: [{ value, key: opts.key ?? null, headers: opts.headers, partition: opts.partition }] });
    return { partition: r?.partition ?? 0, offset: r?.baseOffset ?? '-1' };
  }

  private async disconnectAll(): Promise<void> {
    const consumers = [...this.consumers.values()];
    this.consumers.clear();
    await Promise.all([...consumers.map((c) => c.disconnect()), this.producer?.disconnect(), this.admin?.disconnect()].map((p) => p?.catch(() => undefined)));
    this.producer = this.admin = undefined;
  }

  close(): void {
    if (this.status !== 'closed') {
      this.setStatus('closed');
      this.emitMessage('system', 'Disconnected');
    }
    void this.disconnectAll();
  }

  /** Close and wait until every client of the session has disconnected (tests, the CLI). */
  async closeAndWait(): Promise<void> {
    if (this.status !== 'closed') {
      this.setStatus('closed');
      this.emitMessage('system', 'Disconnected');
    }
    await this.disconnectAll();
  }
}
