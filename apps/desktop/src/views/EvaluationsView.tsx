import { RunMiniBar, RunsOverview, type RunRow } from '../components/RunsOverview';
import { BarChart3, Bookmark, FlaskConical, History, KeyRound, Play, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { useIntent } from '../hooks';
import { call, on } from '../api';
import { persisted, promptText, toastError, useApp } from '../store';
import type { CheckConfig, ProviderConfig } from '../types';
import { templateVars, timeAgo } from '../lib/format';
import { countDatasetRecords, datasetFormatOf, datasetFormatOfName, previewDatasetRecords } from '@testpion/shared';
import { pickTextFile } from '../lib/files';
import { AssertionEditor } from '../components/AssertionEditor';
import { CodeEditor } from '../components/CodeEditor';
import { RunPanel } from '../components/RunPanel';
import { FolderList } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { EnvironmentsPane } from '../components/SidebarPanes';
import { useLibrary } from '../lib/library';
import { Badge, Button, Callout, cx, Empty, Field, Input, Select, Split, Tabs } from '../components/ui';

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

/** Evaluation Lab: dataset × prompt × model × evaluators, streamed through the test runner. */
export function EvaluationsView() {
  const [d, setD] = useState<Draft>(drafts.load);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [runId, setRunId] = useSticky<string | undefined>('eval:runId', undefined);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sub, setSub] = useSticky<'prompt' | 'dataset' | 'evaluators'>('eval:sub', 'dataset');
  // dataset files of the workspace (datasets/), offered next to Load file
  const [datasets, setDatasets] = useState<Array<{ path: string; name: string }>>([]);
  useEffect(() => {
    void call<Array<{ path: string; name: string }>>('datasets.list').then((l) => setDatasets(l.filter((x) => /\.(csv|tsv|json|jsonl|ndjson|md)$/i.test(x.name))), () => setDatasets([]));
  }, []);
  const env = useApp((s) => s.environment);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  useEffect(() => drafts.save(d), [d]);
  useEffect(() => {
    void call<ProviderConfig[]>('ai.providers').then((p) => {
      setProviders(p);
      if (!d.provider && p[0]) set({ provider: p[0].id, model: p[0].defaultModel ?? '' });
    });
    const loadRuns = () => void call('runs.list', { limit: 30 }).then((r) => setRuns(r.items));
    loadRuns();
    // a finished run replaces its placeholder row (passed / total, duration) in the list and the overview
    const off = on<{ runId: string }>('run.finished', () => loadRuns());
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saved = useLibrary<Draft>('evaluations');
  const [savedId, setSavedId] = useSticky<string | undefined>('eval:saved', undefined);
  const current = saved.lib.items.find((i) => i.id === savedId);
  const dirty = useMemo(() => !!current && JSON.stringify(current.data) !== JSON.stringify(d), [current, d]);
  const openSaved = async (id: string) => {
    const it = await saved.find(id);
    if (!it) return undefined;
    setSavedId(id);
    setD({ ...drafts.load(), ...it.data, name: it.name });
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
    setSavedId(await saved.put({ name, folder, data: { ...d, name } }));
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

  const run = () => runDraft(d);
  const runDraft = async (d: Draft) => {
    try {
      // the engine builds the test template, exactly as `testpion eval run` and the run_evaluation MCP tool do
      const r = await call<{ runId: string }>('eval.runDraft', { draft: d, environment: env });
      setRunId(r.runId);
      setRuns((rs) => [{ id: r.runId, name: d.name, startedAt: new Date().toISOString(), passed: 0, total: 0, failed: 0, errors: 0 }, ...rs]);
    } catch (e) {
      toastError(e);
    }
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
                title="Saved evaluations"
                itemNoun="evaluation"
                addLabel="Save current evaluation"
                folders={saved.lib.folders}
                selected={savedId}
                onSelect={(id) => void openSaved(id)}
                onAdd={(folder) => void saveEval(true, folder)}
                ops={saved.ops}
                itemMenu={(id) => [
                  {
                    label: 'Run',
                    icon: <Play size={13} />,
                    onSelect: () =>
                      void openSaved(id).then((it) => {
                        if (it) void runDraft({ ...drafts.load(), ...it.data, name: it.name });
                      }),
                  },
                ]}
                items={savedItems}
                empty={
                  <Empty title="No saved evaluations">
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
                  <button key={r.id} className={cx('w-full text-left px-3 py-2 border-b border-line/60 text-sm', runId === r.id ? 'bg-accent/10' : 'hover:bg-hover')} onClick={() => setRunId(r.id)}>
                    <div className="truncate">{r.name}</div>
                    <RunMiniBar r={r} />
                    <div className="text-xs text-muted flex gap-2">
                      {r.total ? <span className={r.failed + r.errors ? 'text-bad' : 'text-ok'}>{r.passed}/{r.total} passed</span> : null}
                      <span className="ml-auto">{timeAgo(r.startedAt)}</span>
                    </div>
                  </button>
                ))}
                {!evalRuns.length && <Empty icon={<History size={22} />} title="No runs yet">Runs of your evaluations appear here.</Empty>}
              </div>
            ),
          },
        ]}
      />
    <Split id="eval-main" initial={42}>
      <div className="h-full flex flex-col">
        <div className="p-2 border-b border-line flex flex-col gap-2">
          <div className="flex gap-2 flex-wrap">
            <Input className="flex-1 min-w-40 font-medium" value={d.name} onChange={(e) => set({ name: e.target.value })} aria-label="Evaluation name" />
            <Select value={d.type} onChange={(e) => set({ type: e.target.value as Draft['type'] })} aria-label="Evaluation type">
              <option value="llm">Prompt / LLM</option>
              <option value="rag">RAG</option>
            </Select>
            <Button className="shrink-0" icon={<Save size={13} />} title={current ? `Save changes to "${current.name}"` : 'Save this evaluation to run it again later'} onClick={() => void saveEval()}>
              {current && dirty ? 'Save*' : 'Save'}
            </Button>
            <Button variant="primary" className="shrink-0" icon={<Play size={13} />} onClick={run} disabled={!count || !d.provider}>
              Run {count ? `${d.limit ? Math.min(d.limit, count) : count} cases` : ''}
            </Button>
          </div>
          {/* two rows, so the fields fit however narrow the pane is */}
          <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
            <Field label="Provider">
              <Select value={d.provider} onChange={(e) => set({ provider: e.target.value, model: providers.find((p) => p.id === e.target.value)?.defaultModel ?? '' })}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model">
              <Input className="mono" value={d.model} onChange={(e) => set({ model: e.target.value })} />
            </Field>
          </div>
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
            { id: 'prompt', label: d.type === 'rag' ? 'Prompt (optional)' : 'Prompt' },
            { id: 'evaluators', label: 'Evaluators', badge: d.evaluators.length },
          ]}
        />
        <div className="flex-1 min-h-0">
          {sub === 'dataset' && (
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
                  <CodeEditor language={readAs === 'json' ? 'json' : 'plaintext'} value={d.dataset} onChange={(dataset) => set({ dataset })} />
                  <div className="h-full overflow-auto p-2 text-xs">
                    <div className="text-muted mb-1">
                      Preview · {count} records · each record's fields are available as {'{{field}}'} in the prompt and evaluators
                      {d.type === 'rag' && ' · RAG records need question, contexts [{id,text}] and optionally answer/expected'}
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
          {sub === 'prompt' && (
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
              <AssertionEditor checks={d.evaluators} onChange={(evaluators) => set({ evaluators })} groups={['Body', 'AI', 'RAG', 'Safety', 'Response']} />
            </div>
          )}
        </div>
      </div>
      <div className="h-full flex flex-col min-h-0">
        {runId ? (
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
    </Split>
  );
}
