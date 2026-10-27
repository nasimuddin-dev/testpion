/**
 * The AI task runner (AIB-1): one function every host calls — the desktop backend (a thin RPC adapter), the CLI
 * (`testpion ai run`), the MCP server (`ai_run_task`) and a cloud host — so a task behaves the same everywhere:
 *
 * route the model (small/large tier, local only) → build the context (redacted, privacy level, budgets) → estimate
 * tokens and cost, check the caps → (dry run: stop here with the preview) → call the model (structured output with
 * repair, or text with truncation detection) → verify the answer and repair it when a verifier fails → make a proposal
 * (never applied here) → record the call in the usage ledger.
 */
import { extractCodeBlock, type ItemRef } from '@testpion/shared';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApsError, normalizeError } from '../../errors.js';
import type { Collection, PriceEntry, TokenUsage } from '../../model/types.js';
import type { ExecServices } from '../../runner/execute.js';
import { aiSettingsForSurface, checkAiCaps, type AiSurface } from '../../storage/ai-usage.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { shortId } from '../../util/ids.js';
import { maskSensitiveText, type Redaction, type Redactor } from '../../util/redact.js';
import { aiHidden, aiLocalOnly, aiPrefersStable, aiPrivacyOf, assertLocalAllowed, resolveAiRoute, type AiPrivacy, type AiRoute, type AiSettingsSource } from '../ai-settings.js';
import { buildAiContext, type AiContextSection } from '../context.js';
import { estimateCost, type ProviderRegistry } from '../index.js';
import { openProposal, proposedTestFilePath, saveProposal, type Proposal, type ProposalItem } from '../proposal.js';
import { chatStructured, chatText } from '../structured.js';
import { newFence } from '../untrusted.js';
import { estimateTokens, type ChatImage, type ChatMessage } from '../types.js';
import { visionCapable } from '../vision.js';
import { imageTokens } from '../../util/image-info.js';
import { verificationProblems, verifyItems, type StoredResponse } from '../verify.js';
import { aiTask, listAiTasks, type AiTaskDef, type AiTaskInput } from './registry.js';
import { contextOfItem } from '../item-context.js';
import { formatReference } from '../flow-format.js';
import { loadScriptApi } from '../script-reference.js';
import type { EngineContext } from '../../engine.js';
import type { AppSettings } from '../../model/types.js';

/** The runner's dependencies as every host builds them from an engine context and the app settings. */
export function aiRunDeps(o: {
  ctx: EngineContext;
  settings: AppSettings;
  surface: AiSurface;
  store?: WorkspaceStore;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onDelta?: (t: string) => void;
}): AiRunDeps {
  return {
    store: o.store,
    providers: o.ctx.services.providers,
    redactor: o.ctx.redactor,
    settings: o.settings,
    surface: o.surface,
    env: o.env,
    signal: o.signal,
    onDelta: o.onDelta,
    variableNames: () => o.ctx.vars.names(),
    services: o.ctx.services,
    collection: o.ctx.collection,
  };
}

export interface AiRunDeps {
  /** The open workspace: the usage ledger, proposals and per-day caps (none: nothing is stored, e.g. a bare CLI). */
  store?: WorkspaceStore;
  providers: ProviderRegistry;
  redactor: Redactor;
  settings: AiSettingsSource & { pricing?: PriceEntry[] };
  surface: AiSurface;
  /** TESTPION_AI_* variables (the CLI and CI pass process.env; the app passes none). */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Streamed text of the first answer. */
  onDelta?: (text: string) => void;
  /** The names (never the values) of the variables in scope. */
  variableNames?: () => string[];
  /** Engine services and the collection: flows are verified against its mock. */
  services?: ExecServices;
  collection?: Collection;
}

