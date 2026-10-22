import { CopyPlus, FileCheck2, KeyRound, Play, Save, Sparkles, Square, Bookmark, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSticky } from '../../lib/sticky';
import { useLibrary } from '../../lib/library';
import { FolderList } from '../../components/FolderList';
import { SidebarShell } from '../../components/SidebarShell';
import { EnvironmentsPane, HistoryPane } from '../../components/SidebarPanes';
import { asError, call, on, type NormalizedError } from '../../api';
import { promptText, toastError, useApp, attempt } from '../../store';
import { useIntent, useSendShortcut } from '../../hooks';
import type { ProviderConfig } from '../../types';
import { formatCost, formatMs, uid, undatedModel } from '../../lib/format';
import { JsonTree } from '../../components/JsonView';
import { CheckList, ErrorPanel } from '../../components/Results';
import { Button, Empty, LinkButton, Metric, Split, Tabs } from '../../components/ui';
import { ChatResult, SavedPrompt, drafts, type Draft, ModelPicker, Params, responseFormat, parseExpected, PromptEditor, NoProviders } from './common';
import { useLibraryTabs } from '../../lib/library-tabs';
import { LibraryTabStrip, NoOpenItems } from '../../components/LibraryTabStrip';
import { ItemBreadcrumb } from '../../components/ItemBreadcrumb';
import { openItemMenu } from '../../lib/item-menu';
import { deleteWithUndo } from '../../lib/undo-delete';
import { OutputActions } from '../../components/output/OutputFrame';
import { answerOutputSpec } from '../../components/output/ai-specs';

import { refOfWorkspacePath } from '@testpion/shared';
import { saveAsTest as saveAsTestShared, saveAsTestLabel } from '../../lib/save-test';
type PlayResult = ChatResult | { error: NormalizedError };

