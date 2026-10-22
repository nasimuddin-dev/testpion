/**
 * The AI settings every host shares (the desktop app's Settings ▸ AI assistant, the CLI and CI through environment
 * variables, the MCP server through the app settings): which model a task uses (small or large tier), whether only a
 * model on this computer may be used, how much of the context is sent (privacy level), and the cost caps.
 */
import { staysOnThisComputer } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { ProviderConfig } from '../model/types.js';

/** How much of a context is sent: everything (redacted), shapes and names without bodies, or names only. */
export type AiPrivacy = 'full' | 'metadata' | 'names';
export const AI_PRIVACY_LEVELS: ReadonlyArray<{ id: AiPrivacy; label: string; text: string }> = [
  { id: 'full', label: 'Full (redacted)', text: 'Requests, responses and results with secrets, tokens and personal data masked.' },
  { id: 'metadata', label: 'Metadata only', text: 'Methods, URLs without query values, statuses, names and the shape of bodies; no body values.' },
  { id: 'names', label: 'Names only', text: 'Only names, kinds and the structure: no URLs, bodies or values.' },
];

/** A task's tier: cheap and quick (explain, classify, a commit message) or generation (tests, flows, toolsets). */
export type AiTier = 'small' | 'large';

interface AiModelChoice {
  /** A provider id or name (a workspace provider, `claude-app`, `ollama`, `mock`). */
  provider: string;
  model?: string;
}

export interface AiSettings {
  /** The model for small tasks; unset: the assistant's model. */
  small?: AiModelChoice;
  /** The model for generation; unset: the assistant's model. */
  large?: AiModelChoice;
  /** Only providers on this computer (Ollama, LM Studio, a local OpenAI-compatible server, the mock). */
  localOnly?: boolean;
  /** The privacy level a task starts with (default full, redacted). */
  privacy?: AiPrivacy;
  /** Longest wait for a provider's answer (ms; for a stream: the first bytes). Default 120000; 0 = no limit. */
  requestTimeoutMs?: number;
  /** Longest silence inside a stream (ms). Default 60000; 0 = no limit. */
  idleTimeoutMs?: number;
  /** Mask e-mail addresses, phone numbers, card numbers and IBANs (default on). */
  maskPersonalData?: boolean;
  /** Most tokens (input estimate + the output limit) one call may use; 0 or unset: no cap. */
  maxTokensPerCall?: number;
  /** Most tokens the AI features may use per day in this workspace; 0 or unset: no cap. */
  dailyTokens?: number;
  /** Most estimated cost per day in this workspace (USD, from the price table); 0 or unset: no cap. */
  dailyBudgetUsd?: number;
  /** Hide every AI action of the window (menus, buttons, the assistant, shortcuts); the CLI and MCP tools stay explicit calls. */
  hidden?: boolean;
  /** Prefer stable checks: suggested checks assert types, formats and presence instead of literal ids, times and tokens. */
  preferStable?: boolean;
}

/** The parts of the app settings the AI features read. */
export interface AiSettingsSource {
  assistantProvider?: string;
  assistantModel?: string;
  ai?: AiSettings;
}

/** Where a task's model came from (shown with the answer and in --dry-run). */
type AiModelSource = 'override' | 'env' | 'tier' | 'assistant';

export interface AiRoute {
  provider: string;
  model?: string;
  tier: AiTier;
  source: AiModelSource;
}

/** The AI assistant has no model: the one error every surface shows, with how to set it up (the app offers a button). */
function aiNotSetUpError(): ApsError {
  return new ApsError('ConfigurationError', 'The AI assistant is off', {
    why: 'No model is chosen for the AI features, so nothing was sent.',
    details: { setup: { assistant: true } },
    suggestions: [
      'In the app: Settings ▸ AI assistant: save your Claude (Anthropic) API key, or choose a provider of this workspace (a local model works offline).',
      'In the CLI or CI: pass --provider and --model, or set TESTPION_AI_PROVIDER and TESTPION_AI_MODEL (e.g. TESTPION_AI_PROVIDER=ollama).',
    ],
  });
}

const env = (e: Record<string, string | undefined>, k: string) => (e[k] ?? '').trim() || undefined;

/**
 * The model a task uses: an explicit choice (`--provider/--model`, an RPC's `model`), else the environment
 * (TESTPION_AI_PROVIDER, TESTPION_AI_MODEL, TESTPION_AI_MODEL_SMALL / _LARGE), else the tier's model in the settings,
 * else the assistant's. Throws "The AI assistant is off" when none is set.
 */
