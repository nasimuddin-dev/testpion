import { diffResponses } from '@testpion/shared';
import { GitCompareArrows, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { comparable, previousResponse } from '../lib/response-memory';
import type { HttpResponseData } from '../types';
import { CompareView, type Compared } from './ResponseHistory';
import { Bar, Empty, IconButton, Spinner } from './ui';

/**
 * Diff vs previous: this response against the request's previous one — the one sent before it this session, else (a
 * saved request) the one before it in History. Status, time, headers and a field-by-field body diff (text bodies: a
 * line diff), the same view as History ▸ Compare.
 */
export function ResponseDiffPanel({
  response,
  memoryKey,
  sendId,
  requestId,
  historyId,
  onClose,
}: {
  response: HttpResponseData;
  memoryKey?: string;
  sendId: string;
  requestId?: string;
  historyId?: string;
  onClose(): void;
}) {
  const kept = memoryKey ? previousResponse(memoryKey, sendId) : undefined;
  const local = useMemo<{ c: Compared; cut: boolean } | undefined>(() => {
    if (!kept) return undefined;
    const now = comparable(response);
    return {
      c: {
        before: { id: kept.id, timestamp: kept.at, status: kept.response.status, durationMs: kept.response.durationMs, size: kept.response.size },
        after: { id: sendId, timestamp: new Date().toISOString(), status: response.status, durationMs: response.durationMs, size: response.size },
        diff: diffResponses(kept.response, now.response),
        bodyMissing: false,
      },
      cut: kept.cut || now.cut,
    };
  }, [kept, response, sendId]);
  const [fromHistory, setFromHistory] = useState<{ c?: Compared; error?: string; none?: boolean }>();
  // Retry after an error reads History again
  const [attemptNo, setAttemptNo] = useState(0);
  useEffect(() => {
    if (local || !requestId || !historyId) return;
    let live = true;
    setFromHistory(undefined);
    void (async () => {
      try {
        const entries = await call<Array<{ id: string }>>('history.forRequest', { requestId, limit: 50 });
        const i = entries.findIndex((e) => e.id === historyId);
        const before = i >= 0 ? entries[i + 1] : undefined;
        const r = before ? { c: await call<Compared>('history.compare', { before: before.id, after: historyId }) } : { none: true };
        if (live) setFromHistory(r);
      } catch (e) {
        if (live) setFromHistory({ error: asError(e).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [local, requestId, historyId, attemptNo]);

  const c = local?.c ?? fromHistory?.c;
  return (
    <div className="h-full flex flex-col min-h-0" data-response-diff>
      <Bar className="text-xs text-muted">
        <GitCompareArrows size={13} />
        <span className="flex-1 truncate">
          Diff vs previous response{local?.cut ? ' (long bodies: their first 512 KB compared)' : ''}
          {!local && c ? ' (from History)' : ''}
        </span>
        <IconButton size="sm" label="Close the diff" onClick={onClose}>
          <X />
        </IconButton>
      </Bar>
      <div className="flex-1 min-h-0">
        {c ? (
          <CompareView c={c} labels={['Previous response', 'This response']} />
        ) : fromHistory?.error ? (
          <Empty icon={<GitCompareArrows size={24} />} title="Couldn't load the previous response" actions={[{ label: 'Retry', icon: <RotateCcw size={13} />, onClick: () => setAttemptNo((n) => n + 1) }]}>
            {fromHistory.error}
          </Empty>
        ) : requestId && historyId && !fromHistory ? (
          <div className="h-full grid place-items-center">
            <Spinner />
          </div>
        ) : (
          <Empty icon={<GitCompareArrows size={24} />} title="No earlier response to compare with">
            Send the request again: the next response is compared with this one. Saved requests also compare with their History.
          </Empty>
        )}
      </div>
    </div>
  );
}
