import { Eye, FileText, Sparkles, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Proposal, ProposalItem, RunEstimate, TestsetType } from '@testpion/core';
import { asError, call, on } from '../../api';
import { aiSetupAction } from '../../lib/ai-errors';
import { plural } from '../../lib/format';
import { applyProposalItems, discardProposal, skippedNote, useAiRun } from '../ai/ai-run';
import { useApp, type AssistantRequest } from '../../store';
import { AiPreviewDialog } from '../ai/AiPreviewDialog';
import { ProposalReview } from '../ai/ProposalReview';
import { Badge, Button, Callout, Field, Input, Modal, Select, Spinner, Textarea, cx, useDebounced } from '../ui';
import { EstimateLoading, RagEstimateView } from './RagEstimate';

interface Sources {
  files: Array<{ path: string; size: number }>;
  folders: Array<{ path: string; docs: number }>;
  types: Array<{ id: TestsetType; help: string }>;
  styles?: Array<{ id: string; help: string }>;
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
  const [personas, setPersonas] = useState('');
  const [styles, setStyles] = useState<string[]>([]);
  const [dedupe, setDedupe] = useState<'lexical' | 'embedding'>('lexical');
  const [embedder, setEmbedder] = useState('');
  const [estimate, setEstimate] = useState<RunEstimate & { corpus?: { documents: number; passages: number; skipped: string[] } }>();
  const [estimateError, setEstimateError] = useState<string>();
  const { busy, error, run, stop, current: runRef } = useAiRun('ts');
  const [progress, setProgress] = useState<string>();
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();

  useEffect(() => {
    void call<Sources>('rag.testset.sources').then(setSrc, () => setSrc({ files: [], folders: [], types: [] }));
  }, []);
  useEffect(() => on<{ id?: string; text: string }>('rag.testset.progress', (items) => [items].flat().forEach((p) => p.id === runRef.current && setProgress(p.text))), []);

  const urlList = useMemo(() => urls.split(/\s+/).filter(Boolean), [urls]);
  const n = Math.max(1, Math.min(MAX, Math.floor(Number(count) || 1)));
  const personaList = useMemo(() => personas.split('\n').map((s) => s.trim()).filter(Boolean), [personas]);
  const params = useMemo(
    () => ({
      paths: picked,
      urls: urlList,
      count: n,
      types,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(seed.trim() ? { seed: seed.trim() } : {}),
      ...(personaList.length ? { personas: personaList } : {}),
      ...(styles.length ? { styles } : {}),
      ...(dedupe === 'embedding' ? { dedupe, ...(embedder.trim() ? { embedder: embedder.trim() } : {}) } : {}),
    }),
    [picked, urlList, n, types, name, seed, personaList, styles, dedupe, embedder],
  );
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
  const toggleStyle = (t: string) => setStyles((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]));

  const generate = () => {
    if (busy || !ready) return;
    setProgress('Reading the documents …');
    void run((id) => call<{ proposal: Proposal }>('rag.testset.generate', { ...params, requestId: id, environment: env }), (r) => setProposal(r.proposal));
  };

  /** Add to dataset: the ticked rows are appended to the dataset file through the workspace's writers (one Undo). */
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    const dataset = (proposal.items[0]?.data as { dataset?: string } | undefined)?.dataset ?? 'the dataset';
    const r = await applyProposalItems<{ applied: unknown[]; skipped: Array<{ reason: string }> }>(proposal, items, (r) => `Added ${plural(r.applied.length, 'question')} to ${dataset}${skippedNote(r)}`);
    if (!r) return;
    onDone?.(dataset);
    onClose();
  };

  if (proposal) return <ProposalReview proposal={proposal} acceptLabel="Add to dataset" onAccept={accept} onDiscard={() => discardProposal(proposal.id, onClose)} onClose={onClose} />;

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
        onSubmit={() => {
          if (busy) return;
          if (setup) setup.onClick();
          else void generate();
        }}
        width={820}
        footer={
          <>
            <Button variant="ghost" icon={<Eye size={13} />} className="mr-auto" disabled={!ready || !!busy} reason={busy ? 'Still generating' : 'Pick documents or URLs, and at least one question type'} onClick={() => setPreviewing({ task: 'rag-generate-testset', title: 'Generate a RAG test set', context: { ...params } })} data-ai-preview-open>
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
              <Button variant="primary" icon={<Sparkles size={13} />} disabled={!ready || !!estimate?.judgeProblem} reason={estimate?.judgeProblem ?? 'Pick documents or URLs, and at least one question type'} onClick={() => void generate()} data-rag-testset-generate>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Who asks (optional)" hint="One person per line, at most 8: “a nurse on night shift”. Each question is written as one of them would ask it, in turn.">
              <Textarea rows={3} value={personas} onChange={(e) => setPersonas(e.target.value)} placeholder={'a new patient\na vet nurse in a hurry'} aria-label="Personas" data-rag-testset-personas />
            </Field>
            <Field label="How they word it (optional)" hint="A style changes the wording, never the expected answer.">
              <div className="grid gap-1" data-rag-testset-styles>
                {(src?.styles ?? []).map((t) => (
                  <label key={t.id} className="flex items-start gap-2">
                    <input type="checkbox" checked={styles.includes(t.id)} onChange={() => toggleStyle(t.id)} aria-label={`Style ${t.id}`} className="mt-0.5" />
                    <span>
                      <b>{t.id}</b> <span className="text-muted">{t.help}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Repeated questions" hint="By words is free. By meaning also embeds each question (a few cheap calls) to catch a paraphrase; without an embedding model the words are compared.">
              <Select value={dedupe} onChange={(e) => setDedupe(e.target.value as 'lexical' | 'embedding')} aria-label="Find repeated questions" data-rag-testset-dedupe>
                <option value="lexical">By their words</option>
                <option value="embedding">By their words and meaning</option>
              </Select>
            </Field>
            {dedupe === 'embedding' && (
              <Field label="Embedding model" hint="provider/model; empty uses the judge’s provider">
                <Input value={embedder} onChange={(e) => setEmbedder(e.target.value)} placeholder="ollama/nomic-embed-text" aria-label="Embedding model" data-rag-testset-embedder />
              </Field>
            )}
          </div>
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
