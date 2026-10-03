import { CopyPlus, FlaskConical, KeyRound, Play, Plus, RefreshCw, Save, Settings2, Sparkles, Square, Trash2, WifiOff, Bookmark, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { useLibrary } from '../lib/library';
import { FolderList } from '../components/FolderList';
import { SidebarShell } from '../components/SidebarShell';
import { RowMenu, TreeHeader } from '../components/TreeParts';
import { EnvironmentsPane, HistoryPane } from '../components/SidebarPanes';
import { AiUsage } from '../components/AiUsage';
import { stringifyYaml } from '../lib/yaml';
import { asError, call, on, type NormalizedError } from '../api';
import { confirmAction, persisted, promptText, useApp } from '../store';
import { useIntent, useSendShortcut } from '../hooks';
import type { CheckConfig, CheckResult, ProviderConfig } from '../types';
import { formatCost, formatMs, templateVars, uid } from '../lib/format';
import { AssertionEditor } from '../components/AssertionEditor';
import { CodeEditor } from '../components/CodeEditor';
import { JsonTree } from '../components/JsonView';
import { CheckList, ErrorPanel } from '../components/Results';
import { Badge, Button, cx, Empty, Field, IconButton, Input, Metric, PageHeader, Select, Split, Tabs, type MenuItem } from '../components/ui';

interface ChatResult {
  id: string;
  provider: string;
  model: string;
  text: string;
  json?: unknown;
  isJson: boolean;
  schemaValid?: boolean;
  schemaErrors?: string[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  usageEstimated?: boolean;
  costUsd?: number;
  priceVersion?: string;
  timing: { totalMs: number; firstTokenMs?: number; interTokenMsAvg?: number };
  finishReason?: string;
  checks: CheckResult[];
  renderedPrompt: string;
  traceId: string;
  error?: NormalizedError;
}

type SavedPrompt = Pick<Draft, 'provider' | 'model' | 'system' | 'prompt' | 'input' | 'temperature' | 'topP' | 'maxTokens' | 'seed' | 'format' | 'schema' | 'expected' | 'evaluators'>;

interface Draft {
  provider: string;
  model: string;
  system: string;
  prompt: string;
  input: Record<string, string>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  format: 'text' | 'json' | 'json_schema';
  schema: string;
  expected: string;
  evaluators: CheckConfig[];
  compare: Array<{ provider: string; name: string }>;
}

const drafts = persisted<Draft>('ai', {
  provider: '',
  model: '',
  system: 'You are a helpful assistant for a veterinary clinic.',
  prompt: 'Classify the following customer message. Respond with JSON {"category": "..."}.\n\n{{message}}',
  input: { message: 'I want to cancel my appointment' },
  temperature: 0,
  format: 'json',
  schema: '{\n  "type": "object",\n  "required": ["category"],\n  "properties": { "category": { "type": "string" } }\n}',
  expected: '',
  evaluators: [{ type: 'json-schema' }],
  compare: [],
});

export function AiLabView() {
  // kept while the app runs, so switching tabs or views doesn't lose results
  const [tab, setTab] = useSticky<'playground' | 'compare' | 'providers' | 'usage'>('ai:tab', 'providers');
  const [providers, setProviders] = useState<ProviderConfig[]>();
  const load = useCallback(() => call<ProviderConfig[]>('ai.providers').then(setProviders), []);
  useEffect(() => {
    void load();
  }, [load]);
  // nothing else here works without a provider: a workspace without one opens on Providers
  const landed = useRef(false);
  useEffect(() => {
    if (!providers || landed.current) return;
    landed.current = true;
    if (!providers.length) setTab('providers');
  }, [providers, setTab]);
  useIntent('ai', (p) => {
    if (p?.savedId) setTab('playground');
    if (p?.tab) setTab(p.tab);
    if (p?.providerId) setTab('providers');
    if (p?.reset) setTab('playground');
  });
  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          // providers first: the rest needs one
          { id: 'providers', label: 'Providers', badge: providers?.length || undefined, title: 'The AI providers prompts are sent to (set up first)' },
          { id: 'playground', label: 'Playground' },
          { id: 'compare', label: 'Model comparison' },
          { id: 'usage', label: 'Usage' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {tab === 'playground' && <Playground providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'compare' && <Compare providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'providers' && <Providers providers={providers ?? []} onSaved={load} />}
        {tab === 'usage' && <AiUsage />}
      </div>
    </div>
  );
}

function useDraft() {
  const [d, setD] = useState<Draft>(drafts.load);
  useEffect(() => drafts.save(d), [d]);
  return [d, (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))] as const;
}

function ModelPicker({ providers, provider, model, onChange }: { providers: ProviderConfig[]; provider: string; model: string; onChange(p: string, m: string): void }) {
  const [models, setModels] = useState<string[]>([]);
  const env = useApp((s) => s.environment);
  const p = providers.find((x) => x.id === provider) ?? providers[0];
  useEffect(() => {
    if (!provider && providers[0]) onChange(providers[0].id, providers[0].defaultModel ?? '');
  }, [provider, providers, onChange]);
  const refresh = () =>
    p &&
    call<string[]>('ai.models', { providerId: p.id, environment: env })
      .then(setModels)
      .catch((e) => useApp.getState().toast(`Could not list models: ${asError(e).message}`, 'error'));
  return (
    <div className="flex items-center gap-1">
      <Select aria-label="Provider" value={p?.id ?? ''} onChange={(e) => onChange(e.target.value, providers.find((x) => x.id === e.target.value)?.defaultModel ?? '')}>
        {providers.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </Select>
      <Input aria-label="Model" list={`models-${p?.id}`} className="w-48 mono" placeholder={p?.defaultModel ?? 'model name'} value={model} onChange={(e) => onChange(p?.id ?? '', e.target.value)} />
      <datalist id={`models-${p?.id}`}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <IconButton label="Fetch model list" onClick={refresh}>
        <RefreshCw size={13} />
      </IconButton>
    </div>
  );
}

function Params({ d, set }: { d: Draft; set(p: Partial<Draft>): void }) {
  const num = (v: string) => (v === '' ? undefined : Number(v));
  return (
    <div className="grid grid-cols-4 gap-2 text-xs [&>*]:min-w-0">
      <Field label="Temperature">
        <Input type="number" step="0.1" min="0" max="2" placeholder="default" value={d.temperature ?? ''} onChange={(e) => set({ temperature: num(e.target.value) })} />
      </Field>
      <Field label="Top P">
        <Input type="number" step="0.05" min="0" max="1" placeholder="default" value={d.topP ?? ''} onChange={(e) => set({ topP: num(e.target.value) })} />
      </Field>
      <Field label="Max tokens">
        <Input type="number" placeholder="default" value={d.maxTokens ?? ''} onChange={(e) => set({ maxTokens: num(e.target.value) })} />
      </Field>
      <Field label="Seed">
        <Input type="number" placeholder="none" value={d.seed ?? ''} onChange={(e) => set({ seed: num(e.target.value) })} />
      </Field>
    </div>
  );
}

function responseFormat(d: Draft) {
  if (d.format === 'text') return undefined;
  if (d.format === 'json') return { type: 'json' as const };
  try {
    return { type: 'json_schema' as const, name: 'output', schema: JSON.parse(d.schema) };
  } catch {
    return { type: 'json' as const };
  }
}

function parseExpected(s: string): unknown {
  if (!s.trim()) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function PromptEditor({ d, set }: { d: Draft; set(p: Partial<Draft>): void }) {
  const [sub, setSub] = useSticky<'prompt' | 'system' | 'format' | 'evaluators'>('ai:sub', 'prompt');
  const vars = useMemo(() => [...new Set([...templateVars(d.prompt), ...templateVars(d.system)])], [d.prompt, d.system]);
  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'prompt', label: 'Prompt template' },
          { id: 'system', label: 'System' },
          { id: 'format', label: 'Structured output', badge: d.format !== 'text' ? d.format : undefined },
          { id: 'evaluators', label: 'Evaluators', badge: d.evaluators.length },
        ]}
      />
      <div className="flex-1 min-h-0">
        {sub === 'prompt' && (
          <Split id="ai-prompt-vars" direction="vertical" initial={62}>
            <CodeEditor language="markdown" path="ai-lab-prompt.md" localVariables={vars} value={d.prompt} onChange={(prompt) => set({ prompt })} />
            <div className="h-full overflow-auto p-3">
              <div className="text-xs font-semibold text-muted mb-2">Input variables {vars.length ? '' : '— use {{name}} in the template'}</div>
              <div className="flex flex-col gap-2">
                {vars.map((v) => (
                  <Field key={v} label={v}>
                    <textarea className="field text-sm min-h-9" rows={1} value={d.input[v] ?? ''} onChange={(e) => set({ input: { ...d.input, [v]: e.target.value } })} />
                  </Field>
                ))}
              </div>
            </div>
          </Split>
        )}
        {sub === 'system' && <CodeEditor language="markdown" path="ai-lab-system.md" localVariables={vars} value={d.system} onChange={(system) => set({ system })} />}
        {sub === 'format' && (
          <div className="h-full flex flex-col">
            <div className="flex gap-4 px-3 py-2 text-sm border-b border-line">
              {(['text', 'json', 'json_schema'] as const).map((f) => (
                <label key={f} className="flex items-center gap-1">
                  <input type="radio" checked={d.format === f} onChange={() => set({ format: f })} /> {f === 'text' ? 'Free text' : f === 'json' ? 'JSON mode' : 'JSON Schema'}
                </label>
              ))}
            </div>
            {d.format === 'json_schema' ? (
              <div className="flex-1 min-h-0">
                <CodeEditor value={d.schema} onChange={(schema) => set({ schema })} />
              </div>
            ) : (
              <p className="p-3 text-sm text-muted">{d.format === 'json' ? 'The provider is asked for JSON output; validity is checked on every response.' : 'No output structure is enforced.'}</p>
            )}
          </div>
        )}
        {sub === 'evaluators' && (
          <div className="overflow-auto h-full">
            <div className="p-3 pb-0">
              <Field label="Expected output (optional, JSON or text) — used by exact-match, similarity and judge">
                <Input className="mono" value={d.expected} onChange={(e) => set({ expected: e.target.value })} placeholder='{"category": "cancellation"}' />
              </Field>
            </div>
            <AssertionEditor checks={d.evaluators} onChange={(evaluators) => set({ evaluators })} groups={['Body', 'AI', 'Safety', 'Response']} />
          </div>
        )}
      </div>
    </div>
  );
}

