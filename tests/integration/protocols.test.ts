import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  executeHttp,
  executeGraphQL,
  introspect,
  validateQuery,
  summarizeSchema,
  McpSession,
  createProvider,
  runAgent,
  WebSocketSession,
  runLoadTest,
  checkLoadSafeguards,
  Redactor,
  clearTokenCache,
  normalizeError,
  type McpTraceEvent,
  type AgentTool,
} from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { createRestServer, createGraphQLServer, createMockLlmServer, createWsServer, DEMO_TOKEN } from '../../examples/servers/demo-servers.mjs';

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const servers: Server[] = [];
let rest: string, gql: string, llm: string;
let wsServer: { close(cb: () => void): void; address(): AddressInfo };

beforeAll(async () => {
  const a = createRestServer();
  const b = createGraphQLServer();
  const c = createMockLlmServer();
  servers.push(a, b, c);
  [rest, gql, llm] = await Promise.all([listen(a), listen(b), listen(c)]);
  wsServer = createWsServer(0);
  await new Promise((r) => (wsServer as unknown as { once(e: string, cb: () => void): void }).once('listening', r));
});
afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await new Promise<void>((r) => wsServer.close(() => r()));
});

describe('HTTP client', () => {
  it('sends requests with auth, params, cookies and captures timing', async () => {
    const { response, prepared } = await executeHttp({
      method: 'POST',
      url: `${rest}/echo`,
      params: [{ key: 'q', value: 'rex' }, { key: 'off', value: 'x', enabled: false }],
      headers: [{ key: 'x-trace', value: '1' }],
      cookies: [{ key: 'sid', value: 'abc' }],
      auth: { type: 'bearer', token: 'tok-12345' },
      body: { type: 'json', content: '{"a":1}' },
    });
    expect(response.status).toBe(200);
    const j = response.json as { query: Record<string, string>; headers: Record<string, string>; body: string };
    expect(j.query).toEqual({ q: 'rex' });
    expect(j.headers.authorization).toBe('Bearer tok-12345');
    expect(j.headers.cookie).toBe('sid=abc');
    expect(j.headers['content-type']).toBe('application/json');
    expect(JSON.parse(j.body)).toEqual({ a: 1 });
    expect(response.cookies.map((c) => c.name)).toEqual(['session', 'theme']);
    expect(response.timeline.map((t) => t.name)).toEqual(['prepare', 'TCP connect', 'waiting (TTFB)', 'download', 'total']);
    expect(prepared.url).toContain('q=rex');
  });

  it('sends form and multipart bodies and runs OAuth2 client credentials', async () => {
    clearTokenCache();
    const { response } = await executeHttp({
      method: 'GET',
      url: `${rest}/patients`,
      auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: `${rest}/auth/token`, clientId: 'demo', clientSecret: 'demo-secret' },
    });
    expect(response.status).toBe(200);
    const r = new Redactor();
    const bad = await executeHttp({ method: 'GET', url: `${rest}/patients`, auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: `${rest}/auth/token`, clientId: 'x', clientSecret: 'nope-secret' } }, { redactor: r }).catch((e) => e);
    expect(bad.kind).toBe('AuthenticationError');
  });

  // RSS is noisy when the suite runs in parallel (other files allocate in the same process): retry the measurement
  it('streams large responses to disk with a bounded preview', { retry: 2 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aps-payload-'));
    try {
      const before = process.memoryUsage().rss;
      const { response } = await executeHttp({ method: 'GET', url: `${rest}/large?mb=25` }, { payloadDir: dir, maxPreviewBytes: 256 * 1024 });
      expect(response.size).toBeGreaterThan(24 * 1024 * 1024);
      expect(response.truncated).toBe(true);
      expect(response.bodyPreview.length).toBeLessThanOrEqual(256 * 1024);
      expect(response.json).toBeUndefined();
      expect(existsSync(response.payloadPath!)).toBe(true);
      expect(statSync(response.payloadPath!).size).toBe(response.size);
      // the full body was never held in memory
      expect(process.memoryUsage().rss - before).toBeLessThan(120 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delivers streamed chunks (SSE)', async () => {
    const chunks: string[] = [];
    await executeHttp({ method: 'GET', url: `${rest}/events?count=3` }, { onChunk: (c) => chunks.push(c) });
    expect(chunks.join('')).toContain('event: tick');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('normalises connection errors and supports cancellation', async () => {
    // a port that was just released, so nothing is listening on it
    const probe = createServer();
    const freeUrl = await listen(probe);
    await new Promise((r) => probe.close(r));
    const e = await executeHttp({ method: 'GET', url: freeUrl }).catch((x) => x);
    const n = normalizeError(e);
    expect(n.kind).toBe('NetworkError');
    expect(n.why).toMatch(/refused/);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(executeHttp({ method: 'GET', url: `${rest}/delay?ms=2000` }, { signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('GraphQL', () => {
  it('introspects, validates and executes', async () => {
    const { schema, sdl } = await introspect({ endpoint: `${gql}/graphql` });
    expect(sdl).toContain('type Patient');
    const summary = summarizeSchema(schema);
    expect(summary.queryType).toBe('Query');
    expect(summary.mutationType).toBe('Mutation');
    expect(summary.types.find((t) => t.name === 'Species')?.enumValues?.map((v) => v.name)).toContain('DOG');
    expect(validateQuery(schema, '{ patient(id: "1") { nickname } }')[0]!.message).toMatch(/Cannot query field "nickname"/);
    expect(validateQuery(schema, '{ patient(id: "1") { id } }')).toEqual([]);
    const r = await executeGraphQL({ endpoint: `${gql}/graphql`, query: 'query P($id: ID!) { patient(id: $id) { id name owner { name } } }', variables: '{"id":"123"}' });
    expect(r.operationType).toBe('query');
    expect(r.data).toEqual({ patient: { id: '123', name: 'Rex', owner: { name: 'Ada Lovelace' } } });
  });
});

describe('MCP (stdio)', () => {
  it('connects, discovers, calls tools and traces every message', async () => {
    const events: McpTraceEvent[] = [];
    const s = new McpSession({ id: 'c', name: 'customer-mcp', transport: 'stdio', command: process.execPath, args: [resolve('examples/servers/mcp-server.mjs')] });
    s.onEvent((e) => events.push(e));
    await s.connect();
    try {
      const d = await s.discover();
      expect(d.serverInfo?.name).toBe('customer-mcp');
      expect(d.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_customer', 'create_appointment']));
      expect(d.tools.find((t) => t.name === 'search_customer')!.inputSchema).toMatchObject({ type: 'object', properties: { customer_id: { type: 'string' } } });
      expect(d.resources.map((r) => r.uri)).toContain('clinic://info');
      expect(d.resourceTemplates[0]!.uriTemplate).toBe('customer://{id}');
      expect(d.prompts[0]!.name).toBe('summarize_customer');
      const r = await s.callTool('search_customer', { customer_id: '123' });
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({ customer: { id: '123' } });
      const bad = await s.callTool('search_customer', { customer_id: 'nope' });
      expect(bad.isError).toBe(true);
      const res = await s.readResource('customer://456');
      expect(JSON.parse((res.contents[0] as { text: string }).text).name).toBe('Alan Turing');
      const methods = events.map((e) => `${e.direction}:${e.method}:${e.kind}`);
      expect(methods).toContain('outgoing:initialize:request');
      expect(methods).toContain('incoming:initialize:response');
      expect(methods).toContain('outgoing:tools/call:request');
      const toolResp = events.find((e) => e.method === 'tools/call' && e.kind === 'response')!;
      expect(toolResp.durationMs).toBeGreaterThanOrEqual(0);
      expect(toolResp.request).toMatchObject({ name: 'search_customer' });
    } finally {
      await s.close();
    }
  });

  it('explains stdio startup failures', async () => {
    const s = new McpSession({ id: 'x', name: 'broken', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] });
    const e = await s.connect(5000).catch((x) => x);
    expect(e.kind).toBe('ProtocolError');
    expect(e.suggestions.join(' ')).toMatch(/stderr|command/);
  });
});

describe('LLM providers', () => {
  it('OpenAI-compatible: chat, structured output, streaming with TTFT, tools and embeddings', async () => {
    const p = createProvider({ id: 'm', name: 'Mock', kind: 'openai-compatible', baseUrl: `${llm}/v1` }, 'key-123');
    const r = await p.chat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'Classify: cancel my appointment' }], responseFormat: { type: 'json' } });
    expect(JSON.parse(r.text).intent).toBe('cancellation');
    expect(r.usage.totalTokens).toBe(r.usage.inputTokens + r.usage.outputTokens);
    const deltas: string[] = [];
    const s = await p.chat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'hello there' }], stream: true, onDelta: (d) => deltas.push(d) });
    expect(deltas.join('')).toBe(s.text);
    expect(s.timing.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(s.usage.totalTokens).toBeGreaterThan(0);
    const t = await p.chat({ model: 'mock-gpt', messages: [{ role: 'user', content: 'find customer 456' }], tools: [{ name: 'search_customer', inputSchema: { type: 'object' } }], stream: true });
    expect(t.toolCalls[0]).toMatchObject({ name: 'search_customer', arguments: { customer_id: '456' } });
    const [a, b] = await p.embed!(['cat', 'cat']);
    expect(a).toEqual(b);
    expect(await p.listModels!()).toContain('mock-gpt');
    const unauthorized = await createProvider({ id: 'm', name: 'Mock', kind: 'openai-compatible', baseUrl: `${llm}/v1` }, 'bad-key').chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(unauthorized.kind).toBe('AuthenticationError');
  });

  it('runs an agent loop against MCP tools', async () => {
    const s = new McpSession({ id: 'c', name: 'customer-mcp', transport: 'stdio', command: process.execPath, args: [resolve('examples/servers/mcp-server.mjs')] });
    await s.connect();
    try {
      const tools: AgentTool[] = (await s.listTools()).map((t) => ({
        ...t,
        source: 'mcp',
        server: 'customer-mcp',
        invoke: async (args) => {
          const r = await s.callTool(t.name, args);
          return { text: JSON.stringify(r.structuredContent ?? r.content), isError: r.isError };
        },
      }));
      const p = createProvider({ id: 'm', name: 'Mock', kind: 'openai-compatible', baseUrl: `${llm}/v1` }, undefined);
      const r = await runAgent({ provider: p, model: 'mock-gpt', input: 'book an appointment for customer 123', tools });
      expect(r.toolCalls.map((c) => c.name)).toEqual(['create_appointment']);
      expect(r.toolCalls[0]!.source).toBe('mcp');
      expect(r.finalText).toContain('booked');
      expect(r.stoppedReason).toBe('final');
      expect(r.modelCalls).toBe(2);
    } finally {
      await s.close();
    }
  });

  it('maps the Anthropic and Gemini wire formats', async () => {
    const seen: Record<string, any> = {};
    const fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/messages') {
          seen.anthropic = { headers: req.headers, body: j };
          res.end(JSON.stringify({ model: 'claude-x', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'lookup', input: { q: 1 } }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'tool_use' }));
        } else {
          seen.gemini = { url: req.url, headers: req.headers, body: j };
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'yo' }, { functionCall: { name: 'lookup', args: { q: 2 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }));
        }
      });
    });
    const base = await listen(fake);
    try {
      const messages = [
        { role: 'system' as const, content: 'be brief' },
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'tu0', name: 'lookup', arguments: { q: 0 } }] },
        { role: 'tool' as const, content: '{"r":1}', toolCallId: 'tu0', toolName: 'lookup' },
      ];
      const tools = [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }];
      const a = await createProvider({ id: 'a', name: 'A', kind: 'anthropic', baseUrl: base }, 'ak-1').chat({ model: 'claude-x', messages, tools, temperature: 0 });
      expect(seen.anthropic.headers['x-api-key']).toBe('ak-1');
      expect(seen.anthropic.headers['anthropic-version']).toBeTruthy();
      expect(seen.anthropic.body.system).toBe('be brief');
      expect(seen.anthropic.body.max_tokens).toBeGreaterThan(0);
      expect(seen.anthropic.body.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'tu0' });
      expect(seen.anthropic.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu0' });
      expect(seen.anthropic.body.tools[0]).toMatchObject({ name: 'lookup', input_schema: { type: 'object' } });
      expect(a).toMatchObject({ text: 'hi', toolCalls: [{ id: 'tu1', name: 'lookup', arguments: { q: 1 } }], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });

      const g = await createProvider({ id: 'g', name: 'G', kind: 'gemini', baseUrl: base }, 'gk-1').chat({ model: 'gemini-x', messages, tools, responseFormat: { type: 'json' } });
      expect(seen.gemini.url).toBe('/v1beta/models/gemini-x:generateContent');
      expect(seen.gemini.headers['x-goog-api-key']).toBe('gk-1');
      expect(seen.gemini.body.systemInstruction.parts[0].text).toBe('be brief');
      expect(seen.gemini.body.contents[1]).toMatchObject({ role: 'model', parts: [{ functionCall: { name: 'lookup' } }] });
      expect(seen.gemini.body.contents[2].parts[0].functionResponse).toEqual({ name: 'lookup', response: { r: 1 } });
      expect(seen.gemini.body.generationConfig.responseMimeType).toBe('application/json');
      expect(g).toMatchObject({ text: 'yo', toolCalls: [{ name: 'lookup', arguments: { q: 2 } }], usage: { totalTokens: 5 } });
    } finally {
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
    }
  });
});

