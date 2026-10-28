import { useLibraryTabs } from '../lib/library-tabs';
import { LibraryTabStrip, NoOpenItems } from '../components/LibraryTabStrip';
import { ItemBreadcrumb } from '../components/ItemBreadcrumb';
import { openItemMenu } from '../lib/item-menu';
import { deleteWithUndo } from '../lib/undo-delete';
import { RunMiniBar, RunsOverview, type RunRow } from '../components/RunsOverview';
import { BarChart3, Bookmark, Database, FlaskConical, Grid3x3, History, KeyRound, Play, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { useIntent } from '../hooks';
import { call, on } from '../api';
import { persisted, promptText, toastError, useApp, attempt } from '../store';
import type { CheckConfig, ProviderConfig } from '../types';
import { templateVars, timeAgo } from '../lib/format';
import { countDatasetRecords, datasetFormatOf, previewDatasetRecords } from '@testpion/shared';
import { downloadContent } from '../lib/files';
import { CasesPane } from '../components/ai/CasesPane';
import { GoodAnswerPicker } from '../components/ai/GoodAnswerPicker';
import { EvalCostLine } from '../components/ai/EvalCostLine';
import { EvalRunHeadline } from '../components/ai/EvalRunHeadline';
import { SpendDialog } from '../components/ai/SpendDialog';
import { shortCost, useEvalEstimate, type EvalEstimateResult } from '../lib/eval-estimate';
import { formatCost } from '../lib/format';
import type { TryCheckResult } from '@testpion/core';
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
import { ensureOfflineDemo, OFFLINE_DEMO_LABEL, OFFLINE_DEMO_NOTE } from '../lib/offline-demo';
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
  /** A prompt evaluation: the run stops once it has cost this much (USD). Unset: $1.00 on a paid model, none on the offline demo model; 0: no cap. */
  maxCostUsd?: number;
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
export function EvaluationsView() {
  // WF-19: open evaluations are tabs (each its own draft; a single click in the list opens a preview tab)
  const tabs = useLibraryTabs<Draft>('eval', drafts, { canBeEmpty: true });
  const d = tabs.d;
  const setD = tabs.setD;
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  // (a callout about a missing model waits until the providers are known)
  const [providersKnown, setProvidersKnown] = useState(false);
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
  // what a run costs, said beside Run before it starts (AU-5); a run over $0.50 asks once (AU-18)
  const estimate = useEvalEstimate(d, env);
  const [asking, setAsking] = useState<{ draft: Draft; estimate: EvalEstimateResult }>();
  useEffect(() => {
    void call<ProviderConfig[]>('ai.providers').then((p) => {
      setProviders(p);
      setProvidersKnown(true);
      if (!d.provider && p[0]) set({ provider: p[0].id, model: p[0].defaultModel ?? '' });
    }, () => setProvidersKnown(true));
    const loadRuns = () => void call('runs.list', { limit: 30 }).then((r) => setRuns(r.items), toastError);
    loadRuns();
    // a finished run replaces its placeholder row (passed / total, duration) in the list and the overview
    const off = on<{ runId: string }>('run.finished', () => loadRuns());
    // the providers change elsewhere too (AI Lab ▸ Providers, a file edited on disk): the note about a missing model follows
    const offData = on('data.changed', () => void call<ProviderConfig[]>('ai.providers').then(setProviders, () => undefined));
    return () => (off(), offData());
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
  /** The open evaluation's ⋯ (its breadcrumb): its menu as its row in the list has it (lib/node-menu.ts): rename, duplicate, Delete… with Undo (its tab closes). */
  const currentMenu = (c: NonNullable<typeof current>) =>
    openItemMenu('evaluation', {
      ref: { kind: 'saved', library: 'evaluations', itemId: c.id },
      name: c.name,
      on: {
        rename: async () => {
          const name = (await promptText('Rename evaluation', { message: 'Evaluation name', value: c.name, okLabel: 'Rename' }))?.trim();
          if (name && name !== c.name) await saved.ops.renameItem(c.id, name);
        },
        duplicate: () => void saved.ops.duplicateItem?.(c.id),
        delete: () =>
          void deleteWithUndo({
            kind: 'evaluation',
            name: c.name,
            run: async () => {
              const undo = await saved.ops.deleteItem(c.id);
              tabs.close(tabs.tabs.filter((t) => t.savedId === c.id).map((t) => t.id), drafts.defaults);
              return undo;
            },
          }),
      },
    });
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
  useIntent('evaluations', (p) => {
    if (p?.new) tabs.newTab(drafts.defaults);
    if (p?.sample) void trySample();
    else if (p?.savedId)
      void openSaved(p.savedId).then(() => {
        if (p.runId) (setRunId(p.runId), setPane('runs'));
      });
  });
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

  /** What stops a run, with its one-click remedy (AU-8): Run is never disabled without one. */
  const problem: 'cases' | 'model' | undefined = !count ? 'cases' : !ragTarget && providersKnown && !providers.some((x) => x.id === d.provider) ? 'model' : undefined;
  const useDemo = async () => {
    await attempt(async () => {
      const r = await ensureOfflineDemo(providers);
      setProviders(await call<ProviderConfig[]>('ai.providers'));
      set({ provider: r.provider.id, model: r.provider.defaultModel ?? 'demo' });
      useApp.getState().toast('Using the offline demo model. Its answers come from rules, so use it to try things out.', 'success');
    });
  };
  const addExampleCases = () => set(d.type === 'rag' ? { dataset: RAG_STARTER_DATASET, datasetFormat: 'jsonl' } : { dataset: drafts.defaults.dataset, datasetFormat: 'jsonl', expectedField: drafts.defaults.expectedField });
  const remedy = problem === 'cases' ? { label: 'Add example cases', onClick: addExampleCases } : problem === 'model' ? { label: OFFLINE_DEMO_LABEL, onClick: () => void useDemo() } : undefined;
  /** A run that asks a judge or an embedding model is estimated first (calls, tokens, cost, caps); a run of free metrics starts at once. */
  const spends = d.type === 'rag' && !!ragTarget && d.evaluators.some((e) => spendsOnJudge(resolveMetric(e.type), e));
  const run = () => (spends ? setEstimating(true) : void startRun(d));
  /** Estimate first: a prompt evaluation over $0.50 (or 100 calls) asks once before it sends anything. */
  const startRun = async (x: Draft) => {
    if (x.type === 'llm') {
      const est = await call<EvalEstimateResult>('eval.estimate', { draft: x, environment: env }).catch(() => undefined);
      if (est?.plan.ask) return setAsking({ draft: x, estimate: est });
    }
    await runDraft(x);
  };
  const runDraft = async (d: Draft, confirm = false) => {
    await attempt(async () => {
      // the engine builds the test template, exactly as `testpion eval run` and the run_evaluation MCP tool do
      const r = await call<{ runId: string }>('eval.runDraft', { draft: d, environment: env, ...(confirm ? { confirm } : {}) });
      setRunId(r.runId);
      setPane('runs');
      setRuns((rs) => [{ id: r.runId, name: d.name, startedAt: new Date().toISOString(), passed: 0, total: 0, failed: 0, errors: 0 }, ...rs]);
    });
  };
  /** Try the sample (AU-4): the offline demo model and a 10-case evaluation are made, opened and run. */
  const trySample = async () => {
    await attempt(async () => {
      const r = await call<{ runId: string; evaluation: string }>('ai.sample');
      setProviders(await call<ProviderConfig[]>('ai.providers'));
      await saved.reload();
      await openSaved(r.evaluation);
      setRunId(r.runId);
      setPane('runs');
      setRuns((rs) => [{ id: r.runId, name: 'Sample: support intents', startedAt: new Date().toISOString(), passed: 0, total: 0, failed: 0, errors: 0 }, ...rs]);
    });
  };
  /** Try one check on one case (AU-11). */
  const tryCheckOnCase = (check: CheckConfig, caseNumber: number, dryRun: boolean) => call<TryCheckResult>('eval.tryCheck', { draft: d, check, caseNumber, dryRun, environment: env });
  const offline = providers.find((p) => p.id === d.provider)?.kind === 'mock';

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
                        if (it) void startRun({ ...drafts.load(), ...it.data, name: it.name });
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
                  <button key={r.id} className={cx('w-full text-left px-3 py-2 border-b border-line/60 text-sm', runId === r.id ? 'bg-accent-soft' : 'hover:bg-hover')} onClick={() => (setRunId(r.id), setPane('runs'))}>
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
    {asking && <SpendDialog estimate={asking.estimate} onClose={() => setAsking(undefined)} onRun={() => (setAsking(undefined), void runDraft(asking.draft, true))} />}
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
          actions={current ? currentMenu(current) : undefined}
        />
        <div className="p-2 border-b border-line flex flex-col gap-2">
          <div className="flex gap-2 flex-wrap">
            <Input className="flex-1 min-w-40 font-medium" value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Evaluation name" />
            <Select value={d.type} onChange={(e) => setType(e.target.value as Draft['type'])} aria-label="Evaluation type">
              <option value="llm">Prompt or chatbot</option>
              <option value="rag">Bot with sources</option>
            </Select>
            <Button className="shrink-0" icon={<Save size={13} />} title={current ? `Save changes to "${current.name}"` : 'Save this evaluation to run it again later'} onClick={() => void saveEval()}>
              {current && dirty ? 'Save*' : 'Save'}
            </Button>
            <Button variant="primary" className="shrink-0" icon={<Play size={13} />} onClick={run} disabled={!!problem || (!ragTarget && !d.provider)} reason={!count ? 'There are no test cases yet: add example cases' : 'Choose a model first: use the offline demo model'} data-eval-run>
              Run {count ? `${d.limit ? Math.min(d.limit, count) : count} cases` : ''}
              {d.type === 'llm' && count > 0 && shortCost(estimate, formatCost) ? ` · ${shortCost(estimate, formatCost)}` : ''}
            </Button>
          </div>
          {d.type === 'llm' && count > 0 && <EvalCostLine estimate={estimate} model={d.model} />}
          {problem && remedy && (
            <Callout
              tone="warn"
              data-eval-problem={problem}
              action={
                <Button size="sm" variant="primary" onClick={remedy.onClick} data-eval-remedy>
                  {remedy.label}
                </Button>
              }
            >
              {problem === 'cases' ? 'There are no test cases to run yet. Add the example cases, or paste your own on the Test cases tab.' : `Choose a model first, or use the offline demo model. ${OFFLINE_DEMO_NOTE}`}
            </Callout>
          )}
          {d.type === 'rag' && (
            <div className="flex items-end gap-2" data-rag-target-row>
              <Field label="My bot" className="flex-1 min-w-0" hint={ragTarget ? undefined : 'Without a bot, the sources and answers written in the test cases are scored.'}>
                <Select value={d.target ?? ''} onChange={(e) => set({ target: e.target.value || undefined })} aria-label="My bot" data-rag-target>
                  <option value="">None: score what the test cases hold</option>
                  <NamedOptions items={ragTargets.lib.items} />
                </Select>
              </Field>
              <Button icon={<Database size={13} />} onClick={() => setConnect(true)} title="Connect your bot: its request, a test call, then click where the answer is" data-rag-connect-open>
                Connect…
              </Button>
            </div>
          )}
          {d.type === 'rag' && ragTarget && <RagAuthorAction target={ragTarget.name} />}
          {!ragTarget && (
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
          {/* AU-6: the settings an expert changes sit under Options, closed; the defaults are fine for a first run */}
          <details className="text-xs rounded-lg border border-line px-2 py-1" data-eval-options>
            <summary className="cursor-pointer text-muted select-none">
              Options
              <span className="ml-1">
                · randomness {d.temperature ?? 'default'} · {d.concurrency} at once · try again {d.retries}× · {d.limit ? `first ${d.limit} cases` : 'all cases'}
              </span>
            </summary>
            <div className="grid gap-2 mt-2 pb-1">
              {ragTarget && (
                <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0" data-rag-judge>
                  <Field label="AI reviewer provider" hint="Only for checks an AI reviewer grades">
                    <Select value={d.judge?.provider ?? ''} onChange={(e) => set({ judge: { ...d.judge, provider: e.target.value || undefined, model: providers.find((p) => p.id === e.target.value)?.defaultModel || undefined } })} aria-label="AI reviewer provider">
                      <option value="">The AI settings’ large model</option>
                      <NamedOptions items={providers} />
                    </Select>
                  </Field>
                  <Field label="AI reviewer model">
                    <Input className="mono" value={d.judge?.model ?? ''} placeholder="the provider’s default" onChange={(e) => set({ judge: { ...d.judge, model: e.target.value || undefined } })} aria-label="AI reviewer model" />
                  </Field>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
                <Field label="Randomness" hint="0 gives the same answer every time">
                  <Input type="number" step="0.1" value={d.temperature ?? ''} onChange={(e) => set({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </Field>
                <Field label="Run at once" hint="How many cases are sent together">
                  <Input type="number" min={1} max={64} value={d.concurrency} onChange={(e) => set({ concurrency: Math.max(1, Number(e.target.value)) })} />
                </Field>
                <Field label="Try again on errors" hint="How many times a failed call is repeated">
                  <Input type="number" min={0} value={d.retries} onChange={(e) => set({ retries: Math.max(0, Number(e.target.value)) })} />
                </Field>
                <Field label="Only the first … cases" hint="Leave empty to run them all">
                  <Input type="number" value={d.limit ?? ''} placeholder="all" onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })} />
                </Field>
                {d.type === 'llm' && (
                  <Field label="Spend cap (USD)" hint="The run stops once it has cost this much. Empty: $1.00 on a paid model, none on the offline demo model. 0: no cap">
                    <Input type="number" min={0} step="0.1" value={d.maxCostUsd ?? ''} placeholder="1.00" onChange={(e) => set({ maxCostUsd: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} aria-label="Spend cap in dollars" data-eval-cap />
                  </Field>
                )}
              </div>
            </div>
          </details>
        </div>
        <Tabs label="Evaluation"
          value={sub}
          onChange={setSub}
          tabs={[
            { id: 'dataset', label: 'Test cases', badge: count },
            ...(ragTarget ? [] : [{ id: 'prompt' as const, label: d.type === 'rag' ? 'Prompt (optional)' : 'Prompt' }]),
            { id: 'evaluators', label: d.type === 'rag' ? 'Metrics' : 'Checks', badge: d.evaluators.length },
          ]}
        />
        <div className="flex-1 min-h-0">
          {(sub === 'dataset' || (sub === 'prompt' && ragTarget)) && (
            <CasesPane
              d={d}
              set={(p) => set(p)}
              count={count}
              readAs={readAs}
              preview={preview}
              previewKeys={previewKeys}
              vars={vars}
              ragTarget={!!ragTarget}
              datasets={datasets}
              onImport={() => setImporting(true)}
              onMap={() => setMapper(true)}
              onExportRag={(to) => void exportRag(to)}
              onExample={addExampleCases}
            />
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
                Checks with fixed rules are the ones to rely on. Checks of meaning and of sources are approximate, and an AI reviewer’s grades come from a model, so they are labelled as such.
              </p>
              {ragTarget && d.evaluators.some((e) => spendsOnJudge(resolveMetric(e.type), e)) && (
                <Callout tone="accent" className="mx-3 mt-2" data-rag-judge-note>
                  {d.judge?.provider ? `Checks graded by an AI reviewer ask ${providers.find((p) => p.id === d.judge?.provider)?.name ?? d.judge.provider}${d.judge.model ? ` / ${d.judge.model}` : ''}.` : 'Checks graded by an AI reviewer ask the AI settings’ large model.'} If no AI reviewer is set, the run stops before the first question and says what to set up. Grades are kept: running again costs nothing.
                </Callout>
              )}
              {d.type === 'rag' ? (
                <MetricPicker
                  evaluators={d.evaluators}
                  onChange={(evaluators) => set({ evaluators })}
                  columns={previewKeys}
                  hasTarget={!!ragTarget}
                  onTry={setTryCheck}
                  footer={ragTarget ? <MetricEstimateLine draft={d} env={env} /> : <span className="text-muted">Choose a bot to see what a run costs.</span>}
                />
              ) : (
                <>
                  <GoodAnswerPicker evaluators={d.evaluators} onChange={(evaluators) => set({ evaluators })} cases={count} onTry={tryCheckOnCase} />
                  <details className="mx-3 mb-3 text-sm" data-more-checks open={d.evaluators.length > 0}>
                    <summary className="cursor-pointer text-muted select-none py-1">More checks and the checks of this evaluation ({d.evaluators.length})</summary>
                    <AssertionEditor checks={d.evaluators} onChange={(evaluators) => set({ evaluators })} groups={['Body', 'AI', 'RAG', 'Safety', 'Response']} />
                  </details>
                </>
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
            <EvalMatrix runs={evalRuns} onRun={() => void run()} />
          </div>
        ) : runId ? (
          <div className="h-full flex flex-col min-h-0">
            <EvalRunHeadline runId={runId} offline={offline} onCi={() => useApp.getState().set({ ci: { evaluation: current?.name } })} ciReason={current ? undefined : 'Save this evaluation first: the pipeline runs it by name'} />
            <div className="flex-1 min-h-0">
              <RunPanel runId={runId} expectedTotal={d.limit ? Math.min(d.limit, count) : count} />
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {evalRuns.length ? (
              // earlier runs of these evaluations: pass rate and duration, click one to open it
              <RunsOverview scores runs={evalRuns} onSelect={setRunId} />
            ) : (
              <Empty
                icon={<FlaskConical size={28} />}
                title="Run this evaluation"
                steps={['Each test case is sent to the prompt and the model.', 'Your checks decide whether each answer is good.', 'You see how many passed, with the failures first.']}
                actions={[
                  ...(remedy ? [{ label: remedy.label, icon: <Play size={12} />, onClick: remedy.onClick }] : [{ label: `Run ${count ? `${d.limit ? Math.min(d.limit, count) : count} cases` : ''}`.trim(), icon: <Play size={12} />, onClick: run }]),
                  { label: 'Try the sample (offline)', icon: <FlaskConical size={12} />, onClick: () => void trySample(), title: 'Ten example messages on the offline demo model: no key, no network, a result in a few seconds' },
                ]}
              >
                The results are kept, so you can compare runs later.
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
