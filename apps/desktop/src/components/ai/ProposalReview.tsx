import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Copy, FlaskConical, Play, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import { useMemo, useState, type ReactNode } from 'react';
import { call } from '../../api';
import { toastError, useApp, type AiResponse } from '../../store';
import type { Proposal, ProposalItem, VerificationBadge } from '@testpion/core';
import { unifiedDiff } from '@testpion/shared';
import { DiffText } from '../GitCommitPanel';
import { Badge, Button, cx, Input, Modal } from '../ui';
import { Findings } from './Findings';

const KIND_LABEL: Record<ProposalItem['kind'], string> = { file: 'test file', flow: 'flow', assertion: 'check', script: 'script', request: 'request', patch: 'request change', variable: 'variable', text: 'text' };

/** One verification badge: the verifier's verdict in words, its detail on hover. */
export function VerificationBadgeView({ b }: { b: VerificationBadge }) {
  const icon = b.status === 'pass' ? <CheckCircle2 size={11} /> : b.status === 'fail' ? <XCircle size={11} /> : b.status === 'warn' ? <AlertTriangle size={11} /> : <CircleDashed size={11} />;
  return (
    <span data-verification={b.status} data-verifier={b.verifier} className="inline-flex min-w-0 max-w-full">
      {/* a long verdict stays on its row (cut, whole on hover) instead of widening the review */}
      <Badge tone={b.status === 'pass' ? 'ok' : b.status === 'fail' ? 'bad' : b.status === 'warn' ? 'warn' : 'default'} title={`${b.label}${b.detail ? `\n${b.verifier}: ${b.detail}` : ''}`} className="max-w-full min-w-0 overflow-hidden">
        {icon} <span className="truncate">{b.label}</span>
      </Badge>
    </span>
  );
}

/**
 * The one review of an AI proposal (AIB-4), for every AI feature: what the model proposes, item by item, each with
 * its diff and the badges of the verifiers that checked it; ticked items are applied with Accept (one undo step),
 * failing ones start unticked. A check that pins a changing value offers its safer forms (switching checks it again);
 * Run now sends the request again and checks every item against the new response (and the one before it); Try on
 * mock runs a proposed flow against a mock of its collection. Regenerate asks again with a hint; Discard drops it.
 * An analysis (triage, flaky analysis) shows its findings with their evidence first; its host adds its own actions
 * (Attempt to fix) and a banner (the stability verdict).
 * Keyboard: Tab through the items, Space ticks one, Enter on a title shows its diff, Ctrl/Cmd+Enter accepts, Esc closes.
 */
