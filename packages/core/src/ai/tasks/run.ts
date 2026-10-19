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
import { ApsError, normalizeError } from '../../errors.js';
import type { Collection, PriceEntry, TokenUsage } from '../../model/types.js';
import type { ExecServices } from '../../runner/execute.js';
import { checkAiCaps, type AiSurface } from '../../storage/ai-usage.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { shortId } from '../../util/ids.js';
import { maskSensitiveText, type Redaction, type Redactor } from '../../util/redact.js';
import { aiLocalOnly, aiPrivacyOf, assertLocalAllowed, resolveAiRoute, type AiPrivacy, type AiRoute, type AiSettingsSource } from '../ai-settings.js';
import { buildAiContext, type AiContextSection } from '../context.js';
import { estimateCost, type ProviderRegistry } from '../index.js';
import { newProposalId, proposedTestFilePath, PROPOSAL_TTL_MS, saveProposal, type Proposal, type ProposalItem } from '../proposal.js';
import { chatStructured, chatText } from '../structured.js';
import { estimateTokens, type ChatMessage } from '../types.js';
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
  /** Override the task's output limit. */
  maxTokens?: number;
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
  ms: number;
  proposal?: Proposal;
  /** The preview without the messages (`dryRun` has them). */
  preview: Omit<AiPreview, 'messages'> & { messages?: ChatMessage[] };
  aiGenerated: true;
  dryRun?: boolean;
}

const SYSTEM = 'You are the AI assistant inside TestPion, a developer tool for testing REST, GraphQL, MCP and LLM systems.';
const FORMAT = 'Format answers in Markdown (short headings, lists, fenced code blocks with a language). Values shown as *** or [REDACTED…] were hidden by TestPion; never ask for them.';
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
function composeMessages(def: AiTaskDef, contextText: string, req: AiTaskRequest, safe: (s: string) => string): ChatMessage[] {
  const history = (req.history ?? []).slice(-12).map((m) => ({ role: m.role, content: safe(m.content).slice(0, 8000) }));
  const first = history.length === 0;
  const question = req.question ? safe(req.question) : undefined;
  const hint = req.hint ? `\n\nAlso: ${safe(req.hint)}` : '';
  const hasContext = !!contextText;
  const turn = first
    ? `${question ? `Question: ${question}${hint}\n\n` : hint ? `${hint.trim()}\n\n` : ''}${hasContext ? `Context:\n${contextText}` : ''}`.trim() || 'Go ahead.'
    : `${question ?? ''}${hint}`;
  if (!first && hasContext) history[0] = { role: history[0]!.role, content: `${history[0]!.content}\n\nContext:\n${contextText}` };
  // the format reference is made when it is used, from the schema and the check registry (never stale)
  const reference = def.format ? `\n\n${formatReference(def.format)}\n\n` : ' ';
  return [{ role: 'system', content: `${SYSTEM} ${def.instruction}${reference}${FORMAT}${first ? '' : ` ${FOLLOW_UP}`}` }, ...history, { role: 'user', content: turn }];
}

/** Build the call without sending it: route, context, messages and the estimate. */
export function prepareAiTask(deps: AiRunDeps, req: AiTaskRequest, extraContext: Record<string, unknown> = {}) {
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
  const messages = composeMessages(def, ctx.text, req, safe);
  const maxOutputTokens = Math.max(64, Math.min(req.maxTokens ?? def.maxTokens ?? (def.tier === 'large' ? 4000 : 2000), 32_000));
  const inputTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
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
  };
  return { def, provider, model, preview, maxOutputTokens };
}

let counter = 0;

/** Run an AI task (see the module comment). */
export async function runAiTask(deps: AiRunDeps, req: AiTaskRequest): Promise<AiTaskResult> {
  // a workspace item: its context (a request and its latest response, a run result, a flow …), under what the caller passed
  let itemContext: Record<string, unknown> | undefined;
  let local: unknown;
  let label: string | undefined;
  const own = aiTask(req.task, { lenient: deps.surface === 'app' });
  if (own?.prepare && !req.item) throw new ApsError('ValidationError', `The AI task "${own.id}" works on a workspace item`, { suggestions: [`Pass one: ${own.context}`] });
  // the file to propose: inside tests/, refused before anything is built or sent
  if (req.path?.trim() && deps.store) req = { ...req, path: proposedTestFilePath(deps.store, req.path) };
  if (req.item && deps.store) {
    // a task with its own reading of an item (a flow from a folder) builds its context itself; the rest share item-context.ts
    // the privacy level is the task's to know: an analysis leaves out what metadata may not hold (failure messages with values)
    const ic = own?.prepare ? await own.prepare(deps.store, req.item, { path: req.path, privacy: aiPrivacyOf(deps.settings, req.privacy) }) : await contextOfItem(deps.store, req.item);
    itemContext = ic.context;
    label = ic.label;
    local = 'local' in ic ? ic.local : undefined;
    req = { ...req, response: req.response ?? ic.response, previous: req.previous ?? ('previous' in ic ? (ic.previous as StoredResponse | undefined) : undefined), path: req.path ?? ('path' in ic ? (ic.path as string | undefined) : undefined) };
    if (ic.collection && !deps.collection) deps = { ...deps, collection: ic.collection };
  }
  // the tp.* reference is read from the sandbox once per process (before the messages are composed)
  if (own && [own.format].flat().includes('script')) await loadScriptApi();
  const { def, provider, model, preview, maxOutputTokens } = prepareAiTask(deps, req, itemContext);
  const { messages, ...summary } = preview;
  const base = { task: def.id, taskVersion: def.version, title: def.title, provider: provider.config.name, model, aiGenerated: true as const };
  if (req.dryRun) return { ...base, text: '', truncated: false, problems: [], repairs: 0, calls: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, ms: 0, preview, dryRun: true };
  checkAiCaps(deps.store, deps.settings.ai, { tokens: preview.estimate.inputTokens + maxOutputTokens, costUsd: preview.estimate.maxCostUsd });

  const started = Date.now();
  const at = new Date().toISOString();
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let calls = 0;
  let outcome: 'ok' | 'error' | 'cancelled' = 'ok';
  let error: string | undefined;
  let proposal: Proposal | undefined;
  let modelUsed = model;
  const input: AiTaskInput = { question: req.question, context: req.context, item: req.item, path: req.path, target: req.target, model: `${provider.config.name}/${model}`, local, label };
  const verifyCtx = {
    response: req.response,
    previous: req.previous,
    variableNames: deps.variableNames?.(),
    collection: deps.collection,
    services: deps.services,
    schema: req.schema ?? (req.context?.schema as Record<string, unknown> | undefined),
    signal: deps.signal,
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
    const items: ProposalItem[] = drafts.map((d, i) => ({ ...d, id: `i${i + 1}`, verification: [], selected: true }));
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
      temperature: 0.2,
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
      const now = Date.now();
      proposal = {
        schemaVersion: 1,
        id: newProposalId(),
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
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
        status: 'open',
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(cost !== undefined ? { costUsd: cost } : {}) },
        request: { question: req.question, item: req.item, hint: req.hint, privacy: preview.privacy, ...(req.path ? { path: req.path } : {}) },
        ...(problems.length ? { problems } : {}),
      };
      if (deps.store) saveProposal(deps.store, proposal);
    }
    return { ...base, model: modelUsed, text, code, value, truncated, finishReason, problems, repairs, calls, usage, costUsd: cost, ms: Date.now() - started, proposal, preview: summary };
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
