import { Eye, FileText, Sparkles, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Proposal, ProposalItem, RunEstimate, TestsetType } from '@testpion/core';
import { asError, call, on } from '../../api';
import { aiSetupAction } from '../../lib/ai-errors';
import { toastError, useApp, type AssistantRequest } from '../../store';
import { AiPreviewDialog } from '../ai/AiPreviewDialog';
import { ProposalReview } from '../ai/ProposalReview';
import { Badge, Button, Callout, Field, Input, Modal, Spinner, Textarea, cx, useDebounced } from '../ui';
import { EstimateLoading, RagEstimateView } from './RagEstimate';

interface Sources {
  files: Array<{ path: string; size: number }>;
  folders: Array<{ path: string; docs: number }>;
  types: Array<{ id: TestsetType; help: string }>;
}

const MAX = 60;

/**
 * Generate a RAG test set from documents (planning/rag-testing.md §4b): choose the documents (files and folders of the
 * workspace, public https pages), how many questions and of which kinds; the estimate (model and judge calls, tokens, cost
 * range, the caps it would break) and "What will be sent" come BEFORE anything is sent. Generate writes the questions and
 * verifies each one; the result opens in the one proposal review, where each question is a row with its checks, and Add to
 * dataset writes the ticked rows to datasets/<name>.jsonl (one Undo). Reached only from the AI Lab ▸ RAG ▸ Data action, which is
 * not offered while AI is hidden.
 */
