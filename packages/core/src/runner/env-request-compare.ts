import type { Collection, Span } from '../model/types.js';
import { ApsError } from '../errors.js';
import { diffResponses, type ResponseDiff } from '../report/response-diff.js';
import { collectionRequests, runCollection } from './collection-run.js';
import type { ExecServices } from './execute.js';

/**
 * Send one saved request with two environments (scripts, auth and checks included, one after the
 * other) and diff the responses: status, time, headers and a field-by-field body diff. The responses
 * come from the run's traces (bodies up to 16 KB, sensitive values redacted), so the result is safe to
 * give to AI agents.
 */
interface EnvRequestSide {
  environment: string;
  status?: number | string;
  durationMs?: number;
  passed?: boolean;
  error?: string;
}

interface EnvRequestComparison {
  request: string;
  left: EnvRequestSide;
  right: EnvRequestSide;
  diff: ResponseDiff;
}

export async function compareRequestAcrossEnvironments(o: {
  collection: Collection;
  /** Request name or id. */
  request: string;
  left: string;
  right: string;
  context(environment: string): { services: ExecServices; dispose(): Promise<void> };
  signal?: AbortSignal;
}): Promise<EnvRequestComparison> {
  const want = o.request.toLowerCase();
  const ref = collectionRequests(o.collection).find((r) => r.id === o.request || r.name.toLowerCase() === want);
  if (!ref) throw new ApsError('ValidationError', `No request "${o.request}" in "${o.collection.name}"`, { suggestions: [] });
  if (ref.node.kind !== 'http') throw new ApsError('ValidationError', 'Only HTTP requests can be compared across environments', { suggestions: [] });

  const send = async (environment: string) => {
    const ctx = o.context(environment);
    let span: Span | undefined;
    let passed: boolean | undefined;
    let error: string | undefined;
    try {
      await runCollection({
        name: `Compare · ${environment}`,
        runId: `compare-${environment}`,
        collection: o.collection,
        selection: [ref.id],
        services: ctx.services,
        signal: o.signal,
        traceMode: 'all',
        environment,
        onTrace: (t) => {
          span ??= t.spans.find((s) => s.kind === 'http' && s.output !== undefined);
        },
        onEvent: (e) => {
          if (e.type !== 'test-end') return;
          passed = e.result.status === 'passed';
          error ??= e.result.error?.message;
        },
      });
    } finally {
      await ctx.dispose();
    }
    const out = span?.output as { status?: number; headers?: Array<[string, string]>; body?: string } | undefined;
    const side: EnvRequestSide = { environment, status: out?.status ?? 'error', durationMs: span?.durationMs, passed, ...(out ? {} : { error: error ?? 'no response' }) };
    return { side, comparable: out ? { status: out.status, durationMs: span?.durationMs, headers: out.headers, body: out.body } : { status: 'error', body: error ?? '' } };
  };

  const a = await send(o.left);
  const b = await send(o.right);
  return { request: ref.name, left: a.side, right: b.side, diff: diffResponses(a.comparable, b.comparable) };
}
