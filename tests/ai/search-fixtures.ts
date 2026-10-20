/**
 * A small workspace for the search tests: History entries (HTTP, gRPC, LLM; failures, slow calls), two runs with
 * results (a failure, an error, a retried test), and two traces with spans. Times are relative to NOW, so the cases
 * hold on any day.
 */
import { join } from 'node:path';
import { WorkspaceStore, type Collection, type HistoryEntry } from '../../packages/core/src/index.js';
import { addRun, httpResult } from './run-fixtures.js';

export const NOW = Date.parse('2026-10-19T12:00:00Z');
export const ago = (ms: number) => new Date(NOW - ms).toISOString();
export const H = 3_600_000;
export const D = 86_400_000;

const hist = (e: Partial<HistoryEntry> & { id: string }): HistoryEntry => ({ kind: 'http', name: e.id, timestamp: ago(H), ...e }) as HistoryEntry;

/** The data into a workspace that exists (the AI harness makes its own). */
export async function seedSearchData(store: WorkspaceStore): Promise<void> {
  store.saveCollection({ schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 1, variables: [], updatedAt: ago(D), items: [] } as unknown as Collection);
  for (const e of [
    hist({ id: 'h1', name: 'Charge card', method: 'GET', url: 'https://api.example.com/payments/charge', status: 500, durationMs: 2500, size: 900, timestamp: ago(2 * H), collectionId: 'shop' }),
    hist({ id: 'h2', name: 'Create charge', method: 'POST', url: 'https://api.example.com/payments/charge', status: 201, durationMs: 300, size: 200, timestamp: ago(D), collectionId: 'shop' }),
    hist({ id: 'h3', name: 'List users', method: 'GET', url: 'https://api.example.com/users', status: 200, durationMs: 120, size: 4000, timestamp: ago(10 * D) }),
    hist({ id: 'h4', name: 'Ping', kind: 'grpc', url: 'grpc://svc:50051/Ping', status: 'UNAVAILABLE', durationMs: 80, timestamp: ago(3 * H) }),
    hist({ id: 'h5', name: 'Summarise', kind: 'llm', method: 'POST', url: 'https://llm.example.com/v1/chat', status: 200, durationMs: 4000, size: 5000, timestamp: ago(5 * D) }),
    hist({ id: 'h6', name: 'Missing pet', method: 'GET', url: 'https://api.example.com/pets/9', status: 404, durationMs: 60, timestamp: ago(4 * H) }),
  ])
    store.meta.addHistory(e);
  await addRun(store, {
    id: 'run-a',
    name: 'Nightly',
    startedAt: ago(3 * D),
    environment: 'staging',
    results: [
      httpResult({ id: 'login', name: 'Login works', url: 'http://x/login', status: 200, latencyMs: 100, file: 'auth/login.yaml', checks: [{ name: 'status equals 200', passed: true }] }),
      httpResult({
        id: 'checkout',
        name: 'Checkout pays',
        url: 'http://x/pay',
        status: 500,
        latencyMs: 3000,
        file: 'checkout/pay.yaml',
        checks: [{ name: 'status equals 201', passed: false, message: 'expected 201 got 500' }],
      }),
    ],
  });
  await addRun(store, {
    id: 'run-b',
    name: 'Smoke',
    startedAt: ago(D),
    environment: 'production',
    results: [
      httpResult({
        id: 'login',
        name: 'Login works',
        url: 'http://x/login',
        status: 0,
        latencyMs: 5000,
        file: 'auth/login.yaml',
        error: { kind: 'NetworkError', message: 'ECONNRESET while reading' },
      }),
      httpResult({
        id: 'checkout',
        name: 'Checkout pays',
        url: 'http://x/pay',
        status: 201,
        latencyMs: 400,
        file: 'checkout/pay.yaml',
        attempts: 2,
        checks: [{ name: 'status equals 201', passed: true }],
      }),
    ],
  });
  const span = (name: string, error?: string) => ({
    traceId: 'x',
    spanId: name,
    name,
    kind: 'llm' as const,
    startTime: NOW - 6 * H,
    status: error ? ('error' as const) : ('ok' as const),
    attributes: {},
    ...(error ? { error } : {}),
  });
  store.saveTrace({ traceId: 'tr1', name: 'agent run', startTime: NOW - 6 * H, endTime: NOW - 6 * H + 9000, status: 'error', spans: [span('llm.chat'), span('tool.call', 'timeout after 5s')] }, 'llm');
  store.saveTrace({ traceId: 'tr2', name: 'checkout trace', startTime: NOW - 2 * D, endTime: NOW - 2 * D + 200, status: 'ok', spans: [span('http.request')] }, 'http');
}

export async function seedSearchWorkspace(dir: string): Promise<WorkspaceStore> {
  const store = WorkspaceStore.create(join(dir, 'ws'), 'Search');
  await seedSearchData(store);
  return store;
}
