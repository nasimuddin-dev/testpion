import type { AppSettings, ProviderConfig } from '../../types';
import { useApp } from '../../store';
import { Field, Input, LinkButton, Segmented, Select, Toggle } from '../ui';
import { PRIVACY_OPTIONS, type AiPrivacy } from './AiPreviewDialog';

type AiSettings = NonNullable<AppSettings['ai']>;

/**
 * Settings ▸ AI assistant, the part every AI feature shares (AIB-6, AIB-7): a model for small tasks (explain,
 * classify, a commit message) and one for generation (tests, flows), Local only, the default privacy level, personal
 * data masking and the cost caps. The CLI and CI read the same settings (and TESTPION_AI_* variables).
 */
export function AiSettingsPanel({ s, set, providers }: { s: AppSettings; set(p: Partial<AppSettings>): void; providers: ProviderConfig[] }) {
  const ai: AiSettings = s.ai ?? {};
  const put = (p: Partial<AiSettings>) => set({ ai: { ...ai, ...p } });
  const num = (v: string) => (v.trim() === '' ? undefined : Math.max(0, Number(v) || 0));
  const tier = (key: 'small' | 'large', label: string, hint: string) => {
    const t = ai[key];
    return (
      <Field label={label} hint={hint}>
        <div className="flex gap-2">
          <Select
            value={t?.provider ?? ''}
            onChange={(e) => put({ [key]: e.target.value ? { provider: e.target.value, model: providers.find((p) => p.id === e.target.value)?.defaultModel } : undefined })}
            aria-label={`${label}: provider`}
          >
            <option value="">Same as the assistant</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {t?.provider && (
            <Input
              className="mono flex-1"
              value={t.model ?? ''}
              placeholder="model"
              onChange={(e) => put({ [key]: { provider: t.provider, model: e.target.value || undefined } })}
              aria-label={`${label}: model`}
            />
          )}
        </div>
      </Field>
    );
  };
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4 mt-1" data-ai-settings>
      <div className="font-medium">Models per task</div>
      <div className="grid grid-cols-2 gap-3">
        {tier('small', 'Small tasks', 'Explanations, triage, commit messages: a cheaper or local model is enough.')}
        {tier('large', 'Large tasks', 'Tests, flows, assertions, toolsets: the most capable model.')}
      </div>
      <Toggle checked={!!ai.localOnly} onChange={(v) => put({ localOnly: v })} label="Local only: AI never leaves this computer" />
      <p className="text-xs text-muted -mt-2 pl-1">
        Only Ollama, LM Studio or another server on 127.0.0.1 may be used; a cloud model is refused before anything is sent. CLI and CI: TESTPION_AI_LOCAL_ONLY=1.
      </p>
      <Field label="What is sent by default" hint="You can change it per action in “What will be sent…”. Secrets, tokens and keys are always masked.">
        <Segmented label="Default privacy level" value={ai.privacy ?? 'full'} onChange={(v) => put({ privacy: v as AiPrivacy })} options={PRIVACY_OPTIONS} />
      </Field>
      <Toggle checked={ai.maskPersonalData !== false} onChange={(v) => put({ maskPersonalData: v })} label="Mask personal data (e-mail addresses, phone numbers, card numbers, IBANs)" />
      <div className="font-medium mt-2">Limits</div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Tokens per call" hint="Empty: no cap">
          <Input type="number" min={0} value={ai.maxTokensPerCall ?? ''} onChange={(e) => put({ maxTokensPerCall: num(e.target.value) })} />
        </Field>
        <Field label="Tokens per day" hint="Per workspace">
          <Input type="number" min={0} value={ai.dailyTokens ?? ''} onChange={(e) => put({ dailyTokens: num(e.target.value) })} />
        </Field>
        <Field label="Cost per day ($)" hint="From Model pricing">
          <Input type="number" min={0} step="0.01" value={ai.dailyBudgetUsd ?? ''} onChange={(e) => put({ dailyBudgetUsd: num(e.target.value) })} />
        </Field>
      </div>
      <p className="text-xs text-muted">
        A call over a cap is refused with what to do; nothing is sent. Every call is counted —{' '}
        <LinkButton onClick={() => useApp.getState().openIntent('ai', { tab: 'usage' })}>see AI usage</LinkButton> (CLI: testpion ai usage).
      </p>
    </div>
  );
}
