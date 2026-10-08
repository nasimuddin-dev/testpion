import { ChevronRight, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { formatBytes, formatMs } from '../lib/format';
import { Badge, cx, IconButton, Input, statusTone } from './ui';
import { useEventLog } from '../lib/use-rpc';

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
}

type Filter = 'all' | 'errors' | 'logs';

/** Non-numeric statuses that mean success (MCP calls, WebSocket connect / send / close). */
const OK_STATUS = new Set(['passed', 'ok', 'open', 'sent', 'closed']);
const isError = (e: ConsoleEntry) => !!e.error || (typeof e.status === 'number' ? e.status >= 400 : e.status !== undefined && !OK_STATUS.has(e.status)) || !!e.failedChecks;
const KIND_LABEL = { graphql: 'GraphQL', mcp: 'MCP', websocket: 'WebSocket' } as const;

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
        (!needle || `${e.method} ${e.url} ${e.name} ${e.status ?? ''} ${e.logs.map((l) => l.message).join(' ')}`.toLowerCase().includes(needle)),
    );
  }, [entries, filter, q]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <>
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line text-xs shrink-0">
        <div className="flex rounded-md border border-line overflow-hidden">
          {(['all', 'errors', 'logs'] as const).map((f) => (
            <button key={f} className={cx('px-2 h-6 capitalize', filter === f ? 'bg-accent text-white' : 'hover:bg-hover')} onClick={() => setFilter(f)}>
              {f === 'logs' ? 'With logs' : f}
            </button>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by URL, status or log text" aria-label="Filter console" className="h-6 min-h-0 text-xs w-64" />
        <span className="text-muted">
          {shown.length} of {entries.length} · secrets are redacted
        </span>
        <IconButton
          label="Clear console"
          className="ml-auto"
          onClick={() => {
            void call('console.clear');
            setEntries([]);
            setOpen(new Set());
          }}
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
      <div
        className="flex-1 overflow-auto text-[0.8rem]"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!shown.length && <p className="px-3 py-2 text-muted text-xs">{entries.length ? 'Nothing matches the filter.' : 'Requests you send (HTTP, GraphQL, MCP and WebSocket), and the console.log output of their scripts, appear here.'}</p>}
        {shown.map((e, i) => {
          const key = `${e.id}-${e.time}-${i}`;
          const expanded = open.has(key);
          const hasDetails = !!(e.request || e.response || e.error);
          return (
            <div key={key} className="border-b border-line/70">
              <button className={cx('w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-hover', isError(e) && 'text-bad')} onClick={() => hasDetails && toggle(key)} aria-expanded={hasDetails ? expanded : undefined}>
                <ChevronRight size={12} className={cx('shrink-0 transition-transform', expanded && 'rotate-90', !hasDetails && 'opacity-0')} />
                <span className="text-muted tabular-nums shrink-0">{new Date(e.time).toLocaleTimeString()}</span>
                <span className="mono font-medium w-14 shrink-0">{e.method}</span>
                <span className="mono truncate flex-1 text-fg" title={e.url}>
                  {e.url}
                </span>
                {e.kind && <Badge tone={e.kind === 'graphql' ? 'accent' : 'judge'}>{KIND_LABEL[e.kind]}</Badge>}
                {e.source === 'run' && <Badge title={e.run}>run</Badge>}
                {e.status !== undefined && <Badge tone={statusTone(e.status)}>{e.status}</Badge>}
                {!!e.failedChecks && <Badge tone="bad">{e.failedChecks} failed</Badge>}
                {e.durationMs !== undefined && <span className="text-muted tabular-nums w-16 text-right shrink-0">{formatMs(e.durationMs)}</span>}
                {e.size !== undefined && <span className="text-muted tabular-nums w-16 text-right shrink-0">{formatBytes(e.size)}</span>}
              </button>
              {e.logs.map((l, j) => (
                <div key={j} className="mono pl-9 pr-3 py-0.5 whitespace-pre-wrap text-[0.78rem]">
                  <span className="text-muted">{l.phase === 'pre-request' ? 'pre ›' : 'test ›'}</span> {l.message}
                </div>
              ))}
              {expanded && (
                <div className="pl-9 pr-3 pb-2 grid gap-2">
                  {e.error && <div className="text-bad">{e.error}</div>}
                  {e.request && <Section title="Request" headers={e.request.headers} body={e.request.body} />}
                  {e.response && <Section title="Response" headers={e.response.headers} body={e.response.body} />}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
    </>
  );
}

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
      {body && <pre className="mono text-xs bg-[var(--code-bg)] border border-line rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap">{body}</pre>}
    </div>
  );
}
