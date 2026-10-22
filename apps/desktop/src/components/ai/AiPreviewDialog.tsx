import { Eye, Laptop, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AiTaskResult } from '@testpion/core';
import { asError, call } from '../../api';
import type { AssistantRequest } from '../../store';
import { useApp } from '../../store';
import { aiSetupAction } from '../../lib/ai-errors';
import { AiEstimateLine, estimateText } from './AiEstimateLine';
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
export function AiPreviewDialog({
  request,
  onSend,
  onClose,
  load,
}: {
  request: AssistantRequest | { title: string };
  /** Absent: the dialog only shows (a judge call is shown before a run, sent by the run). */
  onSend?(privacy: AiPrivacy): void;
  onClose(): void;
  /** The preview of a call that is not an AI task of the assistant (a judged RAG metric); the privacy level is then the AI settings'. */
  load?: () => Promise<AiTaskResult['preview']>;
}) {
  const env = useApp((s) => s.environment);
  const [privacy, setPrivacy] = useState<AiPrivacy>(('privacy' in request && request.privacy) || useApp.getState().settings?.ai?.privacy || 'full');
  const [preview, setPreview] = useState<AiTaskResult['preview']>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setError(undefined);
    (load ? load() : call<AiTaskResult>('ai.preview', taskParams(request as AssistantRequest, env, privacy)).then((r) => r.preview)).then(
      (r) => live && setPreview(r),
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
      onSubmit={() => onSend?.(privacy)}
      width={820}
      footer={
        <>
          <Button onClick={onClose}>{onSend ? 'Cancel' : 'Close'}</Button>
          {onSend && (
            <Button variant="primary" disabled={!preview} reason="Still preparing the preview" onClick={() => onSend(privacy)} data-ai-send>
              Send
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-ai-preview>
        {!load && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-muted">Privacy</span>
            <Segmented label="Privacy level" value={privacy} onChange={(v) => setPrivacy(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
          </div>
        )}
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
              <AiEstimateLine className="ml-auto tabular-nums" estimate={{ ok: true, text: estimateText(preview, { noModel: true, out: true }) }} data-ai-estimate="" />
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
            {preview.images && preview.images.length > 0 && (
              <div className="rounded-lg border border-warn/50 bg-warn/5 p-2 grid gap-1.5" data-ai-images>
                <div className="text-xs">
                  <b>
                    {preview.images.length} picture{preview.images.length === 1 ? '' : 's'} ({Math.max(1, Math.round(preview.images.reduce((a, i) => a + i.bytes, 0) / 1024)).toLocaleString()} KB)
                  </b>{' '}
                  will be sent to {preview.providerName} as data{preview.local ? ' (it stays on this computer)' : ''}. A picture cannot be masked: what it shows is what the model sees.
                </div>
                <div className="flex gap-2 flex-wrap">
                  {preview.images.map((im) => (
                    <figure key={im.sha256} className="m-0 w-24 text-[10px] text-muted" title={`${im.mime} · ${im.bytes.toLocaleString()} bytes · sha256 ${im.sha256}`}>
                      {im.thumb ? <img src={im.thumb} alt="" className="w-24 h-20 object-contain rounded border border-line bg-surface" /> : <div className="w-24 h-20 grid place-items-center rounded border border-line">no preview</div>}
                      <figcaption className="mono truncate">{im.sha256.slice(0, 10)}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
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
