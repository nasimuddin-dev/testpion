import type * as grpc from '@grpc/grpc-js';
import type descriptorTypes from 'protobufjs/ext/descriptor/index.js';
import { nodeRequire } from '../../util/lazy-require.js';
import { ApsError } from '../../errors.js';
import type { KeyValue } from '../../model/types.js';
import { assertUrlAllowed } from '../../net/policy.js';
import { grpcChannel, grpcJs, protobufLib, protoLoaderLib, type GrpcTlsOptions } from './grpc.js';

// protobuf's descriptor extension loads at first use (see util/lazy-require.ts)
let descriptorMod: typeof descriptorTypes | undefined;
const descriptorLib = (): typeof descriptorTypes => (descriptorMod ??= typeof require === 'function' ? require('protobufjs/ext/descriptor/index.js') : nodeRequire('protobufjs/ext/descriptor/index.js'));

/**
 * gRPC server reflection (grpc.reflection.v1, falling back to v1alpha): lists a server's services and
 * fetches their file descriptors, so methods can be called without .proto files. The result is a
 * FileDescriptorSet (base64), which `executeGrpc` accepts in place of proto files.
 */

// The reflection messages used here (the full definition is grpc/reflection/v1/reflection.proto).
const REFLECTION_PROTO = (pkg: string) => `syntax = "proto3";
package ${pkg};
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

type ReflectionResponse = {
  list_services_response?: { service: Array<{ name: string }> };
  file_descriptor_response?: { file_descriptor_proto: Buffer[] };
  error_response?: { error_code: number; error_message: string };
};

function reflectionClient(pkg: string, address: string, channel: { credentials: grpc.ChannelCredentials; options: grpc.ChannelOptions }) {
  const root = protobufLib().parse(REFLECTION_PROTO(pkg), { keepCase: true }).root;
  const def = grpcJs().loadPackageDefinition(protoLoaderLib().fromJSON(root.toJSON(), { keepCase: true, oneofs: true }));
  const Ctor = pkg.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], def) as Record<string, grpc.ServiceClientConstructor>;
  return new Ctor.ServerReflection!(address, channel.credentials, channel.options);
}

/** One reflection session: requests are answered in order on the same stream. */
async function session(pkg: string, address: string, channel: { credentials: grpc.ChannelCredentials; options: grpc.ChannelOptions }, metadata: grpc.Metadata, deadline: Date) {
  const client = reflectionClient(pkg, address, channel);
  const call = (client as unknown as { ServerReflectionInfo(md: grpc.Metadata, o: grpc.CallOptions): grpc.ClientDuplexStream<object, ReflectionResponse> }).ServerReflectionInfo(metadata, { deadline });
  const waiting: Array<{ ok(r: ReflectionResponse): void; fail(e: Error): void }> = [];
  let failed: Error | undefined;
  call.on('data', (r: ReflectionResponse) => waiting.shift()?.ok(r));
  call.on('error', (e: Error) => {
    failed = e;
    for (const w of waiting.splice(0)) w.fail(e);
  });
  const ask = (req: object) =>
    new Promise<ReflectionResponse>((ok, fail) => {
      if (failed) return fail(failed);
      waiting.push({ ok, fail });
      call.write(req);
    });
  return {
    ask,
    close() {
      call.end();
      client.close();
    },
  };
}

export interface ReflectionResult {
  /** Services the server offers (the reflection service itself left out). */
  services: string[];
  /** FileDescriptorSet (base64) with every file the services need. */
  descriptorSet: string;
}

/** Discover a server's services and their descriptors through server reflection. */
export async function reflectServer(target: { address: string; tls: boolean }, opts: { metadata?: KeyValue[]; timeoutMs?: number; tlsOptions?: GrpcTlsOptions } = {}): Promise<ReflectionResult> {
  const tls = target.tls || !!opts.tlsOptions?.ca || !!opts.tlsOptions?.cert;
  await assertUrlAllowed(new URL(`${tls ? 'https' : 'http'}://${target.address}`));
  const channel = grpcChannel(target.address, tls, opts.tlsOptions);
  const md = new (grpcJs().Metadata)();
  for (const h of opts.metadata ?? []) if (h.enabled !== false && h.key) md.add(h.key.toLowerCase(), h.value);
  const deadline = new Date(Date.now() + (opts.timeoutMs ?? 15_000));

  let lastError: Error | undefined;
  for (const pkg of ['grpc.reflection.v1', 'grpc.reflection.v1alpha']) {
    const s = await session(pkg, target.address, channel, md, deadline);
    try {
      const list = await s.ask({ list_services: '' });
      if (list.error_response) throw new ApsError('ProtocolError', `Reflection: ${list.error_response.error_message}`);
      const services = (list.list_services_response?.service ?? []).map((x) => x.name).filter((n) => !n.startsWith('grpc.reflection.'));
      // file descriptors of every service, then of any dependency the server didn't include
      const files = new Map<string, Uint8Array>();
      const add = (r: ReflectionResponse) => {
        for (const bytes of r.file_descriptor_response?.file_descriptor_proto ?? []) {
          const fd = descriptorLib().FileDescriptorProto.decode(bytes) as unknown as { name: string };
          if (!files.has(fd.name)) files.set(fd.name, bytes);
        }
      };
      for (const name of services) {
        const r = await s.ask({ file_containing_symbol: name });
        if (r.error_response) throw new ApsError('ProtocolError', `Reflection could not describe ${name}: ${r.error_response.error_message}`);
        add(r);
      }
      for (let guard = 0; guard < 200; guard++) {
        const missing = [...files.values()].flatMap((b) => ((descriptorLib().FileDescriptorProto.decode(b) as unknown as { dependency?: string[] }).dependency ?? [])).find((d) => !files.has(d));
        if (!missing) break;
        const r = await s.ask({ file_by_filename: missing });
        if (r.error_response) throw new ApsError('ProtocolError', `Reflection could not provide ${missing}: ${r.error_response.error_message}`);
        const before = files.size;
        add(r);
        if (files.size === before) throw new ApsError('ProtocolError', `Reflection did not return ${missing}`);
      }
      const set = descriptorLib().FileDescriptorSet.encode(descriptorLib().FileDescriptorSet.create({ file: [...files.values()].map((b) => descriptorLib().FileDescriptorProto.decode(b)) })).finish();
      return { services, descriptorSet: Buffer.from(set).toString('base64') };
    } catch (e) {
      lastError = e as Error;
      const code = (e as { code?: number }).code;
      // v1 not offered: try v1alpha; anything else is final
      if (code !== grpcJs().status.UNIMPLEMENTED) break;
    } finally {
      s.close();
    }
  }
  const code = (lastError as { code?: number } | undefined)?.code;
  if (code === grpcJs().status.UNIMPLEMENTED) throw new ApsError('ProtocolError', 'This server does not offer gRPC server reflection', { suggestions: ['Add the .proto files instead.'] });
  if (code === grpcJs().status.UNAVAILABLE) throw new ApsError('NetworkError', `Can't reach ${target.address}: ${(lastError as { details?: string }).details ?? lastError!.message}`, { suggestions: ['Check the address and whether the server uses TLS (grpcs://) or plaintext.'] });
  throw lastError instanceof ApsError ? lastError : new ApsError('ProtocolError', `Reflection failed: ${lastError?.message}`);
}

/** A protobufjs Root from a FileDescriptorSet (base64). */
export function rootFromDescriptorSet(b64: string): protobuf.Root {
  try {
    const set = descriptorLib().FileDescriptorSet.decode(Buffer.from(b64, 'base64'));
    const root = (protobufLib().Root as unknown as { fromDescriptor(s: unknown): protobuf.Root }).fromDescriptor(set);
    root.resolveAll();
    return root;
  } catch (e) {
    throw new ApsError('ValidationError', `The reflected descriptors can't be used: ${(e as Error).message}`);
  }
}
