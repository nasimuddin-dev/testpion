import { closeSync, openSync, readSync } from 'node:fs';
import type { HistoryEntry } from '../model/types.js';
import { ApsError } from '../errors.js';
import { diffResponses, type ResponseDiff } from '../report/response-diff.js';
import { plainFileInside } from './fsutil.js';
import type { WorkspaceStore } from './workspace.js';

const MAX_BODY = 2 * 1024 * 1024;

/** Headers and body text of a response in history; the body is read from its payload file (up to 2 MB). */
export function historyResponse(store: WorkspaceStore, h: HistoryEntry): { headers: Array<[string, string]>; body?: string; bodyMissing: boolean; bodyTruncated: boolean } {
  const meta = (h.responseMeta ?? {}) as { headers?: Array<[string, string]> };
  let body: string | undefined;
  let truncated = false;
  const p = h.payloadPath;
  // only plain files really inside this workspace's payloads folder are read (never through a link)
  const size = typeof p === 'string' ? plainFileInside(store.path('payloads'), p) : undefined;
  if (p && size !== undefined) {
    const fd = openSync(p, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, MAX_BODY));
      readSync(fd, buf, 0, buf.length, 0);
      body = buf.toString('utf8');
      truncated = size > MAX_BODY;
    } finally {
      closeSync(fd);
    }
  }
  return { headers: meta.headers ?? [], body, bodyMissing: body === undefined, bodyTruncated: truncated };
}

interface HistoryComparison {
  before: { id: string; timestamp: string; status?: number | string };
  after: { id: string; timestamp: string; status?: number | string };
  diff: ResponseDiff;
  bodyMissing: boolean;
}

/** Compare two responses from a workspace's history (by history id). */
export function compareHistory(store: WorkspaceStore, beforeId: string, afterId: string): HistoryComparison {
  const a = store.meta.getHistory(beforeId);
  const b = store.meta.getHistory(afterId);
  if (!a || !b) throw new ApsError('ConfigurationError', `History entry ${!a ? beforeId : afterId} not found`);
  const ra = historyResponse(store, a);
  const rb = historyResponse(store, b);
  return {
    before: { id: a.id, timestamp: a.timestamp, status: a.status },
    after: { id: b.id, timestamp: b.timestamp, status: b.status },
    diff: diffResponses({ status: a.status, durationMs: a.durationMs, size: a.size, headers: ra.headers, body: ra.body }, { status: b.status, durationMs: b.durationMs, size: b.size, headers: rb.headers, body: rb.body }),
    bodyMissing: ra.bodyMissing || rb.bodyMissing,
  };
}
