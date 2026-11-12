/**
 * A small OTLP/HTTP receiver for traces: point an AI application's OpenTelemetry exporter at it for a while, and what
 * arrives becomes dataset records (otel-traces.ts) without an export file in between. It takes OTLP over HTTP as
 * protobuf (what exporters send by default) or as JSON, on this computer only (127.0.0.1), and keeps what it gets in memory up to a
 * cap. It is a way to collect test data, not a collector: nothing is forwarded or stored.
 */
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ApsError } from '../../errors.js';
import { decodeOtlpTraces } from './otlp-proto.js';

const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;

export interface OtlpReceiver {
  port: number;
  /** The endpoint to give the exporter (OTEL_EXPORTER_OTLP_ENDPOINT). */
  endpoint: string;
  /** What arrived so far: one object per accepted request, each with `resourceSpans`. */
  batches(): Array<Record<string, unknown>>;
  /** Accepted requests, spans in them, and requests refused (not protobuf or JSON, too large, not traces). */
  stats(): { requests: number; spans: number; refused: number; full: boolean };
  close(): Promise<void>;
}

const countSpans = (batch: Record<string, unknown>): number => {
  let n = 0;
  for (const rs of (batch.resourceSpans as Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> | undefined) ?? []) for (const ss of rs.scopeSpans ?? []) n += ss.spans?.length ?? 0;
  return n;
};

/** Starts the receiver on 127.0.0.1. Port 0 takes a free port. */
export function startOtlpReceiver(o: { port?: number; onBatch?: (spans: number) => void } = {}): Promise<OtlpReceiver> {
  const batches: Array<Record<string, unknown>> = [];
  let total = 0;
  let spans = 0;
  let refused = 0;
  const reply = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || path !== '/v1/traces') {
      refused++;
      req.resume();
      return reply(res, path === '/v1/metrics' || path === '/v1/logs' ? 200 : 404, path === '/v1/metrics' || path === '/v1/logs' ? {} : { message: 'TestPion receives traces only: POST /v1/traces' });
    }
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    const proto = type.includes('protobuf');
    if (!proto && !type.includes('json')) {
      refused++;
      req.resume();
      return reply(res, 415, { message: 'TestPion reads OTLP over HTTP as protobuf or JSON. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf or http/json on the application (gRPC is not read).' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_REQUEST || total + size > MAX_TOTAL) over = true;
      else chunks.push(c);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (over) {
        refused++;
        return reply(res, 413, { message: total + size > MAX_TOTAL ? 'TestPion holds 128 MB of traces at most: stop the receiver and import what it has' : 'A request of more than 16 MB' });
      }
      try {
        let body: Buffer = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip') body = gunzipSync(body, { maxOutputLength: MAX_REQUEST });
        const batch = proto ? (decodeOtlpTraces(body) as Record<string, unknown>) : (JSON.parse(body.toString('utf8')) as Record<string, unknown>);
        if (!batch || typeof batch !== 'object' || !Array.isArray(batch.resourceSpans)) throw new Error('no resourceSpans');
        total += body.length;
        const n = countSpans(batch);
        spans += n;
        batches.push(batch);
        o.onBatch?.(n);
        // the answer in the form the request came in (an empty ExportTraceServiceResponse is no bytes at all)
        if (proto) res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': 0 }).end();
        else reply(res, 200, { partialSuccess: {} });
      } catch {
        refused++;
        reply(res, 400, { message: proto ? 'Not an OTLP trace export in protobuf (ExportTraceServiceRequest)' : 'Not an OTLP/JSON trace export (an object with resourceSpans)' });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(
        new ApsError('ConfigurationError', e.code === 'EADDRINUSE' ? `Port ${o.port} is in use` : `The receiver could not start: ${e.message}`, {
          suggestions: ['Choose another port, or 0 for a free one.'],
        }),
      ),
    );
    server.listen(o.port ?? 4318, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        endpoint: `http://127.0.0.1:${port}`,
        batches: () => batches,
        stats: () => ({ requests: batches.length, spans, refused, full: total >= MAX_TOTAL }),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
