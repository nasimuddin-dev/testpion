import { Check, Code2, FlaskConical, GitCompare, RefreshCw, Trash2, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Proposal, StepDiff } from '@testpion/core';
import { unifiedDiff, type FlowStep } from '@testpion/shared';
import { asError, call } from '../../api';
import { runTestFileNow } from '../../lib/save-test';
import { confirmAction, toastError, useApp } from '../../store';
import { CodeEditor } from '../CodeEditor';
import { FlowDiagram } from '../FlowDiagram';
import { DiffText } from '../GitCommitPanel';
import { Badge, Button, Input, Modal, Segmented, Spinner } from '../ui';
import { VerificationBadgeView } from './ProposalReview';
import { discardProposal } from './ai-run';

type Tab = 'canvas' | 'yaml' | 'changes' | 'draft';

const STATUS_WORD = { same: 'same', changed: 'changed', added: 'added by the model', removed: 'only in the draft' } as const;
const STATUS_TONE = { same: 'default', changed: 'warn', added: 'accent', removed: 'bad' } as const;

/**
 * What the model changed against TestPion's own deterministic draft, step by step (B-12): a step it added (an error case),
 * one it dropped, and for each step in both the fields that differ — its place, what it waits for, the request, the body,
 * what it extracts and its checks. The engine makes the diff (`data.vsDraft`); this only shows it.
 */
