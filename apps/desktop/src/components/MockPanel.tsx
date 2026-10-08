import { Check, Copy, Play, Radio, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call, on } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, cx, Empty, Field, Input, statusTone } from './ui';
import { usePersisted } from '../lib/sticky';
import { useCopied } from '../lib/clipboard';
import { plural } from '../lib/format';

interface MockInfo {
  running: boolean;
  url?: string;
  port?: number;
  routes: Array<{ method: string; path: string; status: number; example: string; request: string; requestId: string }>;
}
interface MockHit {
  collectionId: string;
  method: string;
  path: string;
  status: number;
  example?: string;
  forwarded?: boolean;
  time: string;
}

const portKey = (id: string) => `aps.mockPort.${id}`;

/**
 * Mock server for a collection: serves the collection's saved examples on localhost, picking the
 * example by method and path (and `x-mock-response-name` / `x-mock-response-code` headers).
 */
export function MockPanel({ collectionId, onOpenRequest }: { collectionId: string; onOpenRequest(requestId: string): void }) {
  const toast = useApp((s) => s.toast);
  const [info, setInfo] = useState<MockInfo>({ running: false, routes: [] });
  const [port, setPort] = usePersisted(portKey(collectionId), '', { text: true });
  const [delay, setDelay] = useState('');
  const [fallback, setFallback] = usePersisted(`aps.mockFallback.${collectionId}`, '', { text: true });
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<MockHit[]>([]);
  const { copied, copy } = useCopied();

  useEffect(() => {
    void call<MockInfo>('mock.status', { collectionId }).then(setInfo);
    setHits([]);
    return on<MockHit>('mock.request', (e) => e.collectionId === collectionId && setHits((h) => [e, ...h].slice(0, 100)));
  }, [collectionId]);

  const start = async () => {
    setBusy(true);
    try {
      const p = port.trim() ? Number(port) : undefined;
      if (p !== undefined && !(p > 0 && p < 65536)) throw new Error('Port must be between 1 and 65535, or empty for any free port');
      const r = await call<MockInfo>('mock.start', { collectionId, port: p, delayMs: delay ? Number(delay) : undefined, fallbackUrl: fallback.trim() || undefined });
      setInfo(r);
      toast(`Mock server running on ${r.url}`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    await call('mock.stop', { collectionId });
    setInfo(await call<MockInfo>('mock.status', { collectionId }));
  };
  const routes = info.routes;
  // hits per route (by method and example served), and how requests were answered
  const hitsOf = (r: (typeof routes)[number]) => hits.filter((h) => h.method === r.method && h.example === r.example).length;
  const served = hits.filter((h) => h.example).length;
  const forwarded = hits.filter((h) => !h.example && h.forwarded).length;
  const unmatched = hits.length - served - forwarded;

  return (
    <div className="p-4 flex flex-col gap-4 max-w-4xl">
      <p className="text-sm text-muted">
        The mock server answers requests with the <b>saved examples</b> of this collection, on this computer only. Point <span className="mono">{'{{baseUrl}}'}</span> at it to develop or test a client before the real API exists. Send
        the header <span className="mono">x-mock-response-code: 404</span> or <span className="mono">x-mock-response-name</span> to pick a specific example.
      </p>
      <div className="flex items-start gap-3">
        <Field label="Port" hint="Empty = any free port">
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="auto" className="w-28 mono" disabled={info.running} />
        </Field>
        <Field label="Delay (ms)">
          <Input value={delay} onChange={(e) => setDelay(e.target.value.replace(/\D/g, ''))} placeholder="0" className="w-28 mono" disabled={info.running} />
        </Field>
        <Field label="Forward the rest to" hint="Optional: requests without an example go to this API" className="flex-1">
          <Input value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="https://api.example.com" className="mono" disabled={info.running} aria-label="Fallback URL" />
        </Field>
        {info.running ? (
          <Button variant="danger" className="mt-6" icon={<Square size={12} />} onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" className="mt-6" icon={<Play size={12} />} loading={busy} disabled={!routes.length} onClick={() => void start()}>
            Start mock server
          </Button>
        )}
        {info.running && info.url && (
          <div className="flex items-center gap-2 text-sm">
            <Badge tone="ok">
              <Radio size={11} className="inline mr-1" />
              running
            </Badge>
            <span className="mono">{info.url}</span>
            <Button
              size="sm"
              variant="ghost"
              icon={copied ? <Check size={12} /> : <Copy size={12} />}
              onClick={() => void copy(info.url!)}
            >
              {copied ? 'Copied' : 'Copy URL'}
            </Button>
          </div>
        )}
      </div>

      <section>
        <h3 className="text-xs font-medium text-muted mb-1.5">Routes ({routes.length})</h3>
        {routes.length ? (
          <table className="w-full text-sm border border-line rounded-md overflow-hidden">
            <tbody>
              {routes.map((r, i) => (
                <tr key={i} className="border-t border-line first:border-t-0 hover:bg-hover cursor-pointer" onClick={() => onOpenRequest(r.requestId)} title="Open the request">
                  <td className="px-3 py-1.5 mono text-xs w-20">{r.method}</td>
                  <td className="mono">{r.path}</td>
                  <td className="w-16">
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  </td>
                  <td className="text-muted truncate">
                    {r.example} <span className="text-xs">· {r.request}</span>
                  </td>
                  {info.running && <td className="w-16 pr-3 text-right text-xs tabular-nums" title="Requests answered with this example">{hitsOf(r) ? `${plural(hitsOf(r), 'hit')}` : <span className="text-muted">—</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No examples to serve">Open a request, send it and click “Save as example”. Every example becomes a route.</Empty>
        )}
      </section>

      {info.running && (
        <section>
          <h3 className="text-xs font-medium text-muted mb-1.5">Requests</h3>
          {hits.length > 0 && (
            <div className="mb-2">
              <div className="flex h-2 gap-0.5 rounded-full overflow-hidden" role="img" aria-label={`${served} served from examples, ${forwarded} forwarded, ${unmatched} without a matching example`}>
                {served > 0 && <span className="bg-ok" style={{ flex: served }} />}
                {forwarded > 0 && <span className="bg-accent" style={{ flex: forwarded }} />}
                {unmatched > 0 && <span className="bg-warn" style={{ flex: unmatched }} />}
              </div>
              <div className="flex flex-wrap gap-x-4 mt-1 text-xs text-muted">
                <span>
                  <span className="text-ok">●</span> {served} from examples
                </span>
                {forwarded > 0 && (
                  <span>
                    <span className="text-accent">●</span> {forwarded} forwarded
                  </span>
                )}
                {unmatched > 0 && (
                  <span>
                    <span className="text-warn">●</span> {unmatched} without a matching example
                  </span>
                )}
              </div>
            </div>
          )}
          {hits.length ? (
            <div className="border border-line rounded-md max-h-64 overflow-auto text-sm">
              {hits.map((h, i) => (
                <div key={i} className={cx('flex items-center gap-3 px-3 py-1 border-t border-line first:border-t-0', !h.example && !h.forwarded && 'text-muted')}>
                  <span className="text-xs text-muted tabular-nums">{new Date(h.time).toLocaleTimeString()}</span>
                  <span className="mono text-xs w-14">{h.method}</span>
                  <span className="mono flex-1 truncate">{h.path}</span>
                  <Badge tone={statusTone(h.status)}>{h.status}</Badge>
                  <span className="text-xs w-48 truncate">{h.example ?? (h.forwarded ? 'forwarded to the API' : 'no matching example')}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">Requests to the mock server appear here.</p>
          )}
        </section>
      )}
    </div>
  );
}

