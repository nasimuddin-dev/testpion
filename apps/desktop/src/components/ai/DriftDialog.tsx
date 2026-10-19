import { Eye, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AiTaskResult, DriftReport, DriftSource, Proposal, ProposalFinding, ProposalItem } from '@testpion/core';
import { asError, call } from '../../api';
import { aiSetupAction } from '../../lib/ai-errors';
import { formatCost } from '../../lib/format';
import { toastError, useApp, type AiAnalysisRequest, type AssistantRequest } from '../../store';
import { Badge, Button, Callout, Field, Input, Modal, Segmented, Select, Spinner, useDebounced } from '../ui';
import { AiPreviewDialog, PRIVACY_OPTIONS, type AiPrivacy } from './AiPreviewDialog';
import { Findings } from './Findings';
import { ProposalReview } from './ProposalReview';

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
  const [privacy, setPrivacy] = useState<AiPrivacy>(useApp.getState().settings?.ai?.privacy ?? 'full');
  const [hint, setHint] = useState('');
  const [report, setReport] = useState<Report>();
  const [reportError, setReportError] = useState<string>();
  const [estimate, setEstimate] = useState<{ text: string; ok: boolean }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const runIdRef = useRef<string>(undefined);

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
  useEffect(() => {
    setEstimate(undefined);
    if (!report?.findings.length) return;
    let live = true;
    call<AiTaskResult>('ai.driftExplain', params({ dryRun: true })).then(
      ({ preview: p }) =>
        live &&
        setEstimate({
          ok: true,
          text: `${p.providerName} · ${p.model}${p.local ? ' (on this computer)' : ''} · ≈ ${p.estimate.inputTokens.toLocaleString()} tokens in${p.estimate.priceKnown ? ` · up to ${formatCost(p.estimate.maxCostUsd ?? 0)}` : ''}`,
        }),
      (e) => live && setEstimate({ ok: false, text: asError(e).message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, privacy]);

  const analyse = async (extra: { noAi?: boolean; hint?: string; privacy?: AiPrivacy } = {}) => {
    if (busy || !report) return;
    const id = `dr-${Date.now().toString(36)}`;
    runIdRef.current = id;
    setBusy(id);
    setError(undefined);
    try {
      const r = await call<{ proposal?: Proposal; problems?: string[] }>('ai.driftExplain', params({ ...extra, requestId: id }));
      if (runIdRef.current !== id) return;
      if (!r.proposal) throw new Error(`The model proposed nothing usable${r.problems?.length ? `: ${r.problems.join('; ')}` : ''}. Try again with a hint.`);
      setProposal(r.proposal);
    } catch (e) {
      if (runIdRef.current !== id) return;
      const err = asError(e);
      if (!(err.kind === 'CancelledError' || /abort|cancel/i.test(err.message))) setError(err);
    } finally {
      if (runIdRef.current === id) setBusy(undefined);
    }
  };
  const stop = () => {
    if (busy) void call('ai.cancel', { id: busy }).catch(() => undefined);
    runIdRef.current = undefined;
    setBusy(undefined);
  };

  /** Accept: the ticked patches and checks through the workspace's writers (one Undo). */
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    try {
      const r = await call<{ applied: unknown[]; skipped: Array<{ reason: string }> }>('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id) });
      await useApp.getState().refreshWorkspace();
      useApp
        .getState()
        .toast(`Applied ${r.applied.length} ${r.applied.length === 1 ? 'change' : 'changes'}${r.skipped.length ? `; ${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : ''}`, r.skipped.length ? 'info' : 'success', undefined, {
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
          void analyse({ hint: h });
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
          <Sparkles size={16} /> Check traffic against a spec with AI
        </span>
      }
      onClose={() => (stop(), onClose())}
      width={760}
      footer={
        <>
          <Button
            variant="ghost"
            icon={<Eye size={13} />}
            className="mr-auto"
            disabled={!!busy || !report?.findings.length}
            onClick={() => setPreviewing({ task: 'contract-drift', title: 'Contract drift explained', context: { options: { source } }, item: { kind: 'spec', path: spec }, privacy })}
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
            <Button variant="primary" icon={<Sparkles size={13} />} disabled={!report?.findings.length} onClick={() => void analyse()} data-ai-analyse>
              Explain and fix
            </Button>
          )}
        </>
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
        <Field label="Hint (optional)">
          <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. the nickname field is new in v2" aria-label="Hint for the analysis" />
        </Field>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted">Sent</span>
          <Segmented label="Privacy level" value={privacy} onChange={(v) => setPrivacy(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
        </div>
        <div className="text-xs text-muted min-h-5" data-ai-analysis-estimate>
          {report?.findings.length ? estimate ? <span className={estimate.ok ? '' : 'text-warn'}>{estimate.text}</span> : <Spinner size={11} /> : null}
        </div>
        <p className="text-xs text-muted">
          The comparison above is TestPion’s own: nothing is sent for it. The model sees the findings (kind, operation, place, what the document says, what was seen, how often) and the schemas involved — not the traffic; example values only at the Full
          level, masked. Every patch is made by TestPion from what was observed and checked against the same traffic: the drift must be gone and no other may appear. Nothing changes before you accept it.
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <Spinner /> Explaining the drift and checking the fixes…
          </div>
        )}
        {error && (
          <Callout tone="bad" block role="alert" data-ai-analysis-error>
            <span>{error.message}</span>
            <div className="flex gap-2 flex-wrap">
              {setup && (
                <Button size="sm" variant="primary" onClick={() => (onClose(), setup.onClick())} data-ai-setup>
                  {setup.label}
                </Button>
              )}
              <Button size="sm" onClick={() => void analyse({ noAi: true })} data-drift-draft>
                Use the patches TestPion makes without AI
              </Button>
            </div>
          </Callout>
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
