import { useLibraryTabs } from '../lib/library-tabs';
import { LibraryTabStrip, NoOpenItems } from '../components/LibraryTabStrip';
import { ItemBreadcrumb } from '../components/ItemBreadcrumb';
import { refMenu } from '../components/RefLink';
import { RunMiniBar, RunsOverview, type RunRow } from '../components/RunsOverview';
import { BarChart3, Bookmark, Database, FlaskConical, Grid3x3, History, KeyRound, Play, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { useIntent } from '../hooks';
import { call, on } from '../api';
import { persisted, promptText, toastError, useApp, attempt } from '../store';
import type { CheckConfig, ProviderConfig } from '../types';
import { templateVars, timeAgo } from '../lib/format';
import { countDatasetRecords, datasetFormatOf, datasetFormatOfName, previewDatasetRecords } from '@testpion/shared';
import { downloadContent, pickTextFile } from '../lib/files';
import type { RagJudgeSetup, RagTarget } from '@testpion/shared';
import { RagConnectDialog } from '../components/rag/RagConnectDialog';
import { RAG_STARTER_DATASET, RAG_STARTER_EVALUATORS } from '../components/rag/starter';
import { MetricPicker } from '../components/rag/MetricPicker';
import { metricResolver, spendsOnJudge, type MetricCatalogue } from '../components/rag/metric-resolver';
import { RagEstimateDialog } from '../components/rag/RagEstimateDialog';
import { RagEstimateView, useRagEstimate } from '../components/rag/RagEstimate';
import { RagTryDialog } from '../components/rag/RagTryDialog';
import { RagMetricMatrix } from '../components/rag/RagMetricMatrix';
import { RagColumnMapper } from '../components/rag/RagColumnMapper';
import { RagImportDialog } from '../components/rag/RagImportDialog';
import { RagGatesField } from '../components/rag/RagGatesField';
import { RagJudgeOptions } from '../components/rag/RagJudgeOptions';
import { RagAuthorAction } from '../components/rag/RagAuthorAction';
import { useRpc } from '../lib/use-rpc';
import { AssertionEditor } from '../components/AssertionEditor';
import { CodeEditor } from '../components/CodeEditor';
import { RunPanel } from '../components/RunPanel';
import { EvalMatrix } from '../components/EvalMatrix';
import { FolderList } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { useLibrary } from '../lib/library';
import { Badge, Button, Callout, cx, Empty, Field, Input, Segmented, Select, Split, Tabs, NamedOptions } from '../components/ui';
import { EnvBadge } from '../components/EnvSelect';

interface Draft {
  name: string;
  type: 'llm' | 'rag';
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
  limit?: number;
  retries: number;
  /** type rag: the RAG target (a library item id) the questions are sent to; without one the contexts written in the dataset are scored. */
  target?: string;
  /** type rag with a target: the judge of the judged metrics (unset: the AI settings' large model). */
  judge?: RagJudgeSetup;
  maxJudgeCostUsd?: number;
  maxJudgeCalls?: number;
  /** type rag: the lowest mean each metric may have in a run (saved with the evaluation). */
  gates?: Record<string, number>;
}

const drafts = persisted<Draft>('eval', {
  name: 'Intent classification',
  type: 'llm',
  provider: '',
  model: '',
  temperature: 0,
  system: '',
  prompt: 'Classify the customer intent. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\n\nCustomer: {{input}}',
  format: 'json',
  datasetFormat: 'jsonl',
  dataset: '{"input":"Cancel my appointment","expected":"cancellation"}\n{"input":"I need a refill","expected":"refill"}\n{"input":"Can I book for Tuesday?","expected":"booking"}',
  expectedField: 'expected',
  evaluators: [
    { type: 'exact-match', path: '$.intent', expected: '{{expected}}' },
    { type: 'latency', max: 5000 },
  ],
  concurrency: 4,
  retries: 1,
});

/** The estimate of the draft as one line under the metric picker: it follows the choices (asked again after a pause). */
function MetricEstimateLine({ draft, env }: { draft: Draft; env?: string }) {
  const { estimate, error, loading } = useRagEstimate(draft, { environment: env });
  if (error) return <span className="text-bad">{error}</span>;
  if (!estimate) return <span className="text-muted">Estimating …</span>;
  return (
    <span className={loading ? 'opacity-60' : undefined}>
      <RagEstimateView estimate={estimate} compact />
    </span>
  );
}

/** Evaluation Lab: dataset × prompt × model × evaluators, streamed through the test runner. */
/** The editor's language for each dataset format: colours, and each format's own checks (JSONL line by line). */
const EDITOR_LANGUAGE = { json: 'json', jsonl: 'jsonl', csv: 'csv', md: 'markdown' } as const;

export function EvaluationsView() {
  // WF-19: open evaluations are tabs (each its own draft; a single click in the list opens a preview tab)
  const tabs = useLibraryTabs<Draft>('eval', drafts, { canBeEmpty: true });
  const d = tabs.d;
  const setD = tabs.setD;
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [runId, setRunId] = useSticky<string | undefined>('eval:runId', undefined);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sub, setSub] = useSticky<'prompt' | 'dataset' | 'evaluators'>('eval:sub', 'dataset');
  // the right pane: a run (or the overview of runs), or the matrix of runs side by side, case by case
  const [pane, setPane] = useSticky<'runs' | 'matrix' | 'metrics'>('eval:pane', 'runs', { persist: true });
  // dataset files of the workspace (datasets/), offered next to Load file
  const [datasets, setDatasets] = useState<Array<{ path: string; name: string }>>([]);
  useEffect(() => {
    void call<Array<{ path: string; name: string }>>('datasets.list').then((l) => setDatasets(l.filter((x) => /\.(csv|tsv|json|jsonl|ndjson|md)$/i.test(x.name))), () => setDatasets([]));
  }, []);
  const env = useApp((s) => s.environment);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  useEffect(() => {
    void call<ProviderConfig[]>('ai.providers').then((p) => {
      setProviders(p);
      if (!d.provider && p[0]) set({ provider: p[0].id, model: p[0].defaultModel ?? '' });
    });
    const loadRuns = () => void call('runs.list', { limit: 30 }).then((r) => setRuns(r.items), toastError);
    loadRuns();
    // a finished run replaces its placeholder row (passed / total, duration) in the list and the overview
    const off = on<{ runId: string }>('run.finished', () => loadRuns());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saved = useLibrary<Draft>('evaluations');
  const ragTargets = useLibrary<RagTarget>('rag-targets');
  const [connect, setConnect] = useState(false);
  // RAG evaluations: the metric catalogue (what each evaluator is), the dialogs, and the estimate before a run
  const [estimating, setEstimating] = useState(false);
  const [tryCheck, setTryCheck] = useState<CheckConfig>();
  const [mapper, setMapper] = useState(false);
  const [importing, setImporting] = useState(false);
  const catalogue = useRpc<MetricCatalogue>('rag.metrics', undefined, { keep: true });
  const resolveMetric = useMemo(() => metricResolver(catalogue?.metrics ?? []), [catalogue]);
  /** The target the evaluation calls (type rag): its questions go to that system, and the model fields become the judge. */
  const ragTarget = d.type === 'rag' ? ragTargets.lib.items.find((i) => i.id === d.target) : undefined;
  const setType = (type: Draft['type']) => {
    // a new RAG evaluation starts with RAG records and metrics instead of the intent-classification example
    const untouched = JSON.stringify(d.evaluators) === JSON.stringify(drafts.defaults.evaluators);
    set({ type, ...(type === 'rag' && untouched ? { evaluators: RAG_STARTER_EVALUATORS, ...(d.dataset === drafts.defaults.dataset ? { dataset: RAG_STARTER_DATASET } : {}) } : {}) });
  };
  const exportRag = async (to: 'ragas' | 'deepeval') => {
    await attempt(async () => {
      const r = await call<{ text: string; count: number }>('rag.convert', { text: d.dataset, name: `dataset.${d.datasetFormat}`, to });
      downloadContent(`${(d.name || 'dataset').replace(/[^\w.-]+/g, '-')}-${to}.jsonl`, r.text, { type: 'application/x-ndjson' });
    });
  };
  const savedId = tabs.active.savedId;
  const current = saved.lib.items.find((i) => i.id === savedId);
  const dirty = useMemo(() => !!current && JSON.stringify(current.data) !== JSON.stringify(d), [current, d]);
  const openSaved = async (id: string, preview = false) => {
    const it = await saved.find(id);
    if (!it) return undefined;
    tabs.open(id, { ...drafts.defaults, ...it.data, name: it.name }, { preview });
    return it;
  };
  const saveEval = async (asNew = false, folder?: string) => {
    if (current && !asNew) {
      await saved.put({ ...current, name: d.name || current.name, data: d });
      useApp.getState().toast(`Saved "${d.name || current.name}"`, 'success');
      return;
    }
    const name = await promptText('Save evaluation', { message: 'Name', value: d.name || 'Evaluation', okLabel: 'Save' });
    if (!name) return;
    set({ name });
    tabs.setSaved(await saved.put({ name, folder, data: { ...d, name } }));
  };
  // the Collections explorer / search open a saved evaluation
  useIntent('evaluations', (p) => p?.savedId && void openSaved(p.savedId));
  const evalRuns = useMemo(() => {
    const names = new Set(saved.lib.items.map((i) => i.name));
    return runs.filter((r) => names.has(r.name) || r.name === d.name);
  }, [runs, saved.lib.items, d.name]);
  // the format the text really has: JSON whose text is one object per line is read as JSONL (the editor checks it as such too)
  const readAs = useMemo(() => datasetFormatOf(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const count = useMemo(() => countDatasetRecords(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const preview = useMemo(() => previewDatasetRecords(d.dataset, d.datasetFormat), [d.dataset, d.datasetFormat]);
  const previewKeys = useMemo(() => (preview[0] ? Object.keys(preview[0]) : []), [preview]);
  const vars = useMemo(() => templateVars(d.prompt), [d.prompt]);
  // the saved list's rows (a dataset is counted when the library changes, not on every keystroke)
  const savedItems = useMemo(
    () =>
      saved.lib.items.map((i) => ({
        id: i.id,
        name: i.name,
        folder: i.folder,
        subtitle: `${i.data.model || i.data.provider || 'model'} · ${countDatasetRecords(i.data.dataset ?? '', i.data.datasetFormat ?? 'jsonl')} cases`,
        icon: <FlaskConical size={12} className="text-muted" />,
      })),
    [saved.lib.items],
  );

  /** A run that asks a judge or an embedding model is estimated first (calls, tokens, cost, caps); a run of free metrics starts at once. */
  const spends = d.type === 'rag' && !!ragTarget && d.evaluators.some((e) => spendsOnJudge(resolveMetric(e.type), e));
  const run = () => (spends ? setEstimating(true) : void runDraft(d));
  const runDraft = async (d: Draft) => {
    await attempt(async () => {
      // the engine builds the test template, exactly as `testpion eval run` and the run_evaluation MCP tool do
      const r = await call<{ runId: string }>('eval.runDraft', { draft: d, environment: env });
      setRunId(r.runId);
      setPane('runs');
      setRuns((rs) => [{ id: r.runId, name: d.name, startedAt: new Date().toISOString(), passed: 0, total: 0, failed: 0, errors: 0 }, ...rs]);
    });
  };

  return (
    <Split id="eval-sidebar" sidebar initial={18} min={12}>
      <SidebarShell
        id="evaluations"
        panes={[
          {
            id: 'saved',
            label: 'Saved',
            icon: <Bookmark size={13} />,
            render: () => (
              <FolderList
                id="eval-saved"
                kind="evaluation"
                title="Saved evaluations"
                itemNoun="evaluation"
                addLabel="Save current evaluation"
                folders={saved.lib.folders}
                selected={savedId}
                onSelect={(id) => void openSaved(id, true)}
                onOpen={(id) => void openSaved(id)}
                onAdd={(folder) => void saveEval(true, folder)}
                ops={saved.ops}
                itemActions={(id) => ({
                  on: {
                    run: () =>
                      void openSaved(id).then((it) => {
                        if (it) void runDraft({ ...drafts.load(), ...it.data, name: it.name });
                      }),
                  },
                })}
                items={savedItems}
                empty={
                  <Empty title="No saved evaluations" actions={[{ label: 'Save this evaluation', icon: <Save size={13} />, onClick: () => void saveEval(true) }]}>
                    Save an evaluation (dataset, prompt, model and evaluators) to run it again whenever you need, and group evaluations in folders.
                  </Empty>
                }
              />
            ),
          },
          { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
          {
            id: 'runs',
            label: 'Runs',
            icon: <History size={13} />,
            render: () => (
              <div className="flex-1 overflow-auto">
                {runId && evalRuns.length > 0 && (
                  <button className="w-full flex items-center gap-1.5 px-3 py-1.5 border-b border-line text-xs text-accent hover:bg-hover text-left" onClick={() => setRunId(undefined)}>
                    <BarChart3 size={12} /> Overview of all runs
                  </button>
                )}
                {evalRuns.map((r) => (
                  <button key={r.id} className={cx('w-full text-left px-3 py-2 border-b border-line/60 text-sm', runId === r.id ? 'bg-accent/10' : 'hover:bg-hover')} onClick={() => (setRunId(r.id), setPane('runs'))}>
                    <div className="truncate">{r.name}</div>
                    <RunMiniBar r={r} />
                    <div className="text-xs text-muted flex gap-2">
                      {r.total ? <span className={r.failed + r.errors ? 'text-bad' : 'text-ok'}>{r.passed}/{r.total} passed</span> : null}
                      {r.environment && <EnvBadge name={r.environment} className="max-w-32" />}
                      <span className="ml-auto">{timeAgo(r.startedAt)}</span>
                    </div>
                  </button>
                ))}
                {!evalRuns.length && (
                  <Empty icon={<History size={22} />} title="No runs yet" actions={[{ label: 'Run this evaluation', icon: <Play size={13} />, onClick: () => void run() }]}>
                    Runs of your evaluations appear here.
                  </Empty>
                )}
              </div>
            ),
          },
        ]}
      />
    <div className="h-full flex flex-col min-w-0">
    {connect && <RagConnectDialog onClose={() => setConnect(false)} onSaved={(id) => void ragTargets.reload().then(() => set({ target: id }))} />}
    {estimating && (
      <RagEstimateDialog
        draft={d as never}
        hasTarget={!!ragTarget}
        firstQuestion={String(preview[0]?.question ?? preview[0]?.query ?? preview[0]?.input ?? preview[0]?.user_input ?? '') || undefined}
        onClose={() => setEstimating(false)}
        onRun={(freeFirst) => (setEstimating(false), void runDraft(freeFirst ? { ...d, evaluators: d.evaluators.filter((e) => !spendsOnJudge(resolveMetric(e.type), e)) } : d))}
      />
    )}
    {tryCheck && <RagTryDialog check={tryCheck} target={d.target} question={String(preview[0]?.question ?? preview[0]?.query ?? preview[0]?.input ?? preview[0]?.user_input ?? '') || undefined} judge={d.judge} evaluation={savedId} onClose={() => setTryCheck(undefined)} />}
    {mapper && <RagColumnMapper dataset={d.dataset} format={readAs} onApply={(dataset) => set({ dataset, datasetFormat: 'jsonl' })} onClose={() => setMapper(false)} />}
    {importing && <RagImportDialog onImport={(dataset) => set({ dataset, datasetFormat: 'jsonl' })} onClose={() => setImporting(false)} />}
    <LibraryTabStrip
      label="Open evaluations"
      library="evaluations"
      tabs={tabs.tabs}
      active={tabs.active.id}
      titleOf={(t) => saved.lib.items.find((i) => i.id === t.savedId)?.name ?? (t.id === tabs.active.id && d.name ? d.name : 'New evaluation')}
      dirty={dirty}
      onSelect={tabs.select}
      onClose={(ids) => tabs.close(ids, drafts.defaults)}
      onKeep={tabs.keep}
      onNew={() => tabs.newTab(drafts.defaults)}
      newLabel="New evaluation"
    />
    <div className="flex-1 min-h-0">
    {tabs.empty ? (
      <NoOpenItems icon={FlaskConical} title="No open evaluations" newLabel="New evaluation" onNew={() => tabs.newTab(drafts.defaults)}>
        Open a saved evaluation from the list, or start a new one.
      </NoOpenItems>
    ) : (
    <Split id="eval-main" initial={42}>
      <div className="h-full flex flex-col">
        {/* WF-11: Evaluations › folder › evaluation, like every item view */}
        <ItemBreadcrumb
          label="Where this evaluation is"
          crumbs={[{ label: 'Evaluations' }, ...(current?.folder ? [{ label: current.folder }] : [])]}
          name={current ? current.name : 'Not saved yet'}
          dirty={dirty}
          actions={current ? refMenu({ kind: 'saved', library: 'evaluations', itemId: current.id }) : undefined}
        />
        <div className="p-2 border-b border-line flex flex-col gap-2">
          <div className="flex gap-2 flex-wrap">
            <Input className="flex-1 min-w-40 font-medium" value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Evaluation name" />
            <Select value={d.type} onChange={(e) => setType(e.target.value as Draft['type'])} aria-label="Evaluation type">
              <option value="llm">Prompt / LLM</option>
              <option value="rag">RAG</option>
            </Select>
            <Button className="shrink-0" icon={<Save size={13} />} title={current ? `Save changes to "${current.name}"` : 'Save this evaluation to run it again later'} onClick={() => void saveEval()}>
              {current && dirty ? 'Save*' : 'Save'}
            </Button>
            <Button variant="primary" className="shrink-0" icon={<Play size={13} />} onClick={run} disabled={!count || (!ragTarget && !d.provider)} data-eval-run>
              Run {count ? `${d.limit ? Math.min(d.limit, count) : count} cases` : ''}
            </Button>
          </div>
          {d.type === 'rag' && (
            <div className="flex items-end gap-2" data-rag-target-row>
              <Field label="RAG target" className="flex-1 min-w-0" hint={ragTarget ? undefined : 'Without a target the contexts and answers written in the dataset are scored.'}>
                <Select value={d.target ?? ''} onChange={(e) => set({ target: e.target.value || undefined })} aria-label="RAG target" data-rag-target>
                  <option value="">None: score what the dataset holds</option>
                  <NamedOptions items={ragTargets.lib.items} />
                </Select>
              </Field>
              <Button icon={<Database size={13} />} onClick={() => setConnect(true)} title="Connect a RAG system: request, probe, click-to-map" data-rag-connect-open>
                Connect…
              </Button>
            </div>
          )}
          {d.type === 'rag' && ragTarget && <RagAuthorAction target={ragTarget.name} />}
          {/* two rows, so the fields fit however narrow the pane is */}
          {ragTarget ? (
            <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0" data-rag-judge>
              <Field label="Judge provider" hint="Judged metrics only">
                <Select value={d.judge?.provider ?? ''} onChange={(e) => set({ judge: { ...d.judge, provider: e.target.value || undefined, model: providers.find((p) => p.id === e.target.value)?.defaultModel || undefined } })} aria-label="Judge provider">
                  <option value="">The AI settings’ large model</option>
                  <NamedOptions items={providers} />
                </Select>
              </Field>
              <Field label="Judge model">
                <Input className="mono" value={d.judge?.model ?? ''} placeholder="the provider’s default" onChange={(e) => set({ judge: { ...d.judge, model: e.target.value || undefined } })} aria-label="Judge model" />
              </Field>
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
            <Field label="Provider">
              <Select value={d.provider} onChange={(e) => set({ provider: e.target.value, model: providers.find((p) => p.id === e.target.value)?.defaultModel ?? '' })}>
                <NamedOptions items={providers} />
              </Select>
            </Field>
            <Field label="Model">
              <Input className="mono" value={d.model} onChange={(e) => set({ model: e.target.value })} />
            </Field>
          </div>
          )}
          {ragTarget && <RagJudgeOptions judge={d.judge ?? {}} maxCostUsd={d.maxJudgeCostUsd} maxCalls={d.maxJudgeCalls} providers={providers} onChange={set} />}
          <div className="grid grid-cols-4 gap-2 [&>*]:min-w-0">
            <Field label="Temp.">
              <Input type="number" step="0.1" value={d.temperature ?? ''} onChange={(e) => set({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </Field>
            <Field label="Workers">
              <Input type="number" min={1} max={64} value={d.concurrency} onChange={(e) => set({ concurrency: Math.max(1, Number(e.target.value)) })} />
            </Field>
            <Field label="Retries">
              <Input type="number" min={0} value={d.retries} onChange={(e) => set({ retries: Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Limit">
              <Input type="number" value={d.limit ?? ''} placeholder="all" onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
          </div>
        </div>
        <Tabs
          value={sub}
          onChange={setSub}
          tabs={[
            { id: 'dataset', label: 'Dataset', badge: count },
            ...(ragTarget ? [] : [{ id: 'prompt' as const, label: d.type === 'rag' ? 'Prompt (optional)' : 'Prompt' }]),
            { id: 'evaluators', label: d.type === 'rag' ? 'Metrics' : 'Evaluators', badge: d.evaluators.length },
          ]}
        />
        <div className="flex-1 min-h-0">
          {(sub === 'dataset' || (sub === 'prompt' && ragTarget)) && (
            <div className="h-full flex flex-col">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm border-b border-line">
                {(['jsonl', 'json', 'csv', 'md'] as const).map((f) => (
                  <label key={f} className="flex items-center gap-1">
                    <input type="radio" checked={d.datasetFormat === f} onChange={() => set({ datasetFormat: f })} /> {f.toUpperCase()}
                  </label>
                ))}
                <label className="ml-auto flex items-center gap-1 text-xs text-muted whitespace-nowrap">
                  expected field
                  <Input className="h-6 min-h-6 w-24 text-xs" value={d.expectedField} onChange={(e) => set({ expectedField: e.target.value })} />
                </label>
                {d.type === 'rag' && (
                  <>
                    <Button size="sm" onClick={() => setImporting(true)} title="Read a dataset of another tool (Ragas, DeepEval, BEIR, NVIDIA, promptfoo; only data is read) as RAG records" data-rag-import>
                      Import…
                    </Button>
                    <Button size="sm" onClick={() => setMapper(true)} title="Choose which column is the question, the reference answer, the gold chunk ids …" data-rag-map-columns>
                      Map columns…
                    </Button>
                    <Select className="h-7 min-h-7 py-0 text-xs max-w-32" aria-label="Export the dataset" value="" onChange={(e) => e.target.value && void exportRag(e.target.value as 'ragas' | 'deepeval')}>
                      <option value="">Export as…</option>
                      <option value="ragas">Ragas</option>
                      <option value="deepeval">DeepEval</option>
                    </Select>
                  </>
                )}
                <Button
                  size="sm"
                  onClick={() =>
                    void pickTextFile('.jsonl,.json,.csv,.tsv,.md,.ndjson').then((f) => f && set({ dataset: f.text, datasetFormat: datasetFormatOfName(f.name) ?? 'jsonl' }))
                  }
                >
                  Load file…
                </Button>
                {datasets.length > 0 && (
                  <Select
                    className="h-7 min-h-7 py-0 text-xs max-w-48"
                    aria-label="Load a workspace dataset"
                    value=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      try {
                        const r = await call<{ name: string; text: string }>('datasets.read', { path: e.target.value });
                        set({ dataset: r.text, datasetFormat: datasetFormatOfName(r.name) ?? 'jsonl' });
                      } catch (err) {
                        toastError(err);
                      }
                    }}
                  >
                    <option value="">or a workspace dataset…</option>
                    {datasets.map((x) => (
                      <option key={x.path} value={x.path}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {readAs !== d.datasetFormat && (
                <Callout
                  tone="warn"
                  className="m-2 mb-0"
                  data-format-mismatch="jsonl"
                  action={
                    <Button size="sm" onClick={() => set({ datasetFormat: readAs })}>
                      Switch to {readAs.toUpperCase()}
                    </Button>
                  }
                >
                  This text has one JSON object per line, so it is read as {readAs.toUpperCase()}, not as one JSON document.
                </Callout>
              )}
              <div className="flex-1 min-h-0">
                <Split id="eval-dataset" direction="vertical" initial={65}>
                  <CodeEditor language={EDITOR_LANGUAGE[readAs]} value={d.dataset} onChange={(dataset) => set({ dataset })} />
                  <div className="h-full overflow-auto p-2 text-xs">
                    <div className="text-muted mb-1">
                      Preview · {count} records · each record's fields are available as {'{{field}}'} in the prompt and evaluators
                      {d.type === 'rag' && (ragTarget ? ' · RAG records: question, reference (the expected answer), reference_ids (the gold document ids), reference_contexts' : ' · RAG records need question, contexts [{id,text}] and optionally answer/expected')}
                    </div>
                    {preview.length > 0 && (
                      <table className="w-full">
                        <thead>
                          <tr>
                            {previewKeys.map((k) => (
                              <th key={k} className={cx('text-left px-1 font-medium', vars.includes(k) || k === d.expectedField ? 'text-accent' : 'text-muted')}>
                                {k}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map((r, i) => (
                            <tr key={i} className="border-t border-line">
                              {previewKeys.map((k) => (
                                <td key={k} className="px-1 py-0.5 mono truncate max-w-48">
                                  {typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </Split>
              </div>
            </div>
          )}
          {sub === 'prompt' && !ragTarget && (
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-3 px-3 py-1.5 text-sm border-b border-line">
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={d.format === 'json'} onChange={(e) => set({ format: e.target.checked ? 'json' : 'text' })} /> JSON output
                </label>
                <span className="text-xs text-muted">
                  Variables: {vars.map((v) => (
                    <Badge key={v} tone={preview[0] && v in preview[0] ? 'accent' : 'bad'}>
                      {v}
                    </Badge>
                  ))}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                <CodeEditor language="markdown" value={d.prompt} onChange={(prompt) => set({ prompt })} />
              </div>
            </div>
          )}
          {sub === 'evaluators' && (
            <div className="overflow-auto h-full">
              <p className="px-3 pt-3 text-xs text-muted">
                Deterministic checks are the source of truth for deterministic requirements. Similarity/RAG heuristics are approximate; LLM-judge scores are model-generated and labelled as such.
              </p>
              {ragTarget && d.evaluators.some((e) => spendsOnJudge(resolveMetric(e.type), e)) && (
                <Callout tone="accent" className="mx-3 mt-2" data-rag-judge-note>
                  {d.judge?.provider ? `Judged metrics ask ${providers.find((p) => p.id === d.judge?.provider)?.name ?? d.judge.provider}${d.judge.model ? ` / ${d.judge.model}` : ''}.` : 'Judged metrics ask the AI settings’ large model.'} The run stops before the first question, and says what to configure, when no judge is set. Verdicts are kept: running again costs nothing.
                </Callout>
              )}
              {d.type === 'rag' ? (
                <MetricPicker
                  evaluators={d.evaluators}
                  onChange={(evaluators) => set({ evaluators })}
                  columns={previewKeys}
                  hasTarget={!!ragTarget}
                  onTry={setTryCheck}
                  footer={ragTarget ? <MetricEstimateLine draft={d} env={env} /> : <span className="text-muted">Choose a RAG target to see what a run costs.</span>}
                />
              ) : (
                <AssertionEditor checks={d.evaluators} onChange={(evaluators) => set({ evaluators })} groups={['Body', 'AI', 'RAG', 'Safety', 'Response']} />
              )}
              {/* the gates belong to the metrics: under the picker, so the form above it keeps its height */}
              {d.type === 'rag' && ragTarget && (
                <div className="px-3 pb-3">
                  <RagGatesField gates={d.gates} onChange={(gates) => set({ gates })} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="h-full flex flex-col min-h-0">
        {evalRuns.length > 0 && (
          <div className="flex items-center gap-2 px-2 py-1 border-b border-line">
            <Segmented
              label="Results"
              size="xs"
              value={pane}
              onChange={setPane}
              options={[
                { value: 'runs', label: runId ? 'Run' : 'Runs', icon: <History size={12} /> },
                { value: 'matrix', label: 'Matrix', icon: <Grid3x3 size={12} />, title: 'Runs side by side, case by case, against a baseline' },
                ...(d.type === 'rag' ? [{ value: 'metrics' as const, label: 'Metrics', icon: <BarChart3 size={12} />, title: 'The samples of a run against every metric, with each metric’s mean, interval and distribution' }] : []),
              ]}
            />
          </div>
        )}
        {pane === 'metrics' && d.type === 'rag' && evalRuns.length > 0 ? (
          <div className="flex-1 min-h-0">
            {runId ? (
              <RagMetricMatrix runId={runId} evaluationName={d.name} target={d.target} judge={d.judge} runs={evalRuns} evaluators={d.evaluators} evaluation={savedId} providers={providers} onRescored={(id) => (setRunId(id), void call('runs.list', { limit: 30 }).then((r) => setRuns(r.items), toastError))} />
            ) : (
              <Empty icon={<BarChart3 size={26} />} title="Choose a run">
                Pick a run in the Runs list to see its samples against every metric.
              </Empty>
            )}
          </div>
        ) : pane === 'matrix' && evalRuns.length > 0 ? (
          <div className="flex-1 min-h-0">
            <EvalMatrix runs={evalRuns} />
          </div>
        ) : runId ? (
          <RunPanel runId={runId} expectedTotal={d.limit ? Math.min(d.limit, count) : count} />
        ) : (
          <div className="h-full flex flex-col">
            {evalRuns.length ? (
              // earlier runs of these evaluations: pass rate and duration, click one to open it
              <RunsOverview scores runs={evalRuns} onSelect={setRunId} />
            ) : (
              <Empty
                icon={<FlaskConical size={28} />}
                title="Run an evaluation"
                actions={[{ label: `Run ${count ? `${d.limit ? Math.min(d.limit, count) : count} cases` : ''}`.trim(), icon: <Play size={12} />, onClick: run, disabled: !count }]}
              >
                An evaluation runs every record of the dataset through the prompt and the model, and scores each answer with the evaluators. Records stream with bounded concurrency, retries and rate limiting; the results are kept on disk and can be compared with a baseline.
              </Empty>
            )}
          </div>
        )}
      </div>
    </Split>
    )}
    </div>
    </div>
    </Split>
  );
}