export interface AiTaskRequest {
  task: string;
  question?: string;
  context?: Record<string, unknown>;
  /** The conversation so far (the app's follow-ups); the context goes with its first turn. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  item?: ItemRef;
  privacy?: AiPrivacy | string;
  provider?: string;
  model?: string;
  /** Regenerate with a hint ("include the refund path"). */
  hint?: string;
  /** Where a generated test file goes (under tests/). */
  path?: string;
  /** Where a generated request goes (a collection or folder). */
  target?: ItemRef;
  /** The response checks and scripts are verified against. */
  response?: StoredResponse;
  /** An earlier response to the same request: a check or test that passes on `response` but not on it pins a value that changes. */
  previous?: StoredResponse;
  /** A JSON Schema generated JSON must satisfy. */
  schema?: Record<string, unknown>;
  /** Build everything, send nothing: the preview of what would be sent. */
  dryRun?: boolean;
  /** The proposal is returned but not kept in `.local/ai/proposals` (a caller that merges several calls into one proposal saves that itself). */
  noProposal?: boolean;
  /** Override the task's output limit. */
  maxTokens?: number;
  /** Prefer stable checks (types, formats, presence over literal ids, times, tokens); unset: the AI setting. */
  preferStable?: boolean;
  /**
   * Images sent beside the text, as data (a RAG judge reading a picture). They cannot be redacted, so they go only when
   * `allowImages` is true, the privacy level is Full, and the model takes images; otherwise the call is refused before
   * anything is built. Never logged: the usage ledger counts tokens only.
   */
  images?: ChatImage[];
  allowImages?: boolean;
  /** Refuse before sending when this call could cost more than this many US dollars (the price table; a local model is free). */
  maxCostUsd?: number;
}

/** An image of a preview: what it is, not the bytes (a small one carries a data URI to show a thumbnail). */
interface AiPreviewImage {
  sha256: string;
  mime: string;
  bytes: number;
  /** The image itself when it is small enough to show (at most 256 KB); larger ones show their hash and size. */
  thumb?: string;
}

/** "What will be sent": the exact messages, the context's sections, the estimate and the redactions. */
export interface AiPreview {
  task: string;
  title: string;
  provider: string;
  providerName: string;
  model: string;
  tier: AiRoute['tier'];
  modelSource: AiRoute['source'];
  /** The provider runs on this computer (nothing leaves it). */
  local: boolean;
  privacy: AiPrivacy;
  messages: ChatMessage[];
  context: { tokens: number; budgetTokens: number; sections: AiContextSection[] };
  redactions: Redaction[];
  redactionCount: number;
  estimate: { inputTokens: number; maxOutputTokens: number; costUsd?: number; maxCostUsd?: number; priceKnown: boolean };
  /** The images that will be sent with the text, and the model that will see them. */
  images?: AiPreviewImage[];
}

export interface AiTaskResult {
  task: string;
  taskVersion: number;
  title: string;
  provider: string;
  model: string;
  text: string;
  /** The code block of a code task. */
  code?: string;
  /** The parsed value of a JSON task. */
  value?: unknown;
  /** The answer stopped at the output limit (prose only: code and JSON fail instead). */
  truncated: boolean;
  finishReason?: string;
  /** What is still wrong after the repairs (verification, schema). */
  problems: string[];
  repairs: number;
  calls: number;
  usage: TokenUsage;
  costUsd?: number;
  /** The price table has this model: `costUsd` is a real figure (without it a cost of 0 means unknown). */
  priceKnown: boolean;
  ms: number;
  proposal?: Proposal;
  /** The preview without the messages (`dryRun` has them). */
  preview: Omit<AiPreview, 'messages'> & { messages?: ChatMessage[] };
  aiGenerated: true;
  dryRun?: boolean;
}

const SYSTEM = 'You are the AI assistant inside TestPion, a developer tool for testing REST, GraphQL, MCP and LLM systems.';
const FORMAT = 'Format answers in Markdown (short headings, lists, fenced code blocks with a language). Values shown as *** or [REDACTED…] were hidden by TestPion; never ask for them.';
/** Added to a checks task's instruction while "Prefer stable checks" is on. */
const PREFER_STABLE =
  'Prefer stable checks: assert the status, which fields exist, their types and formats (a regex for an id, a time or a token) and ranges; use equals only for a value the request itself sent or a fixed status, never for an id, a time, a token or any value the server makes up.';
