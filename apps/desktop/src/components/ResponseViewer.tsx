import { prettyBody } from '../lib/pretty';
import { BookmarkPlus, Camera, Download, ExternalLink, Sparkles } from 'lucide-react';
import DOMPurify from 'dompurify';
import { useEffect, useMemo, useState } from 'react';
import { call, visualizationUrl } from '../api';
import type { CheckResult, HttpResponseData, Trace } from '../types';
import { SseEvents } from './SseEvents';
import { formatBytes, formatMs, plural } from '../lib/format';
import { CheckList } from './Results';
import { ResponseHistory } from './ResponseHistory';
import { JsonTree, RawView, type TreeAssertion, type TreeVariable } from './JsonView';
import { TraceView } from './TraceView';
import { finishSave, type SaveResult } from '../lib/files';
import { Badge, Button, cx, Empty, MoreMenu, statusTone, Tabs, type MenuItem } from './ui';
import { useApp, toastError } from '../store';
import { JsonTable, tableRowsOf } from './JsonTable';
import { JwtView } from './JwtView';
import { findDecodedJwts } from '@testpion/shared';

type Tab = 'body' | 'events' | 'headers' | 'cookies' | 'timeline' | 'tests' | 'trace' | 'code' | 'stream' | 'history' | 'jwt';

