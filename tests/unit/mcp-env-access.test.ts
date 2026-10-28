import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEngineContext, createTestPionMcpServer, defaultSettings, EnvSecretStore, WorkspaceManager, type AppSettings, type WorkspaceStore } from '../../packages/core/src/index.js';

// Security review 2026-10-27, P1: the MCP server resolved {{$env.NAME}} for EVERY environment variable unless Settings listed some. An API
// response under test could tell an agent to call send_request with a header {{$env.AWS_SECRET_ACCESS_KEY}}. Now: no variable unless the
// person allows it (setting envVariables); the CLI run commands keep reading all of them; the agent is told plainly why a variable was left.
const dir = mkdtempSync(join(tmpdir(), 'tp-mcp-env-'));
const CANARY = 'canary-value-7f3a';
let store: WorkspaceStore;
let stub: Server;
let port = 0;
const seen: Array<string | undefined> = [];

beforeAll(async () => {
  process.env.TP_CANARY_ENV = CANARY;
  const ws = join(dir, 'ws');
  cpSync(join(process.cwd(), 'examples', 'veterinary-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\/](runs|traces|payloads)([\/]|$)/.test(p) });
  store = new WorkspaceManager(join(dir, 'home')).open(ws);
  stub = createServer((req, res) => {
    seen.push(req.headers['x-canary'] as string | undefined);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  port = (stub.address() as { port: number }).port;
});
afterAll(async () => {
  delete process.env.TP_CANARY_ENV;
  stub?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function sendWith(settings: AppSettings) {
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const r = await client.callTool({ name: 'send_request', arguments: { method: 'GET', url: `http://127.0.0.1:${port}/x`, headers: { 'x-canary': '{{$env.TP_CANARY_ENV}}' } } });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
    return { text, structured: r.structuredContent as Record<string, unknown> | undefined };
  } finally {
    await client.close();
  }
}

describe('{{$env}} in the MCP server', () => {
  it('default settings: the stub never sees the variable, and the agent is told how it can be allowed', async () => {
    seen.length = 0;
    const r = await sendWith(defaultSettings());
    expect(seen).toHaveLength(1);
    expect(seen[0] ?? '').not.toContain(CANARY);
    expect(r.text).not.toContain(CANARY);
    expect(r.text).toContain('blockedEnvVariables');
    expect(r.text).toContain('TP_CANARY_ENV');
    expect(r.text).toMatch(/not resolved/);
    expect(r.text).toContain('envVariables');
  });

  it('an explicit empty list changes nothing', async () => {
    seen.length = 0;
    await sendWith({ ...defaultSettings(), envVariables: [] });
    expect(seen[0] ?? '').not.toContain(CANARY);
  });

  it('the person allowing the name (Settings > Privacy, envVariables) lets it through, and only that name', async () => {
    seen.length = 0;
    const r = await sendWith({ ...defaultSettings(), envVariables: ['tp_canary_env'] });
    expect(seen[0]).toBe(CANARY);
    expect(r.text).not.toContain('blockedEnvVariables');
    seen.length = 0;
    await sendWith({ ...defaultSettings(), envVariables: ['SOMETHING_ELSE'] });
    expect(seen[0] ?? '').not.toContain(CANARY);
  });
});

describe('createEngineContext', () => {
  const lookup = async (o: { envAccess?: 'all' | string[]; settings?: AppSettings }) => {
    const ctx = createEngineContext({ store, secrets: new EnvSecretStore(), settings: o.settings ?? defaultSettings(), envAccess: o.envAccess });
    try {
      return ctx.vars.resolve('{{$env.TP_CANARY_ENV}}');
    } finally {
      await ctx.dispose();
    }
  };

  it('reads no environment variable by default (nothing but the caller can widen it)', async () => {
    expect(await lookup({})).not.toContain(CANARY);
  });

  it("'all' is the caller's explicit choice (the CLI run commands)", async () => {
    expect(await lookup({ envAccess: 'all' })).toBe(CANARY);
  });

  it('the CLI context asks for all unless Settings lists some (cli/shared.ts)', async () => {
    const { cliContext } = await import('../../packages/cli/src/shared.js');
    const ctx = cliContext(store);
    try {
      expect(ctx.vars.resolve('{{$env.TP_CANARY_ENV}}')).toBe(CANARY);
    } finally {
      await ctx.dispose();
    }
  });
});
