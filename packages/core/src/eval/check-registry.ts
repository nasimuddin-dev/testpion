/**
 * The check registry: the context a check reads, the table of check types (one registration per name), the aliases and the
 * documentation of the types, and the helpers every check builds its result with. The checks themselves are in checks.ts.
 */
import { checkSubject } from '@testpion/shared';
import type { CheckConfig, CheckResult, CheckSource, NormalizedError, RetrievedDoc, TestType, TokenUsage } from '../model/types.js';
import { queryAll } from '../util/jsonpath.js';
import type { ProviderRegistry } from '../ai/index.js';
import type { SpanHandle } from '../trace/tracer.js';
import { compileSchema } from '../util/json-schema.js';
import type { RagJudgeHost } from './rag/judge.js';
import type { RagJudgeSetup } from '@testpion/shared';

/** Everything a check may inspect about an execution. */
export interface CheckContext {
  testType: TestType;
  status?: number;
  headers?: Array<[string, string]>;
  /** Parsed body (JSON) or text when not JSON. JSONPath expressions run against this. */
  body: unknown;
  /** Raw text output (response body, LLM text, tool text). */
  text: string;
  latencyMs?: number;
  /** LLM: until the first token arrived (streamed answers). */
  firstTokenMs?: number;
  tokens?: TokenUsage;
  costUsd?: number;
  error?: NormalizedError;
  /** MCP tool result `isError`. */
  isError?: boolean;
  /** HTTP: cookies for `tp.cookies` (name → value). */
  cookies?: Record<string, string>;
  /** HTTPS: the server's certificate (for the `certificate` check). */
  certificate?: { subject?: string; issuer?: string; validTo?: string; daysLeft?: number; altNames?: string[] };
  /** HTTP: the request that was sent (for contract checks such as `openapi`). */
  request?: { method: string; url: string };
  /** Reads a workspace file (relative to the workspace root), e.g. an OpenAPI document. */
  readFile?: (path: string) => string;
  graphqlErrors?: unknown[];
  /** gRPC: the call's status. */
  grpc?: { code: number; codeName: string; details: string; trailers?: Array<[string, string]> };
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolSchemas?: Record<string, Record<string, unknown>>;
  contexts?: RetrievedDoc[];
  question?: string;
  input?: unknown;
  expected?: unknown;
  /** RAG: the gold chunks (texts) and their ids from the dataset record, for the metrics that compare the retrieval with them. */
  referenceContexts?: string[];
  referenceIds?: string[];
  /** The workspace folder (SQL metrics resolve a SQLite file against it). */
  workspaceRoot?: string;
  /** RAG: the other fields of the dataset record the metrics read (answerable, relevance, injection …; see eval/rag/record.ts). */
  record?: import('./rag/record.js').RagRecord;
  /** RAG: the judge the evaluation names (else the AI settings'), and its limits for the run. */
  judge?: RagJudgeSetup;
  /** RAG: set when the answer and contexts come from a RAG target (or a stored sample): the judged metrics then use the judge service strictly, and know which metrics run beside them (the shared claim pass). */
  ragRun?: { strict: boolean; metrics: string[] };
  services?: { providers?: ProviderRegistry; signal?: AbortSignal; span?: SpanHandle; ragJudge?: RagJudgeHost; /** Reads the pictures of a RAG sample (a test host lends fixtures; the default fetches under the network policy). */ imageSource?: import('./rag/images.js').ImageSource };
}

export type CheckFn = (cfg: CheckConfig, ctx: CheckContext) => Promise<CheckResult> | CheckResult;

const registry = new Map<string, CheckFn>();
/** The sorted type names (the "known types" of an unknown-type message, the editor's list): rebuilt only after a registration changes. */
let sortedTypes: string[] | undefined;

/** What a check of a response reads, in one line, and one example of it: the AI format reference and lint hints read these. */
export interface CheckDoc {
  fields: string;
  example: CheckConfig;
}
const docs = new Map<string, CheckDoc>();

/**
 * Register a check type (plugin extension point); `doc` says what it reads (shown to AI models writing checks). A type is
 * registered once: a second registration under the same name throws (which module loaded last would decide which wins);
 * `overrideCheck` is the explicit way to replace one.
 */
export function registerCheck(type: string, fn: CheckFn, doc?: CheckDoc): void {
  if (registry.has(type)) throw new Error(`check type "${type}" is already registered (use overrideCheck to replace it on purpose)`);
  registry.set(type, fn);
  sortedTypes = undefined;
  if (doc) docs.set(type, doc);
}

