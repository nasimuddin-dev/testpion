import { CookiesView, ErrorView, ParamsView, cookiesOf, paramsOf } from './ExchangeExtras';
import { SummaryPanel } from './DockInsights';
import { Bot, ChevronDown, Copy, ExternalLink, Lock, Pause, Play, Scale, Star, X } from 'lucide-react';
import { memo, useMemo } from 'react';
import { formatBytes } from '@testpion/shared';
import { Badge, Button, Menu, Split, statusTone } from '../ui';
import { EventsView, FramesView, GrpcView } from '../DebuggerTools';
import { bodyNote, curlOf, rawOf, versionOf, type Exchange } from './model';
import { AuthView, DetailsPane, HexView } from './DetailsPane';
import { bodyViewTabs } from './BodyViews';
import { copyText } from '../../lib/clipboard';
import { OutputActions } from '../output/OutputFrame';
import { exchangeOutputSpec } from '../output/debugger-specs';

/** What can be done with the exchange shown: a captured one has every action; a request a mock server received only the first three. */
export interface ExchangeActions {
  onOpen(): void;
  onAsk?(): void;
  onResend?(): void;
  onKeepEncrypted?(): void;
  onBookmark?(): void;
  onDelete?(): void;
  onCompare?(): void;
  onRule?(preset: string): void;
}

/**
 * The selected exchange, the HTTP Debugger Pro way: its actions on one line, then Request Details and Response Details
 * side by side. Each pane is a header table (the start line first, a filter on top) with Header / Content / Raw / JSON
 * tabs at the bottom, plus what the exchange has: credentials and bytes on the request, gRPC messages, WebSocket frames
 * or events on the response. Memoised: a capture sync that did not change the exchange renders nothing here.
 */
