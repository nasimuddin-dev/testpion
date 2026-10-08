import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import { MqttSession, VariableScope, normalizeTest, realtimeModeFor, runRealtimeExchange, runTests, type ExecServices, type TestResult } from '../../packages/core/src/index.js';

let broker: Aedes;
let server: Server;
let url = '';

beforeAll(async () => {
  broker = await Aedes.createBroker({
    // only "vet" / "s3cret" may connect when a username is given
    authenticate: (_client, username, password, done) => done(null, !username || (username === 'vet' && String(password) === 's3cret')),
  });
  server = createServer(broker.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await new Promise<void>((ok) => broker.close(() => ok()));
});

const services = (vars?: VariableScope): ExecServices => fakeServices({ scope: vars, timeoutMs: 10_000 });

describe('MQTT', () => {
  it('picks the mode from the URL', () => {
    expect(realtimeModeFor('mqtt://broker:1883')).toBe('mqtt');
    expect(realtimeModeFor('mqtts://broker')).toBe('mqtt');
    expect(realtimeModeFor('http://x')).toBe('socketio');
    expect(realtimeModeFor('ws://x')).toBe('websocket');
  });

  it('subscribes with wildcards, publishes and receives (QoS 1, retained)', async () => {
    const s = new MqttSession(url, { clientId: 'unit-a' });
    const got: string[] = [];
    s.onMessage((m) => m.direction === 'received' && got.push(`${m.topic}=${m.data}`));
    await s.connect();
    expect(await s.subscribe('clinic/+/vitals', 1)).toBe(1);
    await s.publish('clinic/7/vitals', '{"hr":80}', { qos: 1 });
    await s.publish('clinic/7/other', 'ignored');
    await expect(s.publish('clinic/#', 'x')).rejects.toThrow(/wildcards/);
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual(['clinic/7/vitals={"hr":80}']);
    s.close();
    expect(s.status).toBe('closed');
  });

  it('runs a scripted exchange (CLI `testpion mqtt`, MCP realtime_exchange)', async () => {
    const r = await runRealtimeExchange({ url, subscribe: ['alerts/#'], send: [{ topic: 'alerts/fever', payload: { temp: 40.1 } }, { topic: 'alerts/ok', payload: 'fine', qos: 2 }], waitMs: 200, username: 'vet', password: 's3cret' });
    expect(r).toMatchObject({ mode: 'mqtt', connected: true });
    expect(r.messages.filter((m) => m.direction === 'received').map((m) => [m.topic, m.data])).toEqual([
      ['alerts/fever', '{"temp":40.1}'],
      ['alerts/ok', 'fine'],
    ]);
  });

  it('reports a refused login without throwing', async () => {
    const r = await runRealtimeExchange({ url, username: 'vet', password: 'wrong', waitMs: 0 });
    expect(r.connected).toBe(false);
    expect(r.messages.map((m) => m.data).join(' ')).toMatch(/Not authorized|Bad username|refused/i);
  });

  it('works as a suite test (type: mqtt) with {{variables}} and checks on what was received', async () => {
    const vars = new VariableScope();
    vars.setScope('environment', [
      { key: 'broker', value: url, enabled: true },
      { key: 'pw', value: 's3cret', enabled: true },
    ]);
    const results: TestResult[] = [];
    const test = normalizeTest(
      {
        name: 'fever alert',
        type: 'mqtt',
        url: '{{broker}}',
        username: 'vet',
        password: '{{pw}}',
        subscribe: 'alerts/#',
        send: [{ topic: 'alerts/fever', payload: { temp: 40.1 } }],
        waitMs: 200,
        assertions: [
          { type: 'equals', path: '$.received[0].topic', expected: 'alerts/fever' },
          { type: 'equals', path: '$.received[0].data.temp', expected: 40.1 },
        ],
      },
      'mqtt.yaml',
    );
    await runTests({ name: 't', runId: 'r', tests: [test], services: services(vars), concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    expect(results[0]?.checks.filter((c) => !c.passed)).toEqual([]);
    expect(results[0]?.status).toBe('passed');
  });
});
