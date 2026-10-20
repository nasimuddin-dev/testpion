import { Eye, FlaskConical, RotateCcw, Sparkles, Square, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FlakyReport, Proposal, ProposalAttempt, ProposalFinding, ProposalItem, TriageResult } from '@testpion/core';
import { asError, call } from '../../api';
import { aiSetupAction } from '../../lib/ai-errors';
import { formatCost } from '../../lib/format';
import { runAgain } from '../../lib/run-again';
import { toastError, useApp, type AiAnalysisRequest, type AssistantRequest } from '../../store';
import { Badge, Button, Field, Input, Modal, Segmented, Spinner } from '../ui';
import { AiPreviewDialog, PRIVACY_OPTIONS, type AiPrivacy } from './AiPreviewDialog';
import { Findings } from './Findings';
import { ProposalReview } from './ProposalReview';

type Report = (TriageResult | FlakyReport) & { preview?: { providerName: string; model: string; local: boolean; estimate: { inputTokens: number; priceKnown: boolean; maxCostUsd?: number } } };

const isTriage = (r: Exclude<AiAnalysisRequest, { kind: 'drift' }>): r is Extract<AiAnalysisRequest, { kind: 'triage' }> => r.kind === 'triage';
const findingsOf = (r: Report): ProposalFinding[] => ('findings' in r ? r.findings : [r.finding]);

/** "passed 5/5": an attempt's verdict in words. */
function Verdict({ a }: { a: ProposalAttempt }) {
  const tone = a.verdict === 'stable' ? 'ok' : a.verdict === 'flaky' ? 'warn' : 'bad';
  return (
    <div className="rounded-lg border border-line p-2 flex items-center gap-2 flex-wrap text-sm" role="status" data-attempt-verdict={a.verdict}>
      <Badge tone={tone}>{a.verdict === 'stable' ? 'Stable' : a.verdict === 'flaky' ? 'Still flaky' : 'Failing'}</Badge>
      <span>
        passed {a.passed}/{a.runs}
      </span>
      {a.failures?.[0] && <span className="text-xs text-muted truncate">{a.failures[0]}</span>}
    </div>
  );
}

/**
 * "Explain and fix failures with AI" (AI-2) and "Why is this flaky?" (AI-5): what is analysed (the run's failures in
 * groups, or the test's history) and the token and cost estimate before anything is sent, the privacy level, a hint,
 * "What will be sent". Analyse runs it (Stop cancels); the findings with their evidence and the verified fixes open in
 * the proposal review. Accept applies the ticked fixes (Undo), then **Rerun the affected tests**; for a flaky test,
 * **Attempt to fix** applies the fix and runs the test 5 times for a verdict. Without a model: TestPion's own findings
 * and the setup action.
 */
