import { ArrowLeft, ArrowRight, CheckCheck, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { casesToJsonl, countDatasetRecords, datasetFormatOf, datasetRecords, previewDatasetRecords } from '@testpion/shared';
import type { TryCheckResult } from '@testpion/core';
import { call } from '../../api';
import { useApp, toastError } from '../../store';
import { formatCost, plural, templateVars } from '../../lib/format';
import { OFFLINE_DEMO_NOTE } from '../../lib/offline-demo';
import { shortCost, useEvalEstimate } from '../../lib/eval-estimate';
import type { CheckConfig, ProviderConfig } from '../../types';
import { Badge, Button, Callout, Field, Input, LinkButton, Modal, NamedOptions, Select, Textarea } from '../../components/ui';
import { CasesPane } from '../../components/ai/CasesPane';
import { EvalCostLine } from '../../components/ai/EvalCostLine';
import { GenerateCasesDialog } from '../../components/ai/GenerateCasesDialog';
import { GoodAnswerPicker } from '../../components/ai/GoodAnswerPicker';

/** The evaluation the wizard builds: the same fields as a saved evaluation of a prompt or chatbot, nothing more (no new file format). */
export interface WizardDraft {
  name: string;
  type: 'llm';
  provider: string;
  model: string;
  temperature?: number;
  system: string;
  prompt: string;
  format: 'text' | 'json';
  datasetFormat: 'jsonl' | 'json' | 'csv' | 'md';
  dataset: string;
  expectedField: string;
  evaluators: CheckConfig[];
  concurrency: number;
  retries: number;
}

const STEPS = [
  { id: 'what', title: 'What are you testing?', next: 'Next: your cases' },
  { id: 'cases', title: 'Your cases', next: 'Next: a good answer' },
  { id: 'good', title: 'What is a good answer?', next: '' },
] as const;

/**
 * The wizard for "Answers are correct" (AU-12): three steps, one screen each. 1 What are you testing (the prompt with its
 * {{variables}} and the model), 2 Your cases (the one case table: type, paste, load a file, or have AI write them), 3 What is a
 * good answer (the common checks in plain words, each tried on a case). The cost of the run is under every step and Run is on from
 * step 2, because a first check is already ticked. The result is the SAME saved evaluation as the full editor makes: the wizard
 * adds no file format, and "Open the full editor" hands the draft over at any step.
 */
export function Wizard({
  initial,
  providers,
  names,
  onProviders,
  onFinish,
  onEditor,
  onClose,
}: {
  initial: WizardDraft;
  providers: ProviderConfig[];
  /** The names of the saved evaluations (a new one gets a free name). */
  names: string[];
  /** The providers changed (the offline demo model was added). */
  onProviders(p: ProviderConfig[]): void;
  /** Save the evaluation; `run` also starts it. */
  onFinish(d: WizardDraft, run: boolean): Promise<void>;
  /** Hand the draft to the full editor without saving. */
  onEditor(d: WizardDraft): void;
  onClose(): void;
}) {
  const env = useApp((s) => s.environment);
  const [step, setStep] = useState(0);
  const [d, setD] = useState<WizardDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [datasets, setDatasets] = useState<Array<{ path: string; name: string }>>([]);
  const set = (p: Partial<WizardDraft>) => setD((x) => ({ ...x, ...p }));
  useEffect(() => {
    void call<Array<{ path: string; name: string }>>('datasets.list').then((l) => setDatasets(l.filter((x) => /\.(csv|tsv|json|jsonl|ndjson|md)$/i.test(x.name))), () => setDatasets([]));
  }, []);
  // no model yet: the offline demo model is used (said on every result), so the first run needs no key
  useEffect(() => {
    if (d.provider && providers.some((p) => p.id === d.provider)) return;
    const first = providers[0];
    if (first) return set({ provider: first.id, model: first.defaultModel ?? '' });
    void call<{ id: string; model: string }>('ai.demoModel').then(
      async (r) => {
        onProviders(await call<ProviderConfig[]>('ai.providers'));
        set({ provider: r.id, model: r.model });
      },
      toastError,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length]);

  const estimate = useEvalEstimate(d, env);
  const count = useMemo(() => countDatasetRecords(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const readAs = useMemo(() => datasetFormatOf(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const preview = useMemo(() => previewDatasetRecords(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const previewKeys = useMemo(() => (preview[0] ? Object.keys(preview[0]) : []), [preview]);
  const vars = useMemo(() => templateVars(d.prompt), [d.prompt]);
  const provider = providers.find((p) => p.id === d.provider);
  const offline = provider?.kind === 'mock';
  const missingVars = vars.filter((v) => v !== d.expectedField && preview[0] && !(v in preview[0]));

  const why1 = !d.name.trim() ? 'Give the evaluation a name' : !d.prompt.trim() ? 'Write the prompt you are testing' : !provider ? 'Choose a model' : undefined;
  const whyRun = why1 ?? (!count ? 'Add at least one test case on the Your cases step' : !d.evaluators.length ? 'Tick at least one way to tell a good answer' : undefined);
  const runLabel = `Run ${count ? plural(count, 'case') : ''}${shortCost(estimate, formatCost) ? ` · ${shortCost(estimate, formatCost)}` : ''}`.trim();
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
  const tryCheck = (check: CheckConfig, caseNumber: number, dryRun: boolean) => call<TryCheckResult>('eval.tryCheck', { draft: d, check, caseNumber, dryRun, environment: env });

  return (
    <>
      <Modal
        title={
          <span className="flex items-center gap-2" data-wizard-title>
            <CheckCheck size={16} /> Answers are correct
            <Badge>
              Step {step + 1} of 3
            </Badge>
          </span>
        }
        onClose={onClose}
        width={880}
        footer={
          <>
            <Button variant="ghost" className="mr-auto" onClick={() => onEditor({ ...d, name: freeName(d.name) })} title="Open this evaluation in the full editor, with every setting" data-wizard-editor>
              Open the full editor
            </Button>
            {step > 0 && (
              <Button icon={<ArrowLeft size={13} />} onClick={() => setStep(step - 1)} data-wizard-back>
                Back
              </Button>
            )}
            {step < 2 && (
              <Button variant={step === 0 ? 'primary' : 'default'} icon={<ArrowRight size={13} />} onClick={() => setStep(step + 1)} disabled={step === 0 && !!why1} reason={why1} data-wizard-next>
                Next: {STEPS[step + 1]!.title.replace(/\?$/, '').toLowerCase().replace('your cases', 'your cases')}
              </Button>
            )}
            {step >= 1 && (
              <Button variant="primary" icon={<Play size={13} />} onClick={() => void finish(true)} disabled={!!whyRun || saving} reason={saving ? 'Saving' : whyRun} data-wizard-run>
                {runLabel}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3 min-h-[26rem]" data-wizard data-wizard-step={STEPS[step]!.id}>
          <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <button className={i === step ? 'font-semibold text-accent' : i < step ? 'text-fg hover:underline' : 'text-muted'} onClick={() => setStep(i)} disabled={i > step && !!why1} data-wizard-go={s.id} aria-current={i === step ? 'step' : undefined}>
                  {i + 1}. {s.title}
                </button>
                {i < STEPS.length - 1 && <span className="text-muted">›</span>}
              </li>
            ))}
          </ol>
          {step === 0 && (
            <div className="grid gap-3 text-sm" data-wizard-what>
              <Field label="Name">
                <Input value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Evaluation name" data-wizard-name />
              </Field>
              <Field label="The prompt" hint="Write {{variables}} where each case puts its text. The cases on the next step fill them.">
                <Textarea rows={6} className="mono" value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} aria-label="Prompt" data-wizard-prompt />
              </Field>
              <div className="text-xs text-muted flex items-center gap-1.5 flex-wrap" data-wizard-vars>
                Variables found:
                {vars.length ? vars.map((v) => <Badge key={v} tone="accent">{v}</Badge>) : <span>none: the same prompt is sent for every case</span>}
              </div>
              <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
                <Field label="Model provider">
                  <Select value={d.provider} onChange={(e) => set({ provider: e.target.value, model: providers.find((p) => p.id === e.target.value)?.defaultModel ?? '' })} aria-label="Provider" data-wizard-provider>
                    <NamedOptions items={providers} />
                  </Select>
                </Field>
                <Field label="Model">
                  <Input className="mono" value={d.model} onChange={(e) => set({ model: e.target.value })} aria-label="Model" />
                </Field>
              </div>
              {offline && (
                <Callout tone="warn" data-wizard-offline>
                  Using the offline demo model. {OFFLINE_DEMO_NOTE}{' '}
                  <LinkButton icon={null} onClick={() => (onClose(), useApp.getState().openIntent('ai', { tab: 'providers' }))}>
                    Connect a real model
                  </LinkButton>
                </Callout>
              )}
            </div>
          )}
          {step === 1 && (
            <div className="flex flex-col gap-2" data-wizard-cases>
              <p className="text-xs text-muted">5 to 20 cases are enough to start. Add the cases that went wrong before. Each column is available as {'{{column}}'} in the prompt.</p>
              {missingVars.length > 0 && <Callout tone="warn">The prompt uses {missingVars.map((v) => `{{${v}}}`).join(', ')}, but the cases have no such column. Add the column, or change the prompt on the first step.</Callout>}
              <div className="h-80 border border-line rounded-lg overflow-hidden">
                <CasesPane
                  d={d}
                  set={(p) => set(p as Partial<WizardDraft>)}
                  count={count}
                  readAs={readAs}
                  preview={preview}
                  previewKeys={previewKeys}
                  vars={vars}
                  ragTarget={false}
                  datasets={datasets}
                  onImport={() => undefined}
                  onMap={() => undefined}
                  onExportRag={() => undefined}
                  onExample={() => undefined}
                  onGenerate={() => setGenerating(true)}
                />
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="-mx-3" data-wizard-good>
              <GoodAnswerPicker evaluators={d.evaluators} onChange={(evaluators) => set({ evaluators })} cases={count} onTry={tryCheck} />
            </div>
          )}
          <div className="mt-auto pt-2 border-t border-line" data-wizard-cost>
            <EvalCostLine estimate={estimate} model={d.model} />
            {step === 0 && <span className="text-xs text-muted">Run is on from the next step.</span>}
          </div>
        </div>
      </Modal>
      {generating && (
        <GenerateCasesDialog
          draft={d}
          providers={providers}
          onClose={() => setGenerating(false)}
          onAdd={(records) => {
            const before = { dataset: d.dataset, datasetFormat: d.datasetFormat };
            set({ dataset: casesToJsonl([...datasetRecords(d.dataset, d.datasetFormat), ...records]), datasetFormat: 'jsonl' });
            return () => set(before);
          }}
        />
      )}
    </>
  );
}
