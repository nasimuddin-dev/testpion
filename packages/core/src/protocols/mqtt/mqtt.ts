import type { IClientOptions, MqttClient } from 'mqtt';
import { ApsError } from '../../errors.js';
import { assertUrlAllowed } from '../../net/policy.js';
import { shortId } from '../../util/ids.js';

/**
 * MQTT client session (MQTT 3.1.1 or 5): connect to a broker over TCP (mqtt://, mqtts://) or
 * WebSocket (ws://, wss://), subscribe to topic filters, publish messages. Messages are reported like
 * WebSocket messages, with the topic, so the same message log shows them.
 */
export interface MqttMessage {
  id: string;
  time: number;
  direction: 'sent' | 'received' | 'system';
  /** Topic of a published or received message (absent for connection messages). */
  topic?: string;
  /** Payload as UTF-8 text (or the system message). */
  data: string;
  size: number;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

export interface MqttOptions {
  clientId?: string;
  username?: string;
  password?: string;
  /** 4 = MQTT 3.1.1 (default), 5 = MQTT 5. */
  protocolVersion?: 4 | 5;
  /** Start a clean session (default true). */
  clean?: boolean;
  keepaliveSec?: number;
  timeoutMs?: number;
  /** Accept self-signed certificates for mqtts:// and wss://. */
  insecure?: boolean;
}

export type MqttQos = 0 | 1 | 2;

const SCHEMES = /^(mqtt|mqtts|tcp|tls|ws|wss):\/\//i;
const MAX_TEXT = 256 * 1024;

// the client library loads on the first connection (not at startup)
let mqttMod: Promise<typeof import('mqtt')> | undefined;
const mqttLib = () => (mqttMod ??= import('mqtt'));

export class MqttSession {
  readonly id = shortId('mqtt-');
  private client?: MqttClient;
  private messageListeners: Array<(m: MqttMessage) => void> = [];
  private statusListeners: Array<(s: 'connecting' | 'open' | 'closed') => void> = [];
  status: 'connecting' | 'open' | 'closed' = 'closed';

  /** `url`: mqtt://host:1883, mqtts://host:8883, ws://host:8080/mqtt or wss://… (a bare host means mqtt://). */
  constructor(
    readonly url: string,
    private readonly opts: MqttOptions = {},
  ) {}

  onMessage(l: (m: MqttMessage) => void): void {
    this.messageListeners.push(l);
  }
  onStatus(l: (s: 'connecting' | 'open' | 'closed') => void): void {
    this.statusListeners.push(l);
  }

