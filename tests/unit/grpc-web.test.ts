import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import protobuf from 'protobufjs';
import { executeGrpc } from '../../packages/core/src/index.js';
import { grpcWebFrame, grpcWebFrames } from '../../packages/core/src/protocols/grpc/grpc-web.js';

// gRPC-Web: the same protos and message JSON, over HTTP/1.1 (Envoy's grpc_web filter, a grpc-web proxy): a POST of
// application/grpc-web+proto with the message in a frame, the answer's frames read back with the trailers.
const PROTO_TEXT = `syntax = "proto3";
package hi;
service Hello {
  rpc Say (SayRequest) returns (SayReply);
  rpc Count (CountRequest) returns (stream Num);
  rpc Fail (SayRequest) returns (SayReply);
}
message SayRequest { string name = 1; }
message SayReply { string text = 1; int64 big = 2; }
message CountRequest { int32 upTo = 1; }
message Num { int32 n = 1; }
`;
const PROTO = [{ name: 'hi.proto', text: PROTO_TEXT }];
const root = protobuf.parse(PROTO_TEXT, { keepCase: true }).root;
const T = (n: string) => root.lookupType(n);

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/plain/hi.Hello/Say') return void (res.writeHead(404, { 'content-type': 'text/html' }), res.end('<h1>no</h1>'));
      if (req.url === '/empty/hi.Hello/Say') return void (res.writeHead(200, { 'content-type': 'application/grpc-web+proto' }), res.end());
      if (req.url === '/badmsg/hi.Hello/Say') return void (res.writeHead(200, { 'content-type': 'application/grpc-web+proto', 'grpc-status': '13', 'grpc-message': 'bad %ZZ 100%' }), res.end());
      const [frame] = grpcWebFrames(Buffer.concat(chunks));
      const trailer = (status: number, message = '') => grpcWebFrame(0x80, Buffer.from(`grpc-status: ${status}\r\ngrpc-message: ${encodeURIComponent(message)}\r\nx-served-by: test\r\n`));
      res.setHeader('content-type', 'application/grpc-web+proto');
      res.setHeader('x-request-auth', String(req.headers['authorization'] ?? ''));
      if (req.url === '/prefix/hi.Hello/Say' || req.url === '/hi.Hello/Say') {
        const m = T('hi.SayRequest').decode(frame!.bytes) as unknown as { name: string };
        const reply = T('hi.SayReply')
          .encode({ text: `hello ${m.name}`, big: '9007199254740993' })
          .finish();
        return void res.end(Buffer.concat([grpcWebFrame(0, reply), trailer(0)]));
      }
      if (req.url === '/hi.Hello/Count') {
        const m = T('hi.CountRequest').decode(frame!.bytes) as unknown as { upTo: number };
        // 99: two messages, then the stream never ends
        if (m.upTo === 99) return void (res.write(Buffer.concat([1, 2].map((n) => grpcWebFrame(0, T('hi.Num').encode({ n }).finish())))), req.socket.on('close', () => res.end()));
        const frames = Array.from({ length: m.upTo }, (_, i) =>
          grpcWebFrame(
            0,
            T('hi.Num')
              .encode({ n: i + 1 })
              .finish(),
          ),
        );
        return void res.end(Buffer.concat([...frames, trailer(0)]));
      }
      // Fail: a trailers-only answer, the status in the HTTP headers
      res.setHeader('grpc-status', '7');
      res.setHeader('grpc-message', encodeURIComponent('not for you'));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('gRPC-Web', () => {
  it('a unary call: the reply as JSON (longs as strings), metadata sent, trailers read', async () => {
    const r = await executeGrpc({
      target: base,
      web: true,
      method: 'hi.Hello/Say',
      message: '{"name":"web"}',
      protoFiles: PROTO,
      metadata: [{ key: 'Authorization', value: 'Bearer t', enabled: true }],
    });
    expect(r).toMatchObject({ code: 0, codeName: 'OK', response: { text: 'hello web', big: '9007199254740993' }, method: 'hi.Hello/Say' });
    expect(r.metadata).toContainEqual(['x-request-auth', 'Bearer t']);
    expect(r.trailers).toContainEqual(['x-served-by', 'test']);
    // a path prefix of the target is kept
    expect((await executeGrpc({ target: `${base}/prefix`, web: true, method: 'hi.Hello/Say', message: '{"name":"p"}', protoFiles: PROTO })).response).toMatchObject({ text: 'hello p' });
  });

  it('a server stream: every message in order', async () => {
    const r = await executeGrpc({ target: base, web: true, method: 'hi.Hello/Count', message: '{"upTo":3}', protoFiles: PROTO });
    expect(r.code).toBe(0);
    expect(r.messages?.map((m) => m.data)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('a status in the headers (trailers-only), a server that does not speak it, a cut frame', async () => {
    expect(await executeGrpc({ target: base, web: true, method: 'hi.Hello/Fail', protoFiles: PROTO })).toMatchObject({ code: 7, codeName: 'PERMISSION_DENIED', details: 'not for you' });
    await expect(executeGrpc({ target: `${base}/plain`, web: true, method: 'hi.Hello/Say', protoFiles: PROTO })).rejects.toThrow(/HTTP 404 .*instead of gRPC-Web/);
    expect(() => grpcWebFrames(Buffer.from([0, 0, 0, 0, 9, 1, 2]))).toThrow(/middle of a message/);
    // no status at all is not OK; a malformed grpc-message is shown as it came
    expect(await executeGrpc({ target: `${base}/empty`, web: true, method: 'hi.Hello/Say', protoFiles: PROTO })).toMatchObject({ code: 2, codeName: 'UNKNOWN' });
    expect(await executeGrpc({ target: `${base}/badmsg`, web: true, method: 'hi.Hello/Say', protoFiles: PROTO })).toMatchObject({ code: 13, details: 'bad %ZZ 100%' });
    await expect(executeGrpc({ target: base, web: true, method: 'hi.Hello/Say', protoFiles: PROTO, metadata: [{ key: 'bad name', value: 'x', enabled: true }] })).rejects.toThrow(
      /cannot be sent as an HTTP header/,
    );
  });

  it('a stream shows its messages as they come; Stop and the deadline keep them', async () => {
    const live: unknown[] = [];
    const ctrl = new AbortController();
    const p = executeGrpc(
      { target: base, web: true, method: 'hi.Hello/Count', message: '{"upTo":99}', protoFiles: PROTO },
      { signal: ctrl.signal, onMessage: (d) => (live.push(d), live.length === 2 && ctrl.abort()) },
    );
    expect(await p).toMatchObject({ codeName: 'CANCELLED', streamStopped: true, messages: [{ data: { n: 1 } }, { data: { n: 2 } }] });
    const late = await executeGrpc({ target: base, web: true, method: 'hi.Hello/Count', message: '{"upTo":99}', protoFiles: PROTO, timeoutMs: 800 });
    expect(late).toMatchObject({ codeName: 'DEADLINE_EXCEEDED' });
    expect(late.messages).toHaveLength(2);
  });
});
