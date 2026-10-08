import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Span, Trace } from '../types';
import { formatMs } from '../lib/format';
import { Badge, cx, Split, Tabs } from './ui';
import { JsonTree } from './JsonView';
import { useCopied } from '../lib/clipboard';

const KIND_COLORS: Record<string, string> = {
  http: '#0969da',
  graphql: '#e535ab',
  llm: '#8250df',
  mcp: '#bf8700',
  tool: '#d4a72c',
  evaluation: '#1a7f37',
  test: '#6e7781',
  script: '#57606a',
  internal: '#8c959f',
};

/** A span's colour: by kind; the phases of an HTTP request (DNS, TCP, TLS, waiting, download) get their own shades. */
function spanColor(s: Span): string {
  const phase = (s.attributes as { phase?: string } | undefined)?.phase;
  if (phase === 'DNS lookup' || phase === 'TCP connect' || phase === 'TLS handshake') return 'color-mix(in oklab, #0969da 45%, transparent)';
  if (phase === 'download') return '#2da44e';
  return KIND_COLORS[s.kind] ?? '#888';
}

export function spanRows(trace: Trace): Array<{ span: Span; depth: number }> {
  const ids = new Set(trace.spans.map((s) => s.spanId));
  const children = new Map<string | undefined, Span[]>();
  for (const s of trace.spans) {
    const k = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : undefined;
    (children.get(k) ?? children.set(k, []).get(k)!).push(s);
  }
  const out: Array<{ span: Span; depth: number }> = [];
  const walk = (p: string | undefined, d: number) => {
    for (const s of (children.get(p) ?? []).sort((a, b) => a.startTime - b.startTime)) {
      out.push({ span: s, depth: d });
      walk(s.spanId, d + 1);
    }
  };
  walk(undefined, 0);
  return out;
}

/** Waterfall view of a normalised trace (spans for HTTP, GraphQL, LLM, tool, MCP and evaluation). */
export function TraceView({ trace }: { trace: Trace }) {
  const rows = useMemo(() => spanRows(trace), [trace]);
  const [sel, setSel] = useState<string | undefined>(rows[0]?.span.spanId);
  const [tab, setTab] = useState<'payload' | 'attributes' | 'input' | 'output' | 'events'>('payload');
  const start = trace.startTime;
  const end = Math.max(trace.endTime ?? 0, ...trace.spans.map((s) => s.endTime ?? s.startTime));
  const total = Math.max(1, end - start);
  const span = trace.spans.find((s) => s.spanId === sel);
  const tokens = trace.spans.reduce((a, s) => a + (Number(s.attributes.inputTokens) || 0) + (Number(s.attributes.outputTokens) || 0), 0);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-3 h-9 border-b border-line text-sm shrink-0">
        <span className="font-medium truncate min-w-0">{trace.name}</span>
        <Badge tone={trace.status === 'ok' ? 'ok' : trace.status === 'error' ? 'bad' : 'default'}>{trace.status}</Badge>
        <span className="text-muted whitespace-nowrap tabular-nums shrink-0">
          {formatMs(total)} · {trace.spans.length} spans{tokens > 0 ? ` · ${tokens.toLocaleString()} tokens` : ''}
        </span>
        <span className="text-muted mono text-xs ml-auto truncate min-w-0 hidden xl:inline" title="Trace ID (OpenTelemetry-compatible)">
          {trace.traceId}
        </span>
      </div>
      <Split id="trace" direction="vertical" initial={55}>
        <div className="overflow-auto h-full">
          {rows.map(({ span: s, depth }) => {
            const left = ((s.startTime - start) / total) * 100;
            const width = Math.max(0.4, (((s.endTime ?? end) - s.startTime) / total) * 100);
            return (
              <button
                key={s.spanId}
                onClick={() => setSel(s.spanId)}
                className={cx('w-full flex items-center h-7 text-sm border-b border-line/60 text-left hover:bg-hover', sel === s.spanId && 'bg-accent/10')}
              >
                <div className="w-[38%] shrink-0 truncate flex items-center gap-1.5" style={{ paddingLeft: 8 + depth * 14 }}>
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: spanColor(s) }} />
                  <span className={cx('truncate', s.status === 'error' && 'text-bad')}>{s.name}</span>
                </div>
                <div className="flex-1 relative h-full mr-3">
                  <div className="absolute top-1.5 h-4 rounded-sm opacity-80" style={{ left: `${left}%`, width: `${width}%`, background: s.status === 'error' ? 'var(--bad)' : spanColor(s) }} />
                  <span className="absolute top-1 text-[0.72rem] text-muted tabular-nums" style={{ left: `min(${left + width}% + 4px, calc(100% - 60px))` }}>
                    {formatMs(s.durationMs)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        <div className="h-full flex flex-col min-h-0">
          {span ? (
            <>
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'payload', label: 'Payload' },
                  { id: 'attributes', label: 'Attributes' },
                  { id: 'input', label: 'Input' },
                  { id: 'output', label: 'Output' },
                  { id: 'events', label: 'Events', badge: span.events?.length },
                ]}
                right={
                  <span className="text-xs text-muted pr-2">
                    {span.kind} · {formatMs(span.durationMs)} {span.error && <span className="text-bad">· {span.error}</span>}
                  </span>
                }
              />
              <div className="flex-1 min-h-0">
                {tab === 'payload' ? (
                  <PayloadPanel key={span.spanId} span={span} />
                ) : (
                <JsonTree
                  data={
                    tab === 'attributes'
                      ? JSON.parse(JSON.stringify({ spanId: span.spanId, parentSpanId: span.parentSpanId, startTime: new Date(span.startTime).toISOString(), status: span.status, ...span.attributes }))
                      : tab === 'input'
                        ? span.input ?? null
                        : tab === 'output'
                          ? span.output ?? null
                          : span.events ?? []
                  }
                />
                )}
              </div>
            </>
          ) : (
            <div className="p-4 text-muted text-sm">Select a span</div>
          )}
        </div>
      </Split>
    </div>
  );
}

