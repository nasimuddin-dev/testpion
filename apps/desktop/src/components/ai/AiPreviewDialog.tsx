import { Eye, Laptop, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AiTaskResult } from '@testpion/core';
import { asError, call } from '../../api';
import type { AssistantRequest } from '../../store';
import { useApp } from '../../store';
import { aiSetupAction } from '../../lib/ai-errors';
import { formatCost } from '../../lib/format';
import { Badge, Button, Modal, Segmented, Spinner } from '../ui';
import { CodeBlock } from '../CodeBlock';

export type AiPrivacy = 'full' | 'metadata' | 'names';

export const PRIVACY_OPTIONS: Array<{ value: AiPrivacy; label: string; title: string }> = [
  { value: 'full', label: 'Full (redacted)', title: 'Requests, responses and results, with secrets, tokens and personal data masked' },
  { value: 'metadata', label: 'Metadata only', title: 'Methods, URLs without query values, statuses, names and the shape of bodies; no body values' },
  { value: 'names', label: 'Names only', title: 'Only names, kinds and the structure' },
];

/** The task call as the backend takes it (`ai.preview` / `ai.runTask`). */
export const taskParams = (req: AssistantRequest, environment?: string, privacy?: AiPrivacy) => ({
  task: req.task,
  context: (req.context ?? {}) as Record<string, unknown>,
  question: req.question,
  privacy: privacy ?? req.privacy,
  response: req.response,
  previous: req.previous,
  item: req.item,
  path: req.path,
  environment,
});

/**
 * "What will be sent" (AIB-2): the exact messages of an AI action before anything leaves the computer — the model and
 * whether it is local, the privacy level (switchable), each context section with its tokens and how it was fitted,
 * what was masked, and the token and cost estimate. Send goes ahead with the chosen level.
 */
export function AiPreviewDialog({ request, onSend, onClose }: { request: AssistantRequest; onSend(privacy: AiPrivacy): void; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const [privacy, setPrivacy] = useState<AiPrivacy>(request.privacy ?? useApp.getState().settings?.ai?.privacy ?? 'full');
  const [preview, setPreview] = useState<AiTaskResult['preview']>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setError(undefined);
    call<AiTaskResult>('ai.preview', taskParams(request, env, privacy)).then(
      (r) => live && setPreview(r.preview),
      (e) => live && setError(asError(e)),
    );
    return () => {
      live = false;
    };
  }, [request, env, privacy]);
  const fix = error ? aiSetupAction(error) : undefined;
  const kinds = preview ? [...new Set(preview.redactions.map((r) => r.kind))] : [];
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Eye size={16} /> What will be sent · {request.title}
        </span>
      }
      onClose={onClose}
      width={820}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!preview} onClick={() => onSend(privacy)} data-ai-send>
            Send
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-ai-preview>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted">Privacy</span>
          <Segmented label="Privacy level" value={privacy} onChange={(v) => setPrivacy(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
        </div>
        {error ? (
          <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 flex items-center gap-3">
            <span className="flex-1">{error.message}</span>
            {fix && (
              <Button size="sm" variant="primary" onClick={() => (onClose(), fix.onClick())}>
                {fix.label}
              </Button>
            )}
          </div>
        ) : !preview ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Building the context…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap" data-ai-model>
              <Badge tone="judge">
                {preview.providerName} · {preview.model}
              </Badge>
              <span className="text-xs text-muted">{preview.tier === 'large' ? 'large task' : 'small task'}</span>
              {preview.local ? (
                <Badge tone="ok">
                  <Laptop size={10} /> stays on this computer
                </Badge>
              ) : (
                <Badge tone="warn">sent to {preview.providerName}</Badge>
              )}
              <span className="ml-auto tabular-nums" data-ai-estimate>
                ≈ {preview.estimate.inputTokens.toLocaleString()} tokens in · up to {preview.estimate.maxOutputTokens.toLocaleString()} out
                {preview.estimate.priceKnown ? ` · up to ${formatCost(preview.estimate.maxCostUsd ?? 0)}` : ' · no price set'}
              </span>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted text-left">
                  <th className="font-normal py-1">Section</th>
                  <th className="font-normal text-right">Tokens</th>
                  <th className="font-normal pl-4">Fitted</th>
                </tr>
              </thead>
              <tbody>
                {preview.context.sections.map((s) => (
                  <tr key={s.name} className="border-t border-line/60">
                    <td className="py-1 mono">{s.name}</td>
                    <td className="text-right tabular-nums">
                      {s.tokens.toLocaleString()}
                      {s.originalTokens > s.tokens && <span className="text-muted"> of {s.originalTokens.toLocaleString()}</span>}
                    </td>
                    <td className="pl-4 text-muted">{s.notes.join('; ') || 'as it is'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-start gap-2 text-xs" data-ai-masked>
              <ShieldCheck size={14} className="text-ok shrink-0" />
              {preview.redactionCount ? (
                <span>
                  Masked {preview.redactionCount}: {kinds.join(', ')}
                  <span className="text-muted">
                    {' '}
                    —{' '}
                    {preview.redactions
                      .slice(0, 8)
                      .map((r) => r.path)
                      .join(', ')}
                    {preview.redactions.length > 8 ? ' …' : ''}
                  </span>
                </span>
              ) : (
                <span className="text-muted">Nothing needed masking (secret values, tokens, keys and personal data are masked when present).</span>
              )}
            </div>
            {(preview.messages ?? []).map((m, i) => (
              <details key={i} open={m.role === 'user'} className="rounded-lg border border-line">
                <summary className="px-3 py-1.5 cursor-pointer text-xs text-muted select-none">
                  {m.role} · {Math.ceil(m.content.length / 4).toLocaleString()} tokens
                </summary>
                <CodeBlock className="mono text-xs p-3 max-h-80 overflow-auto whitespace-pre-wrap" text={m.content} />
              </details>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
