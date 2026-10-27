/** RPC handlers: gRPC calls described by .proto files (sent as text, so they work the same in a hosted version). */
import { describeRoot, executeGrpc, grpcRoot, parseGrpcTarget, reflectServer, shortId, type GrpcRequestSpec, type GrpcTlsOptions, type ProtoFile } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { linkedController } from '../request-context.js';

export interface GrpcSendParams extends GrpcRequestSpec {
  /** Call id, for grpc.cancel. */
  id?: string;
  environment?: string;
}

/** TLS options with {{variables}} resolved; empty fields are left out. */
function tlsFrom(o: GrpcTlsOptions | undefined, ctx: { vars: { resolve(s: string): string }; redactor: { addSecret(s?: string): void } }): GrpcTlsOptions | undefined {
  if (!o) return undefined;
  const v = (s?: string) => (s?.trim() ? ctx.vars.resolve(s) : undefined);
  const out: GrpcTlsOptions = { ca: v(o.ca), cert: v(o.cert), key: v(o.key) };
  ctx.redactor.addSecret(out.key);
  return out.ca || out.cert || out.key ? out : undefined;
}

export function grpcHandlers(be: Backend): Handlers {
  return {
    /** Methods in the proto files (or reflected descriptors), with example requests. */
    'grpc.describe': ({ protoFiles, descriptorSet }: { protoFiles?: ProtoFile[]; descriptorSet?: string }) => describeRoot(grpcRoot({ protoFiles, descriptorSet })),
    /** Ask the server for its services through gRPC server reflection (no proto files needed). */
    'grpc.reflect': async (p: { target: string; tls?: boolean; tlsOptions?: GrpcTlsOptions; metadata?: Array<{ key: string; value: string }>; environment?: string }) => {
      const ctx = be.context({ environment: p.environment });
      try {
        const r = await reflectServer(parseGrpcTarget(ctx.vars.resolve(p.target), p.tls), { metadata: ctx.vars.resolveDeep(p.metadata ?? []), tlsOptions: tlsFrom(p.tlsOptions, ctx) });
        return { ...r, methods: describeRoot(grpcRoot({ descriptorSet: r.descriptorSet })) };
      } finally {
        await ctx.dispose();
      }
    },
    /** Call a method; streamed responses also arrive live on `grpc.messages`. Cancel with grpc.cancel. */
    'grpc.send': async (p: GrpcSendParams) => {
      const id = p.id ?? shortId('grpc-');
      const ctrl = linkedController();
      be.controllers.set(id, ctrl);
      const ctx = be.context({ environment: p.environment });
      const live = be.batched<unknown>('grpc.messages', 100);
      try {
        const spec: GrpcRequestSpec = {
          ...p,
          target: ctx.vars.resolve(p.target),
          message: p.message !== undefined ? ctx.vars.resolve(p.message) : undefined,
          metadata: ctx.vars.resolveDeep(p.metadata ?? []),
          // certificates may come from (secret) variables; the private key is registered for redaction
          tlsOptions: tlsFrom(p.tlsOptions, ctx),
          timeoutMs: p.timeoutMs ?? be.settings.defaultTimeoutMs,
        };
        const r = await executeGrpc(spec, { signal: ctrl.signal, redactor: ctx.redactor, onMessage: (data, atMs) => live.push({ id, data, atMs }) });
        be.logger.info(`gRPC ${r.method} → ${r.codeName}`, { target: r.target, ms: r.durationMs });
        be.record('history entry', () =>
        be.ws.meta.addHistory({
          id: shortId('h-'),
          timestamp: new Date().toISOString(),
          kind: 'grpc',
          name: r.method,
          method: 'GRPC',
          url: r.target,
          status: r.codeName,
          durationMs: r.durationMs,
          // enough to open it again; the message is redacted, the proto files are not stored
          request: { target: p.target, method: p.method, message: ctx.redactor.redactString(p.message ?? ''), metadata: ctx.redactor.redact(p.metadata ?? []) },
        }),
        );
        return { ...r, unresolved: ctx.vars.unresolved.size ? [...ctx.vars.unresolved] : undefined };
      } finally {
        live.flush();
        be.controllers.delete(id);
        await ctx.dispose();
      }
    },
    'grpc.cancel': ({ id }: { id: string }) => be.controllers.get(id)?.abort(),
  };
}
