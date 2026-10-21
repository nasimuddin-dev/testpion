/**
 * `testpion rag capture` and the MCP tool `rag_capture_dataset` over real processes: a dataset from History entries and a saved
 * Debugger session, masking before the write, the dry run, and a refusal to replace a file. No model, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody } from '../../packages/core/src/index.js';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-capture-');
let ws: WorkspaceStore;
let session: McpSession;
const home = () => join(t.dir, 'home');
const cli = (args: string[]) => runCli(args, { home: home() });

const answer = (a: string) => JSON.stringify({ answer: a, sources: [{ id: 'hours', text: 'The clinic is open 8 to 6.', score: 0.9 }] });

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'Capture');
  ws.saveLibrary('rag-targets', {
    folders: [],
    items: [{ id: 'rag-http', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: '{{ragUrl}}/query', json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }],
  });
  mkdirSync(ws.path('payloads'), { recursive: true });
  const asked = ['When are you open? I am jane.roe@example.org', 'Do you take walk-ins?'];
  asked.forEach((q, i) => {
    const p = ws.path('payloads', `p${i}.bin`);
    writeFileSync(p, answer(`Answer ${i}. Call 415-555-0199`));
    ws.meta.addHistory({ id: `h${i}`, timestamp: `2026-10-01T10:00:0${i}.000Z`, kind: 'http', name: 'ask', method: 'POST', url: 'https://rag.example.com/query', status: 200, durationMs: 5, request: { method: 'POST', url: '{{ragUrl}}/query', headers: [{ key: 'Authorization', value: 'Bearer abcdefghijklmnop0123456789', enabled: true }], body: { type: 'json', content: JSON.stringify({ question: q }) } }, payloadPath: p, responseMeta: { headers: [['content-type', 'application/json']] } });
  });
  mkdirSync(ws.path('debugger'), { recursive: true });
  writeFileSync(
    ws.path('debugger', 'monday.har'),
    JSON.stringify({ log: { entries: [{ startedDateTime: '2026-10-02T09:00:00Z', time: 20, request: { method: 'POST', url: 'https://rag.example.com/query', postData: { mimeType: 'application/json', text: '{"question":"Where do I park?"}' } }, response: { status: 200, content: { text: answer('Behind the building.') } } }] } }),
  );
  session = new McpSession({ id: 'cap', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws.root], env: { ...process.env, TESTPION_HOME: home() } as Record<string, string> });
  await session.connect(30_000);
}, 60_000);
afterAll(async () => {
  await session?.close();
  ws.close();
  t.cleanup();
});

describe('testpion rag capture', () => {
  it('a dry run reports and writes nothing', async () => {
    const r = await cli(['rag', 'capture', '--target', 'Clinic HTTP', '--dry-run', '--json', '-w', ws.root]);
    expect(r.status).toBe(0);
    const d = cliData<{ report: { read: number; records: number; masked: { strings: number } }; preview: Array<{ question: string }>; written?: unknown }>(r.out);
    expect(d.report).toMatchObject({ read: 2, records: 2 });
    expect(d.report.masked.strings).toBeGreaterThan(0);
    expect(d.written).toBeUndefined();
    expect(existsSync(ws.path('datasets', 'captured.jsonl'))).toBe(false);
  });

  it('writes a dataset from History with the email and phone masked and no header in it', async () => {
    const r = await cli(['rag', 'capture', '--target', 'Clinic HTTP', '--name', 'prod', '--json', '-w', ws.root]);
    expect(r.status).toBe(0);
    expect(cliData<{ written: { path: string; rows: number } }>(r.out).written).toEqual({ path: 'datasets/prod.jsonl', rows: 2 });
    const text = readFileSync(ws.path('datasets', 'prod.jsonl'), 'utf8');
    expect(text).not.toMatch(/jane\.roe@example\.org|415-555-0199|Authorization|abcdefghijklmnop/);
    expect(text).toContain('"tags":["captured","history"]');
    const again = await cli(['rag', 'capture', '--target', 'Clinic HTTP', '--name', 'prod', '-w', ws.root]);
    expect(again.status).toBe(2);
    expect(again.err + again.out).toMatch(/exists already/);
  });

  it('reads a saved Debugger session, and a wrong target is a configuration error', async () => {
    const r = await cli(['rag', 'capture', '--target', 'Clinic HTTP', '--session', 'monday', '--name', 'monday', '--as-questions', '--json', '-w', ws.root]);
    expect(r.status).toBe(0);
    const line = JSON.parse(readFileSync(ws.path('datasets', 'monday.jsonl'), 'utf8').trim());
    expect(line).toMatchObject({ question: 'Where do I park?', tags: ['captured', 'debugger'] });
    expect(line.answer).toBeUndefined();
    expect((await cli(['rag', 'capture', '--target', 'Nope', '-w', ws.root])).status).toBe(2);
  });
});

describe('rag_capture_dataset over MCP', () => {
  it('previews, then writes, with the same masking', async () => {
    const call = async (args: Record<string, unknown>) => {
      const r = await session.callTool('rag_capture_dataset', args);
      const text = mcpResultBody(r).text;
      return { isError: r.isError, text, data: (r.isError ? {} : JSON.parse(text)) as { report: { records: number }; written?: { path: string } } };
    };
    const dry = await call({ target: 'Clinic HTTP', dedupe: true, dry_run: true });
    expect(dry.data.report.records).toBe(2);
    expect(dry.data.written).toBeUndefined();
    const real = await call({ target: 'Clinic HTTP', name: 'mcp-made', limit: 1, confirm: true });
    expect(real.data.written?.path).toBe('datasets/mcp-made.jsonl');
    expect(readFileSync(ws.path('datasets', 'mcp-made.jsonl'), 'utf8')).not.toContain('415-555-0199');
    const again = await call({ target: 'Clinic HTTP', name: 'mcp-made', confirm: true });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/exists already/);
  });
});
