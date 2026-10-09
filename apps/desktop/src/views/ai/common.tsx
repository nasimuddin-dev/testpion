import { RefreshCw, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSticky } from '../../lib/sticky';
import { asError, call, type NormalizedError } from '../../api';
import { persisted, useApp } from '../../store';
import type { CheckConfig, CheckResult, ProviderConfig } from '../../types';
import { templateVars } from '../../lib/format';
import { AssertionEditor } from '../../components/AssertionEditor';
import { CodeEditor } from '../../components/CodeEditor';
import { AddKeyButton, setupProviderOf } from '../../components/Results';
import { Badge, Empty, Field, IconButton, Input, Select, Split, Tabs, Textarea } from '../../components/ui';

/** What the AI Lab tabs share: the prompt draft and its editors, the model picker, the pieces that say a provider is not ready. */
export interface ChatResult {
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

export type SavedPrompt = Pick<Draft, 'provider' | 'model' | 'system' | 'prompt' | 'input' | 'temperature' | 'topP' | 'maxTokens' | 'seed' | 'format' | 'schema' | 'expected' | 'evaluators'>;

export interface Draft {
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

export const drafts = persisted<Draft>('ai', {
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


export function useDraft() {
  const [d, setD] = useState<Draft>(drafts.load);
  useEffect(() => drafts.save(d), [d]);
  const set = useCallback((p: Partial<Draft>) => setD((x) => ({ ...x, ...p })), []);
  return [d, set] as const;
}

export function ModelPicker({ providers, provider, model, onChange }: { providers: ProviderConfig[]; provider: string; model: string; onChange(p: string, m: string): void }) {
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

export function Params({ d, set }: { d: Draft; set(p: Partial<Draft>): void }) {
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

export function responseFormat(d: Draft) {
  if (d.format === 'text') return undefined;
  if (d.format === 'json') return { type: 'json' as const };
  try {
    return { type: 'json_schema' as const, name: 'output', schema: JSON.parse(d.schema) };
  } catch {
    return { type: 'json' as const };
  }
}

export function parseExpected(s: string): unknown {
  if (!s.trim()) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function PromptEditor({ d, set }: { d: Draft; set(p: Partial<Draft>): void }) {
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
                    <Textarea className="field text-sm min-h-9" rows={1} value={d.input[v] ?? ''} onChange={(e) => set({ input: { ...d.input, [v]: e.target.value } })} />
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


/** A model of the comparison that failed: what went wrong and, for a missing key, the way to add it. */
export function ModelError({ error }: { error: NormalizedError }) {
  const setup = setupProviderOf(error);
  return (
    <div className="text-xs flex flex-col gap-1.5 items-start">
      <Badge tone="bad">{error.kind}</Badge>
      <span className="font-medium text-sm">{error.what || error.message}</span>
      {error.why && error.why !== error.message && <span className="text-muted">{error.why}</span>}
      {setup && <AddKeyButton provider={setup} />}
    </div>
  );
}

/** Under a model picker: this provider still needs an API key (the run would stop there). */
export function AddKeyHint({ provider }: { provider: ProviderConfig }) {
  return (
    <div className="text-xs text-warn mt-0.5 ml-1">
      {provider.name} needs an API key · <AddKeyButton provider={provider.id} link />
    </div>
  );
}

export function NoProviders({ onSetUp }: { onSetUp(): void }) {
  return (
    <Empty
      icon={<WifiOff size={26} />}
      title="Set up an AI provider first"
      actions={[{ label: 'Open Providers', onClick: onSetUp }]}
    >
      Prompts are sent to a provider you choose: OpenAI-compatible, Azure OpenAI, Anthropic, Gemini, Amazon Bedrock or Ollama. The built-in "mock" provider works fully offline, for trying things out.
    </Empty>
  );
}
