import { Eye, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AiTaskResult, Proposal, ProposalItem } from '@testpion/core';
import { asError, call } from '../../api';
import { aiSetupAction } from '../../lib/ai-errors';
import { toastError, useApp } from '../../store';
import { Busy, Button, Callout, Field, Input, Segmented } from '../ui';
import { estimateOf, type EstimateState } from './AiEstimateLine';
import { PRIVACY_OPTIONS, type AiPrivacy } from './AiPreviewDialog';

/**
 * The scaffolding every "ask the model, review the proposal" dialog shares (Tidy import, Generate flow, Check traffic,
 * Explain failures, RAG testset): the run with Stop, the estimate before anything is sent, the footer, the hint and
 * privacy rows, the error panel with the setup action, and the review's Regenerate / Discard / Accept handlers.
 */

/** The privacy level a dialog starts at: the one set in Settings. */
export const initialPrivacy = (): AiPrivacy => useApp.getState().settings?.ai?.privacy ?? 'full';

/** A cancelled run is not an error. */
const isCancel = (err: ReturnType<typeof asError>) => err.kind === 'CancelledError' || /abort|cancel/i.test(err.message);

/**
 * One cancellable run: `run(work, done)` starts it (ignored while one is running), `stop()` cancels it on the backend and
 * forgets it, so a late answer is dropped. A failure that is not a cancel becomes `error`.
 */
export function useAiRun(prefix: string) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  const current = useRef<string>(undefined);
  const run = async <T,>(work: (id: string) => Promise<T>, done: (r: T) => void) => {
    if (busy) return;
    const id = `${prefix}-${Date.now().toString(36)}`;
    current.current = id;
    setBusy(id);
    setError(undefined);
    try {
      const r = await work(id);
      if (current.current !== id) return;
      done(r);
    } catch (e) {
      if (current.current !== id) return;
      const err = asError(e);
      if (!isCancel(err)) setError(err);
    } finally {
      if (current.current === id) setBusy(undefined);
    }
  };
  const stop = () => {
    if (busy) void call('ai.cancel', { id: busy }).catch(() => undefined);
    current.current = undefined;
    setBusy(undefined);
  };
  return { busy, setBusy, error, run, stop, current };
}

/** The estimate of a dry run (nothing is sent): `load` undefined clears it; `reset` clears it while the next one loads. */
export function useAiEstimate(load: (() => Promise<AiTaskResult>) | undefined, deps: unknown[], reset = false) {
  const [estimate, setEstimate] = useState<EstimateState>();
  useEffect(() => {
    if (reset || !load) setEstimate(undefined);
    if (!load) return;
    let live = true;
    load().then(
      ({ preview: p }) => live && setEstimate(estimateOf(p!)),
      (e) => live && setEstimate({ ok: false, text: asError(e).message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return estimate;
}

/** The footer: "What will be sent…" at the left, Cancel, then Stop while it runs or the dialog's own primary action. */
export function AiRunFooter({ busy, previewDisabled, onPreview, onCancel, onStop, children }: { busy: boolean; previewDisabled?: boolean; onPreview(): void; onCancel(): void; onStop(): void; children: ReactNode }) {
  return (
    <>
      <Button variant="ghost" icon={<Eye size={13} />} className="mr-auto" disabled={busy || previewDisabled} reason={busy ? 'Still running' : 'Nothing to send yet'} onClick={onPreview} data-ai-preview-open>
        What will be sent…
      </Button>
      <Button onClick={onCancel}>Cancel</Button>
      {busy ? (
        <Button icon={<Square size={12} />} onClick={onStop}>
          Stop
        </Button>
      ) : (
        children
      )}
    </>
  );
}

/** A dialog's primary AI action button (the sparkles icon). */
export function AiPrimaryButton({ onClick, disabled, reason, children, ...rest }: { onClick(): void; disabled?: boolean; /** Why it is disabled (its tooltip then). */ reason?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <Button variant="primary" icon={<Sparkles size={13} />} disabled={disabled} reason={reason} onClick={onClick} {...rest}>
      {children}
    </Button>
  );
}

export const AiTitle = ({ children }: { children: ReactNode }) => (
  <span className="flex items-center gap-2">
    <Sparkles size={16} /> {children}
  </span>
);

/** "Hint (optional)". */
export function AiHintField({ value, onChange, placeholder, label }: { value: string; onChange(v: string): void; placeholder: string; label: string }) {
  return (
    <Field label="Hint (optional)">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />
    </Field>
  );
}

/** "Sent: Full / Masked / Metadata only". */
export function AiPrivacyRow({ value, onChange }: { value: AiPrivacy; onChange(v: AiPrivacy): void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-muted">Sent</span>
      <Segmented label="Privacy level" value={value} onChange={(v) => onChange(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
    </div>
  );
}

/** The AI dialogs' wait line: the shared `Busy`, inline. */
export const AiBusyLine = ({ children }: { children: ReactNode }) => <Busy inline>{children}</Busy>;

/** The run's error with the setup action (no model set) and the dialog's own fallbacks (children). */
export function AiErrorPanel({ error, onClose, children, ...rest }: { error: ReturnType<typeof asError>; onClose(): void; children?: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const setup = aiSetupAction(error);
  return (
    <Callout tone="bad" block role="alert" {...rest}>
      <span>{error.message}</span>
      {(setup || children) && (
        <div className="flex gap-2 flex-wrap">
          {setup && (
            <Button size="sm" variant="primary" onClick={() => (onClose(), setup.onClick())} data-ai-setup>
              {setup.label}
            </Button>
          )}
          {children}
        </div>
      )}
    </Callout>
  );
}

/** Discard a proposal (the usage ledger counts the outcome), say so, and carry on. */
export const discardProposal = (id: string, after: () => void) => void call('ai.discardProposal', { id }).then(() => (useApp.getState().toast('Proposal discarded', 'info'), after()), toastError);

/** Regenerate (the old proposal is discarded, so the usage ledger counts the outcome), Discard and Close of a ProposalReview. */
export function proposalReviewProps(proposal: Proposal, o: { onClose(): void; reset(): void; regenerate(hint: string): void }) {
  return {
    proposal,
    onRegenerate: (h: string) => {
      void call('ai.discardProposal', { id: proposal.id }).catch(() => undefined);
      o.reset();
      o.regenerate(h);
    },
    onDiscard: () => discardProposal(proposal.id, o.onClose),
    onClose: o.onClose,
  };
}

/** Accept the ticked items through the workspace's writers: one toast saying what happened, with Undo. Resolves to the result, or undefined after an error toast. */
export async function applyProposalItems<R extends { applied: unknown[]; skipped: Array<{ reason: string }> }>(proposal: Proposal, items: ProposalItem[], message: (r: R) => string): Promise<R | undefined> {
  try {
    const r = await call<R>('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id) });
    await useApp.getState().refreshWorkspace();
    useApp.getState().toast(message(r), r.skipped.length ? 'info' : 'success', undefined, {
      undo: () => call('ai.undoProposal', { id: proposal.id }).then(() => useApp.getState().refreshWorkspace()),
    });
    return r;
  } catch (e) {
    toastError(e);
    return undefined;
  }
}

/** "; 2 skipped: reason" / " (2 skipped: reason)". */
export const skippedNote = (r: { skipped: Array<{ reason: string }> }, parens = false) => (r.skipped.length ? (parens ? ` (${r.skipped.length} skipped: ${r.skipped[0]!.reason})` : `; ${r.skipped.length} skipped: ${r.skipped[0]!.reason}`) : '');

