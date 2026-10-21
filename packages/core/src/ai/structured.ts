/**
 * Calls to a model whose answer must be usable as it is (AIB-3):
 *
 * - `chatStructured`: JSON that conforms to a schema. The provider's JSON-schema mode is used where it has one
 *   (OpenAI-compatible `response_format: json_schema`, which Ollama and LM Studio follow; Gemini `responseJsonSchema`;
 *   Anthropic gets the schema as an instruction), else the schema goes into the prompt; either way the answer is
 *   extracted tolerantly (code fences, text around it), validated, and on a problem sent back with the problem up to
 *   `maxRepairs` times. The best attempt is returned with its problems instead of being hidden.
 * - `chatText`: prose or code, with truncation detected (`finishReason` length / max_tokens) and continued once.
 *
 * Both sum the usage of every call they make.
 */
import { ApsError } from '../errors.js';
import type { TokenUsage } from '../model/types.js';
import { validateSchema } from '../eval/checks.js';
import type { ChatMessage, ChatResponse, LlmProvider } from './types.js';

interface CallBase {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** Told of every call made (the usage ledger, traces). */
  onCall?: (r: ChatResponse) => void;
}

interface StructuredOptions extends CallBase {
  schema: Record<string, unknown>;
  schemaName?: string;
  /** Up to how many times a problem is sent back (default 2). */
  maxRepairs?: number;
  /** More checks of a parsed value (a verifier: lint, references); problems are repaired like schema errors. */
  check?: (value: unknown) => string[] | Promise<string[]>;
  /** How many times a cut answer is continued (default 1). */
  maxContinuations?: number;
}

interface StructuredResult<T = unknown> {
  ok: boolean;
  /** The parsed value of the best attempt (absent when no attempt parsed). */
  value?: T;
  text: string;
  /** Calls answered (attempts + continuations). */
  calls: number;
  attempts: number;
  repairs: number;
  usage: TokenUsage;
  /** The best attempt's problems (empty when ok). */
  problems: string[];
  finishReason?: string;
  model: string;
  mode: 'json_schema' | 'prompt';
}

interface TextResult {
  text: string;
  calls: number;
  usage: TokenUsage;
  finishReason?: string;
  /** Still cut after the continuations: the text ends where the model stopped. */
  truncated: boolean;
  model: string;
}

const zero = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens });

/** The answer stopped at the output limit, not because it was done. */
export const isTruncated = (finishReason: string | undefined): boolean => !!finishReason && /^(length|max_tokens|max_output_tokens|MAX_TOKENS)$/i.test(finishReason);

/** The provider kinds whose API takes a JSON schema for the answer. */
const schemaModeOf = (provider: LlmProvider): 'json_schema' | 'prompt' => (['openai-compatible', 'azure-openai', 'ollama', 'gemini'].includes(provider.config.kind) ? 'json_schema' : 'prompt');

/**
 * The JSON value in a model's answer: the whole text, a fenced block, or the first balanced object/array in it.
 * Returns the error of the most likely candidate when none parses.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = (text ?? '').trim();
  if (!t) return { ok: false, error: 'The answer is empty.' };
  const tries: string[] = [t];
  for (const m of t.matchAll(/```(?:json|JSON)?[^\n]*\n([\s\S]*?)```/g)) tries.push(m[1]!.trim());
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i]!;
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        tries.push(t.slice(start, i + 1));
        break;
      }
    }
  }
  let error = '';
  for (const s of tries) {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch (e) {
      error ||= (e as Error).message;
    }
  }
  return { ok: false, error: `The answer is not JSON: ${error}` };
}

/** A provider that refused the `response_format` (an older server, a model without structured output). */
const refusedFormat = (e: unknown) => {
  const k = (e as ApsError)?.kind;
  return (k === 'ValidationError' || k === 'ProtocolError' || k === 'ServerError') && /response_format|json_schema|responseJsonSchema|structured|format/i.test(String((e as Error)?.message ?? ''));
};

const CONTINUE = 'Your answer was cut off at the output limit. Continue exactly where it stopped: no repetition, no introduction, no code fence opening again.';