const FOLLOW_UP =
  'This is a follow-up in the conversation: answer the question itself, in prose with code blocks where useful (the output-only rule above applied to the first answer); when you change code you gave before, give the whole new version in one code block.';

const LANGS: Record<string, string[]> = { yaml: ['yaml', 'yml'], json: ['json'], javascript: ['javascript', 'js'], graphql: ['graphql', 'gql'], text: ['text', ''] };

/** An unknown task: what exists. */
function unknownTask(id: string): ApsError {
  return new ApsError('ValidationError', `No AI task "${id}"`, {
    suggestions: [
      `Tasks: ${listAiTasks()
        .map((t) => t.id)
        .join(', ')}`,
      'testpion ai tasks (MCP ai_list_tasks) describes each.',
    ],
  });
}

/** The messages of a call: the system prompt (task instruction), the conversation, and this turn with the context. */
function composeMessages(def: AiTaskDef, contextText: string, req: AiTaskRequest, safe: (s: string) => string, preferStable = false): ChatMessage[] {
  const history = (req.history ?? []).slice(-12).map((m) => ({ role: m.role, content: safe(m.content).slice(0, 8000) }));
  const first = history.length === 0;
  const question = req.question ? safe(req.question) : undefined;
  const hint = req.hint ? `\n\nAlso: ${safe(req.hint)}` : '';
  const hasContext = !!contextText;
  // the context is workspace content, responses and tool results: data, in a fence the model is told never to obey
  const fence = newFence([contextText]);
  const fenced = hasContext ? `Context:\n${fence.wrap('context', contextText)}` : '';
  const turn = first
    ? `${question ? `Question: ${question}${hint}\n\n` : hint ? `${hint.trim()}\n\n` : ''}${fenced}`.trim() || 'Go ahead.'
    : `${question ?? ''}${hint}`;
  if (!first && hasContext) history[0] = { role: history[0]!.role, content: `${history[0]!.content}\n\n${fenced}` };
  // the format reference is made when it is used, from the schema and the check registry (never stale)
  const reference = def.format ? `\n\n${formatReference(def.format)}\n\n` : ' ';
  const stable = preferStable ? ` ${PREFER_STABLE}` : '';
  return [{ role: 'system', content: `${SYSTEM} ${def.instruction}${stable}${reference}${FORMAT}${hasContext ? ` ${fence.rule}` : ''}${first ? '' : ` ${FOLLOW_UP}`}` }, ...history, { role: 'user', content: turn }];
}

/** How many calls were built (a counter for tests and profiling: a judged RAG sample used to be built twice per real call). */
export const prepareStats = { built: 0 };

