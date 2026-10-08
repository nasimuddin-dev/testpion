import { Circle, Copy, FolderPlus, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { plural } from '../lib/format';
import { Badge, Button, Empty, Field, Input, Modal, VirtualList, statusTone } from './ui';
import { useEventLog } from '../lib/use-rpc';
import { usePersisted } from '../lib/sticky';
import { copyText } from '../lib/clipboard';

interface Exchange {
  id: string;
  time: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
}

/**
 * Record traffic: TestPion listens on localhost and forwards to the real API; point a front end or any
 * client at the local URL and every request/response is listed. Save the recording as a collection
 * (responses become examples, tokens become {{variables}}), then replay, test or mock it.
 */
export function RecordDialog({ onClose }: { onClose(): void }) {
  const [target, setTarget] = usePersisted('aps.record.target', 'https://', { text: true });
  const [port, setPort] = useState('');
  const [running, setRunning] = useState<{ url: string; target: string }>();
  const [items, setItems] = useEventLog<Exchange>('record.exchange', 2000);
  const [name, setName] = useState('Recorded');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<{ url: string; target: string; exchanges: number } | null>('record.status').then((s) => s && setRunning({ url: s.url, target: s.target }));
  }, []);
  const start = async () => {
    setBusy(true);
    try {
      const r = await call<{ url: string; target: string }>('record.start', { target: target.trim(), port: port ? Number(port) : undefined });
      setRunning(r);
      setItems([]);
      await navigator.clipboard.writeText(r.url).catch(() => undefined);
      useApp.getState().toast(`Recording. Point your client at ${r.url} (copied)`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    await call('record.stop');
    setRunning(undefined);
  };
  const save = async () => {
    try {
      const r = await call<{ collectionId: string; name: string; requests: number; placeholders: string[] }>('record.save', { name });
      await useApp.getState().refreshWorkspace();
      useApp.getState().toast(
        `Saved ${plural(r.requests, 'request')} to "${r.name}"${r.placeholders.length ? `. Secrets were replaced by variables: set ${r.placeholders.join(', ')} as secret environment variables` : ''}`,
        'success',
      );
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal title="Record traffic" onClose={onClose} width={760}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">TestPion listens on this computer and forwards every request to the API. Point your app or any client at the local address instead of the API, use it as usual, and the requests and responses appear here. Save them as a collection to replay, test or mock them.</p>
        {running ? (
          <div className="flex items-center gap-2 rounded-md border border-line bg-panel p-2">
            <Badge tone="bad">
              <Circle size={8} className="fill-current mr-1 inline" /> recording
            </Badge>
            <span className="mono text-sm">{running.url}</span>
            <span className="text-sm text-muted">→ {running.target}</span>
            <Button size="sm" variant="ghost" icon={<Copy size={12} />} className="ml-auto" onClick={() => void copyText(running.url, 'the URL')}>
              Copy
            </Button>
            <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={() => void stop()}>
              Stop
            </Button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <Field label="API base URL" className="flex-1">
              <Input className="mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://api.example.com" aria-label="Target URL" />
            </Field>
            <Field label="Local port" className="w-28">
              <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="any" aria-label="Local port" />
            </Field>
            <Button variant="primary" icon={<Circle size={12} />} loading={busy} disabled={!/^https?:\/\/.+/.test(target.trim())} onClick={() => void start()}>
              Start recording
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">Exchanges</span>
          <span className="text-muted">{items.length}</span>
          {!!items.length && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} className="ml-auto" onClick={() => void call('record.clear').then(() => setItems([]))}>
              Clear
            </Button>
          )}
        </div>
        <div className="h-64 border border-line rounded-md overflow-hidden flex flex-col">
          {items.length ? (
            <VirtualList
              className="flex-1"
              items={items}
              rowHeight={28}
              render={(x) => (
                <div className="h-full flex items-center gap-2 px-2 text-sm border-b border-line/50">
                  <Badge tone={x.error ? 'bad' : statusTone(x.status)}>{x.status}</Badge>
                  <span className="mono text-xs w-14 shrink-0">{x.method}</span>
                  <span className="mono text-xs truncate">{x.path}</span>
                  <span className="text-xs text-muted ml-auto shrink-0">{x.error ? x.error : `${x.durationMs} ms`}</span>
                </div>
              )}
            />
          ) : (
            <Empty title={running ? 'Waiting for requests…' : 'Not recording'}>{running ? `Send requests to ${running.url}` : 'Enter the API base URL and start recording.'}</Empty>
          )}
        </div>
        <div className="flex items-end gap-2 border-t border-line pt-3">
          <Field label="Save as collection" className="flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Collection name" />
          </Field>
          <Button icon={<FolderPlus size={13} />} disabled={!items.length} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
