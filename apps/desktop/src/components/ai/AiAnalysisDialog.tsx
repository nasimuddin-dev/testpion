import { plural } from '../../lib/format';
import { FlaskConical, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FlakyReport, Proposal, ProposalAttempt, ProposalFinding, ProposalItem, TriageResult } from '@testpion/core';
import { asError, call } from '../../api';
import { runAgain } from '../../lib/run-again';
import { toastError, useApp, type AiAnalysisRequest, type AssistantRequest } from '../../store';
import { Badge, Button, Modal, Spinner } from '../ui';
import { AiEstimateLine, estimateOf, type EstimateState } from './AiEstimateLine';
import { AiPreviewDialog, type AiPrivacy } from './AiPreviewDialog';
import { AiBusyLine, AiErrorPanel, AiHintField, AiPrimaryButton, AiPrivacyRow, AiRunFooter, AiTitle, initialPrivacy, proposalReviewProps, useAiRun } from './ai-run';
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
  const [privacy, setPrivacy] = useState<AiPrivacy>(initialPrivacy());
  const [hint, setHint] = useState('');
  const { busy, setBusy, error, run, stop } = useAiRun('an');
  const [draft, setDraft] = useState<Report>();
  const [estimate, setEstimate] = useState<EstimateState>();
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
          setEstimate(estimateOf(p));
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

  const analyse = (extra: { privacy?: AiPrivacy; hint?: string } = {}) =>
    run((id) => call<Report>(method, { ...params(), ...(extra.privacy ? { privacy: extra.privacy } : {}), ...(extra.hint ? { hint: extra.hint } : {}), requestId: id }), setResult);

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
          `Applied ${plural(r.applied.length, 'fix', 'fixes')}${r.skipped.length ? ` (${r.skipped.length} skipped: ${r.skipped[0]!.reason})` : ''}`,
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
            Applied {plural(applied.count, 'fix', 'fixes')}. Run the tests they fix again to see them pass
            {applied.resultIds.length ? ` (${plural(applied.resultIds.length, 'result')})` : ''}.
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
        {...proposalReviewProps(result.proposal, {
          onClose,
          reset: () => setResult(undefined),
          regenerate: (h) => {
            setHint(h);
            void analyse({ hint: h });
          },
        })}
        acceptLabel={triage ? 'Apply selected fixes' : attempt ? 'Keep the fix' : 'Accept selected'}
        onAccept={(items) => accept(result.proposal!, items)}
        banner={attempt ? <Verdict a={attempt} /> : undefined}
        actions={
          triage
            ? undefined
            : (chosen, working) => (
                <Button
                  icon={<FlaskConical size={13} />}
                  loading={!!busy}
                  disabled={working || (!chosen.length && !attempt)} reason={working ? 'Still working' : 'Tick at least one fix'}
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

  const shown = result ?? draft;
  const groups = draft && 'groups' in draft ? draft : undefined;
  const cancel = () => (stop(), onClose());
  return (
    <Modal
      title={<AiTitle>{title}</AiTitle>}
      onClose={cancel}
      width={720}
      footer={
        <AiRunFooter
          busy={!!busy}
          onPreview={() =>
            setPreviewing({
              task: triage ? 'triage-run' : 'analyze-flaky',
              title,
              context: {},
              item: triage ? { kind: 'run', runId: request.runId } : { kind: 'test-case', testId: request.testId },
              privacy,
            })
          }
          onCancel={cancel}
          onStop={stop}
        >
          <AiPrimaryButton onClick={() => void analyse()} data-ai-analyse="">
            {triage ? 'Explain and fix' : 'Analyse'}
          </AiPrimaryButton>
        </AiRunFooter>
      }
    >
      <div className="grid gap-3 text-sm" data-ai-analysis={request.kind}>
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted" data-ai-analysis-subject>
          {groups ? (
            <>
              <Badge tone="bad">{groups.failures === 1 ? '1 failure' : `${groups.failures.toLocaleString()} failures`}</Badge>
              <span>
                in {plural(groups.groups.length, 'group')} (same check, status and endpoint)
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
        <AiHintField value={hint} onChange={setHint} placeholder={triage ? 'e.g. the token was rotated yesterday' : 'e.g. it fails mostly at night'} label="Hint for the analysis" />
        <AiPrivacyRow value={privacy} onChange={setPrivacy} />
        <AiEstimateLine estimate={estimate} data-ai-analysis-estimate="" />
        <p className="text-xs text-muted">
          {triage
            ? 'TestPion groups the failures first; the model sees each group’s examples (the request, the response, the failed check, what changed since the last passing run), never all of them. Secrets, tokens and personal data are masked; Metadata only sends no body values and no failure messages. Every fix is checked against the failing and the last passing response before you see it; nothing changes before you accept it.'
            : 'The model sees the test’s results across runs and a failing and a passing response (masked). Its fix is checked before you see it; skipping or quarantining the test is never offered. Attempt to fix applies it and runs the test 5 times.'}
        </p>
        {busy && <AiBusyLine>{triage ? 'Explaining the failures and checking the fixes…' : 'Analysing the history and checking the fix…'}</AiBusyLine>}
        {error && <AiErrorPanel error={error} onClose={onClose} data-ai-analysis-error="" />}
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
