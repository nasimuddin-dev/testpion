// gRPC-Web: a gRPC call over HTTP/1.1 (Envoy, a grpc-web proxy). A small gRPC-Web server runs in the main process; the
// app calls it through its own RPC (grpc.send) with the protos and `web: true`, as the gRPC editor's switch does.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const PORT = 47391;
const PROTO = 'syntax = "proto3";\\npackage hi;\\nservice Hello { rpc Say (SayRequest) returns (SayReply); }\\nmessage SayRequest { string name = 1; }\\nmessage SayReply { string text = 1; }\\n';

const steps = [
  [
    'a-grpc-web-server',
    `main:
      const http = require('node:http');
      const protobuf = require('protobufjs');
      const root = protobuf.parse('${PROTO}', { keepCase: true }).root;
      const Req = root.lookupType('hi.SayRequest'), Res = root.lookupType('hi.SayReply');
      const frame = (flag, bytes) => { const b = Buffer.alloc(5 + bytes.length); b[0] = flag; b.writeUInt32BE(bytes.length, 1); Buffer.from(bytes).copy(b, 5); return b; };
      const server = http.createServer((req, res) => {
        const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
          const body = Buffer.concat(chunks); const m = Req.decode(body.subarray(5, 5 + body.readUInt32BE(1)));
          res.setHeader('content-type', 'application/grpc-web+proto');
          res.end(Buffer.concat([frame(0, Res.encode({ text: 'hello ' + m.name }).finish()), frame(0x80, Buffer.from('grpc-status: 0\\r\\n'))]));
        });
      });
      await new Promise((r, j) => { server.once('error', j); server.listen(${PORT}, '127.0.0.1', r); });
      global.__grpcWebServer = server;
      return 'listening';`,
    false,
  ],
  [
    'the-app-calls-it-over-grpc-web',
    `(async () => {
      const r = await window.aps.invoke('grpc.send', { target: 'http://127.0.0.1:${PORT}', web: true, method: 'hi.Hello/Say', message: '{"name":"app"}', protoFiles: [{ name: 'hi.proto', text: '${PROTO}' }] });
      return 'code: ' + r.codeName + ' | response: ' + JSON.stringify(r.response);
    })()`,
  ],
  [
    'stop-the-server',
    `main:
      await new Promise((r) => global.__grpcWebServer.close(() => r()));
      return 'stopped';`,
    false,
  ],
];

module.exports = withExpect(steps, {
  'the-app-calls-it-over-grpc-web': /^code: OK \| response: \{"text":"hello app"\}$/,
});