export function ResponseViewer({
  response,
  checks,
  traceId,
  curl,
  stream,
  scriptLogs,
  visualizer,
  requestId,
  historyId,
  onSuggestAssertions,
  onAddAssertion,
  onUpdateSnapshot,
  onSaveVariable,
  onSaveExample,
  onGenerateTests,
  onExplain,
  eventsKey,
}: {
  /** Keeps the selected server-sent event when a live stream's list gives way to this response (the request tab's id). */
  eventsKey?: string;
  response: HttpResponseData;
  checks?: CheckResult[];
  traceId?: string;
  curl?: string;
  stream?: string;
  scriptLogs?: string[];
  /** Output of `tp.visualizer.set(template, data)`, rendered by the backend. */
  visualizer?: { html?: string; error?: string; vizId?: string };
  /** Saved request: enables the History tab (earlier responses, compare). */
  requestId?: string;
  /** History entry of this response (marked "latest"). */
  historyId?: string;
  onSuggestAssertions?(): void;
  /** Clicking a field in the JSON tree can add a check on it to the request's Tests. */
  onAddAssertion?(a: TreeAssertion): void;
  /** Replace a snapshot check's stored copy with this response (at the check's path). */
  onUpdateSnapshot?(path: string): void;
  onSaveVariable?(v: TreeVariable): void;
  /** Save this response as an example of the request. */
  onSaveExample?(): void;
  /** Ask the AI assistant for tp.test checks for this response. */
  onGenerateTests?(): void;
  /** Ask the AI assistant to explain this (error) response. */
  onExplain?(): void;
}) {
  // an event stream opens on its events
  const [tab, setTab] = useState<Tab>(() => (checks?.some((c) => !c.passed) ? 'tests' : response.events ? 'events' : 'body'));
  // a response with a visualization opens on it, like Postman's Visualize view
  const [mode, setMode] = useState<'pretty' | 'table' | 'raw' | 'preview' | 'visualize'>(() => (visualizer ? 'visualize' : 'pretty'));
  useEffect(() => {
    if (visualizer) setMode('visualize');
    else setMode((m) => (m === 'visualize' ? 'pretty' : m));
  }, [visualizer]);
  const visualHtml = useMemo(() => (visualizer?.html !== undefined ? visualPage(visualizer.html) : undefined), [visualizer]);
  const [trace, setTrace] = useState<Trace>();
  const isJson = response.json !== undefined;
  // an array of objects (or a body holding one) can also be read as a table
  const table = useMemo(() => (isJson ? tableRowsOf(response.json) : undefined), [isJson, response.json]);
  // JWTs in the body (e.g. an access_token) or the headers: decoded in their own tab
  const jwts = useMemo(() => findDecodedJwts([response.bodyPreview.slice(0, 200_000), ...response.headers.map(([, v]) => v)]), [response]);
  const isHtml = /html/i.test(response.contentType);
  // Pretty: JSON indented, HTML and XML laid out by nesting (the one formatter, lib/pretty)
  const prettyText = useMemo(() => (isJson ? JSON.stringify(response.json, null, 2) : prettyBody(response.bodyPreview, response.contentType)), [response, isJson]);
  useEffect(() => {
    if (tab === 'trace' && traceId && trace?.traceId !== traceId) void call<Trace>('traces.get', { id: traceId }).then(setTrace);
  }, [tab, traceId, trace]);
  const failed = checks?.filter((c) => !c.passed).length ?? 0;
  /** What can be done with this response: buttons when the panel is wide, a ⋯ menu when it is not. */
  const actions: Array<MenuItem & { title?: string }> = [
    ...(onExplain && response.status >= 400 ? [{ label: 'Explain', icon: <Sparkles size={12} />, onSelect: onExplain, title: 'Ask the AI assistant what this error means and how to fix it' }] : []),
    ...(onGenerateTests
      ? [{ label: 'Generate tests', icon: <Sparkles size={12} />, onSelect: onGenerateTests, title: 'Write tp.test checks for this response with the AI assistant (added to the Post-response script)' }]
      : []),
    ...(onAddAssertion && isJson
      ? [
          {
            label: 'Snapshot',
            icon: <Camera size={12} />,
            onSelect: () => onAddAssertion({ type: 'snapshot', path: '$', expected: response.json, mode: 'shape' }),
            title: "Add a check that later responses keep this response's shape (fields and types); in the Tests tab it can compare values too and ignore fields",
          },
        ]
      : []),
    ...(onSuggestAssertions ? [{ label: 'Suggest assertions', icon: <Sparkles size={12} />, onSelect: onSuggestAssertions }] : []),
    ...(onSaveExample ? [{ label: 'Save as example', icon: <BookmarkPlus size={12} />, onSelect: onSaveExample, title: 'Save this response as an example of the request' }] : []),
    ...(response.payloadPath
      ? [
          {
            label: 'Save response',
            icon: <Download size={12} />,
            onSelect: () => void call<SaveResult>('http.saveBody', { payloadPath: response.payloadPath, name: 'response' + (isJson ? '.json' : '.txt') }).then((r) => finishSave(r, 'Response'), toastError),
          },
        ]
      : []),
  ];
  return (
    <div className="h-full flex flex-col min-h-0">
      {/* one line, whatever the width: the numbers never break, and the actions fold into a ⋯ menu when the panel is narrow */}
      <div className="@container flex items-center gap-3 px-3 h-9 border-b border-line text-sm shrink-0 whitespace-nowrap overflow-hidden">
        <Badge tone={statusTone(response.status)}>
          {response.status} {response.statusText}
        </Badge>
        <span className="text-muted" title="Time to the last byte">
          <span className="hidden @md:inline">Time </span>
          <span className="text-fg tabular-nums">{formatMs(response.durationMs)}</span>
        </span>
        <span className="text-muted" title="Body size">
          <span className="hidden @md:inline">Size </span>
          <span className="text-fg tabular-nums">{formatBytes(response.size)}</span>
        </span>
        {response.httpVersion === '2' && <Badge title="The response came over HTTP/2 (request Settings ▸ HTTP/1.1 only to turn it off)">HTTP/2</Badge>}
        {!!response.attempts && response.attempts > 1 && (
          <Badge tone="warn" title="Earlier attempts failed and were retried (request Settings ▸ Retries)">
            {response.attempts} attempts
          </Badge>
        )}
        {response.truncated && (
          <Badge tone="warn" title="Only the first part of the body is shown. The full payload was streamed to disk.">
            preview truncated
          </Badge>
        )}
        {checks && checks.length > 0 && <Badge tone={failed ? 'bad' : 'ok'}>{failed ? `${failed} failed` : `${checks.length} passed`}</Badge>}
        <div className="ml-auto hidden @3xl:flex items-center gap-1">
          {actions.map((a) => (
            <Button key={a.label} size="sm" variant="ghost" icon={a.icon} onClick={a.onSelect} title={a.title}>
              {a.label}
            </Button>
          ))}
        </div>
        <div className="ml-auto @3xl:hidden">{actions.length > 0 && <MoreMenu label="Response actions" items={actions} />}</div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ...(response.events ? [{ id: 'events' as Tab, label: 'Events', badge: response.events.length }] : []),
          { id: 'body', label: 'Body' },
          { id: 'headers', label: 'Headers', badge: response.headers.length },
          { id: 'cookies', label: 'Cookies', badge: response.cookies.length },
          ...(jwts.length ? [{ id: 'jwt' as Tab, label: 'JWT', badge: jwts.length }] : []),
          { id: 'timeline', label: 'Timeline' },
          { id: 'tests', label: 'Tests', badge: checks?.length },
          ...(stream ? [{ id: 'stream' as Tab, label: 'Stream' }] : []),
          { id: 'trace', label: 'Trace' },
          ...(requestId ? [{ id: 'history' as Tab, label: 'History' }] : []),
          ...(curl ? [{ id: 'code' as Tab, label: 'cURL' }] : []),
        ]}
        right={
          tab === 'body' && (
            <div className="flex rounded-md border border-line overflow-hidden text-xs">
              {(['pretty', ...(table ? ['table'] : []), 'raw', ...(isHtml ? ['preview'] : []), ...(visualizer ? ['visualize'] : [])] as const).map((m) => (
                <button key={m} className={cx('px-2 h-6 capitalize', mode === m ? 'bg-accent text-white' : 'hover:bg-hover')} onClick={() => setMode(m as typeof mode)}>
                  {m}
                </button>
              ))}
            </div>
          )
        }
      />
      <div className="flex-1 min-h-0">
        {tab === 'body' &&
          (!response.bodyPreview ? (
            <Empty title="Empty body" />
          ) : mode === 'pretty' && isJson ? (
            <JsonTree data={response.json} onAssert={onAddAssertion} onSaveVariable={onSaveVariable} />
          ) : mode === 'table' && table ? (
            <JsonTable rows={table.rows} path={table.path} />
          ) : mode === 'visualize' && visualizer ? (
            <div className="h-full flex flex-col">
              {visualizer.error && <div className="px-3 py-2 text-sm text-bad border-b border-line">{visualizer.error}</div>}
              {visualizer.vizId ? (
                // scripts allowed (charts), on the isolated tpviz origin: no same-origin access to the app
                <iframe title="Visualization" sandbox="allow-scripts" className="flex-1 w-full bg-white" src={visualizationUrl(visualizer.vizId)} />
              ) : (
                visualHtml !== undefined && <iframe title="Visualization" sandbox="" className="flex-1 w-full bg-white" srcDoc={visualHtml} />
              )}
            </div>
          ) : mode === 'preview' ? (
            <iframe title="HTML preview" sandbox="" className="w-full h-full bg-white" srcDoc={response.bodyPreview} />
          ) : (
            <RawView text={mode === 'pretty' ? prettyText : response.bodyPreview} />
          ))}
        {tab === 'headers' && <KvTable rows={response.headers} />}
        {tab === 'history' && requestId && <ResponseHistory requestId={requestId} latestId={historyId} />}
        {tab === 'cookies' &&
          (response.cookies.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="px-3 py-1.5">Name</th>
                  <th>Value</th>
                  <th>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {response.cookies.map((c, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-1 mono">{c.name}</td>
                    <td className="mono break-all">{c.value}</td>
                    <td className="text-muted text-xs">
                      {Object.entries(c.attributes)
                        .map(([k, v]) => (v === 'true' ? k : `${k}=${v}`))
                        .join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No cookies" />
          ))}
        {tab === 'jwt' && <JwtView tokens={jwts} />}
        {tab === 'timeline' && <Timeline phases={response.timeline} url={response.url} connection={response.connection} />}
        {tab === 'tests' && (
          <div className="overflow-auto h-full">
            <CheckList
              checks={checks ?? []}
              actions={(c) =>
                onUpdateSnapshot && c.type === 'snapshot' && !c.passed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Camera size={12} />}
                    title="The API changed on purpose: keep this response as the new snapshot"
                    onClick={() => onUpdateSnapshot(String((c.metadata as { path?: string } | undefined)?.path ?? '$'))}
                  >
                    Update snapshot
                  </Button>
                ) : null
              }
            />
            {!!scriptLogs?.length && (
              <div className="border-t border-line">
                <div className="px-3 py-1.5 text-xs text-muted font-semibold">Script console</div>
                <pre className="px-3 pb-3 mono text-xs whitespace-pre-wrap">{scriptLogs.join('\n')}</pre>
              </div>
            )}
          </div>
        )}
        {tab === 'stream' && <RawView text={stream ?? ''} />}
        {tab === 'events' && response.events && <SseEvents events={response.events} stopped={response.streamStopped} dropped={response.eventsDropped} stateKey={eventsKey} />}
        {tab === 'trace' && (trace ? <TraceView trace={trace} /> : <Empty title="Loading trace…" />)}
        {tab === 'code' && <RawView text={curl ?? ''} />}
      </div>
    </div>
  );
}

