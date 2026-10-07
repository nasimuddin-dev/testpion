import { flakyTests, summarizeTestHistory, testHistory } from '../runner/test-history.js';
import { scoreTrend } from '../runner/score-trend.js';
import { workspaceAttention } from '../storage/attention.js';
import { responseTimeStats } from '../report/response-stats.js';
import type { Collection, CollectionNode } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import { ApsError } from '../errors.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools that read what happened in the workspace: a saved request's earlier responses and response times, the
 * latest failures, test history and flaky tests, score trends of evaluations, activity per day, and what needs
 * attention first.
 */
export interface HistoryToolsDeps {
  store: WorkspaceStore;
  redactor: Redactor;
  findCollection(ref: unknown): Collection;
  findRequest(c: Collection, ref: unknown): { node: CollectionNode; folder: string };
}

export function historyTools({ store, redactor, findCollection, findRequest }: HistoryToolsDeps): Tool[] {
  return [
    {
      name: 'request_history',
      description:
        'Earlier responses of a saved request, newest first (from requests sent in the TestPion app): id, time, status, duration and size. Use the ids with compare_responses to see what changed between two runs.',
      inputSchema: {
        type: 'object',
        properties: { collection: str('Collection name or id'), request: str('Request name or id'), limit: { type: 'number', description: 'How many (default 20, max 100)' } },
        required: ['collection', 'request'],
      },
      run: (a) => {
        const { node } = findRequest(findCollection(a.collection), a.request);
        const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
        return store.meta
          .listHistory({ requestId: node.id, kind: 'http', limit })
          .items.map((h) => ({ id: h.id, timestamp: h.timestamp, status: h.status, durationMs: h.durationMs, size: h.size, url: h.url && redactor.redactUrl(h.url) }));
      },
    },
    {
      name: 'score_trend',
      description:
        "Each evaluator's mean score (0 to 1) run by run, oldest first, for runs that have scores (evaluations, AI and RAG tests): is a model, prompt or pipeline getting better or worse? Filter by run name.",
      inputSchema: { type: 'object', properties: { name: str('Only runs whose name contains this'), limit: { type: 'number', description: 'How many runs (default 40, max 300)' } } },
      run: (a) => scoreTrend(store, { name: a.name ? String(a.name) : undefined, limit: Number(a.limit) || 40 }),
    },
    {
      name: 'flaky_tests',
      description:
        'Tests of the workspace whose result keeps changing across the latest runs (two or more flips) or that passed only after a retry, most flips first: runs, passed, failed, flips, retried, last status and the latest results. Use it to find unreliable tests; test_history shows one of them in detail.',
      inputSchema: { type: 'object', properties: { runs: { type: 'number', description: 'How many of the latest runs (default 30, max 300)' } } },
      run: (a) => flakyTests(store, { runs: Number(a.runs) || 30 }),
    },
    {
      name: 'test_history',
      description:
        "One test (or saved request) across the latest runs, newest first: status, latency, attempts and the checks that failed, with a summary (runs, passed, failed, how often the result flipped: a sign of a flaky test, and the median latency). Give the test's name as in run results, or its id.",
      inputSchema: {
        type: 'object',
        properties: { name: str('Test name (as in run results)'), id: str('Or the test / request id'), limit: { type: 'number', description: 'How many runs (default 20, max 200)' } },
      },
      run: async (a) => {
        if (!a.name && !a.id) throw new ApsError('ValidationError', 'Give the name or id of a test');
        const points = await testHistory(store, { id: a.id ? String(a.id) : undefined, name: a.name ? String(a.name) : undefined }, { limit: Math.min(Math.max(Number(a.limit) || 20, 1), 200) });
        return { summary: summarizeTestHistory(points), runs: points };
      },
    },
    {
      name: 'recent_failures',
      description:
        'The latest responses that failed across the workspace (sent from the TestPion app), newest first: time, kind (http, graphql, grpc, mcp, llm), name, method, URL (secrets masked), status (4xx/5xx, a transport error such as NetworkError, a non-OK gRPC code, an MCP tool error) and duration. Use it to see what broke recently; request_history and compare_responses dig into one saved request.',
      inputSchema: { type: 'object', properties: { kind: str('Only this kind: http, graphql, grpc, mcp or llm'), limit: { type: 'number', description: 'How many (default 20, max 200)' } } },
      run: (a) =>
        store.meta
          .listHistory({ failed: true, kind: a.kind ? String(a.kind) : undefined, limit: Math.min(Math.max(Number(a.limit) || 20, 1), 200) })
          .items.map((h) => ({ id: h.id, timestamp: h.timestamp, kind: h.kind, name: h.name, method: h.method, url: h.url && redactor.redactUrl(h.url), status: h.status, durationMs: h.durationMs })),
    },
    {
      name: 'response_time_stats',
      description:
        "Response-time summary of a saved request's recent responses (from requests sent in the TestPion app): count, failed (no status or 400+), fastest, mean, median (p50), p95 and slowest in ms. Use it to spot a slow or flaky endpoint; request_history lists the individual responses.",
      inputSchema: {
        type: 'object',
        properties: { collection: str('Collection name or id'), request: str('Request name or id'), limit: { type: 'number', description: 'How many recent responses (default 50, max 500)' } },
        required: ['collection', 'request'],
      },
      run: (a) => {
        const { node } = findRequest(findCollection(a.collection), a.request);
        const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
        return responseTimeStats(store.meta.listHistory({ requestId: node.id, kind: 'http', limit }).items);
      },
    },
    {
      name: 'what_needs_attention',
      description:
        'What needs attention in this workspace, most severe first: failing monitors, TLS certificates that expire within 30 days, the latest run if it failed, saved requests whose latest response failed, and flaky tests. Each item has a message and a ref (monitorId, host, runId, collectionId + requestId, testId). Start here to find out what to fix.',
      inputSchema: { type: 'object', properties: { certDays: { type: 'number', description: 'Warn about certificates that expire within this many days (default 30)' } } },
      run: (a) => workspaceAttention(store, { certDays: Number(a.certDays) || 30 }),
    },
    {
      name: 'workspace_activity',
      description:
        'Workspace activity per day (local days): requests sent from the app and how many failed (4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors), median response time, test runs and failed tests; plus requests per kind and the slowest requests on average. Use it to spot a day things started failing or slowing down.',
      inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many days (default 14, max 90)' } } },
      run: (a) => store.meta.activity({ days: Number(a.days) || 14, tzOffsetMin: new Date().getTimezoneOffset() }),
    },
  ];
}
