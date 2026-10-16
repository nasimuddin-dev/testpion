import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { MockProvider } from '../../packages/core/src/ai/providers/mock.js';

// The desktop backend is the app's whole RPC surface (and a future server's); its handlers live in one
// module per domain (apps/desktop/backend/handlers). This checks they compose and work end to end.
const home = mkdtempSync(join(tmpdir(), 'tp-backend-'));
const events: string[] = [];
const be = new Backend({ appDir: home, emit: (channel) => void events.push(channel) });
const call = (method: string, params: unknown = {}) => {
  const h = be.handlers[method];
  if (!h) throw new Error(`no RPC method ${method}`);
  return h(params);
};

afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('desktop backend', () => {
  it('exposes every domain through one RPC table', () => {
    const domains = new Set(Object.keys(be.handlers).map((m) => m.split('.')[0]));
    for (const d of ['app', 'settings', 'ws', 'env', 'col', 'http', 'gql', 'mcp', 'ai', 'tests', 'runs', 'load', 'wsock', 'grpc', 'monitor']) expect(domains).toContain(d);
    expect(Object.keys(be.handlers).length).toBeGreaterThan(100);
  });

  it('opens a starter workspace and answers calls from each domain', async () => {
    const info = (await call('app.info')) as { version: string; checkTypes: string[] };
    expect(info.version).toMatch(/\d+\.\d+\.\d+/);
    expect(info.checkTypes).toContain('status');
    const ws = (await call('ws.current')) as { name: string };
    expect(ws.name).toBe('My Workspace');
    expect(await call('col.list')).toEqual([]);
    expect(Array.isArray(await call('env.list'))).toBe(true);
    expect(await call('mcp.servers')).toEqual([]);
    expect(await call('prompt.variables', { template: 'Hi {{name}}' })).toEqual(['name']);
    expect((await call('settings.get')) as object).toHaveProperty('theme');
  });

  it('reports errors as structured values, not crashes', async () => {
    await expect(Promise.resolve().then(() => call('mcp.ping', { serverId: 'nope' }))).rejects.toThrow(/not connected|nope/i);
  });

  it('monitors: save, list, run now, and the scheduler runs due ones (events for the UI)', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      await call('col.save', { schemaVersion: '1.0', id: 'c-mon', name: 'Mon', version: 0, variables: [], updatedAt: '', items: [{ kind: 'request', id: 'r1', name: 'Ping', request: { method: 'GET', url, headers: [], params: [] }, assertions: [{ type: 'status', expected: 200 }] }] });
      await expect(Promise.resolve().then(() => call('monitor.save', { monitor: { name: 'Ping', collectionId: 'c-mon', everyMinutes: 0, enabled: true } }))).rejects.toThrow(/1 minute/);
      const saved = (await call('monitor.save', { monitor: { name: 'Ping', collectionId: 'c-mon', everyMinutes: 5, enabled: true } })) as { id: string; schedule: string; due: boolean };
      expect(saved).toMatchObject({ schedule: 'every 5 minutes', due: true });
      const r = (await call('monitor.run', { id: saved.id })) as { status: string; trigger: string };
      expect(r).toMatchObject({ status: 'passed', trigger: 'manual' });
      expect(events).toContain('monitor.result');
      expect(((await call('monitor.list')) as Array<{ due: boolean; running: boolean }>)[0]).toMatchObject({ due: false, running: false });
      // due again 5 minutes later: the scheduler runs it
      expect(await be.monitorScheduler.tick(Date.now() + 6 * 60_000)).toBe(1);
      expect(((await call('monitor.results', { id: saved.id })) as Array<{ trigger: string }>).map((x) => x.trigger)).toEqual(['schedule', 'manual']);
      await call('monitor.delete', { id: saved.id });
      expect(await call('monitor.list')).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('WebSocket messages resolve {{variables}} before they are sent', async () => {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    const got: string[] = [];
    wss.on('connection', (ws) => ws.on('message', (d) => got.push(String(d))));
    try {
      const { id } = (await call('wsock.connect', { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` })) as { id: string };
      await call('wsock.send', { id, data: '{"id":"{{$guid}}","plain":"x"}' });
      for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 25));
      expect(got[0]).toMatch(/^\{"id":"[0-9a-f-]{36}","plain":"x"\}$/);
      await call('wsock.close', { id });
    } finally {
      wss.close();
    }
  });

  it('settings.save refuses malformed certificates and proxy URLs', async () => {
    const current = (await call('settings.get')) as Record<string, unknown>;
    await expect(Promise.resolve().then(() => call('settings.save', { ...current, tls: { extraCa: '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----' } }))).rejects.toThrow(/Extra CA certificates/);
    await expect(Promise.resolve().then(() => call('settings.save', { ...current, proxy: { mode: 'custom', url: 'proxy:8080 x' } }))).rejects.toThrow(/not a URL/);
  });

  it('settings.save keeps the desktop preferences (rail, density, keybindings) in the shape the window reads', async () => {
    const current = (await call('settings.get')) as Record<string, unknown>;
    const bad = (await call('settings.save', { ...current, rail: { order: 'home', shown: [1, 'tests'] }, density: 7, keybindings: 'Mod+K' })) as Record<string, unknown>;
    expect(bad.rail).toEqual({ shown: ['tests'] });
    expect(bad).not.toHaveProperty('density');
    expect(bad).not.toHaveProperty('keybindings');
    const good = (await call('settings.save', { ...current, rail: { order: ['home', 'tests'], shown: ['home'] }, density: 'compact', keybindings: { palette: 'Mod+J' } })) as Record<string, unknown>;
    expect(good).toMatchObject({ rail: { order: ['home', 'tests'], shown: ['home'] }, density: 'compact', keybindings: { palette: 'Mod+J' } });
    await call('settings.save', { ...current });
  });

  it('vars.setInEnvironment adds a variable to an environment, then updates it (the {{variable}} popover)', async () => {
    const env = { id: 'pop-env', name: 'Popover', variables: [{ key: 'baseUrl', value: 'http://a', enabled: true }] };
    await call('env.save', { env });
    await call('vars.setInEnvironment', { environment: 'pop-env', name: 'token', value: 't1' });
    await call('vars.setInEnvironment', { environment: 'Popover', name: 'baseUrl', value: 'http://b' });
    const saved = ((await call('env.list')) as Array<{ id: string; variables: Array<{ key: string; value: string }> }>).find((e) => e.id === 'pop-env')!;
    expect(saved.variables).toEqual([
      { key: 'baseUrl', value: 'http://b', enabled: true },
      { key: 'token', value: 't1', enabled: true },
    ]);
    const inspect = (await call('vars.inspect', { environment: 'pop-env', template: '{{token}}' })) as Array<{ name: string; scope?: string; value?: string }>;
    expect(inspect[0]).toMatchObject({ name: 'token', scope: 'environment', value: 't1' });
    await expect(Promise.resolve().then(() => call('vars.setInEnvironment', { environment: 'nope', name: 'x', value: '1' }))).rejects.toThrow(/environment/);
    await expect(Promise.resolve().then(() => call('vars.setInEnvironment', { environment: 'pop-env', name: 'bad name', value: '1' }))).rejects.toThrow(/valid variable name/);
  });

  it('assistant: follow-ups carry the conversation, answers stream, secrets stay hidden', async () => {
    await call('ai.saveProviders', { providers: [{ id: 'mock-as', name: 'Mock', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'demo' }] });
    const current = (await call('settings.get')) as object;
    await call('settings.save', { ...current, assistantProvider: 'mock-as', assistantModel: 'demo' });
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const chat = MockProvider.prototype.chat;
    MockProvider.prototype.chat = function (req) {
      seen.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
      return chat.call(this, req);
    };
    try {
      const context = { request: { method: 'GET', url: 'https://api.example.test/pets', headers: [{ key: 'Authorization', value: 'Bearer abc123' }] } };
      const first = (await call('assistant.ask', { task: 'free', context, question: 'Why 404?', requestId: 'as-1' })) as { text: string };
      expect(first.text).toContain('Why 404?');
      expect(seen[0]![1]!.content).toContain('Context:');
      expect(seen[0]![1]!.content).toContain('api.example.test/pets');
      expect(seen[0]![1]!.content).not.toContain('abc123');
      expect(events).toContain('assistant.deltas');
      const history = [
        { role: 'user', content: 'Why 404?' },
        { role: 'assistant', content: first.text },
      ];
      const second = (await call('assistant.ask', { task: 'free', context, question: 'And how do I fix it?', history })) as { text: string };
      expect(second.text).toContain('And how do I fix it?');
      const msgs = seen[1]!;
      expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      // the context stays with the first turn; the follow-up is just the question
      expect(msgs[1]!.content).toContain('api.example.test/pets');
      expect(msgs[3]!.content).toBe('And how do I fix it?');
      // a follow-up may answer in prose (a task's output-only rule is for its first answer)
      expect(msgs[0]!.content).toContain('follow-up');
      expect(seen[0]![0]!.content).not.toContain('follow-up');
    } finally {
      MockProvider.prototype.chat = chat;
    }
  });
});
