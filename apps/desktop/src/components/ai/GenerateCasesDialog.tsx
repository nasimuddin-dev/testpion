import { FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AiTaskResult, CaseSource, Proposal, ProposalItem } from '@testpion/core';
import { call } from '../../api';
import { plural } from '../../lib/format';
import { OFFLINE_DEMO_LABEL } from '../../lib/offline-demo';
import { useCollectionTree } from '../../lib/collections-store';
import { useApp, toastError, type AssistantRequest } from '../../store';
import type { CheckConfig, ProviderConfig } from '../../types';
import { Badge, Button, Field, Input, Modal, NamedOptions, Select, useDebounced } from '../ui';
import { AiPreviewDialog } from './AiPreviewDialog';
import { AiBusyLine, AiErrorPanel, AiHintField, AiPrimaryButton, AiRunFooter, AiTitle, discardProposal, useAiEstimate, useAiRun } from './ai-run';
import { AiEstimateLine } from './AiEstimateLine';
import { ProposalReview } from './ProposalReview';

/** The part of an evaluation the cases are written for: its prompt, checks and the cases it has. */
export interface CasesDraftLike {
  name: string;
  system?: string;
  prompt: string;
  dataset: string;
  datasetFormat: 'jsonl' | 'json' | 'csv' | 'md';
  expectedField: string;
  evaluators: CheckConfig[];
}

const SOURCES: Array<{ id: CaseSource; label: string; help: string }> = [
  { id: 'prompt', label: 'The prompt', help: 'Typical cases and tricky ones for the prompt you are testing.' },
  { id: 'spec', label: 'An API definition', help: 'Questions a user could ask about the operations of an OpenAPI file. The expected answer is the operation.' },
  { id: 'collection', label: 'Saved requests', help: 'Requests a user could make, from a collection or a folder. The expected answer is the saved request that does it.' },
  { id: 'documents', label: 'Documents', help: 'Questions with expected answers from your documents, each checked against the passage it came from.' },
  { id: 'history', label: 'Real calls in history', help: 'Cases based on prompts you sent to a model before, with names and numbers removed.' },
];

/** The cases a proposal's items hold as records: what the person may have edited in the review, else what the model wrote. */
export function recordsOfItems(items: ProposalItem[]): Array<Record<string, string>> {
  return items.map((i) => {
    const original = (i.data as { record?: Record<string, string> } | undefined)?.record ?? {};
    try {
      const edited = JSON.parse(i.after) as Record<string, unknown>;
      if (edited && typeof edited === 'object' && !Array.isArray(edited)) return Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } catch {
      /* the original record stands */
    }
    return original;
  });
}

/**
 * "Generate test cases with AI" (AU-13): where the cases come from (the prompt, an API definition, saved requests, documents,
 * real calls in History), how many, and a hint. The estimate and "What will be sent" come before anything is sent. Generate
 * writes the cases and verifies each one; they open in the one proposal review (a row per case with its checks, a repeat or a
 * case that names something the source does not have is unticked), and Add to test cases puts the ticked ones in the evaluation
 * you are editing, with Undo. Nothing is added before a person accepts. With no model set up, the offline demo model writes a few
 * cases so the feature can be tried.
 */
