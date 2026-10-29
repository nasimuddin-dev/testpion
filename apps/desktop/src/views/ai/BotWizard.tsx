import { ArrowLeft, ArrowRight, Database, FileText, Play, Plus, Radio } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { countDatasetRecords, datasetFormatOf, previewDatasetRecords, type RagJudgeSetup, type RagTarget } from '@testpion/shared';
import type { RagTargetInfo } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { useLibrary } from '../../lib/library';
import { useRpc } from '../../lib/use-rpc';
import { plural } from '../../lib/format';
import type { CheckConfig, ProviderConfig } from '../../types';
import { Badge, Button, Callout, Field, Input, Modal, NamedOptions, Select } from '../../components/ui';
import { CasesPane } from '../../components/ai/CasesPane';
import { RagConnectDialog } from '../../components/rag/RagConnectDialog';
import { RagTestsetDialog } from '../../components/rag/RagTestsetDialog';
import { RagCaptureDialog } from '../../components/rag/RagCaptureDialog';
import { RagImportDialog } from '../../components/rag/RagImportDialog';
import { RagColumnMapper } from '../../components/rag/RagColumnMapper';
import { RagTryDialog } from '../../components/rag/RagTryDialog';
import { RagEstimateLine } from '../../components/rag/RagEstimate';
import { MetricPicker } from '../../components/rag/MetricPicker';
import { metricResolver, spendsOnJudge, type MetricCatalogue } from '../../components/rag/metric-resolver';
import { RAG_STARTER_DATASET, RAG_STARTER_EVALUATORS } from '../../components/rag/starter';

/** The evaluation the wizard builds: the same fields as a saved evaluation of a bot with sources (no new file format). */
export interface BotDraft {
  name: string;
  type: 'rag';
  provider: string;
  model: string;
  system: string;
  prompt: string;
  format: 'text' | 'json';
  datasetFormat: 'jsonl' | 'json' | 'csv' | 'md';
  dataset: string;
  expectedField: string;
  evaluators: CheckConfig[];
  concurrency: number;
  retries: number;
  target?: string;
  judge?: RagJudgeSetup;
}

const STEPS = [
  { id: 'bot', title: 'Which bot?' },
  { id: 'cases', title: 'Your questions' },
  { id: 'checks', title: 'What should be true?' },
] as const;

/** The two goals people have for a bot with sources, each the one to three metrics that decide it (the 138 are under More checks). */
const GOALS = [
  {
    id: 'sources',
    title: 'Answers are backed by the sources',
    what: 'Every claim in the answer can be found in the documents the bot retrieved, and the answer is about the question.',
    checks: [
      { type: 'faithfulness', threshold: 0.8 },
      { type: 'answer-relevance', threshold: 0.7 },
    ] as CheckConfig[],
  },
  {
    id: 'documents',
    title: 'The right documents are found',
    what: 'The bot retrieves the documents that hold the answer. Each question lists the ids of its right documents in the reference_ids column.',
    checks: [{ type: 'context-recall-ids', threshold: 0.8 }] as CheckConfig[],
  },
] as const;
/** What the standard set holds besides the two goals. */
const EXTRAS: CheckConfig[] = RAG_STARTER_EVALUATORS.filter((e) => !GOALS.some((g) => g.checks.some((c) => c.type === e.type)));

/**
 * The wizard for a bot with sources (AU-20): three steps, one screen each. 1 Which bot (choose a connected one, or connect one
 * with a preset), 2 Your questions (the case table of records: type, load, generate from documents, capture from real calls,
 * import), 3 What should be true (two goals instead of 138 metrics, the standard set of 5 checks as a preset, More checks for the
 * full picker; the cost under it). It saves the SAME evaluation of type rag as the full editor: no new file format.
 */
