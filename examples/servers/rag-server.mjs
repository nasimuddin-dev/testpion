#!/usr/bin/env node
/**
 * A small deterministic RAG system for TestPion examples, docs and tests: a four-document corpus, retrieval by word
 * overlap, and an answer built from the best document. Nothing here talks to the internet and no model is involved.
 *
 *   node examples/servers/rag-server.mjs            # HTTP, SSE, WebSocket and gRPC on the ports below
 *   node examples/servers/rag-server.mjs --mcp      # the same system as an MCP server on stdio (tool: ask)
 *
 *   HTTP JSON    POST http://127.0.0.1:4020/query    {"question": "..."} → {answer, sources:[{id,text,score,metadata:{source}}], usage}
 *                with "documents": [{id,text}] (or strings) the system answers from THOSE documents instead of retrieving (what "which document mattered?" needs)
 *   SSE          POST http://127.0.0.1:4020/stream   events {type:"sources"}, {type:"delta"} …, then [DONE]
 *   WebSocket    ws://127.0.0.1:4020/ws              send {"question": "..."} → {type:"sources"}, {type:"delta"} …, {type:"done"}
 *   gRPC         127.0.0.1:4021                      rag.v1.Rag/Ask (examples/servers/rag.proto)
 *
 * Seeded defects, so evaluations have something to find: a question about parking is answered with a claim no document
 * supports (unfaithful); a question about the weather retrieves nothing useful (a retrieval miss).
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const CORPUS = [
  { id: 'doc-1', source: 'hours.md', text: 'The clinic opens at 8am on weekdays and 9am on Saturdays.' },
  { id: 'doc-2', source: 'vaccines.md', text: 'Vaccinations for dogs include rabies and distemper; a booster is due every year.' },
  { id: 'doc-3', source: 'policy.md', text: 'Appointments can be cancelled up to 24 hours before without a fee.' },
  { id: 'doc-4', source: 'emergency.md', text: 'Emergency care is available around the clock at the main clinic.' },
];

const STOP = new Set('a an the and or of to in on at by for with is are was were be do does did can what when how who where which i my you your it its this that'.split(' '));
const words = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));

/** The documents that share words with the question, best first, with a 0..1 score. With `from`, the documents given instead of the corpus. */
export function retrieve(question, from = CORPUS) {
  const q = new Set(words(question));
  return from.map((d) => {
    const dw = new Set(words(d.text));
    const hit = [...q].filter((w) => dw.has(w)).length;
    return { ...d, score: q.size ? Math.round((hit / q.size) * 100) / 100 : 0 };
  })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3);
}

/** The answer: the best document, plus the seeded unsupported claim for questions about parking. */
export function answerFor(question, sources) {
  if (!sources.length) return 'I do not know.';
  const base = sources[0].text;
  return /parking/i.test(question) ? `${base} Parking is free for two hours.` : base;
}

const tokens = (s) => Math.ceil(s.length / 4);

export function ask(question, documents) {
  const given = Array.isArray(documents) ? documents.map((d, i) => (typeof d === 'string' ? { id: `given-${i + 1}`, source: 'given', text: d } : { id: String(d.id ?? `given-${i + 1}`), source: String(d.source ?? 'given'), text: String(d.text ?? '') })) : undefined;
  const sources = retrieve(question, given);
  const answer = answerFor(question, sources);
  return { answer, sources, usage: { prompt_tokens: tokens(question) + sources.reduce((n, d) => n + tokens(d.text), 0), completion_tokens: tokens(answer) } };
}

const asHttp = (r) => ({ answer: r.answer, sources: r.sources.map((d) => ({ id: d.id, text: d.text, score: d.score, metadata: { source: d.source } })), usage: r.usage });

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

/** Starts HTTP + SSE + WebSocket on `port` and gRPC on `grpcPort` (0: any free port). */
export async function startRagServer({ port = 4020, grpcPort = 4021, host = '127.0.0.1' } = {}) {
  const http = createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      if (req.method === 'POST' && req.url === '/query') {
        const r = ask(String(body.question ?? ''), body.documents);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(asHttp(r)));
      }
      if (req.method === 'POST' && req.url === '/stream') {
        const r = asHttp(ask(String(body.question ?? '')));
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'sources', sources: r.sources })}\n\n`);
        for (const piece of r.answer.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ type: 'delta', delta: piece })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'usage', usage: r.usage })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (ws) =>
    ws.on('message', (raw) => {
      let question = '';
      try {
        question = String(JSON.parse(String(raw)).question ?? '');
      } catch {
        question = String(raw);
      }
      const r = asHttp(ask(question));
      ws.send(JSON.stringify({ type: 'sources', sources: r.sources }));
      for (const piece of r.answer.split(/(?<= )/)) ws.send(JSON.stringify({ type: 'delta', delta: piece }));
      ws.send(JSON.stringify({ type: 'done', usage: r.usage }));
    }),
  );
  // a port already in use rejects here (the WebSocket server would re-emit the error unhandled)
  wss.on('error', () => undefined);
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => (http.off('error', reject), resolve()));
  });

  const def = protoLoader.loadSync(fileURLToPath(new URL('./rag.proto', import.meta.url)), { keepCase: true, defaults: true });
  const pkg = grpc.loadPackageDefinition(def);
  const g = new grpc.Server();
  g.addService(pkg.rag.v1.Rag.service, {
    Ask: (call, cb) => {
      const r = ask(String(call.request.question ?? ''));
      cb(null, { answer: r.answer, sources: r.sources.map((d) => ({ id: d.id, text: d.text, score: d.score, source: d.source })) });
    },
  });
  const boundGrpc = await new Promise((resolve, reject) => g.bindAsync(`${host}:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));

  return {
    httpUrl: `http://${host}:${http.address().port}`,
    wsUrl: `ws://${host}:${http.address().port}/ws`,
    grpcTarget: `${host}:${boundGrpc}`,
    async close() {
      wss.close();
      await new Promise((resolve) => http.close(resolve));
      g.forceShutdown();
    },
  };
}

if (process.argv.includes('--mcp')) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'rag-mcp', version: '1.0.0' });
  server.registerTool('ask', { title: 'Ask the clinic knowledge base', description: 'Answers a question from the clinic documents and returns the sources.', inputSchema: { question: z.string() } }, async ({ question }) => {
    const r = asHttp(ask(question));
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  });
  await server.connect(new StdioServerTransport());
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await startRagServer();
  console.log(`RAG demo: ${s.httpUrl}/query (JSON), ${s.httpUrl}/stream (SSE), ${s.wsUrl} (WebSocket), ${s.grpcTarget} (gRPC)`);
}
