import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { request, get, type Server } from 'node:http';
import { connect as h2connect, createSecureServer, type Http2SecureServer } from 'node:http2';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { decodeProtobufRaw, ensureRootCertificate, grpcDecoder, grpcMethodIndex, leafSigner, parseProtos, startDebuggerProxy, type DebuggerProxy } from '@testpion/core';

// DBG-5: HTTP/2 inside a decrypted tunnel, gRPC over h2c through a CONNECT (decoded with the .proto), plain HTTP/1
// inside a CONNECT, the page the proxy serves to a phone, protobuf without a schema.

const PROTO = `syntax = "proto3";
package demo.v1;
service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); rpc Fail (HelloRequest) returns (HelloReply); }
message HelloRequest { string name = 1; int32 times = 2; }
message HelloReply { string message = 1; repeated string tags = 2; }`;

let dir: string;
let proxy: DebuggerProxy;
let h2server: Http2SecureServer;
let h2port = 0;
let grpcServer: grpc.Server;
let grpcPort = 0;
let plain: Server;
let plainPort = 0;
let root: ReturnType<typeof ensureRootCertificate>;
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tp-h2-'));
  root = ensureRootCertificate(dir);
  const leaf = leafSigner(root);
  const cert = leaf('localhost');
  h2server = createSecureServer({ cert: cert.cert, key: cert.key, allowHTTP1: true }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ over: 'h2', path: req.url }));
  });
  await new Promise<void>((r) => h2server.listen(0, '127.0.0.1', () => r()));
  h2port = (h2server.address() as { port: number }).port;

  const def = protoLoader.fromJSON(parseProtos([{ name: 'demo.proto', text: PROTO }]).toJSON());
  const pkg = grpc.loadPackageDefinition(def) as unknown as { demo: { v1: { Greeter: grpc.ServiceClientConstructor } } };
  grpcServer = new grpc.Server();
  grpcServer.addService(pkg.demo.v1.Greeter.service, {
    SayHello: (call: grpc.ServerUnaryCall<{ name: string; times: number }, unknown>, cb: grpc.sendUnaryData<unknown>) => cb(null, { message: `hello ${call.request.name}`, tags: ['a', 'b'] }),
    Fail: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => cb({ code: grpc.status.NOT_FOUND, details: 'no such greeting' }),
  });
  grpcPort = await new Promise<number>((r, j) => grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => (err ? j(err) : r(port))));

  plain = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(`plain ${req.url}`));
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
  plainPort = (plain.address() as { port: number }).port;

  proxy = await startDebuggerProxy({
    applicationOf: async () => 'vitest',
    decrypt: { leafFor: leaf, enabled: () => true, insecureUpstream: true },
    grpcDecode: grpcDecoder(grpcMethodIndex([parseProtos([{ name: 'demo.proto', text: PROTO }])])),
    rootCertificatePem: () => root.certPem,
  });
});
afterAll(async () => {
  await proxy.close();
  grpcServer.forceShutdown();
  await new Promise<void>((r) => h2server.close(() => r()));
  await new Promise<void>((r) => plain.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** A CONNECT through the proxy; resolves with the tunnel socket once the proxy answered. */
const tunnel = (target: string) =>
  new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
    req.on('connect', (_r, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });

describe('debugger: HTTP/2, gRPC and plain tunnels', () => {
  it('reads HTTP/2 inside a decrypted tunnel: the request, its stream and connection', async () => {
    const socket = await tunnel(`localhost:${h2port}`);
    const tls = tlsConnect({ socket, servername: 'localhost', ca: root.certPem, ALPNProtocols: ['h2'] });
    await new Promise<void>((r, j) => (tls.once('secureConnect', () => r()), tls.once('error', j)));
    expect(tls.alpnProtocol).toBe('h2');
    const session = h2connect(`https://localhost:${h2port}`, { createConnection: () => tls });
    const body = await new Promise<string>((resolve, reject) => {
      const s = session.request({ ':path': '/over/h2?x=1' });
      let text = '';
      s.on('data', (c) => (text += c));
      s.on('end', () => resolve(text));
      s.on('error', reject);
      s.end();
    });
    session.close();
    expect(JSON.parse(body)).toEqual({ over: 'h2', path: '/over/h2?x=1' });
    await settle();
    const e = proxy.exchanges.find((x) => x.url === `https://localhost:${h2port}/over/h2?x=1`)!;
    expect(e).toMatchObject({ httpVersion: '2', tls: true, status: 200, method: 'GET', host: `localhost:${h2port}` });
    expect(e.streamId).toBeGreaterThan(0);
    expect(e.connectionId).toMatch(/^conn-/);
  });

  it('captures a gRPC call over h2c through a CONNECT, decoded with the .proto, status from the trailers', async () => {
    const def = protoLoader.fromJSON(parseProtos([{ name: 'demo.proto', text: PROTO }]).toJSON());
    const pkg = grpc.loadPackageDefinition(def) as unknown as { demo: { v1: { Greeter: grpc.ServiceClientConstructor } } };
    // grpc-js reaches the server through an HTTP proxy with CONNECT, as a program with grpc_proxy set does (read when the channel is made)
    const prev = process.env.grpc_proxy;
    process.env.grpc_proxy = proxy.url;
    const client = new pkg.demo.v1.Greeter(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure()) as unknown as {
      SayHello(req: unknown, cb: (err: grpc.ServiceError | null, res: { message: string }) => void): void;
      Fail(req: unknown, cb: (err: grpc.ServiceError | null) => void): void;
      close(): void;
    };
    try {
      const reply = await new Promise<{ message: string }>((r, j) => client.SayHello({ name: 'Ada', times: 3 }, (err, res) => (err ? j(err) : r(res))));
      expect(reply.message).toBe('hello Ada');
      const err = await new Promise<grpc.ServiceError | null>((r) => client.Fail({ name: 'x' }, (e) => r(e)));
      expect(err?.code).toBe(grpc.status.NOT_FOUND);
    } finally {
      client.close();
      if (prev === undefined) delete process.env.grpc_proxy;
      else process.env.grpc_proxy = prev;
    }
    await settle(400);
    const ok = proxy.exchanges.find((x) => x.url.endsWith('/demo.v1.Greeter/SayHello'))!;
    expect(ok).toBeDefined();
    expect(ok.httpVersion).toBe('2');
    expect(ok.grpc).toMatchObject({
      service: 'demo.v1.Greeter',
      method: 'SayHello',
      decodedWith: 'proto',
      status: 0,
      statusName: 'OK',
      requests: [{ name: 'Ada', times: 3 }],
      responses: [{ message: 'hello Ada', tags: ['a', 'b'] }],
    });
    const failed = proxy.exchanges.find((x) => x.url.endsWith('/demo.v1.Greeter/Fail'))!;
    expect(failed.grpc).toMatchObject({ status: 5, statusName: 'NOT_FOUND', message: 'no such greeting' });
  });

  it('reads plain HTTP/1.1 sent inside a CONNECT (no TLS) like any request', async () => {
    const socket = await tunnel(`127.0.0.1:${plainPort}`);
    const text = await new Promise<string>((resolve) => {
      let t = '';
      socket.on('data', (c) => (t += c));
      socket.on('end', () => resolve(t));
      socket.write(`GET /inside?y=2 HTTP/1.1\r\nHost: 127.0.0.1:${plainPort}\r\nConnection: close\r\n\r\n`);
    });
    expect(text).toContain('plain /inside?y=2');
    await settle();
    const e = proxy.exchanges.find((x) => x.url === `http://127.0.0.1:${plainPort}/inside?y=2`)!;
    expect(e).toMatchObject({ status: 200, httpVersion: '1.1' });
    expect(e.tls).toBeUndefined();
  });

  it('serves its own page, with the root certificate to download, to a browser that opens it', async () => {
    const fetchText = (path: string) =>
      new Promise<{ status: number; type: string; text: string }>((resolve, reject) => {
        get({ host: '127.0.0.1', port: proxy.port, path }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), text: t }));
        }).on('error', reject);
      });
    const page = await fetchText('/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Download the root certificate');
    const cert = await fetchText('/testpion-root.crt');
    expect(cert.type).toContain('x509');
    expect(cert.text).toBe(root.certPem);
  });

  it('a server that speaks first gets an opaque tunnel after a moment', async () => {
    const banner = netConnect(0);
    banner.destroy();
    const server = (await import('node:net')).createServer((s) => s.end('220 hello\r\n'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const socket = await tunnel(`127.0.0.1:${port}`);
    const text = await new Promise<string>((resolve) => {
      let t = '';
      socket.on('data', (c) => (t += c));
      socket.on('close', () => resolve(t));
    });
    server.close();
    expect(text).toBe('220 hello\r\n');
    await settle();
    expect(proxy.exchanges.some((x) => x.kind === 'tunnel' && x.host === `127.0.0.1:${port}`)).toBe(true);
  });
});

describe('debugger: protobuf without a schema', () => {
  it('reads numbers, text, nested messages and repeated fields', () => {
    // field 1 = 150, field 2 = "hi", field 3 = { 1: 7 }, field 4 repeated "a", "b"
    const bytes = Buffer.from([0x08, 0x96, 0x01, 0x12, 0x02, 0x68, 0x69, 0x1a, 0x02, 0x08, 0x07, 0x22, 0x01, 0x61, 0x22, 0x01, 0x62]);
    expect(decodeProtobufRaw(bytes)).toEqual({ '1': 150, '2': 'hi', '3': { '1': 7 }, '4': ['a', 'b'] });
    const d = grpcDecoder(new Map())('/x.Y/Z', 'request', bytes);
    expect(d.with).toBe('raw');
  });
});