export function RagTestsetDialog({ onClose, onDone }: { onClose(): void; onDone?(dataset: string): void }) {
  const env = useApp((s) => s.environment);
  const [src, setSrc] = useState<Sources>();
  const [picked, setPicked] = useState<string[]>([]);
  const [urls, setUrls] = useState('');
  const [count, setCount] = useState('10');
  const [types, setTypes] = useState<TestsetType[]>(['single-hop', 'multi-hop', 'abstract', 'unanswerable', 'adversarial']);
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [estimate, setEstimate] = useState<RunEstimate & { corpus?: { documents: number; passages: number; skipped: string[] } }>();
  const [estimateError, setEstimateError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const runRef = useRef<string>(undefined);

  useEffect(() => {
    void call<Sources>('rag.testset.sources').then(setSrc, () => setSrc({ files: [], folders: [], types: [] }));
  }, []);
  useEffect(() => on<{ id?: string; text: string }>('rag.testset.progress', (items) => [items].flat().forEach((p) => p.id === runRef.current && setProgress(p.text))), []);

  const urlList = useMemo(() => urls.split(/\s+/).filter(Boolean), [urls]);
  const n = Math.max(1, Math.min(MAX, Math.floor(Number(count) || 1)));
  const params = useMemo(() => ({ paths: picked, urls: urlList, count: n, types, ...(name.trim() ? { name: name.trim() } : {}), ...(seed.trim() ? { seed: seed.trim() } : {}) }), [picked, urlList, n, types, name, seed]);
  const ready = (picked.length > 0 || urlList.length > 0) && types.length > 0;
  const debounced = useDebounced(params, 500);
  useEffect(() => {
    if (!ready || busy || proposal) return setEstimate(undefined);
    let live = true;
    setEstimateError(undefined);
    call<{ estimate: NonNullable<typeof estimate> }>('rag.testset.estimate', { ...debounced, environment: env }).then(
      (r) => live && setEstimate(r.estimate),
      (e) => live && (setEstimate(undefined), setEstimateError(asError(e).message)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(debounced), ready]);

  const toggle = (path: string) => setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path]));
  const toggleType = (t: TestsetType) => setTypes((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  const generate = async () => {
    if (busy || !ready) return;
    const id = `ts-${Date.now().toString(36)}`;
    runRef.current = id;
    setBusy(id);
    setError(undefined);
    setProgress('Reading the documents …');
    try {
      const r = await call<{ proposal: Proposal }>('rag.testset.generate', { ...params, requestId: id, environment: env });
      if (runRef.current !== id) return;
      setProposal(r.proposal);
    } catch (e) {
      if (runRef.current !== id) return;
      const err = asError(e);
      if (!(err.kind === 'CancelledError' || /abort|cancel/i.test(err.message))) setError(err);
    } finally {
      if (runRef.current === id) setBusy(undefined);
    }
  };
  const stop = () => {
    if (busy) void call('ai.cancel', { id: busy }).catch(() => undefined);
    runRef.current = undefined;
    setBusy(undefined);
  };

  /** Add to dataset: the ticked rows are appended to the dataset file through the workspace's writers (one Undo). */
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    try {
      const r = await call<{ applied: unknown[]; skipped: Array<{ reason: string }> }>('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id) });
      await useApp.getState().refreshWorkspace();
      const dataset = (proposal.items[0]?.data as { dataset?: string } | undefined)?.dataset ?? 'the dataset';
      useApp.getState().toast(`Added ${r.applied.length} ${r.applied.length === 1 ? 'question' : 'questions'} to ${dataset}${r.skipped.length ? `; ${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : ''}`, r.skipped.length ? 'info' : 'success', undefined, {
        undo: () => call('ai.undoProposal', { id: proposal.id }).then(() => useApp.getState().refreshWorkspace()),
      });
      onDone?.(dataset);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  if (proposal)
    return (
      <ProposalReview
        proposal={proposal}
        acceptLabel="Add to dataset"
        onAccept={accept}
        onDiscard={() => void call('ai.discardProposal', { id: proposal.id }).then(() => (useApp.getState().toast('Proposal discarded', 'info'), onClose()), toastError)}
        onClose={onClose}
      />
    );

  const setup = error ? aiSetupAction(error) : undefined;
  const over = (estimate?.caps.exceeds.length ?? 0) > 0;
  return (
    <>
      <Modal
        title={
          <span className="flex items-center gap-2">
            <Sparkles size={16} /> Generate a test set from documents
          </span>
        }
        onClose={() => (stop(), onClose())}
        width={820}
        footer={
          <>
            <Button variant="ghost" icon={<Eye size={13} />} className="mr-auto" disabled={!ready || !!busy} onClick={() => setPreviewing({ task: 'rag-generate-testset', title: 'Generate a RAG test set', context: { ...params } })} data-ai-preview-open>
              What will be sent…
            </Button>
            <Button onClick={() => (stop(), onClose())}>Cancel</Button>
            {busy ? (
              <Button icon={<Square size={12} />} onClick={stop}>
                Stop
              </Button>
            ) : setup ? (
              <Button variant="primary" onClick={setup.onClick}>
                {setup.label}
              </Button>
            ) : (
              <Button variant="primary" icon={<Sparkles size={13} />} disabled={!ready || !!estimate?.judgeProblem} onClick={() => void generate()} data-rag-testset-generate>
                {over ? 'Generate anyway' : 'Generate'}
              </Button>
            )}
          </>
        }
      >
        <div className="grid gap-4 text-sm" data-rag-testset-dialog>
          <Field label="Documents of the workspace" hint="Markdown, text and HTML files. A PDF needs its text extracted first. Pick a folder to use everything in it.">
            <div className="border border-line rounded-lg max-h-44 overflow-auto" data-rag-testset-files>
              {!src && (
                <div className="p-3">
                  <Spinner />
                </div>
              )}
              {src && !src.files.length && <div className="p-3 text-muted">No documents in the workspace yet. Add markdown or text files to it, or give public https pages below.</div>}
              {src?.folders.map((f) => (
                <label key={`d-${f.path}`} className="flex items-center gap-2 px-2 py-1 border-b border-line/60 hover:bg-hover">
                  <input type="checkbox" checked={picked.includes(f.path)} onChange={() => toggle(f.path)} aria-label={`Folder ${f.path}`} />
                  <span className="font-medium">{f.path}/</span>
                  <Badge>{f.docs} documents</Badge>
                </label>
              ))}
              {src?.files.map((f) => (
                <label key={f.path} className={cx('flex items-center gap-2 px-2 py-1 border-b border-line/60 hover:bg-hover', picked.some((p) => f.path.startsWith(`${p}/`)) && 'opacity-50')}>
                  <input type="checkbox" checked={picked.includes(f.path)} onChange={() => toggle(f.path)} aria-label={f.path} />
                  <FileText size={12} className="text-muted" />
                  <span className="truncate">{f.path}</span>
                  <span className="ml-auto text-xs text-muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Public pages (https), one per line" hint="Read as documents: https only, public addresses only, 2 MB each, no redirects to another site.">
            <Textarea rows={2} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://example.com/docs/handbook" aria-label="Document URLs" data-rag-testset-urls />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Questions" hint={`1 to ${MAX}`}>
              <Input type="number" min={1} max={MAX} value={count} onChange={(e) => setCount(e.target.value)} aria-label="Number of questions" data-rag-testset-count />
            </Field>
            <Field label="Dataset" hint="datasets/<name>.jsonl">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="from the first document" aria-label="Dataset name" data-rag-testset-name />
            </Field>
            <Field label="Seed" hint="The same seed asks about the same passages">
              <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="testpion" aria-label="Seed" />
            </Field>
          </div>
          <Field label="Kinds of question">
            <div className="grid gap-1" data-rag-testset-types>
              {(src?.types ?? []).map((t) => (
                <label key={t.id} className="flex items-start gap-2">
                  <input type="checkbox" checked={types.includes(t.id)} onChange={() => toggleType(t.id)} aria-label={t.id} className="mt-0.5" />
                  <span>
                    <b>{t.id}</b> <span className="text-muted">{t.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {ready && !estimate && !estimateError && <EstimateLoading />}
          {estimateError && <Callout tone="bad">{estimateError}</Callout>}
          {estimate && (
            <div data-rag-testset-estimate>
              {estimate.corpus && (
                <p className="text-xs text-muted mb-2">
                  {estimate.corpus.documents} document{estimate.corpus.documents === 1 ? '' : 's'}, {estimate.corpus.passages} passages
                  {estimate.corpus.skipped.length ? `; skipped: ${estimate.corpus.skipped.join('; ')}` : ''}
                </p>
              )}
              <RagEstimateView estimate={estimate} />
            </div>
          )}
          {busy && (
            <div className="flex items-center gap-2 text-muted" data-rag-testset-progress>
              <Spinner /> {progress}
            </div>
          )}
          {error && <Callout tone="bad">{error.message}</Callout>}
        </div>
      </Modal>
      {previewing && <AiPreviewDialog request={previewing} onClose={() => setPreviewing(undefined)} />}
    </>
  );
}