/** Build the call without sending it: route, context, messages and the estimate. */
export function prepareAiTask(deps: AiRunDeps, req: AiTaskRequest, extraContext: Record<string, unknown> = {}) {
  prepareStats.built++;
  const def = aiTask(req.task, { lenient: deps.surface === 'app' });
  if (!def) throw unknownTask(req.task);
  const route = resolveAiRoute({ settings: deps.settings, tier: def.tier, override: { provider: req.provider, model: req.model }, env: deps.env });
  const localOnly = aiLocalOnly(deps.settings, deps.env);
  // Local only is checked on the provider's settings BEFORE its key is looked up: a cloud provider with no key is
  // refused for leaving this computer (the story that matters), not for the key it lacks
  const configured = deps.providers.find(route.provider);
  if (configured) assertLocalAllowed(configured, localOnly);
  const { provider, model } = deps.providers.resolveModel({ provider: route.provider, name: route.model });
  assertLocalAllowed(provider.config, localOnly);
  const privacy = aiPrivacyOf(deps.settings, req.privacy);
  const pii = deps.settings.ai?.maskPersonalData !== false;
  const variables =
    def.variableNames && deps.variableNames
      ? {
          variables: deps
            .variableNames()
            .filter((k) => !k.startsWith('$'))
            .slice(0, 300),
        }
      : {};
  const ctx = buildAiContext(
    { ...extraContext, ...(req.context ?? {}), ...variables },
    { privacy, redactor: deps.redactor, budgetTokens: def.contextTokens, sectionBudgets: def.sectionBudgets, maskPersonalData: pii },
  );
  const safe = (s: string) => maskSensitiveText(deps.redactor.redactString(s), { pii });
  const preferStable = !!def.stable && aiPrefersStable(deps.settings, req.preferStable);
  const messages = composeMessages(def, ctx.text, req, safe, preferStable);
  if (req.images?.length) {
    // pictures cannot be redacted: they leave only when the evaluation allowed it, at the level that sends the content, to a model that can see
    if (!req.allowImages) throw new ApsError('ConfigurationError', `${req.images.length} image(s) would be sent to the judge, but this evaluation does not allow images`, { why: 'An image cannot be redacted, so images are sent only when the evaluation says so (allowImages).', suggestions: ['Turn on "Send images to the judge" in the evaluation (CLI: --allow-images).', 'Or use the metrics that read text only.'] });
    if (privacy !== 'full') throw new ApsError('ConfigurationError', `Images are not sent at the AI privacy level "${privacy}"`, { suggestions: ['Settings ▸ AI assistant ▸ Privacy ▸ Full (redacted), or use a local vision model.'] });
    if (!visionCapable(provider.config, model)) throw new ApsError('ConfigurationError', `The judge ${provider.config.name}/${model} cannot see images`, { why: 'A text-only model would score a prompt that silently lost its pictures.', suggestions: ['Choose a vision-capable judge for this evaluation (a local one such as an Ollama vision model works), or list the model in the provider’s visionModels.'] });
    const last = messages[messages.length - 1]!;
    messages[messages.length - 1] = { ...last, images: req.images };
  }
  const maxOutputTokens = Math.max(64, Math.min(req.maxTokens ?? def.maxTokens ?? (def.tier === 'large' ? 4000 : 2000), 32_000));
  const inputTokens = estimateTokens(messages.map((m) => m.content).join('\n')) + (req.images ?? []).reduce((a) => a + imageTokens(provider.config.kind), 0);
  const pricing = deps.settings.pricing ?? [];
  const inCost = estimateCost(pricing, provider.config, model, { inputTokens, outputTokens: 0, totalTokens: inputTokens });
  const maxCost = estimateCost(pricing, provider.config, model, { inputTokens, outputTokens: maxOutputTokens, totalTokens: inputTokens + maxOutputTokens });
  const preview: AiPreview = {
    task: def.id,
    title: def.title,
    provider: provider.config.id,
    providerName: provider.config.name,
    model,
    tier: def.tier,
    modelSource: route.source,
    local: (() => {
      try {
        assertLocalAllowed(provider.config, true);
        return true;
      } catch {
        return false;
      }
    })(),
    privacy,
    messages,
    context: { tokens: ctx.tokens, budgetTokens: ctx.budgetTokens, sections: ctx.sections },
    redactions: ctx.redactions,
    redactionCount: ctx.redactionCount,
    estimate: { inputTokens, maxOutputTokens, costUsd: inCost.cost, maxCostUsd: maxCost.cost, priceKnown: maxCost.cost !== undefined },
    ...(req.images?.length ? { images: req.images.map((i) => ({ sha256: i.sha256, mime: i.mime, bytes: Math.floor((i.data.length * 3) / 4), ...(i.data.length <= 350_000 ? { thumb: `data:${i.mime};base64,${i.data}` } : {}) })) } : {}),
  };
  return { def, provider, model, preview, maxOutputTokens, preferStable };
}

let counter = 0;

const costCap = new AsyncLocalStorage<number>();
let processCostCap: number | undefined;

