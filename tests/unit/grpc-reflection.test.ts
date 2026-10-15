import { describe, it, expect, afterAll } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { describeRoot, executeGrpc, grpcRoot, parseProtos, reflectServer } from '../../packages/core/src/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cliData } from '../helpers.js';

const cli = (args: string[], cwd: string, command: string) =>
  new Promise<{ status: number | null; stdout: string }>((ok) => {
    const p = spawn(process.execPath, [join(process.cwd(), 'packages/cli/bin/testpion.js'), command, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (status) => ok({ status, stdout }));
  });

const COMMON = { name: 'zoo/v1/common.proto', text: 'syntax = "proto3";\npackage zoo.v1;\nimport "google/protobuf/timestamp.proto";\nmessage Animal { string name = 1; google.protobuf.Timestamp seen = 2; }\n' };
const ZOO = { name: 'zoo/v1/zoo.proto', text: 'syntax = "proto3";\npackage zoo.v1;\nimport "zoo/v1/common.proto";\nmessage Find { string name = 1; }\nservice Zoo { rpc FindAnimal(Find) returns (Animal); }\n' };

const servers: grpc.Server[] = [];
afterAll(() => servers.forEach((s) => s.forceShutdown()));

async function start(withReflection: boolean): Promise<string> {
  const def = protoLoader.fromJSON(parseProtos([ZOO, COMMON]).toJSON(), { keepCase: true, defaults: true });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const server = new grpc.Server();
  server.addService(pkg.zoo.v1.Zoo.service, { FindAnimal: (call: any, cb: any) => cb(null, { name: `found ${call.request.name}`, seen: { seconds: '1', nanos: 0 } }) });
  if (withReflection) new ReflectionService(def).addToServer(server);
  servers.push(server);
  const port = await new Promise<number>((ok, fail) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? fail(e) : ok(p))));
  return `127.0.0.1:${port}`;
}

describe('gRPC server reflection', () => {
  it('discovers services and their descriptors, then calls a method without proto files', async () => {
    const address = await start(true);
    const r = await reflectServer({ address, tls: false });
    expect(r.services).toEqual(['zoo.v1.Zoo']);
    const methods = describeRoot(grpcRoot({ descriptorSet: r.descriptorSet }));
    expect(methods.map((m) => m.name)).toEqual(['zoo.v1.Zoo/FindAnimal']);
    expect(methods[0]!.example).toMatchObject({ name: '' });
    const out = await executeGrpc({ target: address, method: 'zoo.v1.Zoo/FindAnimal', message: '{"name":"otter"}', descriptorSet: r.descriptorSet });
    expect(out).toMatchObject({ code: 0, response: { name: 'found otter' } });
  });

  it('works from the CLI and in grpc tests without protos', async () => {
    const address = await start(true);
    const dir = mkdtempSync(join(tmpdir(), 'tp-refl-'));
    try {
      const list = await cli([address, '--json'], dir, 'grpc');
      expect((cliData(list.stdout) as Array<{ name: string }>).map((m) => m.name)).toEqual(['zoo.v1.Zoo/FindAnimal']);
      const call = await cli([address, 'zoo.v1.Zoo/FindAnimal', '-d', '{"name":"lynx"}', '--json'], dir, 'grpc');
      expect(cliData(call.stdout)).toMatchObject({ code: 0, response: { name: 'found lynx' } });
      writeFileSync(join(dir, 'zoo.test.yaml'), ['name: reflected', 'type: grpc', `target: ${address}`, 'method: zoo.v1.Zoo/FindAnimal', 'message: { name: owl }', 'protos: []', 'assertions: [{ type: equals, path: $.name, expected: found owl }]'].join('\n'));
      const run = await cli(['zoo.test.yaml', '-r', 'json', '-o', join(dir, 'out')], dir, 'test');
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when a server has no reflection', async () => {
    const address = await start(false);
    await expect(reflectServer({ address, tls: false })).rejects.toThrow(/does not offer gRPC server reflection/);
    await expect(reflectServer({ address: '127.0.0.1:1', tls: false, }, { timeoutMs: 3000 })).rejects.toThrow(/reach|UNAVAILABLE|DEADLINE|offer/);
  });
});