/** Plain text or code, continued when the output limit cut it (up to `maxContinuations`, default 1). */
export async function chatText(o: CallBase & { maxContinuations?: number }): Promise<TextResult> {
  let usage = zero();
  let calls = 0;
  let text = '';
  let messages = o.messages;
  let finish: string | undefined;
  let model = o.model;
  for (let i = 0; i <= (o.maxContinuations ?? 1); i++) {
    const r = await o.provider.chat({ model: o.model, messages, maxTokens: o.maxTokens, temperature: o.temperature, signal: o.signal, stream: !!o.onDelta, onDelta: o.onDelta });
    o.onCall?.(r);
    calls++;
    usage = add(usage, r.usage);
    text += r.text;
    finish = r.finishReason;
    model = r.model || model;
    if (!isTruncated(finish)) break;
    messages = [...o.messages, { role: 'assistant', content: text }, { role: 'user', content: CONTINUE }];
  }
  return { text, calls, usage, finishReason: finish, truncated: isTruncated(finish), model };
}

/** JSON conforming to `schema`, validated and repaired (see the module comment). */
export async function chatStructured<T = unknown>(o: StructuredOptions): Promise<StructuredResult<T>> {
  let mode = schemaModeOf(o.provider);
  const maxRepairs = Math.max(0, o.maxRepairs ?? 2);
  const schemaText = JSON.stringify(o.schema);
  const instruction = `Answer with only a JSON value (no prose, no code fence) that conforms to this JSON Schema:\n${schemaText}`;
  const base: ChatMessage[] = [...o.messages.slice(0, -1), { ...o.messages[o.messages.length - 1]!, content: `${o.messages[o.messages.length - 1]!.content}\n\n${instruction}` }];
  let usage = zero();
  let calls = 0;
  let model = o.model;
  let best: { value?: unknown; text: string; problems: string[]; finish?: string } | undefined;
  let convo = base;
  const call = async (messages: ChatMessage[], structured: boolean): Promise<ChatResponse> => {
    try {
      const r = await o.provider.chat({
        model: o.model,
        messages,
        maxTokens: o.maxTokens,
        temperature: o.temperature,
        signal: o.signal,
        stream: !!o.onDelta,
        onDelta: o.onDelta,
        ...(structured && mode === 'json_schema' ? { responseFormat: { type: 'json_schema', name: o.schemaName ?? 'answer', schema: o.schema } } : {}),
      });
      o.onCall?.(r);
      calls++;
      usage = add(usage, r.usage);
      model = r.model || model;
      return r;
    } catch (e) {
      // a server without JSON-schema mode: the schema is in the prompt already, so ask again without it
      if (structured && mode === 'json_schema' && refusedFormat(e)) {
        mode = 'prompt';
        return call(messages, false);
      }
      throw e;
    }
  };
  let attempts = 0;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    attempts++;
    let r = await call(convo, true);
    let text = r.text;
    // a cut answer is continued (without the schema mode, which would start a new value), then fails clearly
    for (let c = 0; isTruncated(r.finishReason) && c < (o.maxContinuations ?? 1); c++) {
      r = await call([...convo, { role: 'assistant', content: text }, { role: 'user', content: CONTINUE }], false);
      text += r.text;
    }
    if (isTruncated(r.finishReason))
      throw new ApsError('ValidationError', `The answer was cut at the output limit (${o.maxTokens ?? 'the model default'} tokens) and is incomplete`, {
        why: 'The model stopped because it reached the most tokens it may write, not because it was done; an incomplete answer is not used.',
        details: { truncated: true, finishReason: r.finishReason, partial: text.slice(-500) },
        suggestions: [
          'Ask for less at once (a folder instead of the whole collection, fewer steps).',
          'Use a larger model for generation (Settings ▸ AI assistant ▸ Large tasks), or raise the output limit.',
        ],
      });
    const parsed = extractJson(text);
    let problems: string[];
    let value: unknown;
    if (!parsed.ok) problems = [parsed.error];
    else {
      value = parsed.value;
      const v = validateSchema(o.schema, value);
      problems = v.valid ? [] : v.errors.slice(0, 20);
      if (!problems.length && o.check) problems = (await o.check(value)).slice(0, 20);
    }
    // a repair that is no worse wins a tie: it answered the problems it was told about
    if (!best || (best.value === undefined && value !== undefined) || (value !== undefined && problems.length <= best.problems.length)) best = { value, text, problems, finish: r.finishReason };
    if (!problems.length) break;
    if (attempt < maxRepairs)
      convo = [
        ...convo,
        { role: 'assistant', content: text },
        { role: 'user', content: `That answer has problems:\n${problems.map((p) => `- ${p}`).join('\n')}\nReply again with the whole corrected JSON only, conforming to the schema.` },
      ];
  }
  return {
    ok: !!best && !best.problems.length,
    value: best?.value as T | undefined,
    text: best?.text ?? '',
    calls,
    attempts,
    repairs: attempts - 1,
    usage,
    problems: best?.problems ?? [],
    finishReason: best?.finish,
    model,
    mode,
  };
}
