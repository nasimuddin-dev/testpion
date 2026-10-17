import { Eye, FileText, FolderTree, Sparkles, Square, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiTaskResult, Proposal } from '@testpion/core';
import { asError, call } from '../../api';
import { useCollectionTree } from '../../lib/collections-store';
import { aiSetupAction } from '../../lib/ai-errors';
import { formatCost } from '../../lib/format';
import { useApp, type AssistantRequest, type FlowGenerateRequest } from '../../store';
import type { CollectionNode } from '../../types';
import { Badge, Button, Field, Input, Modal, Segmented, Select, Spinner, Textarea, useDebounced } from '../ui';
import { AiPreviewDialog, PRIVACY_OPTIONS, type AiPrivacy } from './AiPreviewDialog';
import { FlowProposalReview } from './FlowProposalReview';

type Mode = 'collection' | 'describe';

/** How many requests a list of nodes holds, at every level. */
const countOf = (nodes: CollectionNode[]): number => nodes.reduce((k, x) => k + (x.kind === 'folder' ? countOf(x.items) : 1), 0);

/** The folders of a collection, depth-first, with how many requests each holds. */
function foldersOf(nodes: CollectionNode[], depth = 0, out: Array<{ id: string; name: string; depth: number; count: number }> = []) {
  for (const n of nodes)
    if (n.kind === 'folder') {
      out.push({ id: n.id, name: n.name, depth, count: countOf(n.items) });
      foldersOf(n.items, depth + 1, out);
    }
  return out;
}

/**
 * "Generate integration flow with AI" (AI-1): what the flow is made from — a collection or one of its folders (the
 * saved requests, by id; TestPion's draft improved), or a description in words — an optional hint, the privacy level,
 * the token and cost estimate before anything is sent, and "What will be sent". Generate runs the task (Stop cancels);
 * the verified flow opens in the review on a canvas preview, where it is accepted, edited, regenerated or discarded.
 * Without a model: the setup action, and the draft TestPion makes without AI.
 */