export function Playground({ providers, onSetUp }: { providers: ProviderConfig[]; onSetUp(): void }) {
  // WF-19: open prompts are tabs (each its own draft; a single click in Saved opens a preview tab), kept per workspace;
  // the Model comparison has its own draft (common.tsx useCompareDraft)
  const tabs = useLibraryTabs<Draft>('ai', drafts, { canBeEmpty: true });
  const d = tabs.d;
  const setD = tabs.setD;
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const [running, setRunning] = useState<{ id: string; tab: string }>();
  const [stream, setStream] = useState('');
  // each tab's last result (in memory: answers may hold secrets); a run writes to the tab it started in
  const [results, setResults] = useSticky<Record<string, PlayResult | undefined>>('ai:playground:results', {});
  const result = results[tabs.active.id];
  const setResultOf = (tab: string, r: PlayResult | undefined) => setResults((m) => ({ ...m, [tab]: r }));
  const [resTab, setResTab] = useSticky<'output' | 'json' | 'evaluation' | 'prompt'>('ai:playground:resTab', 'output');
  const env = useApp((s) => s.environment);
  const idRef = useRef<string | undefined>(undefined);
  // saved prompts (model, prompt, system, variables, structured output, evaluators) with folders
  const saved = useLibrary<SavedPrompt>('ai-prompts');
  const savedId = tabs.active.savedId;
  const current = saved.lib.items.find((i) => i.id === savedId);
  /** The open prompt's ⋯ (its breadcrumb): its menu as its row in Saved has it (lib/node-menu.ts): rename, duplicate, Delete… with Undo (its tab closes). */
  const currentMenu = (c: NonNullable<typeof current>) =>
    openItemMenu('prompt', {
      ref: { kind: 'saved', library: 'ai-prompts', itemId: c.id },
      name: c.name,
      on: {
        rename: async () => {
          const name = (await promptText('Rename prompt', { message: 'Prompt name', value: c.name, okLabel: 'Rename' }))?.trim();
          if (name && name !== c.name) await saved.ops.renameItem(c.id, name);
        },
        duplicate: () => void saved.ops.duplicateItem?.(c.id),
        delete: () =>
          void deleteWithUndo({
            kind: 'prompt',
            name: c.name,
            run: async () => {
              const undo = await saved.ops.deleteItem(c.id);
              tabs.close(tabs.tabs.filter((t) => t.savedId === c.id).map((t) => t.id), drafts.defaults);
              return undo;
            },
          }),
      },
    });
  const snapshot = (): SavedPrompt => ({ provider: d.provider, model: d.model, system: d.system, prompt: d.prompt, input: d.input, temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens, seed: d.seed, format: d.format, schema: d.schema, expected: d.expected, evaluators: d.evaluators });
  // compared when the draft or the saved prompt changes, not on every streamed token
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => !!current && JSON.stringify(current.data) !== JSON.stringify(snapshot()), [current, d]);
  const openSaved = async (id: string, preview = false) => {
    const it = await saved.find(id);
    if (!it) return;
    // parameters the saved prompt doesn't set are its defaults (not another prompt's values)
    tabs.open(id, { ...drafts.defaults, temperature: undefined, topP: undefined, maxTokens: undefined, seed: undefined, ...it.data }, { preview });
  };
  // global search → open a saved prompt (keyed: the Playground unmounts when another tab is shown)
  // … or a prompt sent earlier (History ▸ Open): what was sent, not saved as a prompt
  useIntent(
    'ai',
    (p) => {
      if (p?.savedId) return void openSaved(p.savedId);
      const r = p?.prompt as { provider?: string; model?: string; prompt?: string; system?: string; input?: unknown } | undefined;
      if (!r || typeof r !== 'object') return;
      // what was sent: a new tab of its own (the open prompts stay as they are)
      tabs.newTab({ ...drafts.defaults, ...(r.provider ? { provider: r.provider } : {}), ...(r.model ? { model: r.model } : {}), prompt: r.prompt ?? '', system: r.system ?? '', ...(r.input !== undefined ? { input: r.input as Draft['input'] } : {}) });
    },
    'ai-playground-saved',
  );
  const savePrompt = async (asNew = false, folder?: string) => {
    if (current && !asNew) {
      await saved.put({ ...current, data: snapshot() });
      useApp.getState().toast(`Saved "${current.name}"`, 'success');
      return;
    }
    const name = await promptText('Save prompt', { message: 'Name', value: d.prompt.split('\n')[0]!.slice(0, 40) || 'Prompt', okLabel: 'Save' });
    if (!name) return;
    tabs.setSaved(await saved.put({ name, folder, data: snapshot() }));
  };
  useEffect(
    () =>
      on<Array<{ id: string; delta: string }>>('ai.deltas', (items) => {
        const mine = items.filter((i) => i.id === idRef.current).map((i) => i.delta);
        if (mine.length) setStream((s) => s + mine.join(''));
      }),
    [],
  );
  const onModel = useCallback((provider: string, model: string) => setD((x) => ({ ...x, provider, model })), [setD]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    const id = uid('ai-');
    const tab = tabs.active.id;
    idRef.current = id;
    tabs.keep(tab); // a run has a result to come back to: its tab stays (a preview tab is replaced by the next click)
    setRunning({ id, tab });
    setStream('');
    setResultOf(tab, undefined);
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
      setResultOf(tab, r);
    } catch (e) {
      setResultOf(tab, { error: asError(e) });
    } finally {
      setRunning(undefined);
      useApp.getState().setActivity(id);
    }
  };
  useSendShortcut('ai', () => !running && void run());
  // the one Save as test (lib/save-test): the prompt as it is set up here, its evaluators as the checks
  const saveAsTest = () => {
    const format = responseFormat(d);
    void saveAsTestShared({
      source: { kind: 'llm', model: { provider: d.provider, name: d.model || undefined, temperature: d.temperature, topP: d.topP, maxTokens: d.maxTokens, seed: d.seed }, system: d.system || undefined, prompt: d.prompt, input: d.input, responseFormat: format, expected: parseExpected(d.expected) },
      name: current?.name ?? 'Prompt test',
      assertions: d.evaluators,
    });
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
    await attempt(async () => {
      const out = await call<{ path: string; rows: number }>('datasets.appendRow', { name, row: { ...d.input, expected: r.isJson ? r.json : r.text } });
      useApp.getState().toast(`Added case ${out.rows} to ${out.path} (Evaluations ▸ Dataset ▸ workspace dataset)`, 'success', { ref: refOfWorkspacePath(out.path) ?? { kind: 'dataset', name: out.path.replace(/^.*\//, '') } });
    });
  };
  const r = result && !('error' in result) ? result : undefined;
  const spec = useMemo(() => answerOutputSpec(r), [r]);
  if (!providers.length) return <NoProviders onSetUp={onSetUp} />;
  // a run in another tab streams there, not here
  const runningHere = running?.tab === tabs.active.id ? running : undefined;
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
              kind="prompt"
              title="Saved prompts"
              itemNoun="prompt"
              addLabel="Save current prompt"
              folders={saved.lib.folders}
              selected={savedId}
              onSelect={(id) => void openSaved(id, true)}
              onOpen={(id) => void openSaved(id)}
              onAdd={(folder) => void savePrompt(true, folder)}
              ops={saved.ops}
              items={saved.lib.items.map((i) => ({ id: i.id, name: i.name, folder: i.folder, subtitle: `${i.data.model || i.data.provider}`, icon: <Sparkles size={12} className="text-muted" /> }))}
              empty={
                <Empty title="No saved prompts" actions={[{ label: 'Save this prompt', icon: <Save size={13} />, onClick: () => void savePrompt(true) }]}>
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
      <LibraryTabStrip
        label="Open prompts"
        library="ai-prompts"
        tabs={tabs.tabs}
        active={tabs.active.id}
        titleOf={(t) => saved.lib.items.find((i) => i.id === t.savedId)?.name ?? 'New prompt'}
        dirty={dirty}
        onSelect={tabs.select}
        onClose={(ids) => {
          setResults((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !ids.includes(k))));
          tabs.close(ids, drafts.defaults);
        }}
        onKeep={tabs.keep}
        onNew={() => tabs.newTab(drafts.defaults)}
        newLabel="New prompt"
      />
      {/* WF-11: Prompts › folder › prompt, like every item view (its ⋯ is the prompt's menu) */}
      {!tabs.empty && <ItemBreadcrumb label="Where this prompt is" crumbs={[{ label: 'Prompts' }, ...(current?.folder ? [{ label: current.folder }] : [])]} name={current ? current.name : 'Not saved yet'} dirty={dirty} actions={current ? currentMenu(current) : undefined} />}
      <div className="flex items-center gap-2 p-2 border-b border-line flex-wrap">
        <ModelPicker providers={providers} provider={d.provider} model={d.model} onChange={onModel} />
        {current && <span className="text-sm text-muted truncate">{current.name}{dirty ? ' · edited' : ''}</span>}
        <div className="ml-auto flex gap-2">
          <Button icon={<Save size={13} />} title={current ? `Save changes to "${current.name}"` : 'Save this prompt'} onClick={() => void savePrompt()}>
            {current && dirty ? 'Save*' : 'Save'}
          </Button>
          <Button icon={<FileCheck2 size={13} />} onClick={saveAsTest}>
            {saveAsTestLabel({})}
          </Button>
          {running ? (
            <Button variant="danger" icon={<Square size={12} />} onClick={() => void call('ai.cancel', { id: running.id }).catch(toastError)}>
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
        {tabs.empty ? (
          <NoOpenItems icon={Sparkles} title="No open prompts" newLabel="New prompt" onNew={() => tabs.newTab(drafts.defaults)}>
            Open a saved prompt from the list, or start a new one.
          </NoOpenItems>
        ) : (
        <Split id="ai-play" initial={50}>
          <div className="h-full flex flex-col">
            <div className="p-2 border-b border-line">
              <Params d={d} set={set} />
            </div>
            <div className="flex-1 min-h-0">
              <PromptEditor d={d} set={set} />
            </div>
          </div>
          <div className="h-full flex flex-col min-h-0" data-output="ai.answers">
            {result && 'error' in result ? (
              <ErrorPanel error={result.error!} context={{ provider: d.provider, model: d.model }} />
            ) : runningHere || r ? (
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
                    <OutputActions spec={spec}>
                    {r && (
                      <span className="flex items-center gap-3 text-xs text-muted pr-2">
                        <LinkButton icon={<CopyPlus size={12} />} title="Keep this answer as an evaluation case: the inputs and the answer as expected" onClick={() => void addToDataset(r)}>
                          Add to dataset
                        </LinkButton>
                        <span>
                          {providers.find((p) => p.id === r.provider)?.name ?? r.provider} · {r.model} · {r.finishReason}
                        </span>
                      </span>
                    )}
                    </OutputActions>
                  }
                />
                <div className="flex-1 min-h-0 overflow-auto">
                  {resTab === 'output' && <pre className="p-3 whitespace-pre-wrap text-sm leading-relaxed">{r ? r.text : stream}{runningHere && <span className="inline-block w-2 h-4 bg-accent align-middle ml-0.5 animate-pulse" />}</pre>}
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
        )}
      </div>
    </div>
    </Split>
  );
}
