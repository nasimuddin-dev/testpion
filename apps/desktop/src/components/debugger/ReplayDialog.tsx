import { ExternalLink, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatMs, isReplayLocalHost } from '@testpion/shared';
import { call } from '../../api';
import { confirmAction, toastError, useApp } from '../../store';
import { plural } from '../../lib/format';
import { Badge, Button, Field, Input, Modal } from '../ui';
import type { Exchange } from './model';

/** What debug.replay answers (core/debugger/replay.ts). */
interface ReplayAnswer {
  options: { count: number; concurrency: number; delayMs: number; stopOnFailure: boolean };
  planned: number;
  sent: number;
  failed: number;
  skipped: number;
  statuses: Record<string, number>;
  minMs?: number;
  p50Ms?: number;
  maxMs?: number;
  results: Array<{ index: number; status?: number; error?: string; ms: number }>;
}

/** The result table: status counts, the fastest, the middle and the slowest time, and each send. */
export function ReplayResult({ answer }: { answer: ReplayAnswer }) {
  return (
    <div className="grid gap-2" data-replay-result>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <b data-replay-sent>
          {answer.sent} of {answer.planned} sent
        </b>
        {Object.entries(answer.statuses).map(([k, n]) => (
          <Badge key={k} tone={k === 'error' || Number(k) >= 400 ? 'bad' : 'ok'}>
            {k} × {n}
          </Badge>
        ))}
        {answer.skipped > 0 && <Badge tone="warn">{plural(answer.skipped, 'send')} not started (stopped at the first failure)</Badge>}
        {answer.minMs !== undefined && (
          <span className="text-muted tabular-nums">
            fastest {formatMs(answer.minMs)} · middle {formatMs(answer.p50Ms ?? 0)} · slowest {formatMs(answer.maxMs ?? 0)}
          </span>
        )}
      </div>
      <div className="max-h-48 overflow-auto border border-line rounded-md text-xs tabular-nums">
        {answer.results.map((r) => (
          <div key={r.index} className="flex gap-3 px-2 py-0.5 border-b border-line/40 last:border-b-0" data-replay-row={r.index}>
            <span className="w-8 text-right text-muted">{r.index + 1}</span>
            <span className={r.error || (r.status ?? 0) >= 400 ? 'w-16 text-bad font-semibold' : 'w-16 text-ok font-semibold'}>{r.error ? 'ERR' : r.status}</span>
            <span className="w-20 text-right text-muted">{formatMs(r.ms)}</span>
            <span className="flex-1 truncate text-muted">{r.error ?? ''}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">Every send is in History, with its response.</p>
    </div>
  );
}

/** Resend… : how many times, how many at once, the wait between, and whether to stop at the first failure. */
export function ReplayDialog({ rows, start, onClose, onOpen }: { rows: Exchange[]; /** Send this many at once on opening (Resend 10 times); the dialog then shows the result. */ start?: number; onClose(): void; onOpen(e: Exchange): void }) {
  const [times, setTimes] = useState(String(start ?? Math.max(rows.length, 10)));
  const [concurrency, setConcurrency] = useState('1');
  const [delayMs, setDelayMs] = useState('0');
  const [stop, setStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ReplayAnswer>();
  const count = Math.trunc(Number(times));
  const invalid = !Number.isFinite(count) || count < 1 || count > 200 ? 'Send 1 to 200 times' : undefined;
  const send = async (n = count) => {
    const remote = [...new Set(rows.filter((r) => !isReplayLocalHost(r.host)).map((r) => r.host))];
    if (n > 1 && remote.length && !(await confirmAction({ title: 'Send requests to a server that is not yours?', message: `This sends ${n} requests to ${remote.join(', ')}.`, detail: 'A burst can look like an attack or hit a rate limit. Go on only if the server is yours or you have permission.', confirmLabel: `Send ${n}` }))) return;
    setBusy(true);
    try {
      setAnswer(await call<ReplayAnswer>('debug.replay', { ids: rows.map((r) => r.id), times: n, concurrency: Number(concurrency) || 1, delayMs: Number(delayMs) || 0, stopOnFailure: stop, confirmRemote: true, environment: useApp.getState().environment }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  // Resend 10 times: the question (for a host that is not yours) and the sends happen as the dialog opens
  useEffect(() => {
    if (start) void send(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const first = rows[0];
  return (
    <Modal
      title="Resend several times"
      onClose={onClose}
      width={560}
      onSubmit={() => void send()}
      footer={
        <>
          {first && answer && (
            <Button icon={<ExternalLink size={13} />} onClick={() => onOpen(first)} title="Open the first request in a tab, to change it and send it yourself">
              Open as request
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Play size={13} />} loading={busy} disabled={!!invalid} reason={invalid} onClick={() => void send()}>
            Send
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-replay-dialog>
        <p className="text-xs text-muted">
          {rows.length === 1 ? `${rows[0]!.method} ${rows[0]!.url}` : `${plural(rows.length, 'request')}, sent in the order of the list and round again`}. Each send goes the same way Resend does, and lands in History.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Times" hint="1 to 200">
            <Input type="number" min={1} max={200} value={times} onChange={(e) => setTimes(e.target.value)} aria-label="Times" />
          </Field>
          <Field label="At once" hint="1 to 20">
            <Input type="number" min={1} max={20} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} aria-label="At once" />
          </Field>
          <Field label="Wait between (ms)" hint="per lane">
            <Input type="number" min={0} value={delayMs} onChange={(e) => setDelayMs(e.target.value)} aria-label="Wait between" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} /> Stop at the first failure (an error, or a status of 400 and up)
        </label>
        {answer && <ReplayResult answer={answer} />}
      </div>
    </Modal>
  );
}