describe('WebSocket', () => {
  it('connects, sends and receives', async () => {
    const s = new WebSocketSession(`ws://127.0.0.1:${wsServer.address().port}`);
    const msgs: string[] = [];
    s.onMessage((m) => msgs.push(`${m.direction}:${m.data}`));
    await s.connect();
    s.send('ping');
    await new Promise((r) => setTimeout(r, 150));
    s.close();
    expect(msgs.some((m) => m.startsWith('received:') && m.includes('welcome'))).toBe(true);
    expect(msgs).toContain('sent:ping');
    expect(msgs.some((m) => m.includes('"data":"ping"'))).toBe(true);
  });
});

describe('load testing', () => {
  it('measures throughput/percentiles and enforces safeguards', async () => {
    expect(() => checkLoadSafeguards({ target: { kind: 'http', request: { method: 'GET', url: 'x' } }, virtualUsers: 1, durationSec: 1 }, 'https://example.com/')).toThrow(/requires explicit opt-in/);
    expect(() => checkLoadSafeguards({ target: { kind: 'http', request: { method: 'GET', url: 'x' } }, virtualUsers: 1, durationSec: 1, environmentIsProduction: true }, `${rest}/health`)).toThrow(/production/);
    const snaps: number[] = [];
    const r = await runLoadTest(
      { target: { kind: 'http', request: { method: 'GET', url: `${rest}/health` } }, virtualUsers: 8, durationSec: 2, rampUpSec: 0.5 },
      { onSnapshot: (s) => snaps.push(s.requests) },
    );
    expect(r.done).toBe(true);
    expect(r.requests).toBeGreaterThan(50);
    expect(r.errors).toBe(0);
    expect(r.statusCodes['200']).toBe(r.requests);
    expect(r.latency.p99).toBeGreaterThanOrEqual(r.latency.p50);
    expect(snaps.length).toBeGreaterThanOrEqual(2);
  });

  it('reports AI metrics for LLM load tests', async () => {
    const { ProviderRegistry, VariableScope } = await import('../../packages/core/src/index.js');
    const providers = new ProviderRegistry([{ id: 'm', name: 'Mock', kind: 'openai-compatible', baseUrl: `${llm}/v1` }], new VariableScope());
    const r = await runLoadTest(
      { target: { kind: 'llm', model: { provider: 'm', name: 'mock-small' }, prompt: 'hello world', stream: true }, virtualUsers: 4, durationSec: 1 },
      { providers, pricing: [{ provider: '*', model: '*', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] },
    );
    expect(r.ai!.outputTokens).toBeGreaterThan(0);
    expect(r.ai!.ttft.count).toBeGreaterThan(0);
    expect(r.ai!.costUsd).toBeGreaterThan(0);
  });
});

describe('demo servers', () => {
  // a flow run without its data row sent /status?code={{code}}: writeHead(NaN) threw inside the async handler, the
  // unhandled rejection ended the process and every later e2e plan lost the demo servers
  it('answer a bad request with an error and keep running', async () => {
    for (const code of ['{{code}}', 'abc', '42', '600']) {
      const { response } = await executeHttp({ method: 'GET', url: `${rest}/status?code=${encodeURIComponent(code)}` });
      expect(response.status).toBe(400);
      expect(String((response.json as { error: string }).error)).toContain('100 and 599');
    }
    expect((await executeHttp({ method: 'GET', url: `${rest}/status?code=503` })).response.status).toBe(503);
    expect((await executeHttp({ method: 'GET', url: `${rest}/health` })).response.status).toBe(200);
  });
});

void DEMO_TOKEN;
