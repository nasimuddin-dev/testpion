import { useEffect, useState } from 'react';
import type { AiTaskResult, DriftReport, DriftSource, Proposal, ProposalFinding, ProposalItem } from '@testpion/core';
import { asError, call } from '../../api';
import { plural } from '../../lib/format';
import { AiEstimateLine } from './AiEstimateLine';
import { useApp, type AiAnalysisRequest, type AssistantRequest } from '../../store';
import { Badge, Button, Callout, Field, Input, Modal, Segmented, Select, Spinner, useDebounced } from '../ui';
import { AiPreviewDialog, type AiPrivacy } from './AiPreviewDialog';
import { Findings } from './Findings';
import { ProposalReview } from './ProposalReview';
import { AiBusyLine, AiErrorPanel, AiHintField, AiPrimaryButton, AiPrivacyRow, AiRunFooter, AiTitle, applyProposalItems, initialPrivacy, proposalReviewProps, skippedNote, useAiEstimate, useAiRun } from './ai-run';

type Report = DriftReport & { spec: string; patchable: number };
type Kind = 'history' | 'har' | 'run';

/** The report's findings in the shape the shared Findings list shows. */
const listed = (r: Report): ProposalFinding[] =>
  r.findings.map((f) => ({
    id: f.id,
    title: `${f.title}: ${f.operation}${f.status ? ` ${f.status}` : ''}${f.pointer ? ` ${f.pointer}` : ''}`,
    kind: 'drift',
    explanation: f.expected ? `The document says ${f.expected}.` : undefined,
    evidence: [{ text: `Seen ${f.observed.join(', ')} in ${f.count} of ${f.of} ${f.of === 1 ? 'response' : 'responses'}.` }],
    count: f.count,
  }));

/**
 * "Check traffic against this spec" (AI-9): an API definition compared with real traffic (History, a HAR file or a run).
 * What differs is found without a model and listed at once; **Explain and fix** has the configured model say who is right
 * and what to do per finding, and opens the proposal in the review: spec patches made from what was observed and contract
 * checks, each verified against the same traffic. Nothing changes before Accept; Undo puts the file back. The estimate and
 * "What will be sent" come before anything is sent; without a model the patches TestPion makes itself are offered.
 */