export function ProposalReview({
  proposal: initial,
  onAccept,
  onRegenerate,
  onDiscard,
  onClose,
  acceptLabel = 'Accept selected',
  response,
  onRunNow,
  actions,
  banner,
}: {
  proposal: Proposal;
  onAccept(items: ProposalItem[]): void | Promise<void>;
  onRegenerate?(hint: string): void;
  onDiscard?(): void;
  onClose(): void;
  acceptLabel?: string;
  /** The response the items were verified against (it becomes the previous one after Run now). */
  response?: AiResponse;
  /** Send the request again (its editor's own send): the items are checked against the new response. */
  onRunNow?(): Promise<AiResponse | undefined>;
  /** The host's own footer actions (Attempt to fix), given the ticked items. */
  actions?(chosen: ProposalItem[], busy: boolean): ReactNode;
  /** Shown above the findings (a stability verdict, a note). */
  banner?: ReactNode;
}) {
  const [proposal, setProposal] = useState(initial);
  const [lastResponse, setLastResponse] = useState(response);
  const [working, setWorking] = useState<'run' | 'mock' | string>();
  /** Check items again (an edit, a safer form, a new response, the mock) and show the new badges. */
  const reverify = async (params: Record<string, unknown>, what: string) => {
    setWorking(what);
    try {
      const p = await call<Proposal>('ai.reverifyProposal', { id: proposal.id, environment: useApp.getState().environment, ...params });
      setProposal(p);
      // the person's ticks stay; an item a verifier now fails is unticked
      setPicked((cur) => new Set([...cur].filter((id) => p.items.find((i) => i.id === id)?.selected !== false)));
      return p;
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      setWorking(undefined);
    }
  };
  const runNow = async () => {
    if (!onRunNow) return;
    setWorking('run');
    let fresh: AiResponse | undefined;
    try {
      fresh = await onRunNow();
    } catch (e) {
      setWorking(undefined);
      return toastError(e);
    }
    if (!fresh) return setWorking(undefined);
    const p = await reverify({ response: fresh, previous: lastResponse }, 'run');
    setLastResponse(fresh);
    if (p) {
      const failed = p.items.filter((i) => i.verification.some((b) => b.status === 'fail')).length;
      useApp.getState().toast(`Sent again (status ${fresh.status ?? '?'}): ${failed ? `${failed} ${failed === 1 ? 'item fails' : 'items fail'} now` : 'every item holds'}`, failed ? 'info' : 'success');
    }
  };
  const hasFlow = proposal.items.some((i) => i.kind === 'flow' || i.kind === 'file');
  const applicable = proposal.items.filter((i) => i.kind !== 'text');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(applicable.filter((i) => i.selected).map((i) => i.id)));
  const [open, setOpen] = useState<Set<string>>(() => new Set(proposal.items.length <= 3 ? proposal.items.map((i) => i.id) : []));
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = applicable.filter((i) => picked.has(i.id));
  const failing = proposal.items.filter((i) => i.verification.some((b) => b.status === 'fail')).length;
  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };
  const accept = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      await onAccept(chosen);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Review · ${proposal.title}`}
      onClose={onClose}
      width={900}
      footer={
        <>
          {onDiscard && (
            <Button variant="ghost" icon={<Trash2 size={13} />} onClick={onDiscard} className="mr-auto">
              Discard
            </Button>
          )}
          {onRunNow && (
            <Button icon={<Play size={13} />} loading={working === 'run'} disabled={!!working} onClick={() => void runNow()} title="Send the request again and check every item against the new response" data-proposal-run-now>
              Run now
            </Button>
          )}
          {hasFlow && (
            <Button icon={<FlaskConical size={13} />} loading={working === 'mock'} disabled={!!working} onClick={() => void reverify({ verifiers: ['flow-mock'] }, 'mock')} data-proposal-try-mock>
              Try on mock
            </Button>
          )}
          {actions?.(chosen, busy || !!working)}
          <Button onClick={onClose}>Close</Button>
          {applicable.length > 0 && (
            <Button variant="primary" loading={busy} disabled={!chosen.length} onClick={() => void accept()} data-proposal-accept>
              {acceptLabel} ({chosen.length})
            </Button>
          )}
        </>
      }
    >
      <div
        className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm min-w-0"
        data-proposal={proposal.id}
        data-proposal-body
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void accept();
          }
        }}
      >
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted">
          <Badge tone="judge">AI-generated</Badge>
          <span>
            {proposal.provider} · {proposal.model} · task {proposal.task} v{proposal.taskVersion}
          </span>
          <span>
            · {proposal.items.length} item{proposal.items.length === 1 ? '' : 's'}
            {failing ? ` · ${failing} failed verification (unticked)` : ' · all verified'}
          </span>
          {applicable.length > 1 && (
            <span className="ml-auto flex gap-2">
              <button className="hover:text-fg underline-offset-2 hover:underline" onClick={() => setPicked(new Set(applicable.map((i) => i.id)))}>
                Select all
              </button>
              <button className="hover:text-fg underline-offset-2 hover:underline" onClick={() => setPicked(new Set())}>
                None
              </button>
            </span>
          )}
        </div>
        {banner}
        {proposal.summary && <p className="text-muted whitespace-pre-wrap break-words">{proposal.summary}</p>}
        {proposal.findings?.length ? <Findings findings={proposal.findings} fixes={Object.fromEntries(proposal.findings.map((f) => [f.id, proposal.items.filter((i) => i.finding === f.id && i.kind !== 'text').length]))} /> : null}
        {proposal.assumptions.length > 0 && (
          <ul className="list-disc ml-5 text-xs text-muted break-words">
            {proposal.assumptions.map((a) => (
              <li key={a}>Assumed: {a}</li>
            ))}
          </ul>
        )}
        {proposal.problems?.length ? (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-2 text-xs break-words" role="note">
            Still wrong after the repairs (shown, not hidden): {proposal.problems.slice(0, 4).join('; ')}
          </div>
        ) : null}
        {proposal.notes?.length ? (
          <ul className="list-disc ml-5 text-xs text-muted break-words" aria-label="Notes" data-proposal-notes>
            {proposal.notes.slice(0, 8).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label="Proposed changes">
          {proposal.items.map((i) => (
            <ItemRow
              key={i.id}
              item={i}
              picked={picked.has(i.id)}
              open={open.has(i.id)}
              onPick={() => setPicked((p) => toggle(p, i.id))}
              onOpen={() => setOpen((o) => toggle(o, i.id))}
              busy={working === i.id}
              onAlternative={(a) =>
                void reverify({ item: i.id, after: a.after, data: a.data, response: lastResponse }, i.id).then((p) => {
                  const now = p?.items.find((x) => x.id === i.id);
                  if (now?.selected) setPicked((cur) => new Set([...cur, i.id]));
                })
              }
            />
          ))}
        </ul>
        {onRegenerate && (
          <div className="flex gap-2 items-center">
            <Input
              className="flex-1"
              placeholder="Regenerate with a hint, e.g. include the refund path"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && hint.trim() && onRegenerate(hint.trim())}
              aria-label="Hint for regenerating"
            />
            <Button icon={<RefreshCw size={13} />} disabled={!hint.trim()} onClick={() => onRegenerate(hint.trim())}>
              Regenerate
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ItemRow({
  item,
  picked,
  open,
  onPick,
  onOpen,
  busy,
  onAlternative,
}: {
  item: ProposalItem;
  picked: boolean;
  open: boolean;
  onPick(): void;
  onOpen(): void;
  busy?: boolean;
  onAlternative?(a: NonNullable<ProposalItem['alternatives']>[number]): void;
}) {
  const diff = useMemo(() => (open ? unifiedDiff(item.before ?? null, item.after, item.path ?? KIND_LABEL[item.kind]) : ''), [open, item]);
  return (
    <li className={cx('rounded-lg border min-w-0', picked ? 'border-accent/50' : 'border-line')} data-proposal-item={item.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 min-w-0">
        {item.kind !== 'text' ? <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Apply ${item.title}`} /> : <span className="w-[13px]" />}
        <button className="flex items-center gap-1 min-w-0 flex-1 basis-48 text-left hover:text-fg" onClick={onOpen} aria-expanded={open} title={item.title}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Badge>{KIND_LABEL[item.kind]}</Badge>
          <span className="truncate mono text-xs">{item.title}</span>
        </button>
        <span className="flex gap-1 flex-wrap justify-end min-w-0 max-w-full ml-auto">
          {item.verification.map((b, k) => (
            <VerificationBadgeView key={k} b={b} />
          ))}
          {item.kind === 'text' && (
            <button className="text-xs text-muted hover:text-fg inline-flex items-center gap-1" onClick={() => void copyText(item.after, item.title)} title="Copy it (a bug report, what to do)" data-proposal-copy={item.id}>
              <Copy size={11} /> Copy
            </button>
          )}
        </span>
      </div>
      {!!item.alternatives?.length && item.verification.some((b) => b.status !== 'pass') && (
        <div className="flex items-center gap-1.5 flex-wrap px-2.5 pb-1.5 text-xs min-w-0" data-proposal-safer={item.id}>
          <ShieldCheck size={12} className="text-ok" />
          <span className="text-muted">Safer:</span>
          {item.alternatives.map((a) => (
            <button
              key={a.label}
              className="mono rounded border border-line px-1.5 py-0.5 hover:bg-hover hover:text-fg disabled:opacity-50 max-w-full truncate"
              disabled={busy}
              onClick={() => onAlternative?.(a)}
              title={`${a.label}
Use this check instead (it is checked again)`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="border-t border-line max-h-80 overflow-auto min-w-0">
          <DiffText text={diff} />
          {item.verification.some((b) => b.detail) && (
            <div className="px-3 pb-2 text-xs text-muted whitespace-pre-wrap break-words">
              {item.verification
                .filter((b) => b.detail)
                .map((b) => `${b.verifier}: ${b.detail}`)
                .join('\n')}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
