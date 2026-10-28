import { toastError } from '../store';
import { CodeBlock } from './CodeBlock';
import { ChevronRight, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { formatBytes, formatMs } from '../lib/format';
import { Badge, Bar, cx, FilterInput, IconButton, Segmented, statusTone } from './ui';
import { TRAFFIC_KIND, trafficKindLabel } from '../lib/traffic-kinds';
import { useEventLog } from '../lib/use-rpc';
import { RelatedRefs } from './RefLink';
import { outputFileName, type ItemRef } from '@testpion/shared';
import { OutputActions, OutputBarStart } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

export interface ConsoleEntry {
  id: string;
  time: string;
  source: 'request' | 'run';
  kind?: 'graphql' | 'mcp' | 'websocket';
  run?: string;
  name: string;
  method: string;
  url: string;
  status?: number | string;
  durationMs?: number;
  size?: number;
  request?: { headers: Array<[string, string]>; body?: string };
  response?: { headers: Array<[string, string]>; body?: string };
  logs: Array<{ phase: 'pre-request' | 'test'; message: string }>;
  error?: string;
  failedChecks?: number;
  /** What it belongs to: the saved request, its History entry, its run, its trace (WF-16). */
  refs?: ItemRef[];
}

type Filter = 'all' | 'errors' | 'logs';

/** Rows the browser skips laying out and painting while they are off screen (a console of 500 rows, most of them out of view). */
export const OFFSCREEN_ROW = { contentVisibility: 'auto', containIntrinsicSize: 'auto 28px' } as const;

/** What the filter text is looked for in, lower-cased once per entry (typing in the filter does not rebuild 500 strings per key). */
const haystacks = new WeakMap<ConsoleEntry, string>();
const haystackOf = (e: ConsoleEntry): string => {
  let h = haystacks.get(e);
  if (h === undefined) haystacks.set(e, (h = `${e.method} ${e.url} ${e.name} ${e.status ?? ''} ${e.logs.map((l) => l.message).join(' ')}`.toLowerCase()));
  return h;
};

/** Non-numeric statuses that mean success (MCP calls, WebSocket connect / send / close). */
const OK_STATUS = new Set(['passed', 'ok', 'open', 'sent', 'closed']);
const isError = (e: ConsoleEntry) => !!e.error || (typeof e.status === 'number' ? e.status >= 400 : e.status !== undefined && !OK_STATUS.has(e.status)) || !!e.failedChecks;

/** A row's key: the entry's id and time (a run's result id repeats across runs), never its position (the buffer slides). */
export const consoleKey = (e: Pick<ConsoleEntry, 'id' | 'time'>) => `${e.id}-${e.time}`;

/**
 * Postman-style console: every request sent from the app or a run, newest last, with its script
 * output (`console.log`) and, for requests sent from a tab, the request and response details.
 * Everything is redacted by the backend before it arrives here.
 */
export function ConsolePanel() {
  const [entries, setEntries] = useEventLog<ConsoleEntry>('console', 500, 'console.recent');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (filter === 'all' || (filter === 'errors' ? isError(e) : e.logs.length > 0)) &&
        (!needle || haystackOf(e).includes(needle)),
    );
  }, [entries, filter, q]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);

  // the whole console buffer (the backend's, redacted by default), not only the filtered rows
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'console',
      what: 'console',
      name: outputFileName({ name: 'console', ext: '' }),
      formats: [
        { format: 'text', source: { kind: 'console' }, default: true },
        { format: 'jsonl', source: { kind: 'console' } },
      ],
      empty: entries.length ? undefined : 'The console is empty',
    }),
    [entries.length],
  );

  const toggle = useCallback(
    (key: string) =>
      setOpen((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );

  return (
    <>
      <Bar className="text-xs overflow-clip whitespace-nowrap">
        <OutputBarStart>
        <Segmented
          label="Show"
          size="xs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'errors', label: 'Errors' },
            { value: 'logs', label: 'With logs' },
          ]}
        />
        <FilterInput value={q} onChange={setQ} placeholder="Filter by URL, status or log text" label="Filter console" className="w-64" />
        <span className="text-muted truncate min-w-0">
          {shown.length} of {entries.length} · secrets are redacted
        </span>
        </OutputBarStart>
        <OutputActions spec={spec}>
          <IconButton
            label="Clear console"
            onClick={() => {
              void call('console.clear').catch(toastError);
              setEntries([]);
              setOpen(new Set());
            }}
          >
            <Trash2 />
          </IconButton>
        </OutputActions>
      </Bar>
      <div
        className="flex-1 overflow-auto text-xs"
        data-output="console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!shown.length && <p className="px-3 py-2 text-muted text-xs">{entries.length ? 'Nothing matches the filter.' : 'Requests you send (HTTP, GraphQL, MCP and WebSocket), and the console.log output of their scripts, appear here.'}</p>}
        {shown.map((e) => {
          const key = consoleKey(e);
          return <ConsoleRow key={key} e={e} expanded={open.has(key)} onToggle={toggle} />;
        })}
        <div ref={bottom} />
      </div>
    </>
  );
}