function VersusDraft({ steps }: { steps: StepDiff[] }) {
  return (
    <ul className="p-2 grid gap-1.5 text-xs" aria-label="Against the draft" data-flow-vs-draft>
      {steps.map((s) => (
        <li key={s.id} className="rounded-lg border border-line px-2.5 py-1.5 grid gap-1 min-w-0" data-vs-step={s.status}>
          <div className="flex items-center gap-2 min-w-0">
            <Badge tone={STATUS_TONE[s.status]}>{STATUS_WORD[s.status]}</Badge>
            <span className="font-medium truncate" title={s.id}>
              {s.name}
            </span>
          </div>
          {s.changes.map((c, i) => (
            <div key={i} className="pl-1 text-muted break-words" data-vs-field={c.field}>
              <span className="text-fg">{c.field}</span>
              {c.before !== undefined || c.after !== undefined ? (
                <>
                  {' '}
                  <span className="line-through">{c.before || '(none)'}</span> → <span>{c.after || '(none)'}</span>
                </>
              ) : null}
              {c.added?.map((a) => (
                <div key={`+${a}`} className="mono text-ok pl-3">
                  + {a}
                </div>
              ))}
              {c.removed?.map((a) => (
                <div key={`-${a}`} className="mono text-bad pl-3">
                  − {a}
                </div>
              ))}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * The review of a proposed flow (AI-1, the one ProposalReview pattern for a flow file): the flow on a canvas preview
 * marked AI-generated, what the model assumed, what TestPion changed in its answer (a step naming a request that does
 * not exist, dropped), the verification badges, and the YAML (editable: an edit is checked again) and the changes
 * against the file it replaces. Try on mock runs it against a mock of the collection; Regenerate asks again with a
 * hint; Accept writes it (or hands it to the open designer: one undo step) and offers Run now and Open. Nothing is
 * saved or run before Accept.
 */
export function FlowProposalReview({
  proposal: initial,
  environment,
  onAccept,
  onRegenerate,
  onClose,
}: {
  proposal: Proposal;
  environment?: string;
  /** The open flow designer applies it itself (one undo step). */
  onAccept?(text: string): Promise<boolean>;
  onRegenerate?(hint: string): void;
  onClose(): void;
}) {
  const [proposal, setProposal] = useState(initial);
  const item = proposal.items.find((i) => i.kind === 'flow' || i.kind === 'file') ?? proposal.items[0]!;
  const [tab, setTab] = useState<Tab>('canvas');
  const [text, setText] = useState(item.after);
  const [steps, setSteps] = useState<FlowStep[]>();
  const [canvasError, setCanvasError] = useState<string>();
  const [busy, setBusy] = useState<'mock' | 'check' | 'accept' | undefined>();
  const [hint, setHint] = useState('');
  const edited = text !== item.after;
  const ai = proposal.taskVersion > 0;
  const failing = item.verification.some((b) => b.status === 'fail');
  const path = item.path ?? 'flows/generated.yaml';
  // what the model changed against TestPion's own draft (AI flows only)
  const vsDraft = (item.data as { vsDraft?: StepDiff[] } | undefined)?.vsDraft;
  const draftChanges = vsDraft?.filter((s) => s.status !== 'same').length ?? 0;

  // the canvas: the proposed text read as a flow, without writing it
  useEffect(() => {
    let live = true;
    call<{ steps: FlowStep[] }>('tests.flow', { file: path, text: item.after, environment }).then(
      (f) => live && (setSteps(f.steps), setCanvasError(undefined)),
      (e) => live && setCanvasError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, [path, item.after, environment]);
  const diff = useMemo(() => (tab === 'changes' ? unifiedDiff(item.before ?? null, text, `tests/${path}`) : ''), [tab, item.before, text, path]);

  /** Check again: an edit (`after`), or a run on the mock alone. */
  const reverify = async (o: { after?: string; verifiers?: string[] }, what: 'mock' | 'check') => {
    setBusy(what);
    try {
      const p = await call<Proposal>('ai.reverifyProposal', { id: proposal.id, item: item.id, environment, ...o });
      setProposal(p);
      const next = p.items.find((i) => i.id === item.id)!;
      setText(next.after);
      if (what === 'mock') {
        const b = next.verification.find((x) => x.verifier === 'flow-mock');
        useApp.getState().toast(b ? `Mock: ${b.label}` : 'Not tried on a mock', b?.status === 'pass' ? 'success' : 'info');
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };

  const accept = async () => {
    if (edited) return useApp.getState().toast('Check the edit first (Check again), then accept', 'info');
    if (
      failing &&
      !(await confirmAction({ title: 'Accept a flow that failed verification?', message: 'Its problems are listed in the review. You can fix them after saving.', confirmLabel: 'Accept anyway' }))
    )
      return;
    setBusy('accept');
    try {
      const toast = useApp.getState().toast;
      if (onAccept) {
        if (!(await onAccept(item.after))) return;
        void call('ai.applyProposal', { id: proposal.id, items: [item.id], recordOnly: true }).catch(() => undefined);
        toast(`${ai ? 'AI-generated' : 'Generated'} flow saved to tests/${path}: check each step, then Run flow`, 'success');
      } else {
        await call('ai.applyProposal', { id: proposal.id, items: [item.id] });
        toast(`Saved tests/${path}`, 'success', [{ label: 'Run now', onClick: () => void runTestFileNow(path) }, { ref: { kind: 'flow', path } }], {
          undo: () => call('ai.undoProposal', { id: proposal.id }),
          restored: `Removed tests/${path}`,
        });
      }
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const discard = () => discardProposal(proposal.id, onClose);

  return (
    <Modal
      title={
        <span className="flex items-center gap-2 min-w-0">
          <Workflow size={16} /> <span className="truncate">Review · {proposal.title}</span>
        </span>
      }
      onClose={onClose}
      width={1120}
      footer={
        <>
          <Button variant="ghost" icon={<Trash2 size={13} />} onClick={discard} className="mr-auto" data-proposal-discard>
            Discard
          </Button>
          <Button icon={<FlaskConical size={13} />} loading={busy === 'mock'} disabled={!!busy || edited} onClick={() => void reverify({ verifiers: ['flow-mock'] }, 'mock')} data-proposal-try-mock>
            Try on mock
          </Button>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Check size={13} />} loading={busy === 'accept'} disabled={!!busy} onClick={() => void accept()} data-proposal-accept>
            Accept
          </Button>
        </>
      }
    >
      <div
        className="grid gap-3 text-sm"
        data-proposal={proposal.id}
        data-flow-proposal
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void accept();
          }
        }}
      >
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted">
          <span data-flow-proposal-label>
            <Badge tone="judge">{ai ? 'AI-generated' : 'Made without AI'}</Badge>
          </span>
          <span>
            {proposal.provider} · {proposal.model}
            {ai ? ` · task ${proposal.task} v${proposal.taskVersion}` : ''} · tests/{path}
            {item.before !== undefined ? ' (replaces the file)' : ' (a new file)'}
          </span>
          <span className="ml-auto flex gap-1 flex-wrap justify-end" data-flow-proposal-badges>
            {item.verification.map((b, k) => (
              <VerificationBadgeView key={k} b={b} />
            ))}
          </span>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px' }}>
          <div className="grid gap-2 min-w-0">
            <Segmented
              label="Show"
              value={tab}
              onChange={(v) => setTab(v as Tab)}
              options={[
                { value: 'canvas', label: 'Canvas', title: 'The steps and how values flow between them' },
                { value: 'yaml', label: 'YAML', title: 'The file as it will be written: edit it here' },
                ...(vsDraft?.length ? [{ value: 'draft' as const, label: draftChanges ? `Vs draft (${draftChanges})` : 'Vs draft', title: 'What the model changed, step by step, against the flow TestPion builds without it' }] : []),
                ...(item.before !== undefined ? [{ value: 'changes' as const, label: 'Changes', title: 'Against the file it replaces' }] : []),
              ]}
            />
            <div className="h-[440px] rounded-lg border border-line overflow-hidden relative" data-flow-proposal-view={tab}>
              {tab === 'canvas' ? (
                steps ? (
                  <FlowDiagram steps={steps} className="h-full" fitKey={proposal.id + item.after.length} />
                ) : canvasError ? (
                  <p className="p-3 text-warn text-xs">The canvas cannot show it: {canvasError}</p>
                ) : (
                  <div className="p-3 flex items-center gap-2 text-muted">
                    <Spinner /> Drawing the flow…
                  </div>
                )
              ) : tab === 'yaml' ? (
                <CodeEditor value={text} onChange={(v) => setText(v ?? '')} language="yaml" path={`proposal://${proposal.id}/${path}`} />
              ) : tab === 'draft' && vsDraft ? (
                <div className="h-full overflow-auto">
                  <VersusDraft steps={vsDraft} />
                </div>
              ) : (
                <div className="h-full overflow-auto">
                  <DiffText text={diff} />
                </div>
              )}
            </div>
            {edited && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-warn">Edited: check it again before accepting.</span>
                <Button size="sm" icon={<Code2 size={12} />} loading={busy === 'check'} onClick={() => void reverify({ after: text }, 'check')} data-proposal-check>
                  Check again
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setText(item.after)}>
                  Revert the edit
                </Button>
              </div>
            )}
          </div>
          <aside className="grid content-start gap-3 text-xs min-w-0" aria-label="About this proposal">
            {proposal.summary && (
              <p className="text-sm whitespace-pre-wrap" data-flow-proposal-summary>
                {proposal.summary}
              </p>
            )}
            {proposal.assumptions.length > 0 && (
              <div data-flow-proposal-assumptions>
                <div className="font-medium mb-1">Assumptions</div>
                <ul className="list-disc ml-4 grid gap-0.5 text-muted">
                  {proposal.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {!!proposal.notes?.length && (
              <div data-flow-proposal-notes>
                <div className="font-medium mb-1">What TestPion changed</div>
                <ul className="list-disc ml-4 grid gap-0.5 text-muted">
                  {proposal.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
            {(proposal.problems?.length || item.verification.some((b) => b.detail && b.status !== 'pass')) && (
              <div className="rounded-lg border border-warn/40 bg-warn/5 p-2 grid gap-1 whitespace-pre-wrap" role="note">
                {proposal.problems?.length ? <span>Still wrong after the repairs: {proposal.problems.slice(0, 3).join('; ')}</span> : null}
                {item.verification
                  .filter((b) => b.detail && b.status !== 'pass')
                  .map((b) => (
                    <span key={b.verifier} className="text-muted">
                      {b.verifier}: {b.detail}
                    </span>
                  ))}
              </div>
            )}
            {item.before !== undefined && tab !== 'changes' && (
              <button className="inline-flex items-center gap-1 text-muted hover:text-fg" onClick={() => setTab('changes')}>
                <GitCompare size={12} /> See the changes against the current file
              </button>
            )}
            {onRegenerate && (
              <div className="grid gap-1.5">
                <div className="font-medium">Regenerate with a hint</div>
                <Input
                  placeholder="e.g. also test pagination"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && hint.trim() && onRegenerate(hint.trim())}
                  aria-label="Hint for regenerating"
                />
                <Button size="sm" icon={<RefreshCw size={12} />} disabled={!hint.trim()} onClick={() => onRegenerate(hint.trim())} data-proposal-regenerate>
                  Regenerate
                </Button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </Modal>
  );
}