/** The cap of a whole process (the CLI's `--max-cost`: one command per process); `undefined` removes it. */
export function setAiCostCap(maxCostUsd: number | undefined): void {
  processCostCap = typeof maxCostUsd === 'number' && Number.isFinite(maxCostUsd) && maxCostUsd >= 0 ? maxCostUsd : undefined;
}

/** Run `fn` with a per-call cost cap (USD) on every AI call inside it: the MCP tools' `max_cost_usd`, the CLI's `--max-cost`. */
export function withAiCostCap<T>(maxCostUsd: number | undefined, fn: () => T): T {
  return typeof maxCostUsd === 'number' && Number.isFinite(maxCostUsd) && maxCostUsd >= 0 ? costCap.run(maxCostUsd, fn) : fn();
}

/** Refuse a call that could cost more than the caller allowed, before anything is sent. */
function checkCallCost(preview: AiPreview, cap: number | undefined): void {
  if (cap === undefined || preview.local) return;
  const most = preview.estimate.maxCostUsd;
  const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
  if (most === undefined)
    throw new ApsError('ConfigurationError', `This model has no price, so the cost cap of ${usd(cap)} cannot be kept`, {
      why: 'The cost of a call comes from the price table (Settings ▸ Model pricing). Nothing was sent.',
      suggestions: ['Add a price for this model in Settings ▸ Model pricing, or run without a cap.'],
      details: { aiLimit: { cap: 'maxCostUsd', limit: cap }, setup: { assistant: true } },
    });
  if (most > cap)
    throw new ApsError('ValidationError', `This call could cost up to ${usd(most)}, over the cap of ${usd(cap)}`, {
      why: 'The estimate is the context, plus the most the answer may use, at the price of the model. Nothing was sent.',
      suggestions: ['Send less: a folder instead of a collection, or the Metadata only privacy level.', 'Or raise the cap, or pick a cheaper model.'],
      details: { aiLimit: { cap: 'maxCostUsd', limit: cap, estimate: most } },
    });
}

/**
 * Run an AI task (see the module comment). `prepared` is the call already built by `prepareAiTask(deps, req)` for this very
 * request (the RAG judge builds it first to read the cache): it is used as it is, not built again.
 */
