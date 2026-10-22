import { Activity, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, on } from '../api';
import { persisted, toastError, useApp } from '../store';
import { KeyValueEditor } from '../components/KeyValueEditor';
import type { KeyValue } from '../types';
import { useFilteredLoad, useIntent } from '../hooks';
import type { Trace } from '../types';
import { formatMs, plural, timeAgo } from '../lib/format';
import { TraceView } from '../components/TraceView';
import { DurationBar } from '../components/charts';
import { AskSearchButton } from '../components/ai/AskSearchButton';
import { ASK_SCOPE } from '../components/ai/ask-search';
import { Badge, Busy, Button, cx, Empty, IconButton, Input, Modal, Select, Split, VirtualList } from '../components/ui';
import { treeKeys } from '../components/TreeParts';
import { TreeRowShell } from '../components/TreeRowShell';
import type { NodeMenuCtx } from '../lib/node-menu';
import { openRef, copyRefLink } from '../lib/open-ref';
import { outputFileName } from '@testpion/shared';
import { OutputActions } from '../components/output/OutputFrame';
import type { OutputSpec } from '../components/output/output-core';

interface TraceMeta {
  id: string;
  name: string;
  kind: string;
  status: string;
  startTime: number;
  durationMs: number;
  spanCount: number;
  /** The run it belongs to (a test's trace). */
  runId?: string;
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
      onSubmit={() => void send(ids)}
      width={620}
      footer={
        <>
          {selected && (
            <Button loading={busy} disabled={!cfg.endpoint.trim()} reason="Enter the endpoint first" onClick={() => void send([selected])}>
              Send selected trace
            </Button>
          )}
          <Button variant="primary" icon={<Send size={13} />} loading={busy} disabled={!cfg.endpoint.trim() || !ids.length} reason={!cfg.endpoint.trim() ? 'Enter the endpoint first' : 'No traces are listed'} onClick={() => void send(ids)}>
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
  // a trace's menu (right-click, ⋯, Shift+F10): open · its run · copy link (lib/node-menu.ts builds it)
  const traceMenu = (t: TraceMeta): NodeMenuCtx => ({
    ref: { kind: 'trace', traceId: t.id },
    name: t.name,
    on: { open: () => setSel(t.id), ...(t.runId ? { openRun: () => void openRef({ kind: 'run', runId: t.runId! }) } : {}), copyLink: () => void copyRefLink({ kind: 'trace', traceId: t.id }) },
  });
  const load = useCallback(
    async (reset = true) => {
      const r = await call<{ items: TraceMeta[]; total: number }>('traces.list', { query: query || undefined, kind: kind || undefined, failed: errorsOnly || undefined, limit: 200, offset: reset ? 0 : items.length });
      setItems((x) => (reset ? r.items : [...x, ...r.items]));
      setTotal(r.total);
    },
    [query, kind, errorsOnly, items.length],
  );
  useFilteredLoad(() => void load(true), query, [kind, errorsOnly], true);
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
  // OTLP JSON of the traces as filtered here (the newest 1,000), or of the selected one; the backend reads them from disk
  const spec = useMemo<OutputSpec>(() => {
    const shown = { kind: 'traces' as const, query: query || undefined, traceKind: kind || undefined, failed: errorsOnly || undefined, limit: 1000 };
    return {
      id: 'traces',
      what: 'traces',
      name: outputFileName({ name: 'testpion-traces', ext: '' }),
      formats: [
        { key: 'shown', format: 'json', label: 'Traces shown (OTLP JSON)', source: shown, default: true },
        ...(sel ? [{ key: 'selected', format: 'json' as const, label: 'Selected trace (OTLP JSON)', source: { kind: 'traces' as const, ids: [sel] }, fileName: `trace-${sel.slice(0, 8)}.json` }] : []),
      ],
      empty: total ? undefined : 'No traces yet',
    };
  }, [query, kind, errorsOnly, sel, total]);
  return (
    <Split id="traces" initial={32}>
      <div className="h-full flex flex-col" data-output="traces" onKeyDown={treeKeys}>
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
          <AskSearchButton scope={ASK_SCOPE.traces} />
          <IconButton label="Refresh" onClick={() => load(true)}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        {otlpOpen && <OtlpDialog ids={items.map((t) => t.id)} selected={sel} onClose={() => setOtlpOpen(false)} />}
        <div className="flex items-center gap-2 px-3 min-h-8 min-w-0">
          <span className="text-xs text-muted truncate min-w-0">{plural(total, 'trace')}</span>
          <OutputActions spec={spec}>
            <IconButton label="Send to OpenTelemetry (OTLP)" onClick={() => setOtlpOpen(true)}>
              <Send size={14} />
            </IconButton>
          </OutputActions>
        </div>
        {items.length ? (
          <VirtualList
            className="flex-1"
            items={items}
            rowHeight={44}
            role="tree"
            label="Traces"
            onEndReached={items.length < total ? () => void load(false) : undefined}
            // the one row (TreeRowShell, as History's): click or Enter shows the trace, keys and ⋯ open its menu, it drags onto a flow canvas
            render={(t) => (
              <TreeRowShell
                kind="trace"
                nodeId={`trace:${t.id}`}
                label={t.name}
                tall
                active={sel === t.id}
                onClick={() => setSel(t.id)}
                onOpen={() => setSel(t.id)}
                ctx={() => traceMenu(t)}
                drag={[{ kind: 'trace', traceId: t.id }]}
                className="h-full pl-3 border-b border-line/60"
              >
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 text-sm">
                    <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', t.status === 'ok' ? 'bg-ok' : 'bg-bad')} />
                    <span className="truncate min-w-0">{t.name}</span>
                    <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted tabular-nums whitespace-nowrap shrink-0 pl-2">
                      <DurationBar ms={t.durationMs} max={maxMs} bad={t.status !== 'ok'} />
                      {formatMs(t.durationMs)}
                    </span>
                  </span>
                  <span className="text-xs text-muted flex gap-2 pl-3.5">
                    <Badge>{t.kind}</Badge>
                    {plural(t.spanCount, 'span')} · {timeAgo(t.startTime)}
                  </span>
                </span>
              </TreeRowShell>
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
      <div className="h-full min-h-0">{trace ? <TraceView trace={trace} /> : sel ? trace === null ? <Empty title="Trace not found" /> : <Busy>Loading the trace…</Busy> : <Empty icon={<Activity size={24} />} title="Select a trace">See its spans as a waterfall: timing phases, checks, errors and attributes.</Empty>}</div>
    </Split>
  );
}