type Headers = Array<[string, string]> | Record<string, string> | undefined;
function headerValue(h: Headers, name: string): string | undefined {
  if (!h) return undefined;
  const n = name.toLowerCase();
  if (Array.isArray(h)) return h.find(([k]) => k?.toLowerCase() === n)?.[1];
  return Object.entries(h).find(([k]) => k.toLowerCase() === n)?.[1];
}

/** The body of a span's input or output: HTTP spans keep it under `body`; AI, MCP and tool spans are the payload themselves. */
function payloadOf(v: unknown): { body: unknown; contentType?: string; status?: unknown } | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    // too big to record whole: the tracer kept the start of it as text
    if (o.truncated === true && typeof o.preview === 'string') return { body: `${o.preview}…` };
    if ('body' in o || 'headers' in o) {
      const body = o.body;
      return body === undefined || body === null || body === '' ? { body: undefined, contentType: headerValue(o.headers as Headers, 'content-type'), status: o.status } : { body, contentType: headerValue(o.headers as Headers, 'content-type'), status: o.status };
    }
  }
  return { body: v };
}

/** JSON text becomes a value to show as a tree; anything else stays text. */
function parsed(body: unknown): { json?: unknown; text: string } {
  if (typeof body !== 'string') return { json: body, text: JSON.stringify(body, null, 2) };
  const t = body.trim();
  if (/^[[{]/.test(t)) {
    try {
      return { json: JSON.parse(t), text: body };
    } catch {
      /* not JSON (or cut off) */
    }
  }
  return { text: body };
}

const sizeOf = (text: string) => {
  const n = new TextEncoder().encode(text).length;
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
};

function PayloadBox({ title, payload, emptyText }: { title: string; payload?: { body: unknown; contentType?: string; status?: unknown }; emptyText: string }) {
  const [raw, setRaw] = useState(false);
  const { copied, copy: copyToClipboard } = useCopied(1200);
  const body = payload?.body;
  // parsed once per body: a new value each render would fold the tree up again whenever the panel re-renders
  const p = useMemo(() => (body === undefined ? undefined : parsed(body)), [body]);
  const copy = () => p && void copyToClipboard(p.text);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 h-8 px-3 border-b border-line bg-panel/40 shrink-0 text-xs">
        <span className="font-semibold text-fg">{title}</span>
        {payload?.status !== undefined && <Badge>{String(payload.status)}</Badge>}
        {payload?.contentType && <span className="mono text-muted truncate">{payload.contentType.split(';')[0]}</span>}
        {p && <span className="text-muted">{sizeOf(p.text)}{typeof body === 'string' && body.endsWith('…') ? ' · preview' : ''}</span>}
        {p && (
          <div className="ml-auto flex items-center gap-1">
            {p.json !== undefined && (
              <div className="flex rounded-md border border-line overflow-hidden">
                {(['Pretty', 'Raw'] as const).map((m) => (
                  <button key={m} className={cx('px-2 h-6', (m === 'Raw') === raw ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg')} onClick={() => setRaw(m === 'Raw')}>
                    {m}
                  </button>
                ))}
              </div>
            )}
            <button aria-label={`Copy the ${title.toLowerCase()}`} title="Copy" className="p-1 rounded text-muted hover:text-fg hover:bg-hover" onClick={copy}>
              {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!p ? (
          <p className="p-3 text-sm text-muted">{emptyText}</p>
        ) : p.json !== undefined && !raw ? (
          <JsonTree data={p.json} />
        ) : (
          <pre className="p-3 text-xs mono whitespace-pre-wrap break-words">{p.text}</pre>
        )}
      </div>
    </div>
  );
}

/** The span's request and response bodies on their own (secrets are already redacted in traces). */
function PayloadPanel({ span }: { span: Span }) {
  const req = payloadOf(span.input);
  const res = payloadOf(span.output);
  return (
    <Split id="trace-payload" direction="vertical" initial={45} min={15}>
      <PayloadBox title="Request" payload={req} emptyText="No request payload (e.g. a GET without a body)." />
      <PayloadBox title="Response" payload={res} emptyText={span.error ? `No response: ${span.error}` : 'No response payload.'} />
    </Split>
  );
}
