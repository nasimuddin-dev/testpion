import type { Span, Trace } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { Redactor } from '../util/redact.js';
import { ENGINE_VERSION } from '../version.js';
import { ensureProxyApplied } from '../net/proxy.js';

/**
 * OpenTelemetry export: TestPion traces as OTLP/HTTP JSON, sent to a collector (Jaeger, Grafana Tempo,
 * Honeycomb, an OpenTelemetry Collector …). Span inputs and outputs are added as attributes, redacted
 * and cut to 4 KB.
 */

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
const value = (v: unknown): OtlpValue => {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: JSON.stringify(v) ?? String(v) };
};
const text = (v: unknown, redactor?: Redactor) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const r = redactor ? redactor.redactString(s ?? '') : (s ?? '');
  return r.length > 4096 ? `${r.slice(0, 4096)}… [truncated]` : r;
};
const nanos = (ms: number) => `${BigInt(Math.round(ms * 1000)) * 1000n}`;

/** SpanKind: TestPion's kinds are client calls, except tests / evaluations / scripts, which are internal. */
const KIND: Record<string, number> = { http: 3, graphql: 3, grpc: 3, llm: 3, mcp: 3, tool: 3, test: 1, evaluation: 1, script: 1, internal: 1 };

function otlpSpan(s: Span, redactor?: Redactor) {
  const attrs: Array<{ key: string; value: OtlpValue }> = [{ key: 'testpion.kind', value: { stringValue: s.kind } }];
  for (const [k, v] of Object.entries(redactor ? redactor.redact(s.attributes ?? {}) : (s.attributes ?? {}))) if (v !== undefined && v !== null) attrs.push({ key: k, value: value(v) });
  if (s.input !== undefined) attrs.push({ key: 'testpion.input', value: { stringValue: text(s.input, redactor) } });
  if (s.output !== undefined) attrs.push({ key: 'testpion.output', value: { stringValue: text(s.output, redactor) } });
  const end = s.endTime ?? (s.durationMs !== undefined ? s.startTime + s.durationMs : s.startTime);
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: KIND[s.kind] ?? 1,
    startTimeUnixNano: nanos(s.startTime),
    endTimeUnixNano: nanos(end),
    attributes: attrs,
    events: (s.events ?? []).map((e) => ({ timeUnixNano: nanos(e.time), name: e.name, attributes: Object.entries(e.attributes ?? {}).map(([key, v]) => ({ key, value: value(redactor ? redactor.redact(v) : v) })) })),
    status: s.status === 'error' ? { code: 2, message: s.error ? text(s.error, redactor) : 'error' } : s.status === 'ok' ? { code: 1 } : { code: 0 },
  };
}

/** Traces as an OTLP ExportTraceServiceRequest (JSON encoding). */
export function tracesToOtlp(traces: Trace[], opts: { serviceName?: string; redactor?: Redactor; resource?: Record<string, string> } = {}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: opts.serviceName ?? 'testpion' } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'testpion' } },
            { key: 'telemetry.sdk.version', value: { stringValue: ENGINE_VERSION } },
            ...Object.entries(opts.resource ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
          ],
        },
        scopeSpans: [{ scope: { name: 'testpion', version: ENGINE_VERSION }, spans: traces.flatMap((t) => t.spans.map((s) => otlpSpan(s, opts.redactor))) }],
      },
    ],
  };
}

export interface OtlpTarget {
  /** Collector base URL (…/v1/traces is added) or the full traces URL. */
  endpoint: string;
  headers?: Record<string, string>;
}

/**
 * Where to export from the standard OpenTelemetry environment variables: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
 * (full URL) or OTEL_EXPORTER_OTLP_ENDPOINT (base URL), and OTEL_EXPORTER_OTLP_HEADERS / …_TRACES_HEADERS
 * ("key=value,key2=value2", URL-encoded).
 */
export function otlpTargetFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpTarget | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces` : undefined);
  if (!endpoint) return undefined;
  const raw = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS || '';
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) headers[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return { endpoint, headers };
}

const tracesUrl = (endpoint: string) => (/\/v1\/traces\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/traces`);

/** Send traces to an OTLP/HTTP collector, in batches of 100 traces. Returns how many spans were sent. */
export async function exportOtlp(traces: Trace[], target: OtlpTarget, opts: { serviceName?: string; redactor?: Redactor; resource?: Record<string, string>; signal?: AbortSignal } = {}): Promise<{ spans: number; url: string }> {
  const url = tracesUrl(target.endpoint);
  let spans = 0;
  for (let i = 0; i < traces.length; i += 100) {
    const batch = traces.slice(i, i + 100);
    await ensureProxyApplied();
    const { fetch: undiciFetch } = await import('undici');
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(target.headers ?? {}) },
      body: JSON.stringify(tracesToOtlp(batch, opts)),
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    }).catch((e: Error) => {
      throw new ApsError('NetworkError', `Could not reach the OTLP endpoint ${url}: ${e.message}`, { suggestions: ['Check the collector URL (OTLP/HTTP, usually port 4318) and that it is running.'] });
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new ApsError('NetworkError', `The OTLP endpoint answered ${res.status}${body ? `: ${body}` : ''}`, { suggestions: res.status === 401 || res.status === 403 ? ['Set the collector’s API key header (OTEL_EXPORTER_OTLP_HEADERS or --otlp-header).'] : ['Check that the URL is the OTLP/HTTP traces endpoint (…/v1/traces) and that it accepts JSON.'] });
    }
    await res.body?.cancel().catch(() => undefined);
    spans += batch.reduce((n, t) => n + t.spans.length, 0);
  }
  return { spans, url };
}
