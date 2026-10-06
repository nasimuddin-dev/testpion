import { ArrowLeft, ArrowRight, Eye, GitCompareArrows, History as HistoryIcon, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { formatBytes, formatMs, timeAgo } from '../lib/format';
import { JsonTree, RawView } from './JsonView';
import { LatencyTrend } from './LatencyTrend';
import { LinkButton, Badge, Button, cx, Empty, IconButton, Spinner, statusTone } from './ui';

interface Entry {
  id: string;
  timestamp: string;
  status?: number | string;
  durationMs?: number;
  size?: number;
}

interface BodyChange {
  path: string;
  kind: 'added' | 'removed' | 'changed' | 'type';
  before?: unknown;
  after?: unknown;
}
interface Diff {
  status: { before?: number | string; after?: number | string; changed: boolean };
  durationMs: { before?: number; after?: number; deltaMs?: number };
  headers: Array<{ name: string; kind: 'added' | 'removed' | 'changed'; before?: string; after?: string; volatile: boolean }>;
  body: { format: 'json' | 'text' | 'none'; identical: boolean; changes: BodyChange[]; lines?: Array<{ op: ' ' | '+' | '-'; text: string }>; truncated: boolean };
  different: boolean;
  summary: string;
}
export interface Compared {
  before: Entry;
  after: Entry;
  diff: Diff;
  bodyMissing: boolean;
}

const show = (v: unknown) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? s.slice(0, 160) + '…' : s;
};
const KIND = {
  added: { label: 'added', className: 'text-ok bg-ok/10 border-ok/25', sign: '+' },
  removed: { label: 'removed', className: 'text-bad bg-bad/10 border-bad/25', sign: '−' },
  changed: { label: 'changed', className: 'text-warn bg-warn/10 border-warn/25', sign: '~' },
  type: { label: 'type', className: 'text-judge bg-judge/10 border-judge/25', sign: '≠' },
} as const;

/**
 * Response history of a saved request: earlier responses, newest first. View any of them, or compare
 * two (status, timing, headers and a field-by-field body diff) to spot what changed between runs.
 */
