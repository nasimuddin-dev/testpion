import { CopyPlus, FlaskConical, KeyRound, Play, Save, Sparkles, Square, Bookmark, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSticky } from '../../lib/sticky';
import { useLibrary } from '../../lib/library';
import { FolderList } from '../../components/FolderList';
import { SidebarShell } from '../../components/SidebarShell';
import { EnvironmentsPane, HistoryPane } from '../../components/SidebarPanes';
import { stringifyYaml } from '../../lib/yaml';
import { asError, call, on, type NormalizedError } from '../../api';
import { promptText, toastError, useApp } from '../../store';
import { useIntent, useSendShortcut } from '../../hooks';
import type { ProviderConfig } from '../../types';
import { formatCost, formatMs, uid, undatedModel } from '../../lib/format';
import { JsonTree } from '../../components/JsonView';
import { CheckList, ErrorPanel } from '../../components/Results';
import { Button, Empty, LinkButton, Metric, Split, Tabs } from '../../components/ui';
import { ChatResult, SavedPrompt, useDraft, ModelPicker, Params, responseFormat, parseExpected, PromptEditor, NoProviders } from './common';

export function Playground({ providers, onSetUp }: { providers: ProviderConfig[]; onSetUp(): void }) {
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
  // compared when the draft or the saved prompt changes, not on every streamed token
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => !!current && JSON.stringify(current.data) !== JSON.stringify(snapshot()), [current, d]);
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
    const format = responseFormat(d);
    const expected = parseExpected(d.expected);
    const test: Record<string, unknown> = {
      name,
      type: 'llm',
      model: { provider: d.provider, name: d.model || undefined, temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens, seed: d.seed },
      ...(d.system ? { system: d.system } : {}),
      prompt: d.prompt,
      input: d.input,
      ...(format ? { responseFormat: format } : {}),
      ...(expected !== undefined ? { expected } : {}),
      evaluators: d.evaluators,
    };
    const path = `ai/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`;
    await call('tests.write', { path, content: stringifyYaml(test) });
    useApp.getState().toast(`Saved tests/${path}`, 'success');
  };
  // an answer worth keeping becomes an evaluation case: the inputs, and the answer as what is expected
  const addToDataset = async (r: ChatResult) => {
    let last = 'playground-cases';
    try {
      last = localStorage.getItem('aps.ai.dataset') || last;
    } catch {
      /* storage unavailable */
    }
    const name = await promptText('Add to dataset', { message: 'Dataset (a JSONL file in datasets/; made when missing). The inputs and this answer, as expected, become one case.', value: last, okLabel: 'Add' });
    if (!name) return;
    try {
      localStorage.setItem('aps.ai.dataset', name);
    } catch {
      /* storage unavailable */
    }
    try {
      const out = await call<{ path: string; rows: number }>('datasets.appendRow', { name, row: { ...d.input, expected: r.isJson ? r.json : r.text } });
      useApp.getState().toast(`Added case ${out.rows} to ${out.path} (Evaluations ▸ Dataset ▸ workspace dataset)`, 'success');
    } catch (e) {
      toastError(e);
    }
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
            <Button variant="danger" icon={<Square size={12} />} onClick={() => void call('ai.cancel', { id: running }).catch(toastError)}>
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
                  <Metric
                    label="Est. cost"
                    value={r ? formatCost(r.costUsd) : '…'}
                    sub={
                      r?.priceVersion ? (
                        `prices ${r.priceVersion}`
                      ) : r ? (
                        // no price for this model yet: one click to a price row filled in for it (Settings ▸ Model pricing)
                        <LinkButton
                          icon={null}
                          onClick={() => useApp.getState().openIntent('settings', { tab: 'pricing', addPrice: { provider: d.provider, model: undatedModel(r.model || d.model) } })}
                          title="Prices are yours to set (they change): add this model's price per million tokens"
                        >
                          Set a price…
                        </LinkButton>
                      ) : undefined
                    }
                  />
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
                  right={
                    r && (
                      <span className="flex items-center gap-3 text-xs text-muted pr-2">
                        <LinkButton icon={<CopyPlus size={12} />} title="Keep this answer as an evaluation case: the inputs and the answer as expected" onClick={() => void addToDataset(r)}>
                          Add to dataset
                        </LinkButton>
                        <span>
                          {providers.find((p) => p.id === r.provider)?.name ?? r.provider} · {r.model} · {r.finishReason}
                        </span>
                      </span>
                    )
                  }
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
              <Empty
                icon={<Play size={26} />}
                title="Run the prompt"
                actions={[{ label: 'Run (Ctrl+Enter)', icon: <Play size={12} />, onClick: run, disabled: !!running }]}
              >
                Streams the answer and measures latency, time to first token, tokens and estimated cost; the evaluators below the prompt check it. Prompts and answers stay on this machine unless the provider is remote.
              </Empty>
            )}
          </div>
        </Split>
      </div>
    </div>
    </Split>
  );
}