export async function runAiTask(deps: AiRunDeps, req: AiTaskRequest, o: { prepared?: ReturnType<typeof prepareAiTask> } = {}): Promise<AiTaskResult> {
  // Settings ▸ AI assistant ▸ "Hide AI actions": the window offers none, and a stale one is refused here (the CLI and MCP are explicit calls)
  if (deps.surface === 'app' && aiHidden(deps.settings))
    throw new ApsError('ConfigurationError', 'AI actions are hidden', { why: 'Settings ▸ AI assistant has "Hide all AI actions" on, so the window runs no AI task. Nothing was sent.', suggestions: ['Turn it off in Settings ▸ AI assistant to use the AI actions again.'] });
  // a workspace item: its context (a request and its latest response, a run result, a flow …), under what the caller passed
  let itemContext: Record<string, unknown> | undefined;
  let local: unknown;
  let label: string | undefined;
  const own = aiTask(req.task, { lenient: deps.surface === 'app' });
  if (own?.prepare && !own.itemOptional && !req.item) throw new ApsError('ValidationError', `The AI task "${own.id}" works on a workspace item`, { suggestions: [`Pass one: ${own.context}`] });
  // the file to propose: inside tests/, refused before anything is built or sent
  if (req.path?.trim() && deps.store) req = { ...req, path: proposedTestFilePath(deps.store, req.path) };
  if (req.item && deps.store) {
    // a task with its own reading of an item (a flow from a folder) builds its context itself; the rest share item-context.ts
    // the privacy level is the task's to know: an analysis leaves out what metadata may not hold (failure messages with values)
    const ic = own?.prepare ? await own.prepare(deps.store, req.item, { path: req.path, privacy: aiPrivacyOf(deps.settings, req.privacy), context: req.context }) : await contextOfItem(deps.store, req.item);
    itemContext = ic.context;
    label = ic.label;
    local = 'local' in ic ? ic.local : undefined;
    req = { ...req, response: req.response ?? ic.response, previous: req.previous ?? ('previous' in ic ? (ic.previous as StoredResponse | undefined) : undefined), path: req.path ?? ('path' in ic ? (ic.path as string | undefined) : undefined) };
    if (ic.collection && !deps.collection) deps = { ...deps, collection: ic.collection };
  } else if (own?.prepareContext && deps.store) {
    // a task about no single item (documents, a target and a dataset) reads the workspace from the caller's choices; only what
    // it returns is sent, never the choices themselves (paths …), and what it keeps (`local`) stays on this computer
    const ic = await own.prepareContext(deps.store, req.context ?? {}, { privacy: aiPrivacyOf(deps.settings, req.privacy), signal: deps.signal });
    itemContext = ic.context;
    label = ic.label;
    local = ic.local;
    req = { ...req, context: undefined };
  }
  // the tp.* reference is read from the sandbox once per process (before the messages are composed)
  if (own && [own.format].flat().includes('script')) await loadScriptApi();
  const { def, provider, model, preview, maxOutputTokens, preferStable } = o.prepared && !req.item ? o.prepared : prepareAiTask(deps, req, itemContext);
  const { messages, ...summary } = preview;
  const base = { task: def.id, taskVersion: def.version, title: def.title, provider: provider.config.name, model, aiGenerated: true as const };
  // a dry run's messages go to the window: the pictures are in `preview.images` (thumbnails), not twice in the messages
  if (req.dryRun) return { ...base, text: '', truncated: false, problems: [], repairs: 0, calls: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, priceKnown: false, ms: 0, preview: { ...preview, messages: preview.messages.map(({ images: _i, ...m }) => m) }, dryRun: true };
  checkAiCaps(deps.store, aiSettingsForSurface(deps.settings.ai, deps.surface), { tokens: preview.estimate.inputTokens + maxOutputTokens, costUsd: preview.estimate.maxCostUsd });
  checkCallCost(preview, req.maxCostUsd ?? costCap.getStore() ?? processCostCap);

  const started = Date.now();
  const at = new Date().toISOString();
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let calls = 0;
  let outcome: 'ok' | 'error' | 'cancelled' = 'ok';
  let error: string | undefined;
  let proposal: Proposal | undefined;
  let modelUsed = model;
  const input: AiTaskInput = { question: req.question, context: req.context, item: req.item, path: req.path, target: req.target, model: `${provider.config.name}/${model}`, local, label, preferStable };
  const verifyCtx = {
    response: req.response,
    previous: req.previous,
    variableNames: deps.variableNames?.(),
    collection: deps.collection,
    services: deps.services,
    schema: req.schema ?? (req.context?.schema as Record<string, unknown> | undefined),
    signal: deps.signal,
    store: deps.store,
    runDeps: deps,
    tasks: { prepare: prepareAiTask, run: runAiTask },
  };
  /** The answer as proposal items, verified; cached per answer so the repair check and the result share the work. */
  let proposeNotes: string[] = [];
  const itemsOf = async (answer: { text: string; code: string; value?: unknown }): Promise<{ items: ProposalItem[]; problems: string[] }> => {
    // a task that only answers (a search query) may still have its answer checked: the problems are repaired like a verifier's
    if (!def.propose) return { items: [], problems: def.validate && answer.value !== undefined ? def.validate(answer.value) : [] };
    let drafts;
    // what the task could not make of the answer and the model can correct (a fix naming text that is not in the file):
    // repair turns send it back like a failing verifier's problem
    let proposeProblems: string[] = [];
    try {
      const out = def.propose(answer, input);
      // a task may say what it could not make of the answer (a fix whose text is not in the file …)
      drafts = Array.isArray(out) ? out : out.items;
      proposeNotes = Array.isArray(out) ? [] : (out.notes ?? []);
      proposeProblems = Array.isArray(out) ? [] : (out.problems ?? []);
    } catch (e) {
      return { items: [], problems: [normalizeError(e).message] };
    }
    const items: ProposalItem[] = drafts.map((d, i) => ({ ...d, id: `i${i + 1}`, verification: [], selected: d.selected ?? true }));
    // a file that exists: its current text, so the review shows a diff (and apply keeps it for undo)
    for (const it of items)
      if ((it.kind === 'file' || it.kind === 'flow') && it.path && it.before === undefined && deps.store)
        try {
          it.before = deps.store.readTestFile(it.path);
        } catch {
          /* a new file */
        }
    await verifyItems(items, def.verifiers ?? [], verifyCtx);
    return { items, problems: [...proposeProblems, ...verificationProblems(items)] };
  };
  try {
    let text = '';
    let code: string | undefined;
    let value: unknown;
    let truncated = false;
    let finishReason: string | undefined;
    let problems: string[] = [];
    let repairs = 0;
    let items: ProposalItem[] = [];
    let fixes: string[] = [];
    const common = {
      provider,
      model,
      maxTokens: maxOutputTokens,
      temperature: def.temperature ?? 0.2,
      signal: deps.signal,
      onCall: (r: { usage: TokenUsage; model: string }) => (
        (usage = { inputTokens: usage.inputTokens + r.usage.inputTokens, outputTokens: usage.outputTokens + r.usage.outputTokens, totalTokens: usage.totalTokens + r.usage.totalTokens }),
        calls++,
        (modelUsed = r.model || modelUsed)
      ),
    };
    if (def.output.kind === 'json') {
      let last: Awaited<ReturnType<typeof itemsOf>> | undefined;
      const r = await chatStructured({
        ...common,
        messages,
        schema: def.output.schema,
        schemaName: def.id.replace(/-/g, '_'),
        maxRepairs: def.maxRepairs ?? 2,
        onDelta: deps.onDelta,
        check: async (v) => (last = await itemsOf({ text: JSON.stringify(v), code: JSON.stringify(v, null, 2), value: v })).problems,
      });
      text = r.text;
      value = r.value;
      code = r.value !== undefined ? JSON.stringify(r.value, null, 2) : undefined;
      problems = r.problems;
      repairs = r.repairs;
      finishReason = r.finishReason;
      items = r.ok && last ? last.items : value !== undefined ? (await itemsOf({ text, code: code ?? '', value })).items : [];
    } else {
      // prose and code: code is verified and, when a verifier fails, sent back with the problems (first answers only)
      const langs = def.output.kind === 'code' ? (LANGS[def.output.language] ?? []) : [];
      const maxRepairs = def.output.kind === 'code' && !req.history?.length && def.verifiers?.length ? (def.maxRepairs ?? 2) : 0;
      let convo = messages;
      // the best attempt (with items, fewest problems) is kept: a worse repair never replaces a better answer
      let best: { text: string; code: string; items: ProposalItem[]; problems: string[]; finishReason?: string; notes: string[] } | undefined;
      for (let attempt = 0; ; attempt++) {
        const r = await chatText({ ...common, messages: convo, onDelta: attempt === 0 ? deps.onDelta : undefined, maxContinuations: 1 });
        if (def.output.kind === 'markdown') {
          text = r.text;
          truncated = r.truncated;
          finishReason = r.finishReason;
          break;
        }
        if (r.truncated && !best)
          throw new ApsError('ValidationError', `The answer was cut at the output limit (${maxOutputTokens} tokens) and is incomplete`, {
            why: 'The model stopped because it reached the most tokens it may write, not because it was done; incomplete code is not offered.',
            details: { truncated: true, finishReason: r.finishReason, partial: r.text.slice(-500) },
            suggestions: ['Ask for less at once (fewer steps, a folder instead of a collection).', 'Use a larger model for generation (Settings ▸ AI assistant ▸ Large tasks).'],
          });
        // made safe before it is verified (an unquoted {{ in YAML is quoted): the notes say what was fixed
        const n = def.normalize ? def.normalize(extractCodeBlock(r.text, langs)) : { code: extractCodeBlock(r.text, langs), notes: [] as string[] };
        const c = n.code;
        const v = r.truncated ? { items: [] as ProposalItem[], problems: ['the answer was cut at the output limit'] } : await itemsOf({ text: r.text, code: c });
        if (!best || (v.items.length > 0 && (!best.items.length || v.problems.length < best.problems.length)))
          best = { text: r.text, code: c, items: v.items, problems: v.problems, finishReason: r.finishReason, notes: n.notes };
        if (!v.problems.length || attempt >= maxRepairs) break;
        repairs++;
        convo = [
          ...convo,
          { role: 'assistant', content: r.text },
          { role: 'user', content: `TestPion checked that answer and found problems:\n${v.problems.map((p) => `- ${p}`).join('\n')}\nGive the whole corrected version again, in one code block.` },
        ];
      }
      if (best) {
        text = best.text;
        code = best.code;
        fixes = best.notes;
        items = best.items;
        problems = best.problems;
        finishReason = best.finishReason;
      }
    }
    const cost = estimateCost(deps.settings.pricing ?? [], provider.config, modelUsed, usage).cost;
    let described: ReturnType<NonNullable<AiTaskDef['describe']>> = {};
    try {
      described = value !== undefined && def.describe ? def.describe(value, items, input) : {};
    } catch {
      /* a description is a courtesy: the items stand on their own */
    }
    // an analysis is a proposal even when it changes nothing (its findings: the API regressed, a token expired)
    if (items.length || described.findings?.length) {
      proposal = openProposal({
        task: def.id,
        taskVersion: def.version,
        title: label ? `${def.title}: ${label}` : req.question ? `${def.title}: ${req.question.slice(0, 80)}` : def.title,
        summary:
          described.summary?.slice(0, 1200) ||
          (def.output.kind === 'code'
            ? text
                .replace(/```[\s\S]*?```/g, '')
                .trim()
                .slice(0, 1200) || undefined
            : undefined),
        assumptions: (described.assumptions ?? []).filter((a) => typeof a === 'string' && a.trim()).slice(0, 20),
        ...(described.notes?.length || fixes.length || proposeNotes.length ? { notes: [...fixes, ...proposeNotes, ...(described.notes ?? [])].slice(0, 30) } : {}),
        items,
        ...(described.findings?.length ? { findings: described.findings } : {}),
        provider: provider.config.name,
        model: modelUsed,
        surface: deps.surface,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(cost !== undefined ? { costUsd: cost } : {}) },
        request: { question: req.question, item: req.item, hint: req.hint, privacy: preview.privacy, ...(req.path ? { path: req.path } : {}) },
        ...(problems.length ? { problems } : {}),
      });
      if (deps.store && !req.noProposal) saveProposal(deps.store, proposal);
    }
    return { ...base, model: modelUsed, text, code, value, truncated, finishReason, problems, repairs, calls, usage, costUsd: cost, ms: Date.now() - started, proposal, preview: summary, priceKnown: cost !== undefined };
  } catch (e) {
    const n = normalizeError(e);
    outcome = n.kind === 'CancelledError' || deps.signal?.aborted ? 'cancelled' : 'error';
    error = n.kind;
    throw e;
  } finally {
    if (deps.store && (calls > 0 || outcome !== 'ok')) {
      const cost = estimateCost(deps.settings.pricing ?? [], provider.config, modelUsed, usage).cost;
      try {
        deps.store.meta.addAiCall({
          id: `${shortId('aic-')}${(counter++ % 1000).toString(36)}`,
          at,
          surface: deps.surface,
          task: def.id,
          provider: provider.config.name,
          model: modelUsed,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ms: Date.now() - started,
          outcome,
          calls,
          ...(proposal ? { proposalId: proposal.id } : {}),
          ...(error ? { error } : {}),
        });
      } catch {
        /* the ledger must never fail a call */
      }
    }
  }
}
