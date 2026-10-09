import { Activity, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { call, on } from '../api';
import { persisted, toastError, useApp } from '../store';
import { KeyValueEditor } from '../components/KeyValueEditor';
import type { KeyValue } from '../types';
import { useIntent } from '../hooks';
import type { Trace } from '../types';
import { formatMs, plural, timeAgo } from '../lib/format';
import { TraceView } from '../components/TraceView';
import { DurationBar } from '../components/charts';
import { Badge, Button, cx, Empty, IconButton, Input, Modal, Select, Split, VirtualList } from '../components/ui';

interface TraceMeta {
  id: string;
  name: string;
  kind: string;
  status: string;
  startTime: number;
  durationMs: number;
  spanCount: number;
}

/** The collector (and its headers) are remembered; a header value only when it is a {{variable}} (never a typed-in key). */
const otlpSettings = persisted<{ endpoint: string; headers: KeyValue[] }>('otlp', { endpoint: 'http://localhost:4318', headers: [] });
const isVarRef = (v: string) => /^\s*\{\{[^}]+\}\}\s*$/.test(v);

function OtlpDialog({ ids, selected, onClose }: { ids: string[]; selected?: string; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const [cfg, setCfg] = useState(otlpSettings.load);
  const [busy, setBusy] = useState(false);
  useEffect(() => otlpSettings.save({ endpoint: cfg.endpoint, headers: cfg.headers.map((h) => (isVarRef(h.value) ? h : { ...h, value: '' })) }), [cfg]);
  const send = async (list: string[]) => {
    setBusy(true);
    try {
      const r = await call<{ spans: number; url: string }>('traces.exportOtlp', { ids: list, endpoint: cfg.endpoint, headers: cfg.headers, environment: env });
      useApp.getState().toast(`Sent ${r.spans} spans to ${r.url}`, 'success');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Send to OpenTelemetry"
      onClose={onClose}
      width={620}
      footer={
        <>
          {selected && (
            <Button loading={busy} disabled={!cfg.endpoint.trim()} onClick={() => void send([selected])}>
              Send selected trace
            </Button>
          )}
          <Button variant="primary" icon={<Send size={13} />} loading={busy} disabled={!cfg.endpoint.trim() || !ids.length} onClick={() => void send(ids)}>
            Send {ids.length === 1 ? 'the trace' : `${ids.length.toLocaleString()} traces`} shown
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted mb-3">Sends traces as OTLP/HTTP JSON to a collector (Jaeger, Grafana Tempo, Honeycomb, an OpenTelemetry Collector …), redacted. The CLI does this during runs with <span className="mono">--otlp</span> or the standard <span className="mono">OTEL_EXPORTER_OTLP_ENDPOINT</span>.</p>
      <label className="block text-xs text-muted mb-1">Collector URL (…/v1/traces is added)</label>
      <Input className="w-full mono mb-3" value={cfg.endpoint} onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })} placeholder="http://localhost:4318" />
      <label className="block text-xs text-muted mb-1">Headers, e.g. an API key as a secret variable: x-honeycomb-team = {'{{honeycombKey}}'}</label>
      <KeyValueEditor rows={cfg.headers} onChange={(headers) => setCfg({ ...cfg, headers })} keyPlaceholder="Header" />
    </Modal>
  );
}

export function TracesView() {
  const [otlpOpen, setOtlpOpen] = useState(false);
  const [items, setItems] = useState<TraceMeta[]>([]);
  const maxMs = Math.max(1, ...items.map((t) => t.durationMs));
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [sel, setSel] = useState<string>();
  const [trace, setTrace] = useState<Trace | null>();
  const load = useCallback(
    async (reset = true) => {
      const r = await call<{ items: TraceMeta[]; total: number }>('traces.list', { query: query || undefined, kind: kind || undefined, failed: errorsOnly || undefined, limit: 200, offset: reset ? 0 : items.length });
      setItems((x) => (reset ? r.items : [...x, ...r.items]));
      setTotal(r.total);
    },
    [query, kind, errorsOnly, items.length],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(true), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kind, errorsOnly]);
  // the view stays mounted: coming back to it, or a run that finishes, brings the newest traces in
  const active = useApp((st) => st.view === 'traces');
  useEffect(() => {
    if (active) void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => on('run.finished', () => void load(true)), [load]);
  useEffect(() => {
    if (!sel) return;
    setTrace(undefined);
    void call<Trace | null>('traces.get', { id: sel }).then(setTrace);
  }, [sel]);
  useIntent('traces', (p) => p?.traceId && setSel(p.traceId));
  return (
    <Split id="traces" initial={32}>
      <div className="h-full flex flex-col">
        <div className="flex gap-2 p-2 border-b border-line">
          <Input className="flex-1" placeholder="Filter traces" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="">All kinds</option>
            {['http', 'graphql', 'mcp', 'llm', 'test'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
          <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Only traces that ended in an error">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors
          </label>
          <IconButton label="Refresh" onClick={() => load(true)}>
            <RefreshCw size={14} />
          </IconButton>
          <IconButton label="Send to OpenTelemetry (OTLP)" onClick={() => setOtlpOpen(true)}>
            <Send size={14} />
          </IconButton>
        </div>
        {otlpOpen && <OtlpDialog ids={items.map((t) => t.id)} selected={sel} onClose={() => setOtlpOpen(false)} />}
        <div className="text-xs text-muted px-3 py-1">{plural(total, 'trace')}</div>
        {items.length ? (
          <VirtualList
            className="flex-1"
            items={items}
            rowHeight={44}
            onEndReached={items.length < total ? () => void load(false) : undefined}
            render={(t) => (
              <button onClick={() => setSel(t.id)} className={cx('w-full h-full text-left px-3 border-b border-line/60 flex flex-col justify-center', sel === t.id ? 'bg-accent/10' : 'hover:bg-hover')}>
                <div className="flex items-center gap-2 text-sm">
                  <span className={cx('w-1.5 h-1.5 rounded-full', t.status === 'ok' ? 'bg-ok' : 'bg-bad')} />
                  <span className="truncate min-w-0" title={t.name}>{t.name}</span>
                  <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted tabular-nums whitespace-nowrap shrink-0 pl-2">
                    <DurationBar ms={t.durationMs} max={maxMs} bad={t.status !== 'ok'} />
                    {formatMs(t.durationMs)}
                  </span>
                </div>
                <div className="text-xs text-muted flex gap-2 pl-3.5">
                  <Badge>{t.kind}</Badge>
                  {plural(t.spanCount, 'span')} · {timeAgo(t.startTime)}
                </div>
              </button>
            )}
          />
        ) : (
          <Empty
            icon={<Activity size={24} />}
            title="No traces yet"
            actions={[{ label: 'Send a request', onClick: () => useApp.getState().openIntent('rest', { newTab: true }) }]}
          >
            Every request, MCP call, LLM call and test run produces an OpenTelemetry-shaped trace: where the time went, span by span.
          </Empty>
        )}
      </div>
      <div className="h-full min-h-0">{trace ? <TraceView trace={trace} /> : sel ? <Empty title={trace === null ? 'Trace not found' : 'Loading…'} /> : <Empty icon={<Activity size={24} />} title="Select a trace">See its spans as a waterfall: timing phases, checks, errors and attributes.</Empty>}</div>
    </Split>
  );
}