export function GenerateCasesDialog({ draft, evaluation, providers, onAdd, onClose }: { draft: CasesDraftLike; evaluation?: string; providers: ProviderConfig[]; /** Adds the cases to the evaluation being edited; returns what takes them back. */ onAdd(records: Array<Record<string, string>>): () => void; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const cols = useCollectionTree().filter((c) => !c.problem);
  const [source, setSource] = useState<CaseSource>('prompt');
  const [count, setCount] = useState('10');
  const [hint, setHint] = useState('');
  const [provider, setProvider] = useState('');
  const [specs, setSpecs] = useState<string[]>([]);
  const [spec, setSpec] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [folders, setFolders] = useState<Array<{ path: string; docs: number }>>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [historyLimit, setHistoryLimit] = useState('20');
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const [previewLoad, setPreviewLoad] = useState(false);
  const { busy, error, run, stop } = useAiRun('ec');

  useEffect(() => {
    if (source === 'spec' && !specs.length) void call<string[]>('openapi.specs', {}).then((l) => (setSpecs(l), setSpec((s) => s || l[0] || '')), () => undefined);
    if (source === 'documents' && !files.length) void call<{ files: typeof files; folders: typeof folders }>('rag.testset.sources').then((s) => (setFiles(s.files), setFolders(s.folders)), () => undefined);
  }, [source, specs.length, files.length]);

  const n = Math.max(1, Math.min(30, Math.floor(Number(count) || 1)));
  const col = cols.find((c) => c.id === collectionId) ?? cols[0];
  const why =
    source === 'spec' ? (spec ? undefined : 'Choose an API definition. There are none in this workspace yet: import one first.') :
    source === 'collection' ? (col ? undefined : 'There are no collections with saved requests yet.') :
    source === 'documents' ? (picked.length ? undefined : 'Tick at least one document or folder.') :
    !draft.prompt.trim() ? 'Write the prompt first: the cases are written for it.' : undefined;
  const params = useMemo(
    () => ({
      source,
      draft: { name: draft.name, system: draft.system, prompt: draft.prompt, dataset: draft.dataset, datasetFormat: draft.datasetFormat, expectedField: draft.expectedField, evaluators: draft.evaluators },
      ...(evaluation ? { evaluation } : {}),
      count: n,
      ...(source === 'spec' ? { spec } : {}),
      ...(source === 'collection' && col ? { collection: col.id } : {}),
      ...(source === 'documents' ? { paths: picked } : {}),
      ...(source === 'history' ? { historyLimit: Math.max(1, Math.min(50, Math.floor(Number(historyLimit) || 20))) } : {}),
      ...(hint.trim() ? { hint: hint.trim() } : {}),
      ...(provider ? { provider } : {}),
      environment: env,
    }),
    [source, draft, evaluation, n, spec, col, picked, historyLimit, hint, provider, env],
  );
  const key = useDebounced(JSON.stringify(why ? null : params), 400);
  // what it would cost, before anything is sent (a dry run); documents have their own estimate in the preview
  const estimate = useAiEstimate(why || proposal || source === 'documents' ? undefined : () => call<AiTaskResult>('eval.generateCases', { ...(JSON.parse(key) as object), dryRun: true }), [key, proposal, source]);

  const generate = (extra: { hint?: string } = {}) =>
    !why &&
    run(
      (id) => call<{ proposal: Proposal }>('eval.generateCases', { ...params, ...(extra.hint ? { hint: extra.hint } : {}), requestId: id }),
      (r) => setProposal(r.proposal),
    );
  const useDemo = async () => {
    try {
      const r = await call<{ id: string }>('ai.demoModel');
      setProvider(r.id);
    } catch (e) {
      toastError(e);
    }
  };
  const openPreview = () => {
    if (source === 'documents') return setPreviewing({ task: 'rag-generate-testset', title: 'Write test cases from documents', context: { paths: picked, count: n } });
    setPreviewLoad(true);
  };

  /** Add to test cases: the ticked cases go into the evaluation being edited (its own Undo); the proposal records what was accepted. */
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    const undo = onAdd(recordsOfItems(items));
    try {
      await call('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id), recordOnly: true });
    } catch {
      /* the cases are in the evaluation either way */
    }
    useApp.getState().toast(`Added ${plural(items.length, 'test case')} to ${draft.name || 'the evaluation'}`, 'success', undefined, { undo });
    onClose();
  };

  if (proposal)
    return (
      <ProposalReview
        proposal={proposal}
        acceptLabel="Add to test cases"
        onAccept={accept}
        onRegenerate={(h) => {
          void call('ai.discardProposal', { id: proposal.id }).catch(() => undefined);
          setProposal(undefined);
          setHint(h);
          void generate({ hint: h });
        }}
        onDiscard={() => discardProposal(proposal.id, onClose)}
        onClose={onClose}
      />
    );

  const hasModelChoice = providers.length > 0;
  return (
    <>
      <Modal
        title={<AiTitle>Generate test cases with AI</AiTitle>}
        onClose={() => (stop(), onClose())}
        onSubmit={() => !busy && void generate()}
        width={760}
        footer={
          <AiRunFooter busy={!!busy} previewDisabled={!!why} onPreview={openPreview} onCancel={() => (stop(), onClose())} onStop={stop}>
            <AiPrimaryButton onClick={() => void generate()} disabled={!!why} reason={why} data-gen-cases-go>
              Generate
            </AiPrimaryButton>
          </AiRunFooter>
        }
      >
        <div className="grid gap-4 text-sm" data-gen-cases-dialog>
          <Field label="Write the cases from" hint={SOURCES.find((s) => s.id === source)!.help}>
            <Select value={source} onChange={(e) => setSource(e.target.value as CaseSource)} aria-label="Source of the cases" data-gen-cases-source>
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          {source === 'spec' && (
            <Field label="API definition">
              <Select value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="API definition" data-gen-cases-spec>
                {!specs.length && <option value="">No API definitions in this workspace</option>}
                {specs.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {source === 'collection' && (
            <Field label="Collection" hint="Every saved request of it (up to 60) is described to the model; their bodies and headers are not sent.">
              <Select value={col?.id ?? ''} onChange={(e) => setCollectionId(e.target.value)} aria-label="Collection" data-gen-cases-collection>
                {!cols.length && <option value="">No collections yet</option>}
                <NamedOptions items={cols} />
              </Select>
            </Field>
          )}
          {source === 'documents' && (
            <Field label="Documents of the workspace" hint="Markdown, text and HTML files. Tick a folder to use everything in it.">
              <div className="border border-line rounded-lg max-h-40 overflow-auto" data-gen-cases-files>
                {!files.length && !folders.length && <div className="p-3 text-muted">No documents in the workspace yet. Add markdown or text files to it first.</div>}
                {folders.map((f) => (
                  <label key={`d-${f.path}`} className="flex items-center gap-2 px-2 py-1 border-b border-line/60 hover:bg-hover">
                    <input type="checkbox" checked={picked.includes(f.path)} onChange={() => setPicked((p) => (p.includes(f.path) ? p.filter((x) => x !== f.path) : [...p, f.path]))} aria-label={`Folder ${f.path}`} />
                    <span className="font-medium">{f.path}/</span>
                    <Badge>{f.docs} documents</Badge>
                  </label>
                ))}
                {files.map((f) => (
                  <label key={f.path} className="flex items-center gap-2 px-2 py-1 border-b border-line/60 hover:bg-hover">
                    <input type="checkbox" checked={picked.includes(f.path)} onChange={() => setPicked((p) => (p.includes(f.path) ? p.filter((x) => x !== f.path) : [...p, f.path]))} aria-label={f.path} />
                    <FileText size={12} className="text-muted" />
                    <span className="truncate">{f.path}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          {source === 'history' && (
            <Field label="How many recent calls to read" hint="1 to 50. Only prompts you sent to a model are read.">
              <Input type="number" min={1} max={50} value={historyLimit} onChange={(e) => setHistoryLimit(e.target.value)} aria-label="Calls to read" className="w-24" />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="How many cases" hint="1 to 30">
              <Input type="number" min={1} max={30} value={count} onChange={(e) => setCount(e.target.value)} aria-label="Number of cases" data-gen-cases-count />
            </Field>
            {hasModelChoice && (
              <Field label="Written by" hint="Empty: the model set in Settings ▸ AI assistant">
                <Select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Model that writes the cases" data-gen-cases-provider>
                  <option value="">The AI assistant’s model</option>
                  <NamedOptions items={providers} />
                </Select>
              </Field>
            )}
          </div>
          <AiHintField value={hint} onChange={setHint} placeholder="more about refunds; include very short messages" label="Hint for the cases" />
          {why ? <p className="text-xs text-muted">{why}</p> : source === 'documents' ? <p className="text-xs text-muted">“What will be sent…” shows the estimate of the questions and of the check of each answer.</p> : <AiEstimateLine estimate={estimate} data-gen-cases-estimate />}
          {estimate && !estimate.ok && /assistant is off|No AI|No Claude|not set up/i.test(estimate.text) && (
            <div>
              <Button size="sm" onClick={() => void useDemo()} title="Cases written by rules, with no key and no network: for trying the feature" data-gen-cases-demo-now>
                {OFFLINE_DEMO_LABEL}
              </Button>
            </div>
          )}
          {busy && (
            <AiBusyLine>
              <span data-gen-cases-busy>Writing the cases and checking each one …</span>
            </AiBusyLine>
          )}
          {error && (
            <AiErrorPanel error={error} onClose={onClose} data-gen-cases-error>
              <Button size="sm" onClick={() => void useDemo()} title="Cases written by rules, with no key and no network: for trying the feature" data-gen-cases-demo>
                {OFFLINE_DEMO_LABEL}
              </Button>
            </AiErrorPanel>
          )}
        </div>
      </Modal>
      {previewing && <AiPreviewDialog request={previewing} onClose={() => setPreviewing(undefined)} />}
      {previewLoad && <AiPreviewDialog request={{ title: 'Write test cases' }} load={async () => (await call<AiTaskResult>('eval.generateCases', { ...params, dryRun: true })).preview as never} onClose={() => setPreviewLoad(false)} />}
    </>
  );
}

