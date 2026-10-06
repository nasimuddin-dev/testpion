import { Bug, Copy, Download, ExternalLink, Play, Square, Star, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call, on } from '../api';
import { confirmAction, useApp } from '../store';
import { Badge, Button, cx, Empty, Input, PageHeader, Select, Split, statusTone, Tabs, VirtualList } from '../components/ui';
import { ChangeMark } from '../components/ChangeMark';
import { formatBytes, formatMs } from '@testpion/shared';
import { finishSave, downloadContent, type SaveResult } from '../lib/files';
import { JsonTree } from '../components/JsonView';
import type { HttpRequestSpec } from '../types';

interface Exchange {
  id: string;
  startedAt: string;
  kind: 'http' | 'tunnel';
  method: string;
  url: string;
  host: string;
  clientPort: number;
  application?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyBytes: number;
  requestBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBytes: number;
  responseBodyTruncated?: boolean;
  contentType?: string;
  waitMs?: number;
  durationMs?: number;
  error?: string;
  bookmarked?: boolean;
}

interface Status {
  running: boolean;
  url?: string;
  port?: number;
  exchanges: number;
}

const fail = (e: unknown) => useApp.getState().toast(asError(e).message, 'error');

/** An exchange as a REST request, for Open in a tab and Resend. */
function toRequest(e: Exchange): HttpRequestSpec {
  const headers = Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|connection|proxy-.*|accept-encoding)$/i.test(k))
    .map(([key, value]) => ({ key, value, enabled: true }));
  const ct = e.requestHeaders['content-type'] ?? '';
  const body = e.requestBody ? ({ type: /json/i.test(ct) ? 'json' : /xml/i.test(ct) ? 'xml' : 'text', content: e.requestBody } as HttpRequestSpec['body']) : undefined;
  return { method: e.method, url: e.url, headers, body };
}

