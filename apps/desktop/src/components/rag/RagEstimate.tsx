import { AlertTriangle, Laptop } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RunEstimate } from '@testpion/core';
import { asError, call } from '../../api';
import { formatCost } from '../../lib/format';
import { Badge, Callout, Spinner } from '../ui';

/** The cost range of an estimate in one phrase ("$0.04 to $0.09"), or why there is none. */
export function costRange(e: RunEstimate): string {
  if (e.costUsd) return `${formatCost(e.costUsd.low)} to ${formatCost(e.costUsd.high)}`;
  if (e.judge) return e.judge.local ? 'free (a local model)' : 'no price set for this model';
  return '';
}

/**
 * The estimate of a RAG evaluation before it runs (the engine's `estimateRagEvaluation`): one component for the metric
 * picker's footer (`compact`) and the dialog before a run, so the numbers read the same everywhere. Nothing is sent to
 * anyone to make it.
 */
export function RagEstimateView({ estimate, compact }: { estimate: RunEstimate; compact?: boolean }) {
  const judged = estimate.total.llmCalls > 0 || estimate.total.embedCalls > 0;
  if (compact)
    return (
      <span data-rag-estimate-line className="flex items-center gap-2 flex-wrap">
        {judged ? (
          <>
            <span>
              ≈ <b data-rag-estimate-calls>{estimate.total.llmCalls.toLocaleString()}</b> judge calls
              {estimate.total.embedCalls ? ` + ${estimate.total.embedCalls.toLocaleString()} embeddings` : ''} for {estimate.samples} samples
            </span>
            <span className="text-muted">{estimate.total.inputTokens.toLocaleString()} tokens in</span>
            {costRange(estimate) && <span data-rag-estimate-cost>{costRange(estimate)}</span>}
            {estimate.judge && <Badge tone={estimate.judge.local ? 'ok' : 'warn'}>{estimate.judge.model}</Badge>}
          </>
        ) : (
          <span className="text-muted">These metrics need no model: nothing is judged and nothing costs.</span>
        )}
        {estimate.judgeProblem && <span className="text-bad">no judge set up</span>}
        {estimate.caps.exceeds.length > 0 && <span className="text-bad">would break a limit</span>}
      </span>
    );
  return (
    <div className="grid gap-3 text-sm" data-rag-estimate>
      <div className="flex items-center gap-2 flex-wrap">
        {estimate.judge ? (
          <>
            <Badge tone="judge">
              {estimate.judge.provider} · {estimate.judge.model}
            </Badge>
            {estimate.judge.local ? (
              <Badge tone="ok">
                <Laptop size={10} /> stays on this computer
              </Badge>
            ) : (
              <Badge tone="warn">sent to {estimate.judge.provider}</Badge>
            )}
          </>
        ) : judged ? (
          <Badge tone="bad">no judge</Badge>
        ) : (
          <Badge tone="ok">no model needed</Badge>
        )}
        <span className="text-xs text-muted ml-auto">
          sizes from {estimate.basis === 'stored' ? 'the stored answers' : estimate.basis === 'probe' ? 'one real answer of your system' : estimate.basis === 'dataset' ? 'the dataset (answers assumed typical)' : 'typical values'}
        </span>
      </div>
      {estimate.judgeProblem && (
        <Callout tone="bad" data-rag-estimate-problem>
          {estimate.judgeProblem}
        </Callout>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted text-left">
            <th className="font-normal py-1">Metric</th>
            <th className="font-normal text-right">Judge calls / sample</th>
            <th className="font-normal text-right">Tokens in / sample</th>
          </tr>
        </thead>
        <tbody>
          {estimate.metrics.map((m, i) => (
            <tr key={`${m.id}-${i}`} className="border-t border-line/60" data-rag-estimate-metric={m.id}>
              <td className="py-1">
                {m.id}
                {m.note && <span className="text-muted"> · {m.note}</span>}
              </td>
              <td className="text-right tabular-nums">{m.llmCalls || (m.embedCalls ? `${m.embedCalls} embedding` : 'none')}</td>
              <td className="text-right tabular-nums">{m.inputTokens ? m.inputTokens.toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-rag-estimate-total>
        <Figure label="Judge calls" value={estimate.total.llmCalls.toLocaleString()} sub={estimate.cache.exact ? `${estimate.cache.hits} already cached` : `for ${estimate.samples} samples`} />
        <Figure label="Tokens" value={`${estimate.total.inputTokens.toLocaleString()} in`} sub={`about ${estimate.total.outputTokens.toLocaleString()} out`} />
        <Figure label="Cost" value={costRange(estimate) || '—'} sub={estimate.costUsd ? 'a range: outputs vary' : undefined} />
        {estimate.target && <Figure label="Your RAG system" value={`${estimate.target.calls.toLocaleString()} calls`} sub="one per question" />}
      </div>
      {estimate.caps.exceeds.map((x) => (
        <Callout key={x} tone="bad" data-rag-estimate-cap>
          <AlertTriangle size={13} className="inline mr-1" /> This would break {x}.
        </Callout>
      ))}
      {estimate.notes.map((n) => (
        <div key={n} className="text-xs text-muted">
          {n}
        </div>
      ))}
      {estimate.unknown.length > 0 && <div className="text-xs text-warn">Not in the catalogue: {estimate.unknown.join(', ')}</div>}
      {judged && <div className="text-xs text-muted">The judge receives the question, the answer and the retrieved documents of each sample, after masking secrets and personal data. Verdicts are cached: running again costs nothing.</div>}
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** The estimate of a draft evaluation, asked again (after a pause) when the draft changes. `probe` makes ONE call to the target. */
export function useRagEstimate(draft: unknown, o: { enabled?: boolean; probe?: boolean; environment?: string; delay?: number } = {}): { estimate?: RunEstimate; error?: string; loading: boolean } {
  const [state, setState] = useState<{ estimate?: RunEstimate; error?: string; loading: boolean }>({ loading: false });
  const key = JSON.stringify([draft, o.probe, o.environment]);
  const enabled = o.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      call<{ estimate: RunEstimate }>('rag.estimate', { draft, probe: o.probe, environment: o.environment }).then(
        (r) => live && setState({ estimate: r.estimate, loading: false }),
        (e) => live && setState({ error: asError(e).message, loading: false }),
      );
    }, o.delay ?? 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return state;
}

export function EstimateLoading() {
  return (
    <div className="flex items-center gap-2 text-muted text-sm">
      <Spinner /> Estimating …
    </div>
  );
}
