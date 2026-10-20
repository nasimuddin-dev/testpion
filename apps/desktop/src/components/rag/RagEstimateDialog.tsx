import { Eye, Play } from 'lucide-react';
import { useState } from 'react';
import type { TryResult } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import type { CheckConfig } from '../../types';
import { AiPreviewDialog } from '../ai/AiPreviewDialog';
import { Button, Callout, Modal, Spinner } from '../ui';
import { EstimateLoading, RagEstimateView, useRagEstimate } from './RagEstimate';

/**
 * Before a RAG evaluation runs that spends something: how many judge calls it will make, the tokens and a cost range from
 * the price table, what is already cached, which cap it would break, and what the judge receives. The numbers come from the
 * engine, the same as `testpion rag run --estimate` and the MCP tool rag_estimate. A run with only free metrics does not
 * ask: there is nothing to estimate. Sizing the answers with one real call to the target is the person's choice.
 */
export function RagEstimateDialog({ draft, firstQuestion, hasTarget, onRun, onClose }: { draft: { evaluators: CheckConfig[]; target?: string; judge?: unknown } & Record<string, unknown>; firstQuestion?: string; hasTarget: boolean; onRun(): void; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const [probe, setProbe] = useState(false);
  const { estimate, error, loading } = useRagEstimate(draft, { probe, environment: env, delay: 0 });
  const [prompt, setPrompt] = useState<TryResult['willSend']>();
  const [busy, setBusy] = useState(false);
  const firstJudgedLine = estimate?.metrics.find((m) => m.llmCalls > 0);
  const firstJudged = firstJudgedLine ? draft.evaluators[firstJudgedLine.evaluator] : undefined;
  const show = async () => {
    if (!firstJudged || !draft.target) return;
    setBusy(true);
    try {
      const r = await call<TryResult>('rag.metric.try', { metric: firstJudged.type, options: firstJudged, target: draft.target, question: firstQuestion ?? 'What does this system know?', judge: draft.judge, dryRun: true, environment: env });
      if (r.willSend?.length) setPrompt(r.willSend);
      else useApp.getState().toast('That metric needs no model: nothing would be sent.', 'info');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const blocked = !!estimate?.judgeProblem;
  const over = (estimate?.caps.exceeds.length ?? 0) > 0;
  return (
    <>
      <Modal
        title="Before this run"
        onClose={onClose}
        width={760}
        footer={
          <>
            {hasTarget && firstJudged && (
              <Button className="mr-auto" icon={busy ? <Spinner /> : <Eye size={13} />} onClick={() => void show()} disabled={busy} title="Asks your RAG system one question, then shows the exact prompt the judge would receive (nothing is sent to the judge)" data-rag-estimate-show>
                What the judge receives
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            {blocked ? (
              <Button variant="primary" onClick={() => (onClose(), useApp.getState().openIntent('settings', { tab: 'assistant' }))} data-rag-estimate-setup>
                Set up AI
              </Button>
            ) : (
              <Button variant="primary" icon={<Play size={13} />} disabled={!estimate} onClick={onRun} data-rag-estimate-run>
                {over ? 'Run anyway (the rest becomes n/a)' : 'Run'}
              </Button>
            )}
          </>
        }
      >
        <div className="grid gap-3" data-rag-estimate-dialog>
          {error && <Callout tone="bad">{error}</Callout>}
          {!estimate && !error && <EstimateLoading />}
          {estimate && <RagEstimateView estimate={estimate} />}
          {hasTarget && (
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} data-rag-estimate-probe /> Size a typical answer with one real call to your RAG system{loading && probe ? ' …' : ''}
            </label>
          )}
        </div>
      </Modal>
      {prompt && <AiPreviewDialog request={{ title: `${prompt[0]!.metric} (${prompt[0]!.version})` }} load={() => Promise.resolve(prompt[0]!.preview)} onClose={() => setPrompt(undefined)} />}
    </>
  );
}