export function FlowGenerateDialog({ request, onClose }: { request: FlowGenerateRequest; onClose(): void }) {
  const cols = useCollectionTree().filter((c) => !c.problem);
  const env = useApp((s) => request.environment ?? s.environment);
  const [mode, setMode] = useState<Mode>(request.mode ?? (request.source || !request.path ? 'collection' : 'describe'));
  const [collectionId, setCollectionId] = useState(request.source?.collectionId);
  const [folderId, setFolderId] = useState(request.source?.folderId ?? '');
  const [description, setDescription] = useState('');
  const [hint, setHint] = useState('');
  const [privacy, setPrivacy] = useState<AiPrivacy>(useApp.getState().settings?.ai?.privacy ?? 'full');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const [estimate, setEstimate] = useState<{ text: string; ok: boolean }>();
  const col = cols.find((c) => c.id === collectionId) ?? cols[0];
  const folders = useMemo(() => (col ? foldersOf(col.items) : []), [col]);
  const folder = folders.find((f) => f.id === folderId);
  const total = useMemo(() => (col ? countOf(col.items) : 0), [col]);
  const requests = folder ? folder.count : total;

  /** The task call for the current choices (the generic runner: the CLI and MCP make the same one). */
  const params = (extra: { hint?: string; privacy?: AiPrivacy } = {}) =>
    mode === 'collection'
      ? {
          task: 'flow-from-collection',
          item: folder ? { kind: 'folder', collectionId: col!.id, folderId: folder.id } : { kind: 'collection', collectionId: col!.id },
          ...(request.path ? { path: request.path } : {}),
          hint: extra.hint ?? (hint.trim() || undefined),
          privacy: extra.privacy ?? privacy,
          environment: env,
        }
      : {
          task: 'design-flow',
          question: description.trim(),
          context: { ...(request.path ? { file: `tests/${request.path}` } : {}), environment: env, steps: request.steps ?? [] },
          ...(request.path ? { path: request.path } : {}),
          hint: extra.hint ?? (hint.trim() || undefined),
          privacy: extra.privacy ?? privacy,
          environment: env,
        };
  const ready = mode === 'collection' ? !!col && requests > 0 : description.trim().length > 3;
  const asRequest = (): AssistantRequest => {
    const p = params() as { task: string; item?: AssistantRequest['item']; question?: string; context?: unknown; path?: string };
    return { task: p.task, title: 'Generate an integration flow', context: p.context ?? {}, question: p.question, item: p.item, path: p.path, privacy };
  };

  // the estimate before anything is sent (a dry run: nothing leaves the computer)
  const key = useDebounced(JSON.stringify(ready ? params() : null), 400);
  useEffect(() => {
    if (!ready || proposal) return setEstimate(undefined);
    let live = true;
    call<AiTaskResult>('ai.preview', JSON.parse(key) as Record<string, unknown>).then(
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
  }, [key, proposal]);

  const runId = useRef<string>(undefined);
  const generate = async (extra: { hint?: string; privacy?: AiPrivacy; noAi?: boolean } = {}) => {
    if (!ready || busy) return;
    const id = `fg-${Date.now().toString(36)}`;
    runId.current = id;
    setBusy(id);
    setError(undefined);
    try {
      const r = extra.noAi
        ? await call<{ proposal: Proposal }>('ai.generateFlow', { collectionId: col!.id, folderId: folder?.id, path: request.path, environment: env, noAi: true })
        : await call<AiTaskResult>('ai.runTask', { ...params(extra), requestId: id });
      if (runId.current !== id) return;
      if (!r.proposal) throw new Error(`The model proposed no flow${'problems' in r && r.problems.length ? `: ${r.problems.join('; ')}` : ''}. Try again with a hint, or a smaller folder.`);
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

  if (proposal)
    return (
      <FlowProposalReview
        proposal={proposal}
        environment={env}
        onAccept={request.onAccept}
        onRegenerate={(h) => {
          // the one it replaces is discarded (the usage ledger counts the outcome)
          void call('ai.discardProposal', { id: proposal.id }).catch(() => undefined);
          setProposal(undefined);
          setHint(h);
          void generate({ hint: h });
        }}
        onClose={onClose}
      />
    );

  const setup = error ? aiSetupAction(error) : undefined;
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={16} /> Generate integration flow with AI
        </span>
      }
      onClose={() => (stop(), onClose())}
      width={680}
      footer={
        <>
          <Button variant="ghost" icon={<Eye size={13} />} className="mr-auto" disabled={!ready || !!busy} onClick={() => setPreviewing(asRequest())} data-ai-preview-open>
            What will be sent…
          </Button>
          <Button onClick={() => (stop(), onClose())}>Cancel</Button>
          {busy ? (
            <Button icon={<Square size={12} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Sparkles size={13} />} disabled={!ready} onClick={() => void generate()} data-flow-generate>
              Generate
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-flow-generate-dialog>
        <Segmented
          label="What the flow is made from"
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { value: 'collection', label: 'From a collection or folder', title: 'Its saved requests become the steps (by id); TestPion’s draft is improved' },
            { value: 'describe', label: 'Describe in words', title: 'One or two sentences; the assistant writes the steps' },
          ]}
        />
        {mode === 'collection' ? (
          !cols.length ? (
            <p className="text-muted">No collections in this workspace yet: import or create one, or describe the flow in words.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Collection">
                <Select
                  aria-label="Collection"
                  value={col?.id}
                  onChange={(e) => {
                    setCollectionId(e.target.value);
                    setFolderId('');
                  }}
                >
                  {cols.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Folder">
                <Select aria-label="Folder" value={folder?.id ?? ''} onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">The whole collection ({total})</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {`${'  '.repeat(f.depth)}${f.name} (${f.count})`}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )
        ) : (
          <Field label="What should the flow do?">
            <Textarea
              autoGrow
              maxRows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. log in, create an order with the token, read it back, cancel it"
              aria-label="Flow description"
            />
          </Field>
        )}
        <Field label="Hint (optional)">
          <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. also test pagination, include the refund path" aria-label="Hint for the flow" />
        </Field>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-muted">Sent</span>
          <Segmented label="Privacy level" value={privacy} onChange={(v) => setPrivacy(v as AiPrivacy)} options={PRIVACY_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted min-h-5" data-flow-estimate>
          {mode === 'collection' && col && (
            <Badge>
              {folder ? <FolderTree size={10} /> : <Workflow size={10} />} {requests} request{requests === 1 ? '' : 's'}
            </Badge>
          )}
          {mode === 'describe' && (
            <Badge>
              <FileText size={10} /> {request.path ? `tests/${request.path}` : 'a new flow file'}
            </Badge>
          )}
          {estimate ? <span className={estimate.ok ? '' : 'text-warn'}>{estimate.text}</span> : ready ? <Spinner size={11} /> : null}
        </div>
        <p className="text-xs text-muted">
          Variable names are sent, never their values; secrets, tokens and personal data are masked. The flow is linted, its variables checked and, when the collection has saved examples, tried on a
          mock — then you review it. Nothing is saved or run before you accept it.
        </p>
        {busy && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <Spinner /> Writing and checking the flow…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 grid gap-2" role="alert" data-flow-generate-error>
            <span>{error.message}</span>
            <div className="flex gap-2 flex-wrap">
              {setup && (
                <Button size="sm" variant="primary" onClick={() => (onClose(), setup.onClick())} data-ai-setup>
                  {setup.label}
                </Button>
              )}
              {mode === 'collection' && col && (
                <Button size="sm" onClick={() => void generate({ noAi: true })} data-flow-draft>
                  Use the draft without AI
                </Button>
              )}
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