/** Replaces a registered check type on purpose (the strict RAG metrics over the older checks of the same name; a custom metric whose file changed). */
export function overrideCheck(type: string, fn: CheckFn, doc?: CheckDoc): void {
  registry.set(type, fn);
  sortedTypes = undefined;
  if (doc) docs.set(type, doc);
}

/** Another name of a registered check type (`http-status` for `status`): the same function under a second name. */
export function aliasCheck(alias: string, type: string): void {
  const fn = registry.get(type);
  if (!fn) throw new Error(`cannot alias "${alias}": check type "${type}" is not registered`);
  registry.set(alias, fn);
  sortedTypes = undefined;
}

/** The function that runs a check config: its type, or what the resolver makes of an unknown one (the config comes back with the options the spelling implies). */
export function resolveCheck(cfg: CheckConfig): { fn: CheckFn; cfg: CheckConfig } | undefined {
  const fn = registry.get(cfg.type);
  if (fn) return { fn, cfg };
  const r = resolver?.(cfg);
  if (r && registry.has(r.check)) return { fn: registry.get(r.check)!, cfg: { ...r.options, ...cfg, type: r.check, name: cfg.name ?? cfg.type } };
  return undefined;
}

/** Removes a check type (a custom metric whose file was deleted). */
export function unregisterCheck(type: string): void {
  registry.delete(type);
  docs.delete(type);
  sortedTypes = undefined;
}

/** A registered check type's function (a metric that wraps a check of this file reads the original here). */
export const checkFn = (type: string): CheckFn | undefined => registry.get(type);

/**
 * Other spellings of a check type (the metric registry's: Ragas and DeepEval names, `recall@5`): called when a type is not
 * registered; gives the registered type that computes it and the options the spelling implies.
 */
export type CheckResolver = (cfg: CheckConfig) => { check: string; options?: Record<string, unknown> } | undefined;
let resolver: CheckResolver | undefined;
export function setCheckResolver(fn: CheckResolver): void {
  resolver = fn;
}

/** Describe a registered check type (its fields and an example). */
export function documentCheck(type: string, doc: CheckDoc): void {
  docs.set(type, doc);
}

/** Other names of a check type (http-status → status, response-time → latency …): name → the type it stands for. */
export function checkAliases(): Record<string, string> {
  const first = new Map<CheckFn, string>();
  const out: Record<string, string> = {};
  for (const [t, fn] of registry) {
    const canonical = first.get(fn);
    if (canonical) out[t] = canonical;
    else first.set(fn, t);
  }
  return out;
}

/** The documented check types (those that read a response's status, headers or body), in registry order. */
export function checkDocs(): Array<CheckDoc & { type: string }> {
  return [...docs].filter(([t]) => registry.has(t)).map(([type, d]) => ({ type, ...d }));
}

export function checkTypes(): string[] {
  return [...(sortedTypes ??= [...registry.keys()].sort())];
}

export function validateSchema(schema: unknown, data: unknown): { valid: boolean; errors: string[] } {
  const v = compileSchema(schema);
  const valid = v(data) as boolean;
  return { valid, errors: valid ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '$'} ${e.message}`) };
}

export function res(
  cfg: CheckConfig,
  passed: boolean,
  message: string,
  extra: Partial<CheckResult> & { source?: CheckSource } = {},
): CheckResult {
  return {
    type: cfg.type,
    name: cfg.name ?? defaultName(cfg),
    passed,
    source: extra.source ?? 'deterministic',
    message,
    ...extra,
  };
}

function defaultName(cfg: CheckConfig): string {
  // the shared words for what it reads: `header content-type`, `equals $.id`, `tool_called search`
  return [cfg.type, checkSubject(cfg)].filter(Boolean).join(' ');
}

/** Value addressed by `path`, or the whole body/text when no path is given. */
export function target(cfg: CheckConfig, ctx: CheckContext): { found: boolean; value: unknown } {
  if (cfg.path) {
    const hits = queryAll(ctx.body, String(cfg.path)); // one evaluation answers both questions
    return { found: hits.length > 0, value: hits[0] };
  }
  return { found: true, value: ctx.body ?? ctx.text };
}

export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  return JSON.stringify(v);
}

export function short(v: unknown, n = 200): string {
  const s = asText(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function threshold(cfg: CheckConfig, fallback: number): number {
  const t = cfg.threshold ?? cfg.min ?? fallback;
  return typeof t === 'number' ? t : Number(t);
}
