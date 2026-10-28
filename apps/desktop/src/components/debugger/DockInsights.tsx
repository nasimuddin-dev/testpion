import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, memo, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBytes, formatMs } from '@testpion/shared';
import { cx, Empty, SectionTitle } from '../ui';
import { headerSizes, kb, speedOf, versionOf, type Exchange } from './model';

/** The path of an absolute URL, cut by hand (a `new URL` per row costs 20 µs and the tree reads thousands); anything else falls back to the parser. */
const SCHEME_HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const pathOf = (url: string) => {
  const m = SCHEME_HOST.exec(url);
  if (m) {
    const rest = url.slice(m[0].length);
    const end = rest.search(/[?#]/);
    const path = end < 0 ? rest : rest.slice(0, end);
    return path || '/';
  }
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

/** The rows the Timeline draws for a multi-selection: a range of thousands is summarised, the first rows are drawn. */
export const TIMELINE_ROWS = 200;

/** What the selection adds up to (one pass, no spreads: the argument limit and the copies of `Math.min(...rows.map())`). */
export function timelineTotals(picked: Exchange[]): { bytes: number; start: number; end: number; span: number } {
  let bytes = 0;
  let start = Infinity;
  let end = -Infinity;
  for (const e of picked) {
    const h = headerSizes(e);
    bytes += e.requestBodyBytes + e.responseBodyBytes + h.request + h.response;
    const s = Date.parse(e.startedAt);
    start = Math.min(start, s);
    end = Math.max(end, s + (e.durationMs ?? 0));
  }
  return { bytes, start, end, span: Math.max(1, end - start) };
}

/** Skip the render while every selected exchange is the same object (a sync that changed other rows). */
function samePicked(a: { picked: Exchange[] }, b: { picked: Exchange[] }): boolean {
  if (a.picked === b.picked) return true;
  if (a.picked.length !== b.picked.length) return false;
  for (let i = 0; i < a.picked.length; i++) if (a.picked[i] !== b.picked[i]) return false;
  return true;
}

/** Timeline (F5): one request's Sending / Waiting / Receiving, or several on one time axis; their count, time and size. */
export const TimelinePanel = memo(function TimelinePanel({ picked }: { picked: Exchange[] }) {
  const { bytes, start, span } = useMemo(() => timelineTotals(picked), [picked]);
  if (!picked.length) return <Empty title="Select a request">Its timing shows here: sending, waiting for the server, receiving. Select several (Ctrl / Shift) to see them on one axis.</Empty>;
  const one = picked.length === 1 ? picked[0]! : undefined;
  const drawn = one ? [] : picked.length > TIMELINE_ROWS ? picked.slice(0, TIMELINE_ROWS) : picked;
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
                          <span className="absolute top-0 text-2xs tabular-nums" style={{ left: `min(calc(${left + (p[k] / total) * 100}% + 4px), calc(100% - 3rem))` }}>
                            {formatMs(p[k])}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                });
              })()
            : drawn.map((e) => {
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
          {!one && picked.length > drawn.length && (
            <tr className="border-b border-line/60 text-muted" data-timeline-more>
              <td className="px-2 py-1" colSpan={2}>
                and {picked.length - drawn.length} more (the totals below count all {picked.length})
              </td>
            </tr>
          )}
          <tr className="font-semibold border-b border-line/60">
            <td className="px-2 py-1">Selected items</td>
            <td className="px-2 py-1 tabular-nums">{picked.length}</td>
          </tr>
          <tr className="font-semibold border-b border-line/60">
            <td className="px-2 py-1">Total time (s)</td>
            <td className="px-2 py-1 tabular-nums" data-total-time>
              {(one ? (one.durationMs ?? 0) / 1000 : span / 1000).toFixed(3)}
            </td>
          </tr>
          <tr className="font-semibold border-b border-line/60">
            <td className="px-2 py-1">Total size (KB)</td>
            <td className="px-2 py-1 tabular-nums">{kb(bytes)}</td>
          </tr>
        </tbody>
      </table>
      <div className="flex gap-3 px-2 py-2 text-xs text-muted">
        {(Object.keys(BAR) as Array<keyof typeof BAR>).map((k) => (
          <span key={k} className="flex items-center gap-1 capitalize">
            <span className={cx('inline-block w-3 h-2 rounded-sm', BAR[k])} /> {k}
          </span>
        ))}
      </div>
    </div>
  );
}, samePicked);

