import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { LoadSnapshot } from './load.js';
import { appendBoundedLine } from '../util/jsonl-append.js';
import { atomicWrite } from '../storage/fsutil.js';

/** One finished load test, as kept in the workspace (runs/load/history.jsonl, the newest 500). */
export interface LoadRunRecord {
  id: string;
  startedAt: string;
  /** Saved load test it came from (library "load-tests"), if any, and its name. */
  savedId?: string;
  name: string;
  /** What was tested: "GET https://…", "collection My API", "gRPC host/Method", "LLM provider/model". */
  target: string;
  environment?: string;
  virtualUsers: number;
  durationSec: number;
  /** Stopped before its planned duration. */
  stopped?: boolean;
  requests: number;
  throughput: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  statusCodes: Record<string, number>;
  /** HTTP: the server's time to first byte (p95) and the share of requests that opened a new connection. */
  ttfbP95?: number;
  newConnectionShare?: number;
  /** Pass/fail rules and whether each held. */
  thresholds?: Array<{ expr: string; passed: boolean; actual?: number }>;
  passed?: boolean;
}

const KEEP = 500;
const file = (store: Pick<WorkspaceStore, 'path'>) => store.path('runs', 'load', 'history.jsonl');

/** The record of a finished load test from its last snapshot. */
export function loadRunRecord(snap: LoadSnapshot, info: Omit<LoadRunRecord, 'requests' | 'throughput' | 'errorRate' | 'p50' | 'p95' | 'p99' | 'statusCodes' | 'ttfbP95' | 'newConnectionShare'>): LoadRunRecord {
  return {
    ...info,
    requests: snap.requests,
    throughput: snap.throughput,
    errorRate: snap.errorRate,
    p50: Math.round(snap.latency.p50),
    p95: Math.round(snap.latency.p95),
    p99: Math.round(snap.latency.p99),
    statusCodes: snap.statusCodes,
    ...(snap.http ? { ttfbP95: Math.round(snap.http.ttfb.p95), newConnectionShare: Math.round((snap.http.newConnections / Math.max(1, snap.http.newConnections + snap.http.reused)) * 1000) / 1000 } : {}),
    ...(info.thresholds ? { passed: info.thresholds.every((t) => t.passed) } : {}),
  };
}

export function recordLoadRun(store: Pick<WorkspaceStore, 'path'>, r: LoadRunRecord): void {
  // bounded: the newest records are rewritten when the file grows past twice the limit
  appendBoundedLine(file(store), JSON.stringify(r), KEEP, (f, text) => atomicWrite(f, text)); // a crash during the rewrite keeps the old history
}

/** Finished load tests, newest first; only one saved load test's with `savedId`, or with a matching name / target with `query`. */
export function loadHistory(store: Pick<WorkspaceStore, 'path'>, q: { savedId?: string; query?: string; limit?: number } = {}): LoadRunRecord[] {
  const f = file(store);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, 'utf8').split('\n');
  const limit = Math.min(Math.max(q.limit ?? 50, 1), KEEP);
  const needle = q.query?.toLowerCase();
  const out: LoadRunRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]!.trim()) continue;
    let r: LoadRunRecord;
    try {
      r = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (q.savedId && r.savedId !== q.savedId) continue;
    if (needle && !`${r.name} ${r.target}`.toLowerCase().includes(needle)) continue;
    out.push(r);
  }
  return out;
}