export function DriftDialog({ request, onClose }: { request: Extract<AiAnalysisRequest, { kind: 'drift' }>; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const [specs, setSpecs] = useState<string[]>([]);
  const [spec, setSpec] = useState(request.spec ?? '');
  const [kind, setKind] = useState<Kind>('history');
  const [limit, setLimit] = useState('300');
  const [host, setHost] = useState('');
  const [har, setHar] = useState('');
  const [runId, setRunId] = useState('last');
  const [privacy, setPrivacy] = useState<AiPrivacy>(initialPrivacy());
  const [hint, setHint] = useState('');
  const [report, setReport] = useState<Report>();
  const [reportError, setReportError] = useState<string>();
  const { busy, error, run, stop } = useAiRun('dr');
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();

  useEffect(() => {
    void call<string[]>('openapi.specs', {}).then((l) => {
      setSpecs(l);
      setSpec((s) => s || l[0] || '');
    }, () => undefined);
  }, []);

  const source: DriftSource =
    kind === 'har' ? { kind: 'har', path: har.trim() } : kind === 'run' ? { kind: 'run', runId: runId.trim() || 'last' } : { kind: 'history', limit: Math.max(1, Number(limit) || 300), ...(host.trim() ? { host: host.trim() } : {}) };
  const ready = !!spec && (kind !== 'har' || !!har.trim());
  const key = useDebounced(JSON.stringify(ready ? { spec, source } : null), 350);

  // what differs: found at once, without a model, nothing is sent
  useEffect(() => {
    const k = JSON.parse(key) as { spec: string; source: DriftSource } | null;
    setReport(undefined);
    setReportError(undefined);
    if (!k) return;
    let live = true;
    call<Report>('ai.driftReport', k).then(
      (r) => live && setReport(r),
      (e) => live && setReportError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, [key]);

  const params = (extra: Record<string, unknown> = {}) => ({ spec, source, privacy, ...(hint.trim() ? { hint: hint.trim() } : {}), environment: env, ...extra });
  // the estimate before anything is sent (a dry run)
  const estimate = useAiEstimate(report?.findings.length ? () => call<AiTaskResult>('ai.driftExplain', params({ dryRun: true })) : undefined, [report, privacy], true);

  const analyse = (extra: { noAi?: boolean; hint?: string; privacy?: AiPrivacy } = {}) =>
    report &&
    run(
      (id) => call<{ proposal?: Proposal; problems?: string[] }>('ai.driftExplain', params({ ...extra, requestId: id })),
      (r) => {
        if (!r.proposal) throw new Error(`The model proposed nothing usable${r.problems?.length ? `: ${r.problems.join('; ')}` : ''}. Try again with a hint.`);
        setProposal(r.proposal);
      },
    );

  /** Accept: the ticked patches and checks through the workspace's writers (one Undo). */
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    const r = await applyProposalItems<{ applied: unknown[]; skipped: Array<{ reason: string }> }>(proposal, items, (r) => `Applied ${plural(r.applied.length, 'change')}${skippedNote(r)}`);
    if (r) onClose();
  };

  if (proposal)
    return (
      <ProposalReview
        {...proposalReviewProps(proposal, {
          onClose,
          reset: () => setProposal(undefined),
          regenerate: (h) => {
            setHint(h);
            void analyse({ hint: h });
          },
        })}
        acceptLabel="Apply selected changes"
        onAccept={accept}
      />
    );

  const cancel = () => (stop(), onClose());
  return (
    <Modal
      title={<AiTitle>Check traffic against a spec with AI</AiTitle>}
      onClose={cancel}
      width={760}
      footer={
        <AiRunFooter
          busy={!!busy}
          previewDisabled={!report?.findings.length}
          onPreview={() => setPreviewing({ task: 'contract-drift', title: 'Contract drift explained', context: { options: { source } }, item: { kind: 'spec', path: spec }, privacy })}
          onCancel={cancel}
          onStop={stop}
        >
          <AiPrimaryButton disabled={!report?.findings.length} onClick={() => void analyse()} data-ai-analyse="">
            Explain and fix
          </AiPrimaryButton>
        </AiRunFooter>
      }
    >
      <div className="grid gap-3 text-sm" data-ai-analysis="drift">
        <div className="grid grid-cols-2 gap-3">
          <Field label="API definition">
            <Select aria-label="API definition" value={spec} onChange={(e) => setSpec(e.target.value)}>
              {!specs.length && <option value="">No API definitions in this workspace</option>}
              {specs.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Traffic">
            <Segmented
              label="Where the traffic comes from"
              value={kind}
              onChange={(v) => setKind(v as Kind)}
              options={[
                { value: 'history', label: 'History', title: 'The newest responses of History' },
                { value: 'har', label: 'HAR file', title: 'A saved Debugger session or a browser export' },
                { value: 'run', label: 'A run', title: 'The responses the HTTP results of a run stored' },
              ]}
            />
          </Field>
        </div>
        {kind === 'history' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="How many responses">
              <Input type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="How many responses" />
            </Field>
            <Field label="Only this host (optional)">
              <Input className="mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1:4010" aria-label="Only this host" />
            </Field>
          </div>
        )}
        {kind === 'har' && (
          <Field label="HAR file (a path in the workspace)">
            <Input className="mono" value={har} onChange={(e) => setHar(e.target.value)} placeholder="captures/session.har" aria-label="HAR file" />
          </Field>
        )}
        {kind === 'run' && (
          <Field label="Run (an id, or last)">
            <Input className="mono" value={runId} onChange={(e) => setRunId(e.target.value)} aria-label="Run id" />
          </Field>
        )}
        <div className="grid gap-2" data-drift-report>
          {!report && !reportError && ready && (
            <div className="flex items-center gap-2 text-muted">
              <Spinner size={12} /> Comparing…
            </div>
          )}
          {reportError && <Callout tone="warn">{reportError}</Callout>}
          {report && (
            <>
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted">
                <Badge tone={report.findings.length ? 'warn' : 'ok'}>{report.findings.length ? `${report.findings.length} kinds of drift` : 'no drift'}</Badge>
                <span>
                  in {report.exchanges} responses · {report.matched} match an operation of the document
                  {report.patchable ? ` · ${report.patchable} can be patched from what was observed` : ''}
                </span>
              </div>
              {report.findings.length > 0 && <Findings findings={listed(report).slice(0, 12)} />}
            </>
          )}
        </div>
        <AiHintField value={hint} onChange={setHint} placeholder="e.g. the nickname field is new in v2" label="Hint for the analysis" />
        <AiPrivacyRow value={privacy} onChange={setPrivacy} />
        <AiEstimateLine estimate={report?.findings.length ? estimate : undefined} waiting={!!report?.findings.length} data-ai-analysis-estimate="" />
        <p className="text-xs text-muted">
          The comparison above is TestPion’s own: nothing is sent for it. The model sees the findings (kind, operation, place, what the document says, what was seen, how often) and the schemas involved — not the traffic; example values only at the Full
          level, masked. Every patch is made by TestPion from what was observed and checked against the same traffic: the drift must be gone and no other may appear. Nothing changes before you accept it.
        </p>
        {busy && <AiBusyLine>Explaining the drift and checking the fixes…</AiBusyLine>}
        {error && (
          <AiErrorPanel error={error} onClose={onClose} data-ai-analysis-error="">
            <Button size="sm" onClick={() => void analyse({ noAi: true })} data-drift-draft>
              Use the patches TestPion makes without AI
            </Button>
          </AiErrorPanel>
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
