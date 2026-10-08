import { describe, it, expect, afterAll } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Server } from 'socket.io';
import { VariableScope, normalizeTest, runRealtimeExchange, runTests, type ExecServices, type TestResult } from '../../packages/core/src/index.js';

const services = (vars?: VariableScope): ExecServices => fakeServices({ scope: vars, timeoutMs: 10_000 });
async function runOne(raw: Record<string, unknown>, vars?: VariableScope): Promise<TestResult> {
  const results: TestResult[] = [];
  await runTests({ name: 't', runId: 'r', tests: [normalizeTest(raw, 'ws.yaml')], services: services(vars), concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
  return results[0]!;
}

const closers: Array<() => void> = [];
afterAll(() => closers.forEach((c) => c()));

describe('realtime exchange (CLI `testpion ws`, MCP realtime_exchange)', () => {
  it('WebSocket: sends messages in order and collects the replies', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.on('message', (d) => ws.send(`echo:${d}`)));
    closers.push(() => wss.close());
    const r = await runRealtimeExchange({ url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, send: ['a', 'b'], waitMs: 300 });
    expect(r).toMatchObject({ mode: 'websocket', connected: true });
    expect(r.messages.filter((m) => m.direction === 'received').map((m) => m.data)).toEqual(['echo:a', 'echo:b']);
  });

  it('Socket.IO: emits events with acknowledgements (mode from the http URL)', async () => {
    const http = createServer();
    const io = new Server(http);
    io.on('connection', (s) => s.on('add', (a: number, b: number, ack: (n: number) => void) => ack(a + b)));
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', () => ok()));
    closers.push(() => io.close());
    const r = await runRealtimeExchange({ url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, send: [{ event: 'add', args: [2, 3], ack: true }], waitMs: 100 });
    expect(r.mode).toBe('socketio');
    expect(r.messages.find((m) => m.ack)?.data).toBe('5');
  });

  it('reports a failed connection once, without throwing', async () => {
    const r = await runRealtimeExchange({ url: 'ws://127.0.0.1:1', waitMs: 0 });
    expect(r.connected).toBe(false);
    expect(r.messages.filter((m) => /connection refused/.test(m.data))).toHaveLength(1);
  });
});

describe('websocket test type', () => {
  it('WebSocket: sends text and JSON, asserts on parsed replies', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    wss.on('connection', (ws) => ws.on('message', (d) => ws.send(String(d).startsWith('{') ? JSON.stringify({ echo: JSON.parse(String(d)) }) : `echo:${d}`)));
    closers.push(() => wss.close());
    const vars = new VariableScope();
    vars.setScope('environment', [{ key: 'wsUrl', value: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, enabled: true }]);
    const r = await runOne(
      {
        name: 'echo',
        type: 'websocket',
        url: '{{wsUrl}}',
        send: ['hello', { type: 'ping', n: 1 }],
        waitMs: 300,
        assertions: [
          { type: 'status', expected: 101 },
          { type: 'equals', path: '$.received[0]', expected: 'echo:hello' },
          { type: 'equals', path: '$.received[1].echo.type', expected: 'ping' },
          { type: 'length', path: '$.received', expected: 2 },
          { type: 'contains', expected: 'echo:hello' },
        ],
      },
      vars,
    );
    expect(r.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.status).toBe('passed');
  });

  it('Socket.IO: events with acknowledgements, as { event, data }', async () => {
    const http = createServer();
    const io = new Server(http);
    io.on('connection', (s) => {
      s.emit('welcome', { hi: true });
      s.on('add', (a: number, b: number, ack: (n: number) => void) => ack(a + b));
    });
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', () => ok()));
    closers.push(() => io.close());
    const r = await runOne({
      name: 'sio',
      type: 'socketio',
      url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      send: [{ event: 'add', args: [2, 3], ack: true }],
      waitMs: 200,
      assertions: [{ type: 'equals', path: '$.received[0].event', expected: 'welcome' }, { type: 'equals', path: '$.received[0].data.hi', expected: true }],
    });
    expect(r.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.status).toBe('passed');
  });

  it('a refused connection is an error with the reason', async () => {
    const r = await runOne({ name: 'down', type: 'websocket', url: 'ws://127.0.0.1:1', waitMs: 0 });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/Could not connect .*refused/i);
  });
});