const curlOf = (e: Exchange) =>
  `curl -X ${e.method} '${e.url}'${Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|proxy-.*)$/i.test(k))
    .map(([k, v]) => ` \\\n  -H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join('')}${e.requestBody ? ` \\\n  --data '${e.requestBody.replace(/'/g, "'\\''")}'` : ''}`;

/**
 * The HTTP Debugger (planning/http-debugger.md): other programs send through TestPion's proxy; every exchange is
 * listed as it happens, with the program that sent it, and opens whole: headers, bodies, timing. From a row: open
 * it as a request, resend it, copy it as cURL, bookmark it, delete it. Statistics and HAR export of the session.
 */
export function DebuggerView() {
  const [status, setStatus] = useState<Status>();
  const [rows, setRows] = useState<Exchange[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Exchange>();
  const [filter, setFilter] = useState({ text: '', host: '', method: '', status: '' as '' | 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error', bookmarked: false });
  const [tab, setTab] = useState<'traffic' | 'stats'>('traffic');
  const [port, setPort] = useState('8899');
  const [stats, setStats] = useState<{
    total: number;
    bytes: number;
    errors: number;
    hosts: Array<{ name: string; count: number; bytes: number; ms: number }>;
    contentTypes: Array<{ name: string; count: number; bytes: number }>;
    applications: Array<{ name: string; count: number; bytes: number }>;
    largest: Array<{ id: string; method: string; url: string; bytes: number }>;
    slowest: Array<{ id: string; method: string; url: string; ms?: number }>;
  }>();

  const load = useCallback(async () => {
    try {
      const [st, list] = await Promise.all([
        call<Status>('debug.status'),
        call<Exchange[]>('debug.exchanges', {
          text: filter.text || undefined,
          host: filter.host || undefined,
          method: filter.method || undefined,
          status: filter.status || undefined,
          bookmarked: filter.bookmarked || undefined,
        }),
      ]);
      setStatus(st);
      setRows(list);
    } catch (e) {
      fail(e);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);
  // rows arrive as programs send; a batch of updates is one refresh
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = on('debug.exchange', () => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 150);
    });
    return () => (off(), clearTimeout(t));
  }, [load]);
  useEffect(() => {
    if (!selected) return setDetail(undefined);
    void call<Exchange>('debug.exchange', { id: selected }).then(setDetail, () => setDetail(undefined));
  }, [selected, rows.length]);
  useEffect(() => {
    if (tab === 'stats') void call<typeof stats>('debug.stats').then(setStats, fail);
  }, [tab, rows.length]);

  const start = async () => {
    try {
      const p = Number(port) || undefined;
      setStatus(await call<Status>('debug.start', { port: p }));
    } catch (e) {
      fail(e);
    }
  };
  const stop = async () => setStatus(await call<Status>('debug.stop'));
  const openInTab = (e: Exchange) => useApp.getState().openIntent('rest', { request: toRequest(e), name: `${e.method} ${new URL(e.url).pathname}` });
  const resend = async (e: Exchange) => {
    try {
      await call('http.send', { request: toRequest(e), environment: useApp.getState().environment, id: `dbg-resend-${e.id}` });
      useApp.getState().toast('Sent again (see the History view for the response)', 'success');
    } catch (err) {
      fail(err);
    }
  };
  const exportHar = async () => {
    const har = await call<unknown>('debug.har');
    const text = JSON.stringify(har, null, 2);
    const r = await call<SaveResult>('app.saveText', { name: `debugger-${new Date().toISOString().slice(0, 10)}.har`, text }).catch(() => null);
    if (r) finishSave(r, 'HAR file');
    else downloadContent(`debugger-${new Date().toISOString().slice(0, 10)}.har`, text, { type: 'application/json' });
  };

  const hosts = useMemo(() => [...new Set(rows.map((r) => r.host))].sort(), [rows]);
  const sel = detail;

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader
        icon={<Bug size={18} />}
        title="HTTP Debugger"
        subtitle={
          status?.running
            ? `Listening on ${status.url} · point a program at it: HTTP_PROXY=${status.url}, a browser's proxy setting, or --proxy-server=${status.url}`
            : 'Start the proxy, then point a program at it: its traffic is listed here as it happens.'
        }
        actions={
          <>
            {!status?.running && <Input className="w-24" aria-label="Port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="Port" />}
            {status?.running ? (
              <Button icon={<Square size={13} />} onClick={() => void stop()}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" icon={<Play size={13} />} onClick={() => void start()}>
                Start capturing
              </Button>
            )}
            <Button icon={<Download size={13} />} disabled={!rows.length} onClick={() => void exportHar()} title="Save the session as a HAR file (opens in any HTTP tool, or Import here)">
              HAR
            </Button>
            <Button
              icon={<Trash2 size={13} />}
              disabled={!status?.exchanges}
              onClick={async () => {
                if (await confirmAction({ title: 'Clear the session', message: 'Forget every captured exchange?', confirmLabel: 'Clear', danger: true })) {
                  setSelected(undefined);
                  setStatus(await call<Status>('debug.clear'));
                  void load();
                }
              }}
            >
              Clear
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'traffic', label: 'Traffic', badge: status?.exchanges || undefined },
          { id: 'stats', label: 'Statistics' },
        ]}
      />
      {tab === 'stats' ? (
        <div className="flex-1 min-h-0 overflow-auto p-4 grid gap-4 content-start max-w-5xl">
          {!stats || !stats.total ? (
            <Empty icon={<Bug size={26} />} title="Nothing captured yet">
              Start the proxy and send some traffic through it; the session's numbers appear here.
            </Empty>
          ) : (
            <>
              <div className="text-sm text-muted">
                {stats.total} exchanges · {formatBytes(stats.bytes)} received · {stats.errors} errors
              </div>
              {(
                [
                  ['Top hosts', stats.hosts],
                  ['Top content types', stats.contentTypes],
                  ['Applications', stats.applications],
                ] as Array<[string, Array<{ name: string; count: number; bytes: number }>]>
              ).map(([title, list]) => (
                <section key={title}>
                  <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">{title}</div>
                  <table className="text-sm w-full">
                    <tbody>
                      {list.map((x) => (
                        <tr key={x.name} className="border-t border-line">
                          <td className="py-1 pr-3 truncate max-w-md">{x.name}</td>
                          <td className="py-1 pr-3 text-right tabular-nums text-muted">{x.count}</td>
                          <td className="py-1 text-right tabular-nums">{formatBytes(x.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
              {(
                [
                  ['Largest responses', stats.largest.map((x) => ({ ...x, value: formatBytes(x.bytes) }))],
                  ['Slowest', stats.slowest.map((x) => ({ ...x, value: formatMs(x.ms) }))],
                ] as Array<[string, Array<{ id: string; method: string; url: string; value: string }>]>
              ).map(([title, list]) => (
                <section key={title}>
                  <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">{title}</div>
                  <table className="text-sm w-full">
                    <tbody>
                      {list.map((x) => (
                        <tr key={x.id} className="border-t border-line cursor-pointer hover:bg-hover" onClick={() => (setTab('traffic'), setSelected(x.id))}>
                          <td className="py-1 pr-3 mono text-xs">{x.method}</td>
                          <td className="py-1 pr-3 truncate max-w-xl">{x.url}</td>
                          <td className="py-1 text-right tabular-nums">{x.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </>
          )}
        </div>
      ) : (
        <Split id="debugger" initial={55}>
          <div className="h-full flex flex-col min-h-0">
            <div className="flex gap-2 p-2 border-b border-line items-center flex-wrap">
              <Input
                className="flex-1 min-w-40"
                placeholder="Filter (URL, method, program, type)"
                aria-label="Filter exchanges"
                value={filter.text}
                onChange={(e) => setFilter({ ...filter, text: e.target.value })}
              />
              <Select aria-label="Host" value={filter.host} onChange={(e) => setFilter({ ...filter, host: e.target.value })}>
                <option value="">All hosts</option>
                {hosts.map((h) => (
                  <option key={h}>{h}</option>
                ))}
              </Select>
              <Select aria-label="Method" value={filter.method} onChange={(e) => setFilter({ ...filter, method: e.target.value })}>
                <option value="">Any method</option>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
              <Select aria-label="Status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as typeof filter.status })}>
                <option value="">Any status</option>
                <option value="ok">2xx</option>
                <option value="redirect">3xx</option>
                <option value="client-error">4xx</option>
                <option value="server-error">5xx</option>
                <option value="error">Errors</option>
              </Select>
              <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap">
                <input type="checkbox" checked={filter.bookmarked} onChange={(e) => setFilter({ ...filter, bookmarked: e.target.checked })} /> Bookmarked
              </label>
            </div>
            {!rows.length ? (
              <Empty icon={<Bug size={26} />} title={status?.running ? 'Waiting for traffic' : 'Not capturing'}>
                {status?.running ? (
                  <>
                    Point a program at <span className="mono">{status.url}</span>: for a terminal <span className="mono">HTTP_PROXY={status.url}</span>, for Chrome{' '}
                    <span className="mono">--proxy-server={status.url}</span>, or the system proxy setting. HTTPS shows as a tunnel by host until the root certificate (coming) decrypts it.
                  </>
                ) : (
                  'Start capturing, then run the program you want to watch.'
                )}
              </Empty>
            ) : (
              <VirtualList
                className="flex-1"
                items={rows}
                rowHeight={30}
                render={(r) => (
                  <div
                    role="row"
                    aria-selected={r.id === selected}
                    className={cx(
                      'flex items-center gap-2 h-[30px] px-2 text-xs cursor-pointer border-b border-line/60',
                      r.id === selected ? 'bg-accent-soft' : 'hover:bg-hover',
                      r.error || (r.status ?? 0) >= 400 ? 'text-bad' : '',
                    )}
                    onClick={() => setSelected(r.id)}
                    onDoubleClick={() => openInTab(r)}
                    title={r.url}
                  >
                    <span className="w-4 shrink-0 text-warn">{r.bookmarked && <Star size={11} className="fill-current" />}</span>
                    <span className={cx('mono w-14 shrink-0 font-bold', `method-${r.method}`)}>{r.method}</span>
                    <span className="w-10 shrink-0">
                      <Badge tone={r.error ? 'bad' : statusTone(r.status)}>{r.error ? 'ERR' : (r.status ?? '…')}</Badge>
                    </span>
                    <span className="w-28 shrink-0 truncate text-muted" title={r.application ?? 'unknown program'}>
                      {r.application ?? `:${r.clientPort}`}
                    </span>
                    <span className="flex-1 min-w-0 truncate">{r.kind === 'tunnel' ? `${r.host}  (HTTPS tunnel)` : r.url}</span>
                    <span className="w-28 shrink-0 truncate text-muted">{r.contentType?.split(';')[0]}</span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted">{formatBytes(r.responseBodyBytes)}</span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted">{r.durationMs !== undefined ? formatMs(r.durationMs) : '…'}</span>
                  </div>
                )}
              />
            )}
          </div>
          <div className="h-full flex flex-col min-h-0">
            {!sel ? (
              <Empty title="Select an exchange">Its request, response and timing show here. Double-click a row to open it as a request.</Empty>
            ) : (
              <ExchangeDetail
                e={sel}
                onOpen={() => openInTab(sel)}
                onResend={() => void resend(sel)}
                onBookmark={async () => (await call('debug.bookmark', { id: sel.id, on: !sel.bookmarked }), void load(), setDetail({ ...sel, bookmarked: !sel.bookmarked }))}
                onDelete={async () => (await call('debug.delete', { ids: [sel.id] }), setSelected(undefined), void load())}
              />
            )}
          </div>
        </Split>
      )}
    </div>
  );
}

function ExchangeDetail({ e, onOpen, onResend, onBookmark, onDelete }: { e: Exchange; onOpen(): void; onResend(): void; onBookmark(): void; onDelete(): void }) {
  const [tab, setTab] = useState<'response' | 'request' | 'headers' | 'timing'>('response');
  const json = (text?: string) => {
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  const resJson = json(e.responseBody);
  const reqJson = json(e.requestBody);
  const headers = (h?: Record<string, string>) => (
    <table className="text-xs w-full">
      <tbody>
        {Object.entries(h ?? {}).map(([k, v]) => (
          <tr key={k} className="border-t border-line/60">
            <td className="py-1 pr-3 font-medium whitespace-nowrap align-top">{k}</td>
            <td className="py-1 mono break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0 whitespace-nowrap overflow-hidden">
        <Badge tone={e.error ? 'bad' : statusTone(e.status)}>{e.error ? 'error' : `${e.status ?? '…'} ${e.statusText ?? ''}`}</Badge>
        <span className="mono text-xs truncate" title={e.url}>
          {e.method} {e.url}
        </span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={onOpen} title="Open as a request in a tab, to change and send">
            Open
          </Button>
          <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={onResend} title="Send it again as it was">
            Resend
          </Button>
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void navigator.clipboard.writeText(curlOf(e)).then(() => useApp.getState().toast('Copied as cURL'))}>
            cURL
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Star size={12} className={e.bookmarked ? 'fill-current text-warn' : ''} />}
            onClick={onBookmark}
            title={e.bookmarked ? 'Remove the bookmark' : 'Bookmark'}
          >
            {e.bookmarked ? 'Bookmarked' : 'Bookmark'}
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={onDelete} title="Remove from the session">
            Delete
          </Button>
        </span>
      </div>
      {e.error && <div className="px-3 py-2 text-sm text-bad border-b border-line">{e.error}</div>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'response', label: 'Response', badge: e.responseBodyBytes ? formatBytes(e.responseBodyBytes) : undefined },
          { id: 'request', label: 'Request', badge: e.requestBodyBytes ? formatBytes(e.requestBodyBytes) : undefined },
          { id: 'headers', label: 'Headers', badge: Object.keys(e.requestHeaders).length + Object.keys(e.responseHeaders ?? {}).length },
          { id: 'timing', label: 'Timing' },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'response' &&
          (e.kind === 'tunnel' ? (
            <div className="p-3 text-sm text-muted">
              An HTTPS tunnel: {formatBytes(e.requestBodyBytes)} sent, {formatBytes(e.responseBodyBytes)} received, encrypted end to end. Decrypting with a TestPion root certificate is on the way.
            </div>
          ) : resJson !== undefined ? (
            <JsonTree data={resJson} />
          ) : (
            <pre className="p-3 text-xs mono whitespace-pre-wrap break-all">
              {e.responseBody ?? (e.responseBodyBytes ? `(${formatBytes(e.responseBodyBytes)} of ${e.contentType ?? 'binary'}, not kept)` : '(empty)')}
            </pre>
          ))}
        {tab === 'request' &&
          (reqJson !== undefined ? (
            <JsonTree data={reqJson} />
          ) : (
            <pre className="p-3 text-xs mono whitespace-pre-wrap break-all">{e.requestBody ?? (e.requestBodyBytes ? `(${formatBytes(e.requestBodyBytes)}, not kept)` : '(no body)')}</pre>
          ))}
        {tab === 'headers' && (
          <div className="p-3 grid gap-3">
            <div>
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Request</div>
              {headers(e.requestHeaders)}
            </div>
            <div>
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Response</div>
              {headers(e.responseHeaders)}
            </div>
          </div>
        )}
        {tab === 'timing' && (
          <div className="p-3 text-sm grid gap-1">
            <div>
              Started <span className="mono text-xs">{e.startedAt}</span>
            </div>
            <div>Waiting for the server: {formatMs(e.waitMs)}</div>
            <div>Receiving: {e.durationMs !== undefined && e.waitMs !== undefined ? formatMs(e.durationMs - e.waitMs) : '…'}</div>
            <div>Total: {formatMs(e.durationMs)}</div>
            <div className="text-muted">
              From {e.application ?? 'an unknown program'} (client port {e.clientPort}) · {e.requestBodyBytes ? `${formatBytes(e.requestBodyBytes)} sent` : 'no body sent'} ·{' '}
              {formatBytes(e.responseBodyBytes)} received
              {e.responseBodyTruncated ? ' (the body shown is the first part)' : ''}
            </div>
            <ChangeMark change="changed" className="hidden" />
          </div>
        )}
      </div>
    </>
  );
}