export const ExchangePanes = memo(function ExchangePanes({ e, ...a }: { e: Exchange } & ExchangeActions) {
  const raw = useMemo(() => rawOf(e), [e]);
  const path = (() => {
    try {
      const u = new URL(e.url);
      return u.pathname + u.search;
    } catch {
      return e.url;
    }
  })();
  const version = versionOf(e);
  const tunnel = e.kind === 'tunnel';
  const spec = useMemo(() => exchangeOutputSpec(e), [e]);
  return (
    <div className="h-full flex flex-col min-h-0" data-output="debugger.exchange">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0 whitespace-nowrap overflow-hidden">
        <Badge tone={e.error ? 'bad' : statusTone(e.status)}>{e.error ? 'error' : `${e.status ?? '…'} ${e.statusText ?? ''}`}</Badge>
        <span className="mono text-xs truncate" title={e.url}>
          {e.method} {e.url}
        </span>
        <OutputActions spec={spec}>
          <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={a.onOpen} disabled={e.kind === 'tunnel'} title={e.kind === 'tunnel' ? 'A tunnel is not a request: turn on HTTPS decryption to see the requests inside it' : 'Open as request: in a tab, to change and send'}>
            Open
          </Button>
          {a.onKeepEncrypted && e.kind === 'tunnel' && (
            <Button size="sm" variant="ghost" icon={<Lock size={12} />} onClick={a.onKeepEncrypted} title="Stop decrypting this host: a program that does not trust the TestPion certificate, or pins its own">
              Keep host encrypted
            </Button>
          )}
          {a.onResend && (
            <Button size="sm" variant="ghost" icon={<Play size={12} />} onClick={a.onResend} disabled={e.kind === 'tunnel'} title={e.kind === 'tunnel' ? 'A tunnel is not a request: turn on HTTPS decryption to see the requests inside it' : 'Send it again as it was'}>
              Resend
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void copyText(curlOf(e), 'as cURL')}>
            cURL
          </Button>
          {a.onAsk && (
            <Button size="sm" variant="ghost" icon={<Bot size={12} />} onClick={a.onAsk} title="Ask the AI assistant what this exchange does, why it failed, what to check (sent redacted)">
              Ask AI
            </Button>
          )}
          {a.onCompare && (
            <Button size="sm" variant="ghost" icon={<Scale size={12} />} onClick={a.onCompare} title="Compare with another exchange: click it next">
              Compare
            </Button>
          )}
          {a.onRule && (
            <Menu
              width={280}
              items={[
                { label: `Reply with this response from now on`, icon: <Play size={14} />, onSelect: () => a.onRule!('reply-with-this') },
                { label: `Filter out ${e.host}`, onSelect: () => a.onRule!('ignore') },
                { label: `Capture only ${e.host}`, onSelect: () => a.onRule!('only') },
                { label: `Highlight ${e.host}`, onSelect: () => a.onRule!('highlight') },
                { label: `Offline: reply 503 for ${e.host}`, onSelect: () => a.onRule!('offline') },
                { label: `Slow down ${e.host} by 2 s`, onSelect: () => a.onRule!('slow') },
                { label: `Allow CORS for ${e.host}`, onSelect: () => a.onRule!('cors') },
                { label: `Pause every request to ${e.host}`, icon: <Pause size={14} />, onSelect: () => a.onRule!('break-request') },
              ]}
              trigger={
                <Button size="sm" variant="ghost" title="Add a rule for this exchange's host">
                  Rule <ChevronDown size={12} />
                </Button>
              }
            />
          )}
          {a.onBookmark && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Star size={12} className={e.bookmarked ? 'fill-current text-warn' : ''} />}
              onClick={a.onBookmark}
              title={e.bookmarked ? 'Remove the bookmark' : 'Bookmark'}
            >
              {e.bookmarked ? 'Bookmarked' : 'Bookmark'}
            </Button>
          )}
          {a.onDelete && (
            <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={a.onDelete} title="Remove from the session">
              Delete
            </Button>
          )}
        </OutputActions>
      </div>
      {e.error && <div className="px-3 py-2 text-sm text-bad border-b border-line">{e.error}</div>}
      {(e.rules?.length || e.redirectedTo || e.repliedByRule || e.edited) && (
        <div className="px-3 py-1.5 text-xs border-b border-line flex gap-2 flex-wrap items-center text-muted">
          <Scale size={12} />
          {e.repliedByRule && <Badge tone="warn">answered by a rule</Badge>}
          {e.redirectedTo && (
            <Badge tone="warn" title={e.redirectedTo}>
              redirected to {e.redirectedTo.replace(/^https?:\/\//, '').split('/')[0]}
            </Badge>
          )}
          {e.edited && <Badge tone="warn">edited at a breakpoint</Badge>}
          {e.rules?.map((r) => (
            <Badge key={r}>{r}</Badge>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <Split id="debugger-panes" initial={50}>
          <DetailsPane
            exchangeId={e.id}
            title="Request details"
            side="request"
            startLabel="[Request]"
            startLine={tunnel ? `CONNECT ${e.host}` : `${e.method} ${path} ${version}`}
            headers={e.requestHeaders}
            body={e.requestBody}
            bodyNote={bodyNote(e, 'request', formatBytes)}
            raw={raw.request}
            extra={[
              ...(tunnel ? [] : [{ id: 'params', label: 'Params', badge: (() => { const p = paramsOf(e); return p.query.length + p.form.length || undefined; })(), render: () => <ParamsView e={e} /> }]),
              ...(tunnel ? [] : [{ id: 'cookies', label: 'Cookies', badge: cookiesOf(e, 'request').length || undefined, render: () => <CookiesView e={e} side="request" /> }]),
              { id: 'summary', label: 'Summary', render: () => <SummaryPanel e={e} /> },
              {
                id: 'auth',
                label: 'Auth',
                badge: e.auth && e.auth.scheme !== 'none' ? e.auth.scheme.split(' ')[0] : undefined,
                render: () => <AuthView e={e} />,
              },
              ...bodyViewTabs(e, 'request'),
              { id: 'hex', label: 'Hex', render: () => <HexView text={e.requestBody} /> },
            ]}
          />
          <DetailsPane
            exchangeId={e.id}
            title="Response details"
            side="response"
            startLabel="[Response]"
            startLine={e.error ? `error: ${e.error}` : e.status ? `${version} ${e.status} ${e.statusText ?? ''}`.trim() : '(waiting for the response)'}
            headers={e.responseHeaders}
            trailers={e.trailers}
            body={e.responseBody}
            bodyNote={
              tunnel
                ? `An HTTPS tunnel: ${formatBytes(e.requestBodyBytes)} sent, ${formatBytes(e.responseBodyBytes)} received, encrypted end to end. Click Capture all traffic, or HTTPS ▸ See inside HTTPS…: TestPion asks once to trust its certificate, then the requests inside show here.`
                : bodyNote(e, 'response', formatBytes)
            }
            raw={raw.response}
            initial={e.grpc ? 'grpc' : e.frames ? 'frames' : e.events?.length ? 'events' : undefined}
            extra={[
              ...(tunnel ? [] : [{ id: 'cookies', label: 'Cookies', badge: cookiesOf(e, 'response').length || undefined, render: () => <CookiesView e={e} side="response" /> }]),
              ...(e.error || (e.status && e.status >= 400) ? [{ id: 'error', label: 'Error', badge: '!', render: () => <ErrorView e={e} /> }] : []),
              ...bodyViewTabs(e, 'response'),
              { id: 'hex', label: 'Hex', render: () => <HexView text={e.responseBody} /> },
              ...(e.grpc ? [{ id: 'grpc', label: 'gRPC', badge: e.grpc.requests.length + e.grpc.responses.length, render: () => <GrpcView call={e.grpc!} open={e.open} /> }] : []),
              ...(e.frames ? [{ id: 'frames', label: 'Frames', badge: e.frames.length, render: () => <FramesView frames={e.frames!} open={e.open} /> }] : []),
              ...(e.events ? [{ id: 'events', label: 'Events', badge: e.events.length, render: () => <EventsView events={e.events!} open={e.open} /> }] : []),
            ]}
          />
        </Split>
      </div>
    </div>
  );
});

