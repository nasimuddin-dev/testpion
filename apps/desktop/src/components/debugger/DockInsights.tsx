import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { formatBytes, formatMs } from '@testpion/shared';
import { cx, Empty } from '../ui';
import { headerSizes, kb, speedOf, versionOf, type Exchange } from './model';

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** The three phases of one exchange, in milliseconds. */
export function phasesOf(e: Exchange): { sending: number; waiting: number; receiving: number } {
  const total = e.durationMs ?? 0;
  const wait = e.waitMs ?? total;
  const send = Math.min(e.sendMs ?? 0, wait);
  return { sending: send, waiting: Math.max(0, wait - send), receiving: Math.max(0, total - wait) };
}

const BAR = { sending: 'bg-accent', waiting: 'bg-muted/60', receiving: 'bg-ok' } as const;

/** Timeline (F5): one request's Sending / Waiting / Receiving, or several on one time axis; their count, time and size. */
export function TimelinePanel({ picked }: { picked: Exchange[] }) {
  if (!picked.length) return <Empty title="Select a request">Its timing shows here: sending, waiting for the server, receiving. Select several (Ctrl / Shift) to see them on one axis.</Empty>;
  const bytes = picked.reduce((n, e) => {
    const h = headerSizes(e);
    return n + e.requestBodyBytes + e.responseBodyBytes + h.request + h.response;
  }, 0);
  const start = Math.min(...picked.map((e) => Date.parse(e.startedAt)));
  const end = Math.max(...picked.map((e) => Date.parse(e.startedAt) + (e.durationMs ?? 0)));
  const span = Math.max(1, end - start);
  const one = picked.length === 1 ? picked[0]! : undefined;
  return (
    <div className="flex-1 min-h-0 overflow-auto text-xs" data-timeline>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-panel text-muted">
          <tr>
            <th className="text-left font-medium px-2 py-1 w-2/5 border-b border-line">{one ? 'Phase' : 'URL'}</th>
            <th className="text-left font-medium px-2 py-1 border-b border-line">Timeline</th>
          </tr>
        </thead>
        <tbody>
          {one
            ? (() => {
                const p = phasesOf(one);
                const total = Math.max(1, p.sending + p.waiting + p.receiving);
                let at = 0;
                return (['sending', 'waiting', 'receiving'] as const).map((k) => {
                  const left = (at / total) * 100;
                  at += p[k];
                  return (
                    <tr key={k} className="border-b border-line/60" data-phase={k}>
                      <td className="px-2 py-1 capitalize">{k}</td>
                      <td className="px-2 py-1">
                        <div className="relative h-4">
                          <div className={cx('absolute top-0.5 h-3 rounded-sm', BAR[k])} style={{ left: `${left}%`, width: `max(2px, ${(p[k] / total) * 100}%)` }} />
                          <span className="absolute top-0 text-[10px] tabular-nums" style={{ left: `min(calc(${left + (p[k] / total) * 100}% + 4px), calc(100% - 3rem))` }}>
                            {formatMs(p[k])}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                });
              })()
            : picked.map((e) => {
                const p = phasesOf(e);
                const s = Date.parse(e.startedAt) - start;
                const seg = (ms: number, k: keyof typeof BAR, from: number) => (
                  <div key={k} className={cx('absolute top-0.5 h-3', BAR[k])} style={{ left: `${(from / span) * 100}%`, width: `max(1px, ${(ms / span) * 100}%)` }} />
                );
                return (
                  <tr key={e.id} className="border-b border-line/60" title={e.url}>
                    <td className="px-2 py-1 truncate max-w-0">
                      <span className={cx('font-bold mr-1', `method-${e.method}`)}>{e.method}</span>
                      {pathOf(e.url)}
                    </td>
                    <td className="px-2 py-1">
                      <div className="relative h-4">
                        {seg(p.sending, 'sending', s)}
                        {seg(p.waiting, 'waiting', s + p.sending)}
                        {seg(p.receiving, 'receiving', s + p.sending + p.waiting)}
                      </div>
                    </td>
                  </tr>
                );
              })}
          <tr className="font-semibold border-b border-line/60">
            <td className="px-2 py-1">Selected Items</td>
            <td className="px-2 py-1 tabular-nums">{picked.length}</td>
          </tr>
          <tr className="font-semibold border-b border-line/60">
            <td className="px-2 py-1">Total Time (sec)</td>
            <td className="px-2 py-1 tabular-nums" data-total-time>
              {(picked.length === 1 ? (one!.durationMs ?? 0) / 1000 : span / 1000).toFixed(3)}
            </td>
          </tr>
          <tr className="font-semibold border-b border-line/60">
            <td className="px-2 py-1">Total Size (kb)</td>
            <td className="px-2 py-1 tabular-nums">{kb(bytes)}</td>
          </tr>
        </tbody>
      </table>
      <div className="flex gap-3 px-2 py-2 text-[11px] text-muted">
        {(Object.keys(BAR) as Array<keyof typeof BAR>).map((k) => (
          <span key={k} className="flex items-center gap-1 capitalize">
            <span className={cx('inline-block w-3 h-2 rounded-sm', BAR[k])} /> {k}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A grouped property table (Summary): a header row per group that folds, then name / value rows. */
function PropertyTable({ groups }: { groups: Array<{ title: string; rows: Array<[string, ReactNode]> }> }) {
  const [closed, setClosed] = useState<string[]>([]);
  return (
    <table className="w-full text-xs border-collapse">
      <tbody>
        {groups.map((g) => {
          const open = !closed.includes(g.title);
          return (
            <Fragment key={g.title}>
              <tr
                className="bg-panel font-semibold cursor-pointer select-none"
                onClick={() => setClosed(open ? [...closed, g.title] : closed.filter((x) => x !== g.title))}
                data-summary-group={g.title}
              >
                <td className="px-2 py-1 border-b border-line" colSpan={2}>
                  <span className="inline-flex items-center gap-1">
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {g.title}
                  </span>
                </td>
              </tr>
              {open &&
                g.rows.map(([k, v]) => (
                  <tr key={k} className="border-b border-line/60 hover:bg-hover" data-summary-row={k}>
                    <td className="pl-6 pr-2 py-1 w-2/5 text-muted whitespace-nowrap">{k}</td>
                    <td className="px-2 py-1 mono break-all">{v ?? ''}</td>
                  </tr>
                ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** Summary: the selected request at a glance: program, connection, request and response sizes and types, timing. */
export function SummaryPanel({ e }: { e?: Exchange }) {
  if (!e) return <Empty title="Select a request">Its program, connection, sizes and types show here.</Empty>;
  // the sizes as sent (the detail's header values are masked)
  const { request: reqHead, response: resHead } = headerSizes(e);
  const p = phasesOf(e);
  return (
    <div className="flex-1 min-h-0 overflow-auto" data-summary>
      <PropertyTable
        groups={[
          {
            title: 'Main',
            rows: [
              ['PID', e.pid],
              ['Application', e.application ?? `unknown (client port ${e.clientPort})`],
              ['IP Address', e.serverAddress],
              ['Total Size (kb)', kb(e.requestBodyBytes + e.responseBodyBytes + reqHead + resHead)],
            ],
          },
          {
            title: 'Connection',
            rows: [
              ['Protocol', versionOf(e)],
              ['HTTPS', e.kind === 'tunnel' ? 'tunnel (not decrypted)' : e.tls ? 'decrypted' : 'no'],
              ['Connection ID', e.connectionId],
              ['Stream ID', e.streamId],
              ['Client port', e.clientPort],
            ],
          },
          {
            title: 'Request Details',
            rows: [
              ['Method', e.method],
              ['URL', e.url],
              ['Header Size (kb)', kb(reqHead)],
              ['Content Size (kb)', kb(e.requestBodyBytes)],
              ['Content Type', e.requestHeaders['content-type']],
            ],
          },
          {
            title: 'Response Details',
            rows: [
              ['Status', e.error ? `error: ${e.error}` : e.status ? `${e.status} ${e.statusText ?? ''}` : 'waiting'],
              ['Header Size (kb)', kb(resHead)],
              ['Content Size (kb)', kb(e.responseBodyBytes)],
              ['Content Type', e.contentType],
              ...(e.grpc ? ([['gRPC status', e.grpc.statusName ?? e.grpc.status]] as Array<[string, ReactNode]>) : []),
            ],
          },
          {
            title: 'Timing',
            rows: [
              ['Started', new Date(e.startedAt).toLocaleString()],
              ['Sending', formatMs(p.sending)],
              ['Waiting', formatMs(p.waiting)],
              ['Receiving', formatMs(p.receiving)],
              ['Total', formatMs(e.durationMs)],
              ['Speed (KB/s)', speedOf(e)],
            ],
          },
        ]}
      />
    </div>
  );
}

interface Node {
  name: string;
  count: number;
  bytes: number;
  ids: string[];
  children: Map<string, Node>;
}

/** Structure (F6): the requests listed, by domain then path (each segment a level), with counts and sizes. */
export function StructurePanel({ rows, onPick }: { rows: Exchange[]; onPick(id: string): void }) {
  const [open, setOpen] = useState<string[]>([]);
  const root = useMemo(() => {
    const top: Node = { name: '', count: 0, bytes: 0, ids: [], children: new Map() };
    for (const e of rows) {
      const bytes = e.requestBodyBytes + e.responseBodyBytes;
      const parts = [e.host, ...pathOf(e.url).split('/').filter(Boolean)];
      let n = top;
      top.count++;
      top.bytes += bytes;
      for (const part of parts) {
        let c = n.children.get(part);
        if (!c) n.children.set(part, (c = { name: part, count: 0, bytes: 0, ids: [], children: new Map() }));
        c.count++;
        c.bytes += bytes;
        c.ids.push(e.id);
        n = c;
      }
    }
    return top;
  }, [rows]);
  if (!rows.length) return <Empty title="No requests">Domains and their paths show here as traffic comes in.</Empty>;
  const render = (n: Node, key: string, depth: number): ReactNode[] => {
    const isOpen = open.includes(key);
    const kids = [...n.children.values()].sort((a, b) => b.count - a.count);
    return [
      <tr key={key} className="border-b border-line/60 hover:bg-hover cursor-default" data-structure={key} onDoubleClick={() => onPick(n.ids[0]!)}>
        <td className="py-1 pr-2" style={{ paddingLeft: 8 + depth * 14 }}>
          <button
            type="button"
            className="inline-flex items-center gap-1 min-w-0 max-w-full"
            onClick={() => kids.length && setOpen(isOpen ? open.filter((x) => x !== key) : [...open, key])}
            aria-expanded={kids.length ? isOpen : undefined}
          >
            {kids.length ? isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="w-3" />}
            <span className={cx('truncate', depth === 0 && 'font-medium')}>{depth === 0 ? n.name : `/${n.name}`}</span>
          </button>
        </td>
        <td className="px-2 py-1 text-right tabular-nums">{n.count}</td>
        <td className="px-2 py-1 text-right tabular-nums">{kb(n.bytes)}</td>
      </tr>,
      ...(isOpen ? kids.flatMap((c) => render(c, `${key}/${c.name}`, depth + 1)) : []),
    ];
  };
  return (
    <div className="flex-1 min-h-0 overflow-auto text-xs" data-structure-panel>
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-panel text-muted">
          <tr>
            <th className="text-left font-medium px-2 py-1 border-b border-line">Domain</th>
            <th className="text-right font-medium px-2 py-1 border-b border-line w-16">Count</th>
            <th className="text-right font-medium px-2 py-1 border-b border-line w-20">Size (kb)</th>
          </tr>
        </thead>
        <tbody>
          {[...root.children.values()].sort((a, b) => b.count - a.count).flatMap((d) => render(d, d.name, 0))}
          <tr className="font-semibold">
            <td className="px-2 py-1">Total</td>
            <td className="px-2 py-1 text-right tabular-nums">{root.count}</td>
            <td className="px-2 py-1 text-right tabular-nums">{kb(root.bytes)}</td>
          </tr>
        </tbody>
      </table>
      <p className="px-2 py-2 text-[11px] text-muted">Double-click a domain or a path to select its first request.</p>
    </div>
  );
}

/** Performance: where the time and the bytes go: the slowest, the largest, the slowest transfers, and by domain. */
export function PerformancePanel({ rows, onPick }: { rows: Exchange[]; onPick(id: string): void }) {
  const done = rows.filter((e) => e.durationMs !== undefined && e.kind !== 'tunnel');
  if (!done.length) return <Empty title="Nothing finished yet">Response times and sizes show here once requests complete.</Empty>;
  const top = (list: Exchange[], value: (e: Exchange) => string) => (
    <table className="w-full text-xs border-collapse mb-2">
      <tbody>
        {list.slice(0, 8).map((e) => (
          <tr key={e.id} className="border-b border-line/60 hover:bg-hover cursor-pointer" onClick={() => onPick(e.id)} title={e.url}>
            <td className="px-2 py-1 truncate max-w-0">
              <span className={cx('font-bold mr-1', `method-${e.method}`)}>{e.method}</span>
              {e.host}
              {pathOf(e.url)}
            </td>
            <td className="px-2 py-1 text-right tabular-nums w-24">{value(e)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const byHost = new Map<string, { n: number; ms: number; max: number; bytes: number }>();
  for (const e of done) {
    const h = byHost.get(e.host) ?? { n: 0, ms: 0, max: 0, bytes: 0 };
    h.n++;
    h.ms += e.durationMs!;
    h.max = Math.max(h.max, e.durationMs!);
    h.bytes += e.responseBodyBytes;
    byHost.set(e.host, h);
  }
  const waitShare =
    done.reduce((n, e) => n + phasesOf(e).waiting, 0) /
    Math.max(
      1,
      done.reduce((n, e) => n + (e.durationMs ?? 0), 0),
    );
  const title = (t: string) => <div className="px-2 pt-2 pb-1 text-[11px] font-semibold text-muted uppercase tracking-wide">{t}</div>;
  return (
    <div className="flex-1 min-h-0 overflow-auto" data-performance>
      <p className="px-2 pt-2 text-xs">
        {done.length} requests · {Math.round(waitShare * 100)}% of the time is spent waiting for servers
        {waitShare > 0.7 ? ' (the servers are the bottleneck)' : waitShare < 0.3 ? ' (transfers are the bottleneck)' : ''}.
      </p>
      {title('Slowest responses')}
      {top(
        [...done].sort((a, b) => b.durationMs! - a.durationMs!),
        (e) => formatMs(e.durationMs),
      )}
      {title('Largest payloads')}
      {top(
        [...done].sort((a, b) => b.responseBodyBytes - a.responseBodyBytes),
        (e) => formatBytes(e.responseBodyBytes),
      )}
      {title('Slowest transfers (KB/s)')}
      {top(
        done.filter((e) => e.responseBodyBytes > 0).sort((a, b) => Number(speedOf(a)) - Number(speedOf(b))),
        (e) => speedOf(e),
      )}
      {title('By domain')}
      <table className="w-full text-xs border-collapse mb-2">
        <thead className="text-muted">
          <tr>
            <th className="text-left font-medium px-2 py-1">Domain</th>
            <th className="text-right font-medium px-2 py-1">Count</th>
            <th className="text-right font-medium px-2 py-1">Average</th>
            <th className="text-right font-medium px-2 py-1">Slowest</th>
          </tr>
        </thead>
        <tbody>
          {[...byHost.entries()]
            .sort((a, b) => b[1].ms / b[1].n - a[1].ms / a[1].n)
            .map(([h, v]) => (
              <tr key={h} className="border-t border-line/60">
                <td className="px-2 py-1 truncate max-w-0">{h}</td>
                <td className="px-2 py-1 text-right tabular-nums">{v.n}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatMs(v.ms / v.n)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatMs(v.max)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