export function BotWizard({
  initial,
  providers,
  names,
  onFinish,
  onEditor,
  onClose,
}: {
  initial: BotDraft;
  providers: ProviderConfig[];
  names: string[];
  /** Save the evaluation; `run` also starts it. */
  onFinish(d: BotDraft, run: boolean): Promise<void>;
  /** Hand the draft to the full editor without saving. */
  onEditor(d: BotDraft): void;
  onClose(): void;
}) {
  const env = useApp((s) => s.environment);
  const [step, setStep] = useState(0);
  const [d, setD] = useState<BotDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'connect' | 'generate' | 'capture' | 'import' | 'map' | 'more'>();
  const [trying, setTrying] = useState<CheckConfig>();
  const set = (p: Partial<BotDraft>) => setD((x) => ({ ...x, ...p }));
  const targets = useLibrary<RagTarget>('rag-targets');
  const [info, setInfo] = useState<RagTargetInfo[]>([]);
  useEffect(() => {
    void call<RagTargetInfo[]>('rag.targets').then(setInfo, () => setInfo([]));
  }, [targets.lib]);
  const [datasets, setDatasets] = useState<Array<{ path: string; name: string }>>([]);
  const loadDatasets = () => call<Array<{ path: string; name: string }>>('datasets.list').then((l) => (setDatasets(l.filter((x) => /\.(csv|tsv|json|jsonl|ndjson|md)$/i.test(x.name))), l), () => []);
  useEffect(() => void loadDatasets(), []);
  // no bot chosen yet: the only one connected is the one to test
  useEffect(() => {
    if (!d.target && targets.lib.items.length === 1) set({ target: targets.lib.items[0]!.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.lib.items.length]);

  const targetInfo = info.find((i) => i.id === d.target);
  const count = useMemo(() => countDatasetRecords(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const readAs = useMemo(() => datasetFormatOf(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const preview = useMemo(() => previewDatasetRecords(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const previewKeys = useMemo(() => (preview[0] ? Object.keys(preview[0]) : []), [preview]);
  const firstQuestion = String(preview[0]?.question ?? preview[0]?.query ?? preview[0]?.input ?? preview[0]?.user_input ?? '') || undefined;
  const catalogue = useRpc<MetricCatalogue>('rag.metrics', { columns: previewKeys, hasTarget: !!d.target }, { keep: true });
  const resolve = useMemo(() => metricResolver(catalogue?.metrics ?? []), [catalogue]);
  const judged = d.evaluators.some((e) => spendsOnJudge(resolve(e.type), e));

  const why1 = !d.name.trim() ? 'Give the evaluation a name' : !d.target ? 'Choose the bot to test, or connect one' : undefined;
  const whyRun = why1 ?? (!count ? 'Add at least one question on the Your questions step' : !d.evaluators.length ? 'Tick at least one thing that should be true' : undefined);
  const freeName = (n: string) => {
    let name = n.trim();
    for (let i = 2; names.includes(name); i++) name = `${n.trim()} (${i})`;
    return name;
  };
  const finish = async (run: boolean) => {
    setSaving(true);
    try {
      await onFinish({ ...d, name: freeName(d.name) }, run);
    } finally {
      setSaving(false);
    }
  };
  const hasAll = (checks: readonly CheckConfig[]) => checks.every((c) => d.evaluators.some((e) => e.type === c.type));
  const toggleGoal = (checks: readonly CheckConfig[], on: boolean) =>
    set({ evaluators: on ? [...d.evaluators, ...checks.filter((c) => !d.evaluators.some((e) => e.type === c.type))] : d.evaluators.filter((e) => !checks.some((c) => c.type === e.type)) });
  const isStandard = d.evaluators.length === RAG_STARTER_EVALUATORS.length && RAG_STARTER_EVALUATORS.every((c) => d.evaluators.some((e) => e.type === c.type));
  const loadDataset = async (name: string) => {
    const list = await loadDatasets();
    const f = list.find((x) => x.name === name || x.path === name);
    if (!f) return;
    try {
      const r = await call<{ name: string; text: string }>('datasets.read', { path: f.path });
      set({ dataset: r.text, datasetFormat: /\.csv$/i.test(r.name) ? 'csv' : /\.json$/i.test(r.name) ? 'json' : 'jsonl' });
    } catch (e) {
      toastError(e);
    }
  };
  const nameOf = (type: string) => resolve(type)?.name ?? type;

  return (
    <>
      <Modal
        title={
          <span className="flex items-center gap-2" data-botwizard-title>
            <FileText size={16} /> Answers come from my documents
            <Badge>Step {step + 1} of 3</Badge>
          </span>
        }
        onClose={onClose}
        onSubmit={() => (step < 2 ? !(step === 0 && why1) && setStep(step + 1) : !whyRun && !saving && void finish(true))}
        help="ai-testing/rag"
        width={900}
        footer={
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => onEditor({ ...d, name: freeName(d.name) })} title="Open this evaluation in the full editor, with every setting" data-botwizard-editor>
              Open the full editor
            </Button>
            {step > 0 && (
              <Button icon={<ArrowLeft size={13} />} onClick={() => setStep(step - 1)} data-botwizard-back>
                Back
              </Button>
            )}
            {step < 2 && (
              <Button variant={step === 0 ? 'primary' : 'default'} icon={<ArrowRight size={13} />} onClick={() => setStep(step + 1)} disabled={step === 0 && !!why1} reason={why1} data-botwizard-next>
                Next: {STEPS[step + 1]!.title.replace(/\?$/, '').toLowerCase()}
              </Button>
            )}
            {step >= 1 && (
              <Button variant="primary" icon={<Play size={13} />} onClick={() => void finish(true)} disabled={!!whyRun || saving} reason={saving ? 'Saving' : whyRun} data-botwizard-run>
                {`Run ${count ? plural(count, 'question') : ''}`.trim()}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3 min-h-[24rem]" data-botwizard data-botwizard-step={STEPS[step]!.id}>
          <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <button className={i === step ? 'font-semibold text-accent' : i < step ? 'text-fg hover:underline' : 'text-muted'} onClick={() => setStep(i)} disabled={i > step && !!why1} aria-current={i === step ? 'step' : undefined} data-botwizard-go={s.id}>
                  {i + 1}. {s.title}
                </button>
                {i < STEPS.length - 1 && <span className="text-muted">›</span>}
              </li>
            ))}
          </ol>
          {step === 0 && (
            <div className="grid gap-3 text-sm" data-botwizard-bot>
              <Field label="Name">
                <Input value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Evaluation name" data-botwizard-name />
              </Field>
              {targets.lib.items.length === 0 ? (
                <Callout tone="accent" data-botwizard-nobot action={<Button size="sm" variant="primary" icon={<Plus size={12} />} onClick={() => setDialog('connect')} data-botwizard-connect>Connect a bot…</Button>}>
                  No bot is connected yet. Connect the system you test: pick a preset (OpenAI-compatible, LangServe, LlamaIndex, Dify …), ask it one question, and click where its answer and the documents it retrieved are in the response.
                </Callout>
              ) : (
                <div className="flex items-end gap-2">
                  <Field label="The bot to test" className="flex-1 min-w-0" hint={targetInfo ? `${targetInfo.protocol} · ${targetInfo.mapped}` : undefined}>
                    <Select value={d.target ?? ''} onChange={(e) => set({ target: e.target.value || undefined })} aria-label="The bot to test" data-botwizard-target>
                      <option value="">Choose a bot</option>
                      <NamedOptions items={targets.lib.items} />
                    </Select>
                  </Field>
                  <Button icon={<Database size={13} />} onClick={() => setDialog('connect')} title="Connect another bot: a preset, one test question, then click where the answer is" data-botwizard-connect>
                    Connect another…
                  </Button>
                </div>
              )}
              {targetInfo?.problems.length ? <Callout tone="warn">This bot has a problem: {targetInfo.problems[0]}</Callout> : null}
              <p className="text-xs text-muted">A bot with sources is a system that answers from documents it retrieves. Each question goes to it, and the checks look at the answer and at the documents it found.</p>
            </div>
          )}
          {step === 1 && (
            <div className="flex flex-col gap-2" data-botwizard-cases>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<FileText size={12} />} onClick={() => setDialog('generate')} title="Have AI write questions with reference answers from your documents; you review them" data-botwizard-generate>
                  Generate from documents…
                </Button>
                <Button size="sm" icon={<Radio size={12} />} onClick={() => setDialog('capture')} title="Questions from real calls in History, a Debugger session or a file; secrets and personal data are masked" data-botwizard-capture>
                  From real calls…
                </Button>
                <Button size="sm" onClick={() => set({ dataset: RAG_STARTER_DATASET, datasetFormat: 'jsonl' })} data-botwizard-example>
                  Use the example questions
                </Button>
                <span className="text-xs text-muted">Each record has a question, a reference answer and the ids of its right documents. 10 to 30 questions are enough to start.</span>
              </div>
              <div className="h-80 border border-line rounded-lg overflow-hidden">
                <CasesPane
                  d={d}
                  set={(p) => set(p as Partial<BotDraft>)}
                  count={count}
                  readAs={readAs}
                  preview={preview}
                  previewKeys={previewKeys}
                  vars={[]}
                  ragTarget
                  datasets={datasets}
                  onImport={() => setDialog('import')}
                  onMap={() => setDialog('map')}
                  onExportRag={() => undefined}
                  onExample={() => set({ dataset: RAG_STARTER_DATASET, datasetFormat: 'jsonl' })}
                />
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="flex flex-col gap-2" data-botwizard-checks>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-1.5" data-botwizard-preset>
                <span className="text-sm">
                  Quality checks: <b data-botwizard-count>{d.evaluators.length} selected</b>
                  {isStandard ? ' (the standard set)' : ''}
                </span>
                <span className="text-xs text-muted truncate min-w-0 flex-1" title={d.evaluators.map((e) => nameOf(e.type)).join(', ')}>
                  {d.evaluators.map((e) => nameOf(e.type)).join(', ') || 'none yet'}
                </span>
                {!isStandard && (
                  <Button size="sm" onClick={() => set({ evaluators: RAG_STARTER_EVALUATORS })} title="Go back to the five checks most bots start with" data-botwizard-standard>
                    Use the standard set
                  </Button>
                )}
                <Button size="sm" onClick={() => setDialog('more')} title={`Choose from all ${catalogue?.metrics.length ?? ''} checks, each with what it measures`.replace('  ', ' ')} data-botwizard-more>
                  More checks…
                </Button>
              </div>
              {GOALS.map((g) => {
                const on = hasAll(g.checks);
                return (
                  <div key={g.id} className="rounded-lg border border-line px-2.5 py-1.5" data-botwizard-goal={g.id} data-botwizard-on={on ? 'true' : 'false'}>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={on} onChange={(e) => toggleGoal(g.checks, e.target.checked)} aria-label={g.title} />
                      {g.title}
                    </label>
                    <div className="text-xs text-muted pl-6">{g.what}</div>
                    <div className="pl-6 mt-1 flex flex-col gap-0.5">
                      {g.checks.map((c) => {
                        const row = resolve(c.type);
                        return (
                          <div key={c.type} className="flex items-center gap-2 text-xs" data-botwizard-metric={c.type}>
                            <span className="font-medium">{row?.name ?? c.type}</span>
                            {row && row.kind !== 'deterministic' && <Badge tone="judge">AI reviewer</Badge>}
                            <span className="text-muted truncate min-w-0 flex-1" title={row?.what}>
                              {row?.what}
                            </span>
                            {row?.missing?.length ? <span className="text-warn">needs {row.missing.join(', ')}</span> : null}
                            <Button size="sm" onClick={() => setTrying(c)} disabled={!d.target || !firstQuestion} reason={!d.target ? 'Choose a bot first' : 'Add a question first'} title="Ask the bot the first question and see this check on its answer" data-botwizard-try>
                              Try on question 1
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {EXTRAS.length > 0 && (
                <div className="text-xs text-muted" data-botwizard-extras>
                  The standard set also checks: {EXTRAS.map((e) => nameOf(e.type)).join(', ')}.
                </div>
              )}
              {judged && (
                <Field label="AI reviewer for the checks that need one" hint={d.judge?.provider ? undefined : 'Not chosen: the AI settings’ large model is used. If none is set, the run stops before the first question and says what to set up.'}>
                  <Select
                    value={d.judge?.provider ?? ''}
                    onChange={(e) => set({ judge: { ...d.judge, provider: e.target.value || undefined, model: providers.find((p) => p.id === e.target.value)?.defaultModel || undefined } })}
                    aria-label="AI reviewer"
                    data-botwizard-judge
                  >
                    <option value="">The AI settings’ large model</option>
                    <NamedOptions items={providers} />
                  </Select>
                </Field>
              )}
            </div>
          )}
          <div className="mt-auto pt-2 border-t border-line text-xs" data-botwizard-cost>
            {step === 2 || (step === 1 && d.evaluators.length > 0) ? (
              d.target && count > 0 && d.evaluators.length > 0 ? (
                <RagEstimateLine draft={d} env={env} />
              ) : (
                <span className="text-muted">{!d.target ? 'Choose a bot to see what a run costs.' : !count ? 'Add questions to see what a run costs.' : 'Tick a check to see what a run costs.'}</span>
              )
            ) : (
              <span className="text-muted">Run is on from the next step.</span>
            )}
          </div>
        </div>
      </Modal>
      {dialog === 'connect' && <RagConnectDialog onClose={() => setDialog(undefined)} onSaved={(id) => void targets.reload().then(() => set({ target: id }))} />}
      {dialog === 'generate' && <RagTestsetDialog onClose={() => setDialog(undefined)} onDone={(name) => void loadDataset(name)} />}
      {dialog === 'capture' && <RagCaptureDialog onClose={() => setDialog(undefined)} onCreated={(name) => void loadDataset(name)} />}
      {dialog === 'import' && <RagImportDialog onImport={(dataset) => set({ dataset, datasetFormat: 'jsonl' })} onClose={() => setDialog(undefined)} />}
      {dialog === 'map' && <RagColumnMapper dataset={d.dataset} format={readAs} onApply={(dataset) => set({ dataset, datasetFormat: 'jsonl' })} onClose={() => setDialog(undefined)} />}
      {dialog === 'more' && (
        <Modal
          title="More checks"
          onClose={() => setDialog(undefined)}
          onSubmit={() => setDialog(undefined)}
          width={860}
          footer={
            <Button variant="primary" onClick={() => setDialog(undefined)} data-botwizard-more-done>
              Done
            </Button>
          }
        >
          <div className="h-[28rem] -m-3" data-botwizard-picker>
            <MetricPicker evaluators={d.evaluators} onChange={(evaluators) => set({ evaluators })} columns={previewKeys} hasTarget={!!d.target} onTry={setTrying} footer={d.target && count > 0 ? <RagEstimateLine draft={d} env={env} /> : undefined} />
          </div>
        </Modal>
      )}
      {trying && <RagTryDialog check={trying} target={d.target} question={firstQuestion} judge={d.judge} onClose={() => setTrying(undefined)} />}
    </>
  );
}