export function AiAnalysisDialog({ request, onClose }: { request: Exclude<AiAnalysisRequest, { kind: 'drift' }>; onClose(): void }) {
  const triage = isTriage(request);
  const [privacy, setPrivacy] = useState<AiPrivacy>(useApp.getState().settings?.ai?.privacy ?? 'full');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  const [draft, setDraft] = useState<Report>();
  const [estimate, setEstimate] = useState<{ text: string; ok: boolean }>();
  const [result, setResult] = useState<Report>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const [attempt, setAttempt] = useState<ProposalAttempt>();
  const [applied, setApplied] = useState<{ proposal: Proposal; resultIds: string[]; count: number }>();
  const method = triage ? 'ai.triageRun' : 'ai.analyzeFlaky';
  const params = (extra: Record<string, unknown> = {}) => ({
    ...(triage ? { runId: request.runId } : { item: { kind: 'test-case', testId: request.testId } }),
    privacy,
    ...(hint.trim() ? { hint: hint.trim() } : {}),
    ...extra,
  });

  // what is analysed and the estimate, before anything is sent (a dry run); without a model, TestPion's own findings
  useEffect(() => {
    let live = true;
    setEstimate(undefined);
    call<Report>(method, params({ dryRun: true })).then(
      (r) => {
        if (!live) return;
        setDraft(r);
        const p = r.preview;
        if (p)
          setEstimate({
            ok: true,
            text: `${p.providerName} · ${p.model}${p.local ? ' (on this computer)' : ''} · ≈ ${p.estimate.inputTokens.toLocaleString()} tokens in${p.estimate.priceKnown ? ` · up to ${formatCost(p.estimate.maxCostUsd ?? 0)}` : ''}`,
          });
      },
      (e) => {
        if (!live) return;
        setEstimate({ ok: false, text: asError(e).message });
        void call<Report>(method, params({ noAi: true })).then(
          (r) => live && setDraft(r),
          () => undefined,
        );
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privacy]);

  const runId = useRef<string>(undefined);
  const analyse = async (extra: { privacy?: AiPrivacy; hint?: string } = {}) => {
    if (busy) return;
    const id = `an-${Date.now().toString(36)}`;
    runId.current = id;
    setBusy(id);
    setError(undefined);
    try {
      const r = await call<Report>(method, { ...params(), ...(extra.privacy ? { privacy: extra.privacy } : {}), ...(extra.hint ? { hint: extra.hint } : {}), requestId: id });
      if (runId.current !== id) return;
      setResult(r);
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

  /** Accept: the ticked fixes through the workspace's writers (one Undo), then the affected tests can run again. */
  const accept = async (proposal: Proposal, items: ProposalItem[]) => {
    if (attempt) {
      // the attempt applied them already: keeping the fix is all that is left
      useApp.getState().toast('Kept the fix', 'success');
      return onClose();
    }
    try {
      const r = await call<{ applied: Array<{ item: string }>; skipped: Array<{ reason: string }> }>('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id) });
      const findings = new Set(items.map((i) => i.finding).filter(Boolean));
      const resultIds = [...new Set((proposal.findings ?? []).filter((f) => findings.has(f.id)).flatMap((f) => f.resultIds ?? []))].slice(0, 2000);
      setApplied({ proposal, resultIds, count: r.applied.length });
      const undo = () => call('ai.undoProposal', { id: proposal.id });
      useApp
        .getState()
        .toast(
          `Applied ${r.applied.length} ${r.applied.length === 1 ? 'fix' : 'fixes'}${r.skipped.length ? ` (${r.skipped.length} skipped: ${r.skipped[0]!.reason})` : ''}`,
          r.skipped.length ? 'info' : 'success',
          undefined,
          { undo },
        );
    } catch (e) {
      toastError(e);
    }
  };
  const attemptFix = async (proposal: Proposal, items: ProposalItem[]) => {
    const id = `af-${Date.now().toString(36)}`;
    setBusy(id);
    try {
      const r = await call<{ attempt: ProposalAttempt }>('ai.attemptFix', { id: proposal.id, items: items.map((i) => i.id), times: 5, requestId: id });
      setAttempt(r.attempt);
      useApp
        .getState()
        .toast(
          `${r.attempt.verdict === 'stable' ? 'Stable' : r.attempt.verdict === 'flaky' ? 'Still flaky' : 'Failing'}: passed ${r.attempt.passed}/${r.attempt.runs}`,
          r.attempt.verdict === 'stable' ? 'success' : 'info',
          undefined,
          {
            undo: () => call('ai.undoProposal', { id: proposal.id }).then(() => setAttempt(undefined)),
          },
        );
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };

  const title = triage ? 'Explain and fix failures with AI' : 'Why is this flaky?';
  if (applied && triage)
    return (
      <Modal title={title} onClose={onClose} width={560} footer={<Button onClick={onClose}>Close</Button>}>
        <div className="grid gap-3 text-sm" data-triage-applied>
          <p>
            Applied {applied.count} {applied.count === 1 ? 'fix' : 'fixes'}. Run the tests they fix again to see them pass
            {applied.resultIds.length ? ` (${applied.resultIds.length} ${applied.resultIds.length === 1 ? 'result' : 'results'})` : ''}.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" icon={<RotateCcw size={13} />} onClick={() => void runAgain(request.runId, applied.resultIds).then((id) => id && onClose())} data-triage-rerun>
              Rerun the affected tests
            </Button>
            <Button
              icon={<Undo2 size={13} />}
              onClick={() => void call('ai.undoProposal', { id: applied.proposal.id }).then(() => (useApp.getState().toast('Undone', 'success'), setApplied(undefined)), toastError)}
            >
              Undo
            </Button>
          </div>
        </div>
      </Modal>
    );
  if (result?.proposal)
    return (
      <ProposalReview
        proposal={result.proposal}
        acceptLabel={triage ? 'Apply selected fixes' : attempt ? 'Keep the fix' : 'Accept selected'}
        onAccept={(items) => accept(result.proposal!, items)}
        onRegenerate={(h) => {
          void call('ai.discardProposal', { id: result.proposal!.id }).catch(() => undefined);
          setResult(undefined);
          setHint(h);
          void analyse({ hint: h });
        }}
        onDiscard={() => void call('ai.discardProposal', { id: result.proposal!.id }).then(() => (useApp.getState().toast('Proposal discarded', 'info'), onClose()), toastError)}
        onClose={onClose}
        banner={attempt ? <Verdict a={attempt} /> : undefined}
        actions={
          triage
            ? undefined
            : (chosen, working) => (
                <Button
                  icon={<FlaskConical size={13} />}
                  loading={!!busy}
                  disabled={working || (!chosen.length && !attempt)}
                  onClick={() => void attemptFix(result.proposal!, chosen)}
                  title="Apply the fix and run the test 5 times"
                  data-attempt-fix
                >
                  {attempt ? 'Run 5 times again' : 'Attempt to fix'}
                </Button>
              )
        }
      />
    );

  const setup = error ? aiSetupAction(error) : undefined;
  const shown = result ?? draft;
  const groups = draft && 'groups' in draft ? draft : undefined;
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={16} /> {title}
        </span>
      }
      onClose={() => (stop(), onClose())}
      width={720}
      footer={
        <>
          <Button
            variant="ghost"
            icon={<Eye size={13} />}
            className="mr-auto"
            disabled={!!busy}
            onClick={() =>
              setPreviewing({
                task: triage ? 'triage-run' : 'analyze-flaky',
                title,
                context: {},
                item: triage ? { kind: 'run', runId: request.runId } : { kind: 'test-case', testId: request.testId },
                privacy,
              })
            }
            data-ai-preview-open
          >
            What will be sent…
          </Button>
          <Button onClick={() => (stop(), onClose())}>Cancel</Button>
          {busy ? (
            <Button icon={<Square size={12} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Sparkles size={13} />} onClick={() => void analyse()} data-ai-analyse>
              {triage ? 'Explain and fix' : 'Analyse'}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-ai-analysis={request.kind}>
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted" data-ai-analysis-subject>
          {groups ? (
            <>
              <Badge tone="bad">{groups.failures === 1 ? '1 failure' : `${groups.failures.toLocaleString()} failures`}</Badge>
              <span>
                in {groups.groups.length} {groups.groups.length === 1 ? 'group' : 'groups'} (same check, status and endpoint)
                {groups.omitted.groups ? ` · ${groups.omitted.groups} more groups not sent` : ''} · run “{groups.run.name}”
              </span>
            </>
          ) : draft && 'signals' in draft ? (
            <>
              <Badge tone="warn">
                passed {draft.signals.passed}/{draft.signals.runs}
              </Badge>
              <span>
                “{draft.name}” changed result {draft.signals.flips} times
              </span>
            </>
          ) : (
            <Spinner size={11} />
          )}
        </div>
        <Field label="Hint (optional)">
          <Input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder={triage ? 'e.g. the token was rotated yesterday' : 'e.g. it fails mostly at night'}
            aria-label="Hint for the analysis"
          />
        </Field>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted">Sent</span>
          <Segmented label="Privacy level" value={privacy} onChange={(v) => setPrivacy(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
        </div>
        <div className="text-xs text-muted min-h-5" data-ai-analysis-estimate>
          {estimate ? <span className={estimate.ok ? '' : 'text-warn'}>{estimate.text}</span> : <Spinner size={11} />}
        </div>
        <p className="text-xs text-muted">
          {triage
            ? 'TestPion groups the failures first; the model sees each group’s examples (the request, the response, the failed check, what changed since the last passing run), never all of them. Secrets, tokens and personal data are masked; Metadata only sends no body values and no failure messages. Every fix is checked against the failing and the last passing response before you see it; nothing changes before you accept it.'
            : 'The model sees the test’s results across runs and a failing and a passing response (masked). Its fix is checked before you see it; skipping or quarantining the test is never offered. Attempt to fix applies it and runs the test 5 times.'}
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <Spinner /> {triage ? 'Explaining the failures and checking the fixes…' : 'Analysing the history and checking the fix…'}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 grid gap-2" role="alert" data-ai-analysis-error>
            <span>{error.message}</span>
            {setup && (
              <div>
                <Button size="sm" variant="primary" onClick={() => (onClose(), setup.onClick())} data-ai-setup>
                  {setup.label}
                </Button>
              </div>
            )}
          </div>
        )}
        {shown && (result || !estimate?.ok) && (
          <div className="grid gap-2" data-ai-analysis-findings>
            {shown.fallback && <p className="text-xs text-warn">{shown.fallback}</p>}
            <Findings findings={findingsOf(shown)} title={title} />
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
            void analyse({ privacy: p });
          }}
        />
      )}
    </Modal>
  );
}