/** One entry: memoised, so the rows already shown are not rendered again when an entry arrives or one leaves the buffer. */
const ConsoleRow = memo(function ConsoleRow({ e, expanded, onToggle }: { e: ConsoleEntry; expanded: boolean; onToggle(key: string): void }) {
  const hasDetails = !!(e.request || e.response || e.error || e.refs?.length);
  return (
    <div className="border-b border-line/70" style={OFFSCREEN_ROW} data-console-row={consoleKey(e)}>
      <button className={cx('w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-hover', isError(e) && 'text-bad')} onClick={() => hasDetails && onToggle(consoleKey(e))} aria-expanded={hasDetails ? expanded : undefined}>
        <ChevronRight size={12} className={cx('shrink-0 transition-transform', expanded && 'rotate-90', !hasDetails && 'opacity-0')} />
        <span className="text-muted tabular-nums shrink-0">{new Date(e.time).toLocaleTimeString()}</span>
        <span className="mono font-medium w-14 shrink-0">{e.method}</span>
        <span className="mono truncate flex-1 text-fg" title={e.url}>
          {e.url}
        </span>
        {e.kind && <Badge tone={TRAFFIC_KIND[e.kind]?.tone}>{trafficKindLabel(e.kind)}</Badge>}
        {e.source === 'run' && <Badge title={e.run}>run</Badge>}
        {e.status !== undefined && <Badge tone={statusTone(e.status)}>{e.status}</Badge>}
        {!!e.failedChecks && <Badge tone="bad">{e.failedChecks} failed</Badge>}
        {e.durationMs !== undefined && <span className="text-muted tabular-nums w-16 text-right shrink-0">{formatMs(e.durationMs)}</span>}
        {e.size !== undefined && <span className="text-muted tabular-nums w-16 text-right shrink-0">{formatBytes(e.size)}</span>}
      </button>
      {e.logs.map((l, j) => (
        <div key={j} className="mono pl-9 pr-3 py-0.5 whitespace-pre-wrap text-xs">
          <span className="text-muted">{l.phase === 'pre-request' ? 'pre ›' : 'test ›'}</span> {l.message}
        </div>
      ))}
      {expanded && (
        <div className="pl-9 pr-3 pb-2 grid gap-2">
          <RelatedRefs refs={e.refs} />
          {e.error && <div className="text-bad">{e.error}</div>}
          {e.request && <Section title="Request" headers={e.request.headers} body={e.request.body} />}
          {e.response && <Section title="Response" headers={e.response.headers} body={e.response.body} />}
        </div>
      )}
    </div>
  );
});

function Section({ title, headers, body }: { title: string; headers: Array<[string, string]>; body?: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted mb-0.5">{title}</div>
      <table className="text-xs mono mb-1">
        <tbody>
          {headers.map(([k, v], i) => (
            <tr key={i}>
              <td className="pr-3 text-muted align-top whitespace-nowrap">{k}</td>
              <td className="break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {body && <CodeBlock className="mono text-xs bg-[var(--code-bg)] border border-line rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap" text={body} />}
    </div>
  );
}