export function resolveAiRoute(o: { settings: AiSettingsSource; tier: AiTier; override?: Partial<AiModelChoice>; env?: Record<string, string | undefined> }): AiRoute {
  const e = o.env ?? {};
  const { settings, tier } = o;
  if (o.override?.provider) return { provider: o.override.provider, model: o.override.model || undefined, tier, source: 'override' };
  const envProvider = env(e, 'TESTPION_AI_PROVIDER');
  const envModel = env(e, tier === 'small' ? 'TESTPION_AI_MODEL_SMALL' : 'TESTPION_AI_MODEL_LARGE') ?? env(e, 'TESTPION_AI_MODEL');
  if (envProvider) return { provider: envProvider, model: o.override?.model || envModel, tier, source: 'env' };
  const t = settings.ai?.[tier];
  if (t?.provider) return { provider: t.provider, model: o.override?.model || t.model || undefined, tier, source: 'tier' };
  if (settings.assistantProvider) return { provider: settings.assistantProvider, model: o.override?.model || envModel || settings.assistantModel || undefined, tier, source: 'assistant' };
  throw aiNotSetUpError();
}

/** Whether the "Local only" switch is on: the settings, or TESTPION_AI_LOCAL_ONLY=1 for the CLI and CI. */
export function aiLocalOnly(settings: AiSettingsSource, e: Record<string, string | undefined> = {}): boolean {
  const v = env(e, 'TESTPION_AI_LOCAL_ONLY');
  return v ? v !== '0' && v.toLowerCase() !== 'false' : settings.ai?.localOnly === true;
}

/** "Local only" refuses a provider that sends anything off this computer, before anything is sent. */
export function assertLocalAllowed(cfg: ProviderConfig, localOnly: boolean): void {
  if (!localOnly || staysOnThisComputer(cfg)) return;
  throw new ApsError('ConfigurationError', `Local only is on: ${cfg.name} would send the context off this computer`, {
    why: `${cfg.name} (${cfg.kind}${cfg.baseUrl ? `, ${cfg.baseUrl}` : ''}) is not a model on this computer, and the AI settings allow only local models. Nothing was sent.`,
    details: { setup: { assistant: true }, localOnly: true },
    suggestions: [
      'Choose a local model in Settings ▸ AI assistant (Ollama or LM Studio on 127.0.0.1), or turn Local only off there.',
      'CLI and CI: --provider ollama (or a workspace provider on 127.0.0.1), or unset TESTPION_AI_LOCAL_ONLY.',
    ],
  });
}

const isPrivacy = (v: unknown): v is AiPrivacy => v === 'full' || v === 'metadata' || v === 'names';

/**
 * The AI settings in the shape the hosts read, whatever settings.json holds (a hand-edited file, an older or newer
 * version): a value of the wrong type is dropped for its default (no model for the tier, Local only off, full privacy,
 * masking on, no cap) instead of reaching a host. A cap must be a finite number above 0: a negative or non-numeric one
 * would refuse every call (or none) with a message that makes no sense. Undefined when nothing usable is left.
 */
export function normalizeAiSettings(v: unknown): AiSettings | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  const out: AiSettings = {};
  for (const tier of ['small', 'large'] as const) {
    const t = a[tier] as Record<string, unknown> | undefined;
    if (t && typeof t === 'object' && !Array.isArray(t) && typeof t.provider === 'string' && t.provider.trim())
      out[tier] = { provider: t.provider, ...(typeof t.model === 'string' && t.model.trim() ? { model: t.model } : {}) };
  }
  if (typeof a.localOnly === 'boolean') out.localOnly = a.localOnly;
  if (isPrivacy(a.privacy)) out.privacy = a.privacy;
  if (typeof a.maskPersonalData === 'boolean') out.maskPersonalData = a.maskPersonalData;
  if (typeof a.hidden === 'boolean') out.hidden = a.hidden;
  if (typeof a.preferStable === 'boolean') out.preferStable = a.preferStable;
  for (const cap of ['maxTokensPerCall', 'dailyTokens', 'dailyBudgetUsd'] as const) {
    const n = a[cap];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[cap] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The privacy level of a call: the call's own, else the settings' default, else full (redacted). */
export const aiPrivacyOf = (settings: AiSettingsSource, asked?: string): AiPrivacy => (isPrivacy(asked) ? asked : isPrivacy(settings.ai?.privacy) ? settings.ai.privacy : 'full');

/** Whether Settings hides every AI action of the window (the app refuses to run a task then; the CLI and MCP are explicit calls). */
export const aiHidden = (settings: AiSettingsSource): boolean => settings.ai?.hidden === true;

/** Whether suggested checks prefer stable forms: the call's own choice, else the setting (off by default). */
export const aiPrefersStable = (settings: AiSettingsSource, asked?: boolean): boolean => (typeof asked === 'boolean' ? asked : settings.ai?.preferStable === true);