function Playground({ providers, onSetUp }: { providers: ProviderConfig[]; onSetUp(): void }) {
  const [d, set] = useDraft();
  const [running, setRunning] = useState<string>();
  const [stream, setStream] = useState('');
  const [result, setResult] = useSticky<ChatResult | { error: NormalizedError } | undefined>('ai:playground:result', undefined);
  const [resTab, setResTab] = useSticky<'output' | 'json' | 'evaluation' | 'prompt'>('ai:playground:resTab', 'output');
  const env = useApp((s) => s.environment);
  const idRef = useRef<string | undefined>(undefined);
  // saved prompts (model, prompt, system, variables, structured output, evaluators) with folders
  const saved = useLibrary<SavedPrompt>('ai-prompts');
  const [savedId, setSavedId] = useSticky<string | undefined>('ai:saved', undefined);
  const current = saved.lib.items.find((i) => i.id === savedId);
  const snapshot = (): SavedPrompt => ({ provider: d.provider, model: d.model, system: d.system, prompt: d.prompt, input: d.input, temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens, seed: d.seed, format: d.format, schema: d.schema, expected: d.expected, evaluators: d.evaluators });
  const dirty = !!current && JSON.stringify(current.data) !== JSON.stringify(snapshot());
  const openSaved = async (id: string) => {
    const it = await saved.find(id);
    if (!it) return;
    setSavedId(id);
    // parameters the saved prompt doesn't set go back to their defaults (not the previous prompt's values)
    set({ temperature: undefined, topP: undefined, maxTokens: undefined, seed: undefined, ...it.data });
    setResult(undefined);
  };
  // global search → open a saved prompt (keyed: the Playground unmounts when another tab is shown)
  useIntent('ai', (p) => p?.savedId && openSaved(p.savedId), 'ai-playground-saved');
  const savePrompt = async (asNew = false, folder?: string) => {
    if (current && !asNew) {
      await saved.put({ ...current, data: snapshot() });
      useApp.getState().toast(`Saved "${current.name}"`, 'success');
      return;
    }
    const name = await promptText('Save prompt', { message: 'Name', value: d.prompt.split('\n')[0]!.slice(0, 40) || 'Prompt', okLabel: 'Save' });
    if (!name) return;
    setSavedId(await saved.put({ name, folder, data: snapshot() }));
  };
  useEffect(
    () =>
      on<Array<{ id: string; delta: string }>>('ai.deltas', (items) => {
        const mine = items.filter((i) => i.id === idRef.current).map((i) => i.delta);
        if (mine.length) setStream((s) => s + mine.join(''));
      }),
    [],
  );
  const onModel = useCallback((provider: string, model: string) => set({ provider, model }), [set]);
  const run = async () => {
    const id = uid('ai-');
    idRef.current = id;
    setRunning(id);
    setStream('');
    setResult(undefined);
    setResTab('output');
    useApp.getState().setActivity(id, `Running ${d.model || 'model'}`);
    try {
      const r = await call<ChatResult>('ai.chat', {
        requestId: id,
        provider: d.provider,
        model: d.model,
        system: d.system || undefined,
        prompt: d.prompt,
        input: d.input,
        temperature: d.temperature,
        topP: d.topP,
        maxTokens: d.maxTokens,
        seed: d.seed,
        responseFormat: responseFormat(d),
        stream: true,
        environment: env,
        evaluators: d.evaluators,
        expected: parseExpected(d.expected),
      });
      setResult(r);
    } catch (e) {
      setResult({ error: asError(e) });
    } finally {
      setRunning(undefined);
      useApp.getState().setActivity(id);
    }
  };
  useSendShortcut('ai', () => !running && void run());
  const saveAsTest = async () => {
    const name = await promptText('Save as test', { message: 'Test name', value: 'Prompt test', okLabel: 'Save' });
    if (!name) return;
    const test: Record<string, unknown> = {
      name,
      type: 'llm',
      model: { provider: d.provider, name: d.model || undefined, temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens, seed: d.seed },
      ...(d.system ? { system: d.system } : {}),
      prompt: d.prompt,
      input: d.input,
      ...(responseFormat(d) ? { responseFormat: responseFormat(d) } : {}),
      ...(parseExpected(d.expected) !== undefined ? { expected: parseExpected(d.expected) } : {}),
      evaluators: d.evaluators,
    };
    const path = `ai/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`;
    await call('tests.write', { path, content: stringifyYaml(test) });
    useApp.getState().toast(`Saved tests/${path}`, 'success');
  };
  if (!providers.length) return <NoProviders onSetUp={onSetUp} />;
  const r = result && !('error' in result) ? result : undefined;
  return (
    <Split id="ai-saved" sidebar initial={18} min={12}>
    <SidebarShell
      id="ai"
      panes={[
        {
          id: 'saved',
          label: 'Saved',
          icon: <Bookmark size={13} />,
          render: () => (
            <FolderList
              id="ai-saved"
              title="Saved prompts"
              itemNoun="prompt"
              addLabel="Save current prompt"
              folders={saved.lib.folders}
              selected={savedId}
              onSelect={openSaved}
              onAdd={(folder) => void savePrompt(true, folder)}
              ops={saved.ops}
              items={saved.lib.items.map((i) => ({ id: i.id, name: i.name, folder: i.folder, subtitle: `${i.data.model || i.data.provider}`, icon: <Sparkles size={12} className="text-muted" /> }))}
              empty={
                <Empty title="No saved prompts">
                  Save a prompt with its model, variables, structured output and evaluators to run it again later, and group prompts in folders.
                </Empty>
              }
            />
          ),
        },
        { id: 'environments', label: 'Environments', icon: <KeyRound size={13} />, render: () => <EnvironmentsPane /> },
        { id: 'history', label: 'History', icon: <History size={13} />, render: () => <HistoryPane kind="llm" noun="Prompts you run" /> },
      ]}
    />
    <div className="h-full flex flex-col min-w-0">
      <div className="flex items-center gap-2 p-2 border-b border-line flex-wrap">
        <ModelPicker providers={providers} provider={d.provider} model={d.model} onChange={onModel} />
        {current && <span className="text-sm text-muted truncate">{current.name}{dirty ? ' · edited' : ''}</span>}
        <div className="ml-auto flex gap-2">
          <Button icon={<Save size={13} />} title={current ? `Save changes to "${current.name}"` : 'Save this prompt'} onClick={() => void savePrompt()}>
            {current && dirty ? 'Save*' : 'Save'}
          </Button>
          <Button icon={<FlaskConical size={13} />} onClick={saveAsTest}>
            Save as test
          </Button>
          {running ? (
            <Button variant="danger" icon={<Square size={12} />} onClick={() => call('ai.cancel', { id: running })}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Play size={13} />} onClick={run} title="Run (Ctrl+Enter)">
              Run
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Split id="ai-play" initial={50}>
          <div className="h-full flex flex-col">
            <div className="p-2 border-b border-line">
              <Params d={d} set={set} />
            </div>
            <div className="flex-1 min-h-0">
              <PromptEditor d={d} set={set} />
            </div>
          </div>
          <div className="h-full flex flex-col min-h-0">
            {result && 'error' in result ? (
              <ErrorPanel error={result.error!} context={{ provider: d.provider, model: d.model }} />
            ) : running || r ? (
              <>
                <div className="flex gap-2 p-2 flex-wrap border-b border-line">
                  <Metric label="Latency" value={r ? formatMs(r.timing.totalMs) : '…'} />
                  <Metric label="Time to first token" value={r?.timing.firstTokenMs !== undefined ? formatMs(r.timing.firstTokenMs) : '–'} />
                  <Metric label="Tokens in / out" value={r ? `${r.usage.inputTokens} / ${r.usage.outputTokens}` : '…'} sub={r?.usageEstimated ? 'estimated' : undefined} />
                  <Metric label="Est. cost" value={r ? formatCost(r.costUsd) : '…'} sub={r?.priceVersion ? `prices ${r.priceVersion}` : r ? 'no price configured' : undefined} />
                  {r && d.format !== 'text' && <Metric label="Structured output" value={r.schemaValid === false ? 'invalid' : r.isJson ? 'valid' : 'not JSON'} tone={r.schemaValid === false || !r.isJson ? 'bad' : 'ok'} />}
                </div>
                <Tabs
                  value={resTab}
                  onChange={setResTab}
                  tabs={[
                    { id: 'output', label: 'Output' },
                    ...(r?.isJson ? [{ id: 'json' as const, label: 'JSON' }] : []),
                    { id: 'evaluation', label: 'Evaluation', badge: r?.checks.length },
                    { id: 'prompt', label: 'Rendered prompt' },
                  ]}
                  right={r && <span className="text-xs text-muted pr-2">{r.provider} · {r.model} · {r.finishReason}</span>}
                />
                <div className="flex-1 min-h-0 overflow-auto">
                  {resTab === 'output' && <pre className="p-3 whitespace-pre-wrap text-sm leading-relaxed">{r ? r.text : stream}{running && <span className="inline-block w-2 h-4 bg-accent align-middle ml-0.5 animate-pulse" />}</pre>}
                  {resTab === 'json' && r && <JsonTree data={r.json} />}
                  {resTab === 'evaluation' && r && (
                    <>
                      {r.schemaErrors?.length ? <div className="p-3 text-sm text-bad">Schema errors: {r.schemaErrors.join('; ')}</div> : null}
                      <CheckList checks={r.checks} />
                    </>
                  )}
                  {resTab === 'prompt' && r && <pre className="p-3 whitespace-pre-wrap text-sm mono">{r.renderedPrompt}</pre>}
                </div>
              </>
            ) : (
              <Empty icon={<Play size={26} />} title="Run the prompt">
                Streams the response and measures latency, time-to-first-token, tokens and estimated cost. Prompts and responses stay on this machine unless the selected provider is remote.
              </Empty>
            )}
          </div>
        </Split>
      </div>
    </div>
    </Split>
  );
}

function Compare({ providers, onSetUp }: { providers: ProviderConfig[]; onSetUp(): void }) {
  const [d, set] = useDraft();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useSticky<Array<ChatResult & { error?: NormalizedError }>>('ai:compare:results', []);
  const env = useApp((s) => s.environment);
  const rows = d.compare.length ? d.compare : providers.slice(0, 2).map((p) => ({ provider: p.id, name: p.defaultModel ?? '' }));
  const run = async () => {
    setRunning(true);
    try {
      setResults(
        await call('ai.compare', {
          requestId: uid('cmp-'),
          models: rows,
          system: d.system || undefined,
          prompt: d.prompt,
          input: d.input,
          temperature: d.temperature,
          topP: d.topP,
          maxTokens: d.maxTokens,
          seed: d.seed,
          responseFormat: responseFormat(d),
          environment: env,
          evaluators: [...d.evaluators, ...(parseExpected(d.expected) !== undefined ? [{ type: 'similarity', name: 'similarity to expected' }] : [])],
          expected: parseExpected(d.expected),
        }),
      );
    } finally {
      setRunning(false);
    }
  };
  if (!providers.length) return <NoProviders onSetUp={onSetUp} />;
  return (
    <Split id="ai-compare" initial={38}>
      <div className="h-full flex flex-col">
        <div className="p-2 border-b border-line flex flex-col gap-2">
          <div className="text-xs font-semibold text-muted">Models</div>
          {rows.map((m, i) => (
            <div key={i} className="flex items-center gap-1">
              <ModelPicker providers={providers} provider={m.provider} model={m.name} onChange={(p, name) => set({ compare: rows.map((x, j) => (j === i ? { provider: p, name } : x)) })} />
              <IconButton label="Remove model" onClick={() => set({ compare: rows.filter((_, j) => j !== i) })}>
                <Trash2 size={13} />
              </IconButton>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" icon={<Plus size={12} />} onClick={() => set({ compare: [...rows, { provider: providers[0]!.id, name: providers[0]!.defaultModel ?? '' }] })}>
              Add model
            </Button>
            <Button size="sm" variant="primary" icon={<Play size={12} />} loading={running} onClick={run} className="ml-auto">
              Run comparison
            </Button>
          </div>
          <Params d={d} set={set} />
        </div>
        <div className="flex-1 min-h-0">
          <PromptEditor d={d} set={set} />
        </div>
      </div>
      <div className="h-full overflow-auto">
        {results.length ? (
          <>
            <p className="px-3 py-2 text-xs text-muted border-b border-line">
              Measurements only — there is no universal ranking. Choose the criteria that matter for your use case and inspect the underlying outputs.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted border-b border-line">
                  <th className="px-3 py-2 w-40">Metric</th>
                  {results.map((r, i) => (
                    <th key={i} className="px-3 py-2">
                      {r.provider} · <span className="mono">{r.model}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Latency', (r: ChatResult) => formatMs(r.timing?.totalMs), (r: ChatResult) => r.timing?.totalMs],
                    ['Time to first token', (r: ChatResult) => formatMs(r.timing?.firstTokenMs), (r: ChatResult) => r.timing?.firstTokenMs],
                    ['Input tokens', (r: ChatResult) => r.usage?.inputTokens, (r: ChatResult) => r.usage?.inputTokens],
                    ['Output tokens', (r: ChatResult) => r.usage?.outputTokens, (r: ChatResult) => r.usage?.outputTokens],
                    ['Est. cost', (r: ChatResult) => formatCost(r.costUsd), (r: ChatResult) => r.costUsd],
                    ['Valid JSON', (r: ChatResult) => (d.format === 'text' ? '–' : r.isJson ? '✓' : '✗')],
                    ['Schema valid', (r: ChatResult) => (r.schemaValid === undefined ? '–' : r.schemaValid ? '✓' : '✗')],
                    ['Checks passed', (r: ChatResult) => (r.checks ? `${r.checks.filter((c) => c.passed).length}/${r.checks.length}` : '–')],
                  ] as Array<[string, (r: ChatResult) => React.ReactNode, ((r: ChatResult) => number | undefined)?]>
                ).map(([label, fn, num]) => {
                  // numeric rows get a bar per model, relative to the largest value in the row
                  const max = num ? Math.max(0, ...results.filter((r) => !r.error).map((r) => num(r) ?? 0)) : 0;
                  return (
                    <tr key={label} className="border-b border-line">
                      <td className="px-3 py-1.5 text-muted">{label}</td>
                      {results.map((r, i) => {
                        const v = num && !r.error ? num(r) : undefined;
                        return (
                          <td key={i} className="px-3 py-1.5 tabular-nums">
                            {/* a failed model shows its error once (first row); the message is under Output */}
                            {r.error ? label === 'Latency' ? <span className="text-bad">{r.error.kind}</span> : <span className="text-muted">—</span> : fn(r)}
                            {v !== undefined && max > 0 && (
                              <span aria-hidden className="block h-1 mt-1 w-full max-w-40 rounded-full bg-hover/70 overflow-hidden">
                                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(3, (v / max) * 100)}%` }} />
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="align-top">
                  <td className="px-3 py-2 text-muted">Output</td>
                  {results.map((r, i) => (
                    <td key={i} className="px-3 py-2">
                      {r.error ? <span className="text-bad text-xs">{r.error.message}</span> : <pre className="whitespace-pre-wrap text-xs mono max-h-80 overflow-auto">{r.text}</pre>}
                    </td>
                  ))}
                </tr>
                <tr className="align-top">
                  <td className="px-3 py-2 text-muted">Evaluation</td>
                  {results.map((r, i) => (
                    <td key={i} className="px-1 py-1">
                      {r.checks && <CheckList checks={r.checks} compact />}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </>
        ) : (
          <Empty title="Compare models side by side">Runs the same prompt against every selected model and reports latency, tokens, cost, structured-output validity and your evaluators.</Empty>
        )}
      </div>
    </Split>
  );
}

function NoProviders({ onSetUp }: { onSetUp(): void }) {
  return (
    <Empty
      icon={<WifiOff size={26} />}
      title="Set up an AI provider first"
      action={
        <Button variant="primary" onClick={onSetUp}>
          Open Providers
        </Button>
      }
    >
      Prompts are sent to a provider you choose: OpenAI-compatible, Azure OpenAI, Anthropic, Gemini, Amazon Bedrock or Ollama. The built-in "mock" provider works fully offline, for trying things out.
    </Empty>
  );
}

const KINDS: Array<[ProviderConfig['kind'], string, string]> = [
  ['openai-compatible', 'OpenAI-compatible', 'https://api.openai.com/v1'],
  ['azure-openai', 'Azure OpenAI', 'https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT'],
  ['anthropic', 'Anthropic', 'https://api.anthropic.com'],
  ['gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com'],
  ['bedrock', 'Amazon Bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com'],
  ['ollama', 'Ollama (local)', 'http://127.0.0.1:11434/v1'],
  ['mock', 'Mock (offline, deterministic)', 'mock://local'],
];

function Providers({ providers, onSaved }: { providers: ProviderConfig[]; onSaved(): void }) {
  const [list, setList] = useState<ProviderConfig[]>(providers);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [sel, setSel] = useState(providers[0]?.id);
  const [testing, setTesting] = useState(false);
  const env = useApp((s) => s.environment);
  useEffect(() => setList(providers), [providers]);
  const p = list.find((x) => x.id === sel);
  const upd = (patch: Partial<ProviderConfig>) => setList(list.map((x) => (x.id === sel ? { ...x, ...patch } : x)));
  const save = async (next = list) => {
    try {
      await call('ai.saveProviders', { providers: next.map(({ hasKey: _h, ...x }) => x), keys });
      setKeys({});
      onSaved();
      useApp.getState().toast('Providers saved. API keys are stored in the OS credential store.', 'success');
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    }
  };
  const addProvider = () => {
    const id = uid('prov-');
    setList([...list, { id, name: 'New provider', kind: 'openai-compatible', baseUrl: KINDS[0]![2] }]);
    setSel(id);
  };
  const duplicateProvider = (x: ProviderConfig) => {
    const id = uid('prov-');
    // the copy has no stored API key: type one, or it uses the key reference
    const { hasKey: _h, ...rest } = x;
    setList([...list, { ...rest, id, name: `${x.name} copy` }]);
    setSel(id);
  };
  /** Remove a provider and save the list at once. */
  const removeProvider = async (x: ProviderConfig) => {
    if (!(await confirmAction({ title: 'Remove provider', message: `Remove the provider "${x.name}"?`, detail: 'Tests and prompts that use it will fail until you choose another provider.', confirmLabel: 'Remove provider', danger: true }))) return;
    const next = list.filter((y) => y.id !== x.id);
    setList(next);
    if (sel === x.id) setSel(next[0]?.id);
    await save(next);
  };
  const [menuFor, setMenuFor] = useState<string>();
  const providerMenu = (x: ProviderConfig): MenuItem[] =>
    (x as { builtIn?: boolean }).builtIn
      ? [{ label: 'Open Settings', icon: <Settings2 size={14} />, onSelect: () => useApp.getState().setView('settings') }]
      : [
          { label: 'Duplicate', icon: <CopyPlus size={14} />, onSelect: () => duplicateProvider(x) },
          { label: 'Remove provider', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void removeProvider(x) },
        ];
  const test = async () => {
    if (!p) return;
    setTesting(true);
    try {
      await save();
      const models = await call<string[]>('ai.models', { providerId: p.id, environment: env });
      useApp.getState().toast(`Connected — ${models.length} models available`, 'success');
    } catch (e) {
      useApp.getState().toast(`Connection failed: ${asError(e).message}`, 'error');
    } finally {
      setTesting(false);
    }
  };
  return (
    <Split id="ai-providers" sidebar initial={26}>
      <div className="h-full flex flex-col bg-panel/50">
        <TreeHeader title="Providers" count={list.length} addLabel="Add provider" onAdd={addProvider} />
        <div className="flex-1 overflow-auto pb-2">
          {list.map((x) => (
            <div
              key={x.id}
              className={cx('group flex items-center gap-1 mx-1 pl-3 pr-1 rounded-md cursor-pointer transition-colors', sel === x.id ? 'bg-accent-soft' : 'hover:bg-hover', menuFor === x.id && sel !== x.id && 'bg-hover')}
              onClick={() => setSel(x.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(x.id);
              }}
            >
              <button className="flex-1 min-w-0 py-1.5 text-left" data-tree-row>
                <div className="text-sm flex items-center gap-2">
                  <span className="truncate">{x.name}</span>
                  {x.hasKey && <KeyRound size={11} className="text-warn shrink-0" aria-label="API key stored" />}
                  {(x as { builtIn?: boolean }).builtIn && <Badge>Settings</Badge>}
                </div>
                <div className="text-xs text-muted truncate">{KINDS.find((k) => k[0] === x.kind)?.[1]}</div>
              </button>
              <RowMenu label={x.name} items={providerMenu(x)} open={menuFor === x.id} onOpenChange={(o) => setMenuFor(o ? x.id : undefined)} />
            </div>
          ))}
        </div>
      </div>
      <div className="h-full overflow-auto">
        {p && (p as { builtIn?: boolean }).builtIn ? (
          <div className="p-4 flex flex-col gap-3 max-w-2xl">
            <PageHeader icon={<Sparkles size={18} />} title={p.name} subtitle="Built in: the assistant's Claude key from Settings" />
            <p className="text-sm text-muted">
              This provider uses the Anthropic API key saved in <b>Settings ▸ AI assistant</b> (kept in the OS secret store). It is available in every workspace; tests and prompts refer to it as <code>claude-app</code>.
            </p>
            <div className="text-sm">
              Model: <span className="mono">{p.defaultModel}</span>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => useApp.getState().setView('settings')}>Open Settings</Button>
              <Button variant="primary" loading={testing} onClick={() => void test()}>
                Test connection
              </Button>
            </div>
          </div>
        ) : p ? (
          <div className="p-4 flex flex-col gap-3 max-w-2xl">
            <PageHeader
              icon={<Sparkles size={18} />}
              title={p.name}
              subtitle={`${KINDS.find((k) => k[0] === p.kind)?.[1] ?? p.kind}${p.hasKey ? ' · API key stored' : ''}`}
              actions={
                <>
                  <Button size="sm" onClick={() => void test()} loading={testing}>
                    Test connection
                  </Button>
                  <Button size="sm" variant="primary" icon={<Save size={13} />} onClick={() => void save()}>
                    Save
                  </Button>
                </>
              }
              menuLabel="More provider actions"
              menu={providerMenu(p)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input value={p.name} onChange={(e) => upd({ name: e.target.value })} />
              </Field>
              <Field label="Kind">
                <Select value={p.kind} onChange={(e) => upd({ kind: e.target.value as ProviderConfig['kind'], baseUrl: KINDS.find((k) => k[0] === e.target.value)![2] })}>
                  {KINDS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Base URL" hint={p.kind === 'azure-openai' ? 'Include the deployment path; set the API version below.' : undefined}>
              <Input className="mono" value={p.baseUrl} onChange={(e) => upd({ baseUrl: e.target.value })} />
            </Field>
            {p.kind !== 'mock' && (
              <Field label="API key" hint={p.hasKey ? 'A key is stored in the OS credential store. Type to replace it.' : 'Stored encrypted in the OS credential store — never in workspace files. You can also reference {{$env.NAME}} in the field below.'}>
                <Input type="password" placeholder={p.hasKey ? '••••••••••••' : p.kind === 'bedrock' ? 'accessKeyId:secretAccessKey[:sessionToken] or a Bedrock API key' : 'sk-…'} value={keys[p.id] ?? ''} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} />
              </Field>
            )}
            {p.kind !== 'mock' && (
              <Field label="API key reference (advanced)" hint="Leave empty to use the stored key. CI: {{$env.OPENAI_API_KEY}} or TESTPION_SECRET_PROVIDER_<ID>_APIKEY.">
                <Input className="mono" value={p.apiKey?.includes('$secret') ? '' : p.apiKey ?? ''} onChange={(e) => upd({ apiKey: e.target.value || undefined })} placeholder="{{$env.MY_KEY}}" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Default model">
                <Input className="mono" value={p.defaultModel ?? ''} onChange={(e) => upd({ defaultModel: e.target.value || undefined })} />
              </Field>
              <Field label="Embedding model">
                <Input className="mono" value={p.embeddingModel ?? ''} onChange={(e) => upd({ embeddingModel: e.target.value || undefined })} />
              </Field>
              {p.kind === 'bedrock' && (
                <Field label="AWS region" hint="Used to sign requests; defaults to the region in the base URL.">
                  <Input className="mono" value={p.region ?? ''} placeholder="us-east-1" onChange={(e) => upd({ region: e.target.value || undefined, ...(e.target.value && /bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/.test(p.baseUrl) ? { baseUrl: `https://bedrock-runtime.${e.target.value}.amazonaws.com` } : {}) })} />
                </Field>
              )}
              {(p.kind === 'azure-openai' || p.kind === 'anthropic') && (
                <Field label="API version">
                  <Input className="mono" value={p.apiVersion ?? ''} placeholder={p.kind === 'anthropic' ? '2023-06-01' : '2024-10-21'} onChange={(e) => upd({ apiVersion: e.target.value || undefined })} />
                </Field>
              )}
            </div>
            <div className="font-medium text-sm mt-2">Rate limits</div>
            <div className="grid grid-cols-4 gap-2">
              {(['requestsPerSecond', 'requestsPerMinute', 'tokensPerMinute', 'concurrency'] as const).map((k) => (
                <Field key={k} label={{ requestsPerSecond: 'Req/sec', requestsPerMinute: 'Req/min', tokensPerMinute: 'Tokens/min', concurrency: 'Concurrency' }[k]}>
                  <Input type="number" value={p.rateLimit?.[k] ?? ''} onChange={(e) => upd({ rateLimit: { ...p.rateLimit, [k]: e.target.value ? Number(e.target.value) : undefined } })} />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted">Cloud providers need network access; prompts are only sent to the provider you select.</p>
          </div>
        ) : (
          <Empty title="Select a provider" />
        )}
      </div>
    </Split>
  );
}
