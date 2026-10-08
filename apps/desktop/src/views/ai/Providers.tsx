import { CopyPlus, KeyRound, Plus, Save, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PROVIDER_KINDS, PROVIDER_PRESETS, providerNeedsKey } from '@testpion/shared';
import { RowMenu, TreeHeader } from '../../components/TreeParts';
import { asError, call } from '../../api';
import { confirmAction, toastError, useApp } from '../../store';
import type { ProviderConfig } from '../../types';
import { uid } from '../../lib/format';
import { Badge, Button, cx, Empty, Field, Input, LinkButton, PageHeader, Select, Split, type MenuItem } from '../../components/ui';

/** kind, label, default base URL: the shared table, in the shape this view reads. */
const KINDS: Array<[ProviderConfig['kind'], string, string]> = PROVIDER_KINDS.map((k) => [k.kind, k.label, k.baseUrl]);

export function Providers({ providers, onSaved, focus }: { providers: ProviderConfig[]; onSaved(): void; focus?: { id: string; at: number } }) {
  const [list, setList] = useState<ProviderConfig[]>(providers);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [sel, setSel] = useState(focus?.id ?? providers[0]?.id);
  const keyField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) setSel(focus.id);
  }, [focus]);
  const [testing, setTesting] = useState(false);
  const env = useApp((s) => s.environment);
  useEffect(() => setList(providers), [providers]);
  const p = list.find((x) => x.id === sel);
  // the key field is focused once the provider's form is there (the list may still be loading when a link opens it)
  const focused = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focus || focused.current === focus.at || p?.id !== focus.id) return;
    focused.current = focus.at;
    requestAnimationFrame(() => keyField.current?.focus());
  }, [focus, p?.id]);
  const upd = (patch: Partial<ProviderConfig>) => setList(list.map((x) => (x.id === sel ? { ...x, ...patch } : x)));
  const save = async (next = list) => {
    try {
      await call('ai.saveProviders', { providers: next.map(({ hasKey: _h, ...x }) => x), keys });
      setKeys({});
      onSaved();
      useApp.getState().toast('Providers saved. API keys are stored in the OS credential store.', 'success');
    } catch (e) {
      toastError(e);
    }
  };
  const addProvider = () => {
    const id = uid('prov-');
    setList([...list, { id, name: 'New provider', kind: 'openai-compatible', baseUrl: KINDS[0]![2] }]);
    setSel(id);
  };
  /**
   * A provider filled in from a preset (the usual ones, as the examples workspace has them): a cloud one is selected
   * with its key field focused, ready for the key; the offline demo needs no key and is saved at once.
   */
  const addPreset = async (preset: ProviderConfig) => {
    const taken = list.some((x) => x.id === preset.id);
    const next = { ...preset, id: taken ? uid('prov-') : preset.id };
    const all = [...list, next];
    setList(all);
    setSel(next.id);
    if (!providerNeedsKey(next)) return save(all);
    requestAnimationFrame(() => keyField.current?.focus());
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
                <div className="text-xs text-muted truncate">
                  {KINDS.find((k) => k[0] === x.kind)?.[1]}
                  {!x.hasKey && x.needsKey && <span className="text-warn"> · needs an API key</span>}
                </div>
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
                <Input ref={keyField} type="password" aria-label="API key" placeholder={p.hasKey ? '••••••••••••' : p.kind === 'bedrock' ? 'accessKeyId:secretAccessKey[:sessionToken] or a Bedrock API key' : 'sk-…'} value={keys[p.id] ?? ''} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} />
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
          // nothing selected: in a workspace without providers, what a provider is and the usual ones one click away
          <Empty
            icon={<Sparkles size={26} />}
            title={list.length ? 'Select a provider' : 'Connect a model to test with'}
            actions={[
              ...PROVIDER_PRESETS.map((x) => ({
                label: providerNeedsKey(x) ? x.name : `${x.name} (no key)`,
                icon: <Plus size={12} />,
                primary: !providerNeedsKey(x),
                onClick: () => void addPreset(x),
                title: providerNeedsKey(x) ? `Adds ${x.name}; paste its API key, Save, then Test connection` : 'No key, no network: answers from rules, for trying things out',
              })),
              { label: 'Something else…', icon: <Plus size={12} />, primary: false, onClick: addProvider, title: 'Any OpenAI-compatible server (vLLM, LM Studio, OpenRouter), Azure OpenAI or Amazon Bedrock' },
            ]}
            steps={[
              'Add a provider above (the offline demo works at once).',
              <>
                Paste its API key and <b>Save</b>: the key goes to the OS secret store, never into the workspace.
              </>,
              <>
                <b>Test connection</b> lists the models the key can use.
              </>,
              <>
                Try it in the <b>Playground</b>, compare models, or use it in tests as <span className="mono">model: {'{'} provider: &lt;id&gt; {'}'}</span>.
              </>,
            ]}
            action={
              !list.some((x) => (x as { builtIn?: boolean }).builtIn) && (
                <LinkButton className="text-xs" onClick={() => useApp.getState().setView('settings')}>
                  Or save the assistant's Claude key in Settings: it then appears here in every workspace
                </LinkButton>
              )
            }
          >
            {list.length
              ? 'Pick one on the left to see its settings, or add one of the usual ones.'
              : 'A provider is where the Playground, evaluations and AI tests send their prompts. Add the ones you use; the offline demo needs neither a key nor a network.'}
          </Empty>
        )}
      </div>
    </Split>
  );
}
