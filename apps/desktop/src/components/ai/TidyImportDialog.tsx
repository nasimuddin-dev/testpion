import { Eye, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AiTaskResult, Proposal, ProposalItem } from '@testpion/core';
import { asError, call } from '../../api';
import { useCollectionTree } from '../../lib/collections-store';
import { aiSetupAction } from '../../lib/ai-errors';
import { formatCost } from '../../lib/format';
import { toastError, useApp, type AssistantRequest, type TidyImportRequest } from '../../store';
import { Badge, Button, Field, Input, Modal, Segmented, Spinner, Toggle, useDebounced } from '../ui';
import { AiPreviewDialog, PRIVACY_OPTIONS, type AiPrivacy } from './AiPreviewDialog';
import { ProposalReview } from './ProposalReview';

/**
 * "Tidy this import with AI" (AI-10): after a Postman / curl / HAR / Insomnia / Bruno import, or on any collection. TestPion
 * finds the hosts, tokens, tracking and duplicate requests and the chains a saved example confirms itself; the model names
 * and groups. The result opens in the one ProposalReview as separate changes (each verified: the collection stays valid
 * and every request sends what it sent), accepted one by one, with Undo. Without a model: the setup action and the
 * changes TestPion finds without AI.
 */
export function TidyImportDialog({ request, onClose }: { request: TidyImportRequest; onClose(): void }) {
  const cols = useCollectionTree();
  const col = cols.find((c) => c.id === request.collectionId);
  const [flow, setFlow] = useState(false);
  const [hint, setHint] = useState('');
  const [privacy, setPrivacy] = useState<AiPrivacy>(useApp.getState().settings?.ai?.privacy ?? 'full');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const [estimate, setEstimate] = useState<{ text: string; ok: boolean }>();
  const params = (extra: { hint?: string; privacy?: AiPrivacy } = {}) => ({
    task: 'tidy-import',
    item: { kind: 'collection', collectionId: request.collectionId },
    context: { options: { flow, ...(request.source ? { source: request.source } : {}) } },
    hint: extra.hint ?? (hint.trim() || undefined),
    privacy: extra.privacy ?? privacy,
  });
  const key = useDebounced(JSON.stringify(params()), 400);
  useEffect(() => {
    if (proposal) return setEstimate(undefined);
    let live = true;
    call<AiTaskResult>('ai.preview', JSON.parse(key) as Record<string, unknown>).then(
      ({ preview: p }) =>
        live &&
        setEstimate({ ok: true, text: `${p.providerName} · ${p.model}${p.local ? ' (on this computer)' : ''} · ≈ ${p.estimate.inputTokens.toLocaleString()} tokens in${p.estimate.priceKnown ? ` · up to ${formatCost(p.estimate.maxCostUsd ?? 0)}` : ''}` }),
      (e) => live && setEstimate({ ok: false, text: asError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [key, proposal]);

  const runId = useRef<string>(undefined);
  const generate = async (extra: { hint?: string; privacy?: AiPrivacy; noAi?: boolean } = {}) => {
    if (busy) return;
    const id = `ti-${Date.now().toString(36)}`;
    runId.current = id;
    setBusy(id);
    setError(undefined);
    try {
      const r = extra.noAi
        ? await call<{ proposal: Proposal }>('ai.tidyImport', { collectionId: request.collectionId, source: request.source, noAi: true })
        : await call<AiTaskResult>('ai.runTask', { ...params(extra), requestId: id });
      if (runId.current !== id) return;
      if (!r.proposal) throw new Error(`Nothing to tidy${'problems' in r && r.problems.length ? `: ${r.problems.join('; ')}` : ''}.`);
      setProposal(r.proposal);
    } catch (e) {
      if (runId.current !== id) return;
      const err = asError(e);
      if (!(err.kind === 'CancelledError' || /abort|cancel/i.test(err.message))) setError(err);
    } finally {
      if (runId.current === id) setBusy(undefined);
    }
  };
  const stop = () => {
    if (busy) void call('ai.cancel', { id: busy }).catch(() => undefined);
    runId.current = undefined;
    setBusy(undefined);
  };
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    try {
      const r = await call<{ applied: unknown[]; skipped: Array<{ reason: string }> }>('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id) });
      await useApp.getState().refreshWorkspace();
      useApp.getState().toast(`Applied ${r.applied.length} change${r.applied.length === 1 ? '' : 's'} to ${col?.name ?? 'the collection'}${r.skipped.length ? ` (${r.skipped.length} skipped: ${r.skipped[0]!.reason})` : ''}`, r.skipped.length ? 'info' : 'success', undefined, {
        undo: () => call('ai.undoProposal', { id: proposal.id }).then(() => useApp.getState().refreshWorkspace()),
      });
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  if (proposal)
    return (
      <ProposalReview
        proposal={proposal}
        acceptLabel="Apply selected changes"
        onAccept={accept}
        onRegenerate={(h) => {
          void call('ai.discardProposal', { id: proposal.id }).catch(() => undefined);
          setProposal(undefined);
          setHint(h);
          void generate({ hint: h });
        }}
        onDiscard={() => void call('ai.discardProposal', { id: proposal.id }).then(() => (useApp.getState().toast('Proposal discarded', 'info'), onClose()), toastError)}
        onClose={onClose}
      />
    );

  const setup = error ? aiSetupAction(error) : undefined;
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={16} /> Tidy this import with AI
        </span>
      }
      onClose={() => (stop(), onClose())}
      width={640}
      footer={
        <>
          <Button variant="ghost" icon={<Eye size={13} />} className="mr-auto" disabled={!!busy} onClick={() => setPreviewing({ task: 'tidy-import', title: 'Tidy this import', context: params().context, item: params().item as AssistantRequest['item'], privacy })} data-ai-preview-open>
            What will be sent…
          </Button>
          <Button onClick={() => (stop(), onClose())}>Cancel</Button>
          {busy ? (
            <Button icon={<Square size={12} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Sparkles size={13} />} onClick={() => void generate()} data-tidy-generate>
              Tidy
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-tidy-import-dialog>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge>{col?.name ?? request.collectionId}</Badge>
          {request.source && <span className="text-xs text-muted">imported from {request.source}</span>}
        </div>
        <Field label="Hint (optional)">
          <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. group by resource, keep the login first" aria-label="Hint for the tidy" />
        </Field>
        <Toggle checked={flow} onChange={setFlow} label="Also write a flow that wires the requests" />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted">Sent</span>
          <Segmented label="Privacy level" value={privacy} onChange={(v) => setPrivacy(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
        </div>
        <div className="text-xs text-muted min-h-5" data-tidy-estimate>
          {estimate ? <span className={estimate.ok ? '' : 'text-warn'}>{estimate.text}</span> : <Spinner size={11} />}
        </div>
        <p className="text-xs text-muted">
          TestPion finds the hosts and tokens typed into requests, tracking, static and duplicate requests, and the ids an earlier saved response returns; the model names the requests, groups them in folders and picks the chains. Request URLs, names and a short
          saved response are sent, never header values or tokens. Every change is checked: the collection stays valid and every request sends exactly what it sent. Nothing changes before you accept, and Undo puts it back.
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <Spinner /> Tidying and checking the changes…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 grid gap-2" role="alert" data-tidy-error>
            <span>{error.message}</span>
            <div className="flex gap-2 flex-wrap">
              {setup && (
                <Button size="sm" variant="primary" onClick={() => (onClose(), setup.onClick())} data-ai-setup>
                  {setup.label}
                </Button>
              )}
              <Button size="sm" onClick={() => void generate({ noAi: true })} data-tidy-draft>
                Use what TestPion finds without AI
              </Button>
            </div>
          </div>
        )}
      </div>
      {previewing && (
        <AiPreviewDialog
          request={previewing}
          onClose={() => setPreviewing(undefined)}
          onSend={(p) => {
            setPreviewing(undefined);
            setPrivacy(p);
            void generate({ privacy: p });
          }}
        />
      )}
    </Modal>
  );
}
