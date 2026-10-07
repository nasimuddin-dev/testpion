import { CompareView, type Compared } from '../components/ResponseHistory';
import { Download, History, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { confirmAction, useApp } from '../store';
import { useIntent } from '../hooks';
import type { HttpRequestSpec } from '../types';
import { formatBytes, formatMs, groupByDay } from '../lib/format';
import { DurationBar } from '../components/charts';
import { finishSave, type SaveResult } from '../lib/files';
import { JsonTree } from '../components/JsonView';
import { Badge, Button, cx, Empty, Input, Select, Split, statusTone, VirtualList } from '../components/ui';

interface Entry {
  id: string;
  timestamp: string;
  kind: string;
  name: string;
  method?: string;
  url?: string;
  status?: number | string;
  durationMs?: number;
  size?: number;
  request?: unknown;
  traceId?: string;
  responseMeta?: unknown;
}

const MIX = [
  { key: 'ok', label: '2xx / OK', color: 'var(--ok)' },
  { key: '3xx', label: '3xx', color: 'var(--accent)' },
  { key: '4xx', label: '4xx', color: 'var(--warn)' },
  { key: '5xx', label: '5xx', color: 'var(--bad)' },
  { key: 'error', label: 'Errors', color: 'color-mix(in oklab, var(--bad) 55%, transparent)' },
] as const;

/** A response's outcome bucket: 2xx (and OK results), 3xx, 4xx, 5xx, or an error (transport, gRPC, tool). */
function bucket(status: Entry['status']): (typeof MIX)[number]['key'] {
  if (typeof status === 'number') return status < 300 ? 'ok' : status < 400 ? '3xx' : status < 500 ? '4xx' : '5xx';
  // as the history's own Failed filter counts them (historyOk in core)
  return status === undefined || status === '' || /^(ok|passed|success|connected|closed)$/i.test(status) ? 'ok' : 'error';
}

/** The outcomes of the entries shown, as one bar with a count per kind (hover a part for its share). */
function StatusMix({ items }: { items: Entry[] }) {
  if (items.length < 2) return null;
  const counts = Object.fromEntries(MIX.map((m) => [m.key, 0])) as Record<(typeof MIX)[number]['key'], number>;
  for (const e of items) counts[bucket(e.status)]++;
  const shown = MIX.filter((m) => counts[m.key] > 0);
  return (
    <div className="px-3 pb-2" aria-label={`Outcomes of the ${items.length} entries shown: ${shown.map((m) => `${counts[m.key]} ${m.label}`).join(', ')}`} role="img">
      <div className="flex h-2 rounded overflow-hidden gap-0.5">
        {shown.map((m) => (
          <span key={m.key} style={{ flex: counts[m.key], background: m.color }} title={`${m.label}: ${counts[m.key]} (${Math.round((counts[m.key] / items.length) * 100)}%)`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[0.7rem] text-muted">
        {shown.map((m) => (
          <span key={m.key} className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ background: m.color }} />
            {m.label} <b className="text-fg font-medium tabular-nums">{counts[m.key]}</b>
          </span>
        ))}
        <span className="ml-auto">of the {items.length} loaded</span>
      </div>
    </div>
  );
}

/** The timing phases kept with a response (timingSummary in core). */
interface Timing {
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  downloadMs?: number;
  totalMs: number;
  reusedConnection?: boolean;
  tlsProtocol?: string;
}

const PHASES: Array<[keyof Timing, string, string]> = [
  ['dnsMs', 'DNS', 'color-mix(in oklab, var(--accent) 35%, transparent)'],
  ['tcpMs', 'TCP', 'color-mix(in oklab, var(--accent) 50%, transparent)'],
  ['tlsMs', 'TLS', 'color-mix(in oklab, var(--accent) 65%, transparent)'],
  ['ttfbMs', 'Server', 'var(--accent)'],
  ['downloadMs', 'Download', 'color-mix(in oklab, var(--ok) 70%, transparent)'],
];

/** Where an entry's time went, as one bar (connection set-up lighter), with each phase's time. */
function TimingStrip({ timing }: { timing?: Timing }) {
  if (!timing || timing.ttfbMs === undefined) return null;
  const parts = PHASES.filter(([k]) => typeof timing[k] === 'number' && (timing[k] as number) > 0);
  const sum = parts.reduce((n, [k]) => n + (timing[k] as number), 0) || 1;
  return (
    <div className="px-3 py-2 border-b border-line" role="img" aria-label={`Timing: ${parts.map(([k, l]) => `${l} ${formatMs(timing[k] as number)}`).join(', ')}`}>
      <div className="flex h-2 rounded overflow-hidden gap-0.5">
        {parts.map(([k, l, c]) => (
          <span key={k} style={{ flex: timing[k] as number, background: c }} title={`${l}: ${formatMs(timing[k] as number)} (${Math.round(((timing[k] as number) / sum) * 100)}%)`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[0.7rem] text-muted">
        {parts.map(([k, l, c]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ background: c }} />
            {l} <b className="text-fg font-medium tabular-nums">{formatMs(timing[k] as number)}</b>
          </span>
        ))}
        <span className="ml-auto">{timing.reusedConnection ? 'reused connection' : 'new connection'}{timing.tlsProtocol ? ` · ${timing.tlsProtocol}` : ''}</span>
      </div>
    </div>
  );
}

export function HistoryView() {
  const [items, setItems] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [sel, setSel] = useState<Entry>();
  // Ctrl/⌘+click a second entry: compare the two responses (older first)
  const [pair, setPair] = useState<{ before: Entry; after: Entry; result?: Compared; error?: string }>();
  const pick = (e: Entry, ev: React.MouseEvent) => {
    if ((ev.ctrlKey || ev.metaKey) && sel && sel.id !== e.id) {
      const [before, after] = sel.timestamp <= e.timestamp ? [sel, e] : [e, sel];
      setPair({ before, after });
      void call<Compared>('history.compare', { before: before.id, after: after.id }).then(
        (result) => setPair({ before, after, result }),
        (err) => setPair({ before, after, error: asError(err).message }),
      );
      return;
    }
    setPair(undefined);
    setSel(e);
  };
  const load = useCallback(
    async (reset = true) => {
      const r = await call<{ items: Entry[]; total: number }>('history.list', { query: query || undefined, kind: kind || undefined, failed: failedOnly || undefined, limit: 200, offset: reset ? 0 : items.length });
      setItems((x) => (reset ? r.items : [...x, ...r.items]));
      setTotal(r.total);
    },
    [query, kind, failedOnly, items.length],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(true), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kind, failedOnly]);
  useEffect(() => {
    const onVis = () => useApp.getState().view === 'history' && void load(true);
    return useApp.subscribe((s, p) => s.view !== p.view && onVis());
  }, [load]);
  useIntent('history', async (p) => {
    if (p?.historyId) setSel(await call('history.get', { id: p.historyId }));
  });
  const rows = useMemo(() => groupByDay(items, (e) => e.timestamp), [items]);
  // the slowest loaded entry sets the scale of the duration bars
  const maxMs = useMemo(() => Math.max(1, ...items.map((e) => e.durationMs ?? 0)), [items]);
  const reopen = (e: Entry) => {
    if (e.kind === 'http') useApp.getState().openIntent('rest', { request: e.request as HttpRequestSpec, name: e.name });
    else if (e.kind === 'llm') useApp.getState().openIntent('ai', {});
    else if (e.kind === 'mcp') useApp.getState().openIntent('mcp', {});
    else if (e.kind === 'graphql') useApp.getState().openIntent('graphql', {});
    else if (e.kind === 'grpc') useApp.getState().openIntent('grpc', { request: e.request });
  };
  return (
    <Split id="history" initial={45}>
      <div className="h-full flex flex-col">
        <div className="flex gap-2 p-2 border-b border-line">
          <Input className="flex-1" placeholder="Search history (name, URL, method, status)" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            <option value="">All</option>
            {['http', 'graphql', 'grpc', 'mcp', 'llm'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
          <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap" title="Only responses that failed: 4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed
          </label>
          <Button
            variant="ghost"
            icon={<Download size={13} />}
            title="Export the HTTP and GraphQL entries shown here as a HAR file (secrets are masked)"
            onClick={() => void call<SaveResult>('history.exportHar', { query: query || undefined, kind: kind || undefined }).then((r) => finishSave(r, 'HAR file'))}
          >
            HAR
          </Button>
          <Button
            variant="ghost"
            icon={<Trash2 size={13} />}
            onClick={async () => {
              if (!(await confirmAction({ title: 'Clear history', message: 'Clear the request history of this workspace?', detail: 'Saved requests, collections and run reports are not affected.', confirmLabel: 'Clear history', danger: true }))) return;
              await call('history.clear');
              void load(true);
            }}
          >
            Clear
          </Button>
        </div>
        <div className="text-xs text-muted px-3 py-1">{total.toLocaleString()} {total === 1 ? 'entry' : 'entries'} · grouped by day · double-click to open · Ctrl+click another to compare</div>
        <StatusMix items={items} />
        {items.length ? (
          <VirtualList
            className="flex-1"
            items={rows}
            rowHeight={44}
            onEndReached={items.length < total ? () => void load(false) : undefined}
            render={(row) => {
              if ('header' in row)
                return (
                  <div className="h-full flex items-end px-3 pb-1.5 border-b border-line bg-panel/60 text-xs font-semibold text-muted uppercase tracking-wide" role="heading" aria-level={3}>
                    {row.header}
                  </div>
                );
              const e = row.item;
              return (
              <button onDoubleClick={() => reopen(e)} onClick={(ev) => pick(e, ev)} className={cx('w-full h-full text-left px-3 border-b border-line/60 flex flex-col justify-center', sel?.id === e.id || pair?.before.id === e.id || pair?.after.id === e.id ? 'bg-accent/10' : 'hover:bg-hover')}>
                <div className="flex items-center gap-2 text-sm">
                  {e.method && <span className={cx('mono method-badge text-[0.64rem] font-bold w-14 shrink-0', `method-${e.method}`)}>{e.method}</span>}
                  {!e.method && <Badge>{e.kind}</Badge>}
                  <span className="truncate">{e.url ?? e.name}</span>
                  {e.status !== undefined && (
                    <span className="ml-auto">
                      <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted flex gap-2">
                  <span>{new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {e.durationMs !== undefined && (
                    <span className="inline-flex items-center gap-1.5">
                      <DurationBar ms={e.durationMs} max={maxMs} bad={statusTone(e.status) === 'bad'} />
                      {formatMs(e.durationMs)}
                    </span>
                  )}
                  {e.size !== undefined && <span>{formatBytes(e.size)}</span>}
                </div>
              </button>
              );
            }}
          />
        ) : (
          <Empty
            icon={<History size={24} />}
            title="No history yet"
            actions={[{ label: 'Send a request', onClick: () => useApp.getState().openIntent('rest', { newTab: true }) }]}
          >
            Every request you send is kept here with its response: open it again, compare two, or save it to a collection.
          </Empty>
        )}
      </div>
      <div className="h-full flex flex-col">
        {pair ? (
          <>
            <div className="flex items-center gap-2 px-3 h-10 border-b border-line text-sm">
              <span className="font-medium truncate">Comparing two responses</span>
              <span className="text-xs text-muted truncate">
                {new Date(pair.before.timestamp).toLocaleTimeString()} → {new Date(pair.after.timestamp).toLocaleTimeString()}
              </span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPair(undefined)}>
                Close
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {pair.error ? <p className="p-3 text-sm text-bad">{pair.error}</p> : pair.result ? <CompareView c={pair.result} labels={[`${pair.before.name} · ${new Date(pair.before.timestamp).toLocaleString()}`, `${pair.after.name} · ${new Date(pair.after.timestamp).toLocaleString()}`]} /> : <Empty title="Comparing…" />}
            </div>
          </>
        ) : sel ? (
          <>
            <div className="flex items-center gap-2 px-3 h-10 border-b border-line">
              <span className="font-medium truncate">{sel.name}</span>
              <div className="ml-auto flex gap-2">
                {sel.traceId && (
                  <Button size="sm" onClick={() => useApp.getState().openIntent('traces', { traceId: sel.traceId })}>
                    View trace
                  </Button>
                )}
                <Button size="sm" variant="primary" icon={<RotateCcw size={12} />} onClick={() => reopen(sel)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={12} />}
                  onClick={async () => {
                    await call('history.delete', { id: sel.id });
                    setSel(undefined);
                    void load(true);
                  }}
                />
              </div>
            </div>
            <TimingStrip timing={(sel.responseMeta as { timing?: Timing } | undefined)?.timing} />
            <div className="flex-1 min-h-0">
              <JsonTree data={{ timestamp: sel.timestamp, kind: sel.kind, status: sel.status, durationMs: sel.durationMs, request: sel.request }} />
            </div>
            <p className="text-xs text-muted p-2 border-t border-line">History stores redacted request metadata; response bodies are kept on disk under payloads/.</p>
          </>
        ) : (
          <Empty icon={<History size={24} />} title="Select an entry">
            See its request and response here. Double-click to open it in a tab; Ctrl+click a second one to compare the two.
          </Empty>
        )}
      </div>
    </Split>
  );
}
