// A server that speaks MCP 2026-07-28 over HTTP (the v2 SDK's fetch-style handler on node:http), for the tests of the
// revision TestPion negotiates. `strict`: the 2026 revision only; otherwise 2025 clients are served too.
// Prints "listening <port>" when it is up.
import { createServer } from 'node:http';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

const factory = () => {
  const s = new Server({ name: 'modern', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'A server of the 2026-07-28 revision.' });
  s.setRequestHandler('tools/list', async () => ({
    tools: [{ name: 'echo', description: 'Echo the text back. Use it to check that a call goes through.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to send back' } }, required: ['text'] } }],
  }));
  s.setRequestHandler('tools/call', async (req) =>
    req.params.name === 'echo' ? { content: [{ type: 'text', text: String(req.params.arguments?.text ?? '') }] } : { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] },
  );
  return s;
};
const handler = createMcpHandler(factory, process.argv[2] === 'strict' ? { legacy: 'reject' } : {});
const http = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks) });
    const r = await handler.fetch(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});
http.listen(0, '127.0.0.1', () => console.log(`listening ${http.address().port}`));