  private emitMessage(direction: MqttMessage['direction'], data: string, extra: Partial<MqttMessage> = {}): void {
    const m: MqttMessage = { id: shortId('m-'), time: Date.now(), direction, data: data.length > MAX_TEXT ? data.slice(0, MAX_TEXT) + '… [truncated]' : data, size: Buffer.byteLength(data), ...extra };
    for (const l of this.messageListeners) l(m);
  }
  private setStatus(s: MqttSession['status']): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  async connect(): Promise<void> {
    const raw = SCHEMES.test(this.url.trim()) ? this.url.trim() : `mqtt://${this.url.trim()}`;
    let target: URL;
    try {
      target = new URL(raw);
    } catch (e) {
      throw new ApsError('ConfigurationError', `Invalid MQTT URL: ${(e as Error).message}`, { suggestions: ['Use mqtt://host:1883, mqtts://host:8883, ws://host:8080/mqtt or wss://host/mqtt.'] });
    }
    if (!target.hostname) throw new ApsError('ConfigurationError', 'Invalid MQTT URL: give the broker host');
    await assertUrlAllowed(target);
    this.setStatus('connecting');
    const o: IClientOptions = {
      clientId: this.opts.clientId || `testpion_${Math.random().toString(16).slice(2, 10)}`,
      username: this.opts.username || undefined,
      password: this.opts.password || undefined,
      protocolVersion: this.opts.protocolVersion ?? 4,
      clean: this.opts.clean ?? true,
      keepalive: this.opts.keepaliveSec ?? 60,
      connectTimeout: this.opts.timeoutMs ?? 15_000,
      reconnectPeriod: 0,
      rejectUnauthorized: !this.opts.insecure,
    };
    const mqtt = await mqttLib();
    const client = (mqtt.default ?? mqtt).connect(target.toString(), o);
    this.client = client;
    client.on('message', (topic, payload, packet) => this.emitMessage('received', payload.toString('utf8'), { topic, qos: packet.qos, ...(packet.retain ? { retain: true } : {}) }));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        this.emitMessage('system', `Error: ${msg}`);
        this.setStatus('closed');
        client.end(true);
        reject(
          new ApsError('NetworkError', `MQTT connection failed: ${msg}`, {
            suggestions: [
              /ECONNREFUSED|ENOTFOUND|timeout/i.test(msg) ? 'Check the URL and port (1883 for mqtt://, 8883 for mqtts://) and that the broker is running.' : 'The broker refused the connection: check the client ID, username and password.',
              'Brokers behind a WebSocket endpoint need ws:// or wss:// and the path (often /mqtt).',
            ],
          }),
        );
      };
      client.once('connect', (ack) => {
        settled = true;
        this.setStatus('open');
        this.emitMessage('system', `Connected (client ID ${o.clientId}, MQTT ${o.protocolVersion === 5 ? '5' : '3.1.1'}${ack.sessionPresent ? ', session present' : ''})`);
        client.on('close', () => {
          if (this.status === 'closed') return;
          this.emitMessage('system', 'Disconnected');
          this.setStatus('closed');
        });
        resolve();
      });
      client.once('error', (e) => fail(e.message));
      client.once('close', () => fail('connection closed'));
    });
  }

  private requireOpen(): MqttClient {
    if (!this.client || this.status !== 'open') throw new ApsError('ProtocolError', 'MQTT is not connected');
    return this.client;
  }

  /** Subscribe to a topic filter (`+` and `#` wildcards). Returns the granted QoS. */
  async subscribe(topic: string, qos: MqttQos = 0): Promise<number> {
    const c = this.requireOpen();
    if (!topic.trim()) throw new ApsError('ValidationError', 'Give the topic to subscribe to');
    const granted = await c.subscribeAsync(topic.trim(), { qos });
    const g = granted[0]?.qos ?? 128;
    if (g === 128 || g > 2) {
      this.emitMessage('system', `Subscription to "${topic}" refused`);
      throw new ApsError('ProtocolError', `The broker refused the subscription to "${topic}"`, { suggestions: ['Check the topic filter and that this client may read it.'] });
    }
    this.emitMessage('system', `Subscribed to "${topic.trim()}" (QoS ${g})`);
    return g;
  }

  async unsubscribe(topic: string): Promise<void> {
    const c = this.requireOpen();
    await c.unsubscribeAsync(topic.trim());
    this.emitMessage('system', `Unsubscribed from "${topic.trim()}"`);
  }

  /** Publish a text payload. QoS 1 and 2 wait for the broker to acknowledge. */
  async publish(topic: string, payload: string, opts: { qos?: MqttQos; retain?: boolean } = {}): Promise<void> {
    const c = this.requireOpen();
    if (!topic.trim()) throw new ApsError('ValidationError', 'Give the topic to publish to');
    if (/[+#]/.test(topic)) throw new ApsError('ValidationError', 'Topics you publish to cannot contain the + or # wildcards');
    const qos = opts.qos ?? 0;
    this.emitMessage('sent', payload, { topic: topic.trim(), qos, ...(opts.retain ? { retain: true } : {}) });
    await c.publishAsync(topic.trim(), payload, { qos, retain: !!opts.retain });
  }

  close(): void {
    if (this.status !== 'closed') {
      this.setStatus('closed');
      this.emitMessage('system', 'Disconnected');
    }
    this.client?.end(true);
  }
}