function KvTable({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-sm table-fixed">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="border-b border-line">
              <td className="px-3 py-1 mono text-muted w-1/3 align-top break-all">{k}</td>
              <td className="px-3 py-1 mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phases of setting up the connection (shown lighter than the request's own wait and download). */
const CONNECT_PHASES = new Set(['DNS lookup', 'TCP connect', 'TLS handshake']);

/** The server's certificate: who it is for, who issued it and how long it is still valid (amber under 30 days, red under 7). */
function CertificateLine({ c }: { c: NonNullable<NonNullable<HttpResponseData['connection']>['certificate']> }) {
  const days = c.daysLeft;
  const tone = days === undefined ? 'text-muted' : days < 7 ? 'text-bad' : days < 30 ? 'text-warn' : 'text-ok';
  return (
    <div
      className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-1"
      title={[c.altNames?.length ? `Also valid for: ${c.altNames.join(', ')}` : '', c.fingerprint256 ? `SHA-256 ${c.fingerprint256}` : ''].filter(Boolean).join('\n')}
    >
      <span>
        <b className="text-fg font-medium">Certificate</b> {c.subject}
        {c.issuer && <> · issued by {c.issuer}</>}
      </span>
      {c.validTo && (
        <span>
          valid until {new Date(c.validTo).toLocaleDateString()}
          {days !== undefined && <b className={'font-medium ml-1 ' + tone}>{days < 0 ? `expired ${-days} day${days === -1 ? '' : 's'} ago` : `${plural(days, 'day')} left`}</b>}
        </span>
      )}
    </div>
  );
}

function Timeline({ phases, url, connection }: { phases: Array<{ name: string; startMs: number; durationMs: number }>; url: string; connection?: HttpResponseData['connection'] }) {
  const total = phases.find((p) => p.name === 'total')?.durationMs ?? 1;
  const connect = phases.filter((p) => CONNECT_PHASES.has(p.name)).reduce((n, p) => n + p.durationMs, 0);
  const peer = connection?.remoteAddress
    ? `${connection.remoteAddress.includes(':') ? `[${connection.remoteAddress}]` : connection.remoteAddress}${connection.remotePort ? `:${connection.remotePort}` : ''}`
    : undefined;
  return (
    <div className="p-4 text-sm flex flex-col gap-2 max-w-3xl">
      <div className="text-muted text-xs mono break-all">{url}</div>
      {connection && (
        <div className="text-xs text-muted flex flex-wrap gap-x-3 gap-y-1">
          <span>
            {connection.reused ? (
              <>
                <b className="text-fg font-medium">Reused connection</b>: no DNS lookup, TCP connect or TLS handshake
              </>
            ) : (
              <>
                <b className="text-fg font-medium">New connection</b>
                {connect > 0 && ` · set up in ${formatMs(connect)}`}
              </>
            )}
          </span>
          {peer && <span className="mono">{peer}</span>}
          {connection.tlsProtocol && (
            <span>
              {connection.tlsProtocol}
              {connection.cipher && <span className="mono"> · {connection.cipher}</span>}
            </span>
          )}
        </div>
      )}
      {connection?.certificate && <CertificateLine c={connection.certificate} />}
      {phases.map((p) => (
        <div key={p.name} className="grid grid-cols-[140px_1fr_80px] items-center gap-3">
          <span className={cx(p.name === 'total' && 'font-semibold')}>{p.name}</span>
          <div className="h-3 bg-panel2 rounded relative overflow-hidden">
            <div
              className={cx('absolute top-0 bottom-0 rounded', p.name === 'total' ? 'bg-muted/60' : CONNECT_PHASES.has(p.name) ? 'bg-accent/50' : 'bg-accent')}
              style={{ left: `${(p.startMs / total) * 100}%`, width: `${Math.max(0.5, (p.durationMs / total) * 100)}%` }}
            />
          </div>
          <span className="text-right tabular-nums">{formatMs(p.durationMs)}</span>
        </div>
      ))}
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        <Button
          size="sm"
          icon={<Sparkles size={12} />}
          title="Ask the AI assistant where the time went and what to try (the URL, phases, connection and certificate are sent; no bodies or headers)"
          onClick={() =>
            useApp.getState().set({
              assistant: {
                task: 'explain-timing',
                title: 'Where the time went',
                context: {
                  url,
                  phases,
                  connection: connection && {
                    ...connection,
                    certificate: connection.certificate && {
                      subject: connection.certificate.subject,
                      issuer: connection.certificate.issuer,
                      validTo: connection.certificate.validTo,
                      daysLeft: connection.certificate.daysLeft,
                    },
                  },
                },
              },
            })
          }
        >
          Explain with AI
        </Button>
        <p className="text-xs text-muted flex items-center gap-1">
          <ExternalLink size={11} /> Full span details are available in the Trace tab.
        </p>
      </div>
    </div>
  );
}

/**
 * A visualization page for the sandboxed frame: sanitised (no scripts, event handlers or remote
 * frames) and given a readable default style. The frame has no script or same-origin rights either.
 */
function visualPage(html: string): string {
  const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false, FORCE_BODY: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'] });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2230;margin:16px}
table{border-collapse:collapse}th,td{border:1px solid #d9dbe3;padding:4px 10px;text-align:left}th{background:#f3f4f8}
</style></head><body>${clean}</body></html>`;
}