/** A grouped property table (Summary): a header row per group that folds, then name / value rows. */
function PropertyTable({ groups }: { groups: Array<{ title: string; rows: Array<[string, ReactNode]> }> }) {
  const [closed, setClosed] = useState<string[]>([]);
  return (
    <table className="w-full text-xs border-collapse">
      <tbody>
        {groups.filter((g) => g.rows.some(([, v]) => v !== undefined && v !== null && v !== '')).map((g) => {
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
                g.rows
                  .filter(([, v]) => v !== undefined && v !== null && v !== '')
                  .map(([k, v]) => (
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
              ['User', e.user],
              ['IP address', e.serverAddress],
              ['Total size (KB)', kb(e.requestBodyBytes + e.responseBodyBytes + reqHead + resHead)],
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
            title: 'Request details',
            rows: [
              ['Method', e.method],
              ['URL', e.url],
              ['Header Size (kb)', kb(reqHead)],
              ['Content Size (kb)', kb(e.requestBodyBytes)],
              ['Content Type', e.requestHeaders['content-type']],
            ],
          },
          {
            title: 'Response details',
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
          {
            title: 'Rules and errors',
            rows: [
              ['Rules that acted', e.rules?.length ? e.rules.join(', ') : undefined],
              ['Redirected to', e.redirectedTo],
              ['Answered by a rule', e.repliedByRule ? 'yes' : undefined],
              ['Edited at a breakpoint', e.edited ? 'yes' : undefined],
              ['Error', e.error],
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
  /** The children by count, kept until one of them changes. */
  sorted?: Node[];
}

const newNode = (name: string): Node => ({ name, count: 0, bytes: 0, ids: [], children: new Map() });

/** The most children of one level the table draws (a domain with thousands of paths stays a short list). */
export const STRUCTURE_KIDS = 300;

/**
 * The domain / path tree of a list of exchanges, kept between syncs: an exchange already in the tree costs one lookup (and
 * a few additions when its size changed), only a new one is parsed. A list that lost rows (cleared, filtered) starts over.
 */
export class StructureTree {
  root: Node = newNode('');
  private known = new Map<string, { nodes: Node[]; bytes: number; mark: number }>();
  private pass = 0;

  update(rows: Exchange[]): Node {
    const pass = ++this.pass;
    let seen = 0;
    for (const e of rows) {
      const bytes = e.requestBodyBytes + e.responseBodyBytes;
      const k = this.known.get(e.id);
      if (k) {
        if (k.mark === pass) continue; // a duplicate id in one list
        k.mark = pass;
        seen++;
        if (k.bytes !== bytes) {
          const d = bytes - k.bytes;
          k.bytes = bytes;
          this.root.bytes += d;
          for (const n of k.nodes) n.bytes += d;
        }
        continue;
      }
      seen++;
      const nodes: Node[] = [];
      let n = this.root;
      this.root.count++;
      this.root.bytes += bytes;
      this.root.sorted = undefined;
      const step = (part: string) => {
        let c = n.children.get(part);
        if (!c) n.children.set(part, (c = newNode(part)));
        c.count++;
        c.bytes += bytes;
        c.ids.push(e.id);
        c.sorted = undefined;
        nodes.push(c);
        n = c;
      };
      step(e.host);
      const path = pathOf(e.url);
      for (let from = 0; from < path.length; ) {
        let to = path.indexOf('/', from);
        if (to < 0) to = path.length;
        if (to > from) step(path.slice(from, to));
        from = to + 1;
      }
      this.known.set(e.id, { nodes, bytes, mark: pass });
    }
    if (seen !== this.known.size) {
      // rows left the list: build again from what is there
      this.root = newNode('');
      this.known = new Map();
      this.pass = 0;
      if (rows.length) return this.update(rows);
    }
    return this.root;
  }
}

const kidsOf = (n: Node): Node[] => (n.sorted ??= [...n.children.values()].sort((a, b) => b.count - a.count));

/** Structure (F6): the requests listed, by domain then path (each segment a level), with counts and sizes. */
export function StructurePanel({ rows, onPick }: { rows: Exchange[]; onPick(id: string): void }) {
  const [open, setOpen] = useState<string[]>([]);
  const tree = useRef<StructureTree | undefined>(undefined);
  const root = useMemo(() => (tree.current ??= new StructureTree()).update(rows), [rows]);
  if (!rows.length) return <Empty title="No requests">Domains and their paths show here as traffic comes in.</Empty>;
  const render = (n: Node, key: string, depth: number): ReactNode[] => {
    const isOpen = open.includes(key);
    const kids = kidsOf(n);
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
      ...(isOpen ? kids.slice(0, STRUCTURE_KIDS).flatMap((c) => render(c, `${key}/${c.name}`, depth + 1)) : []),
      ...(isOpen && kids.length > STRUCTURE_KIDS
        ? [
            <tr key={`${key}/…more`} className="border-b border-line/60 text-muted" data-structure-more>
              <td className="py-1 pr-2" style={{ paddingLeft: 8 + (depth + 1) * 14 }} colSpan={3}>
                and {kids.length - STRUCTURE_KIDS} more
              </td>
            </tr>,
          ]
        : []),
    ];
  };
  const domains = kidsOf(root);
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
          {domains.slice(0, STRUCTURE_KIDS).flatMap((d) => render(d, d.name, 0))}
          {domains.length > STRUCTURE_KIDS && (
            <tr className="text-muted" data-structure-more>
              <td className="px-2 py-1" colSpan={3}>
                and {domains.length - STRUCTURE_KIDS} more domains
              </td>
            </tr>
          )}
          <tr className="font-semibold">
            <td className="px-2 py-1">Total</td>
            <td className="px-2 py-1 text-right tabular-nums">{root.count}</td>
            <td className="px-2 py-1 text-right tabular-nums">{kb(root.bytes)}</td>
          </tr>
        </tbody>
      </table>
      <p className="px-2 py-2 text-xs text-muted">Double-click a domain or a path to select its first request.</p>
    </div>
  );
}

/** Performance: where the time and the bytes go: the slowest, the largest, the slowest transfers, and by domain. */
/** The `k` entries with the largest `key`, largest first, without sorting the whole list (thousands of rows, eight shown). */
function topBy<T>(list: T[], k: number, key: (x: T) => number): T[] {
  const top: Array<{ x: T; v: number }> = [];
  for (const x of list) {
    const v = key(x);
    if (top.length === k && v <= top[k - 1]!.v) continue;
    let i = top.length;
    while (i > 0 && top[i - 1]!.v < v) i--;
    top.splice(i, 0, { x, v });
    if (top.length > k) top.pop();
  }
  return top.map((t) => t.x);
}

/** Performance: where the time and the bytes go: the slowest, the largest, the slowest transfers, and by domain. */
export function PerformancePanel({ rows, onPick }: { rows: Exchange[]; onPick(id: string): void }) {
  // computed once per change of the rows (a selection or a re-render of the dock doesn't redo it); each speed once
  const stats = useMemo(() => {
    const done = rows.filter((e) => e.durationMs !== undefined && e.kind !== 'tunnel');
    const byHost = new Map<string, { n: number; ms: number; max: number; bytes: number }>();
    let waiting = 0;
    let total = 0;
    const speeds: Array<{ e: Exchange; speed: string; v: number }> = [];
    for (const e of done) {
      const h = byHost.get(e.host) ?? { n: 0, ms: 0, max: 0, bytes: 0 };
      h.n++;
      h.ms += e.durationMs!;
      h.max = Math.max(h.max, e.durationMs!);
      h.bytes += e.responseBodyBytes;
      byHost.set(e.host, h);
      waiting += phasesOf(e).waiting;
      total += e.durationMs ?? 0;
      if (e.responseBodyBytes > 0) {
        const speed = speedOf(e);
        speeds.push({ e, speed, v: Number(speed) });
      }
    }
    const slowTransfers = topBy(speeds, 8, (s) => -s.v);
    return {
      done,
      waitShare: waiting / Math.max(1, total),
      slowest: topBy(done, 8, (e) => e.durationMs!),
      largest: topBy(done, 8, (e) => e.responseBodyBytes),
      slowTransfers: slowTransfers.map((s) => s.e),
      speedOf: new Map(slowTransfers.map((s) => [s.e.id, s.speed])),
      hosts: [...byHost.entries()].sort((a, b) => b[1].ms / b[1].n - a[1].ms / a[1].n),
    };
  }, [rows]);
  const { done, waitShare } = stats;
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
  const title = (t: string) => <SectionTitle size="sm" className="px-2 pt-2 pb-1">{t}</SectionTitle>;
  return (
    <div className="flex-1 min-h-0 overflow-auto" data-performance>
      <p className="px-2 pt-2 text-xs">
        {done.length} requests · {Math.round(waitShare * 100)}% of the time is spent waiting for servers
        {waitShare > 0.7 ? ' (the servers are the bottleneck)' : waitShare < 0.3 ? ' (transfers are the bottleneck)' : ''}.
      </p>
      {title('Slowest responses')}
      {top(stats.slowest, (e) => formatMs(e.durationMs))}
      {title('Largest bodies')}
      {top(stats.largest, (e) => formatBytes(e.responseBodyBytes))}
      {title('Slowest transfers (KB/s)')}
      {top(stats.slowTransfers, (e) => stats.speedOf.get(e.id) ?? '')}
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
          {stats.hosts.map(([h, v]) => (
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