export function ResponseHistory({ requestId, latestId }: { requestId: string; latestId?: string }) {
  const [entries, setEntries] = useState<Entry[]>();
  const [picked, setPicked] = useState<string[]>([]);
  const [compared, setCompared] = useState<Compared>();
  const [viewing, setViewing] = useState<{ entry: Entry; body?: string; bodyMissing: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = () => {
    setError(undefined);
    call<Entry[]>('history.forRequest', { requestId, limit: 50 }).then(setEntries, (e) => setError(asError(e).message));
  };
  useEffect(load, [requestId, latestId]);

  const compare = async (beforeId: string, afterId: string) => {
    setBusy(true);
    setViewing(undefined);
    try {
      setCompared(await call<Compared>('history.compare', { before: beforeId, after: afterId }));
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const view = async (id: string) => {
    setBusy(true);
    setCompared(undefined);
    try {
      setViewing(await call<{ entry: Entry; body?: string; bodyMissing: boolean }>('history.response', { id }));
    } catch (e) {
      setError(asError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  if (error) return <Empty icon={<HistoryIcon size={24} />} title="Couldn't load the history">{error}</Empty>;
  if (!entries) return <div className="h-full grid place-items-center"><Spinner /></div>;
  if (!entries.length)
    return (
      <Empty icon={<HistoryIcon size={24} />} title="No earlier responses yet">
        Each time you send this saved request, its response is kept here so you can compare runs.
      </Empty>
    );

  const sorted = (ids: string[]) => [...ids].sort((a, b) => entries.findIndex((e) => e.id === b) - entries.findIndex((e) => e.id === a));

  return (
    <div className="h-full flex min-h-0">
      <div className="w-72 shrink-0 border-r border-line flex flex-col min-h-0">
        <div className="flex items-center gap-1 px-2 h-9 border-b border-line text-xs text-muted shrink-0">
          <span className="flex-1">{entries.length} response{entries.length === 1 ? '' : 's'} · pick two to compare</span>
          <IconButton label="Refresh" className="h-7 w-7" onClick={load}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
        <LatencyTrend entries={entries} onPick={(id) => void view(id)} />
        <div className="flex-1 overflow-auto">
          {entries.map((e, i) => (
            <div key={e.id} className={cx('group flex items-center gap-2 px-2 py-1.5 border-b border-line/60 text-sm', picked.includes(e.id) ? 'bg-accent-soft' : 'hover:bg-hover')}>
              <input type="checkbox" aria-label={`Select the response from ${timeAgo(e.timestamp)}`} checked={picked.includes(e.id)} onChange={() => toggle(e.id)} />
              <button className="flex-1 min-w-0 text-left" onClick={() => void view(e.id)} title="View this response">
                <div className="flex items-center gap-1.5">
                  <Badge tone={e.status === undefined ? 'bad' : statusTone(e.status)}>{e.status ?? '—'}</Badge>
                  <span className="text-xs text-muted tabular-nums">{formatMs(e.durationMs)} · {formatBytes(e.size)}</span>
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {timeAgo(e.timestamp)}
                  {e.id === latestId && <span className="text-accent"> · latest</span>}
                </div>
              </button>
              {i < entries.length - 1 && (
                <IconButton label="Compare with the previous response" className="h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void compare(entries[i + 1]!.id, e.id)}>
                  <GitCompareArrows size={14} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
        <div className="p-2 border-t border-line shrink-0">
          <Button size="sm" variant="primary" className="w-full" icon={<GitCompareArrows size={13} />} disabled={picked.length !== 2} loading={busy && picked.length === 2}
            onClick={() => { const [a, b] = sorted(picked); void compare(a!, b!); }}>
            Compare selected
          </Button>
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {busy && !compared && !viewing ? (
          <div className="h-full grid place-items-center"><Spinner /></div>
        ) : compared ? (
          <CompareView c={compared} />
        ) : viewing ? (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0">
              <Eye size={14} className="text-muted" />
              <Badge tone={viewing.entry.status === undefined ? 'bad' : statusTone(viewing.entry.status)}>{viewing.entry.status}</Badge>
              <span className="text-muted">{new Date(viewing.entry.timestamp).toLocaleString()}</span>
            </div>
            <div className="flex-1 min-h-0">{viewing.bodyMissing ? <Empty title="The body of this response is no longer on disk" /> : <BodyView text={viewing.body ?? ''} />}</div>
          </div>
        ) : (
          <Empty icon={<GitCompareArrows size={24} />} title="Compare responses">
            Click a response to view it, or pick two and press <b>Compare selected</b> (or use the compare button on a row to compare it with the one before) to see what changed.
          </Empty>
        )}
      </div>
    </div>
  );
}

function BodyView({ text }: { text: string }) {
  try {
    return <JsonTree data={JSON.parse(text)} />;
  } catch {
    return <RawView text={text} />;
  }
}

/** Two responses side by side: status, time, headers and body changes. `labels` name the sides (default: when they were received). */
export function CompareView({ c, labels }: { c: Compared; labels?: [string, string] }) {
  const d = c.diff;
  const [showVolatile, setShowVolatile] = useState(false);
  const headers = d.headers.filter((h) => showVolatile || !h.volatile);
  const hiddenVolatile = d.headers.filter((h) => h.volatile).length;
  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-line flex items-center gap-3 flex-wrap">
        <span className={cx('text-xs', labels ? 'font-medium text-fg' : 'text-muted')}>{labels?.[0] ?? new Date(c.before.timestamp).toLocaleString()}</span>
        <ArrowRight size={14} className="text-muted" />
        <span className={cx('text-xs', labels ? 'font-medium text-fg' : 'text-muted')}>{labels?.[1] ?? new Date(c.after.timestamp).toLocaleString()}</span>
        <Badge tone={d.different ? 'warn' : 'ok'}>{d.different ? 'Changed' : 'Same'}</Badge>
        <span className="text-sm">{d.summary}</span>
      </div>
      <div className="px-4 py-3 grid gap-4">
        <div className="flex flex-wrap gap-6 text-sm">
          <div>
            <div className="text-xs text-muted mb-1">Status</div>
            <span className="inline-flex items-center gap-1.5">
              <Badge tone={statusTone(d.status.before)}>{d.status.before}</Badge>
              <ArrowRight size={12} className="text-muted" />
              <Badge tone={statusTone(d.status.after)}>{d.status.after}</Badge>
            </span>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Time</div>
            <span className="tabular-nums">
              {formatMs(d.durationMs.before)} → {formatMs(d.durationMs.after)}
              {d.durationMs.deltaMs !== undefined && (
                <span className={cx('ml-1.5 text-xs', d.durationMs.deltaMs > 0 ? 'text-warn' : 'text-ok')}>
                  ({d.durationMs.deltaMs > 0 ? '+' : ''}
                  {formatMs(d.durationMs.deltaMs)})
                </span>
              )}
            </span>
          </div>
        </div>

        <section>
          <div className="text-sm font-semibold mb-2">Body {d.body.identical ? <span className="text-muted font-normal">· identical</span> : null}</div>
          {c.bodyMissing && <p className="text-xs text-warn mb-2">One of the bodies is no longer on disk, so it is compared as empty.</p>}
          {d.body.format === 'json' && !d.body.identical && (
            <div className="rounded-lg border border-line overflow-hidden">
              {d.body.changes.map((ch, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-1.5 border-b border-line/60 last:border-0 text-sm">
                  <span className={cx('shrink-0 whitespace-nowrap text-[0.7rem] font-semibold px-1.5 rounded border min-w-[4.75rem] text-center', KIND[ch.kind].className)}>
                    {KIND[ch.kind].sign} {KIND[ch.kind].label}
                  </span>
                  <span className="mono text-xs shrink-0 pt-0.5 text-fg">{ch.path}</span>
                  <span className="mono text-xs min-w-0 break-all pt-0.5">
                    {ch.kind !== 'added' && <span className="text-bad line-through decoration-bad/50">{show(ch.before)}</span>}
                    {ch.kind === 'changed' || ch.kind === 'type' ? <span className="text-muted"> → </span> : null}
                    {ch.kind !== 'removed' && <span className="text-ok">{show(ch.after)}</span>}
                  </span>
                </div>
              ))}
              {d.body.truncated && <div className="px-3 py-1.5 text-xs text-muted">More changes not shown.</div>}
            </div>
          )}
          {d.body.format === 'text' && !d.body.identical && (
            <pre className="mono text-xs rounded-lg border border-line overflow-auto max-h-96 py-1">
              {d.body.lines?.map((l, i) => (
                <div key={i} className={cx('px-3 whitespace-pre-wrap', l.op === '+' && 'bg-ok/10 text-ok', l.op === '-' && 'bg-bad/10 text-bad')}>
                  {l.op} {l.text}
                </div>
              ))}
            </pre>
          )}
        </section>

        <section>
          <div className="text-sm font-semibold mb-2 flex items-center gap-2">
            Headers
            {hiddenVolatile > 0 && (
              <LinkButton className="text-xs font-normal" onClick={() => setShowVolatile(!showVolatile)}>
                {showVolatile ? 'Hide' : 'Show'} {hiddenVolatile} that change every time (date, request ids …)
              </LinkButton>
            )}
          </div>
          {headers.length ? (
            <div className="rounded-lg border border-line overflow-hidden">
              {headers.map((h) => (
                <div key={h.name} className={cx('flex items-start gap-2 px-3 py-1.5 border-b border-line/60 last:border-0 text-sm', h.volatile && 'opacity-60')}>
                  <span className={cx('shrink-0 whitespace-nowrap text-[0.7rem] font-semibold px-1.5 rounded border min-w-[4.75rem] text-center', KIND[h.kind].className)}>
                    {KIND[h.kind].sign} {KIND[h.kind].label}
                  </span>
                  <span className="mono text-xs shrink-0 pt-0.5">{h.name}</span>
                  <span className="mono text-xs min-w-0 break-all pt-0.5">
                    {h.before !== undefined && <span className="text-bad">{h.before}</span>}
                    {h.before !== undefined && h.after !== undefined && <ArrowLeft size={10} className="inline mx-1 rotate-180 text-muted" />}
                    {h.after !== undefined && <span className="text-ok">{h.after}</span>}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No header changes.</p>
          )}
        </section>
      </div>
    </div>
  );
}
