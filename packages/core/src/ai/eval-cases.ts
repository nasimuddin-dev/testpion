/**
 * The AI task `eval-cases` (AU-13): test cases for an AI evaluation, written by a model from what the person has: the prompt
 * under test, an OpenAPI document, the saved requests of a collection or folder, or real calls from History (documents go
 * through the RAG test-set generator, `rag-generate-testset`, and are turned into cases by runner/eval-cases-generate.ts).
 *
 * Every case is a proposal item (`eval-case`) with badges from the verifiers below, so a person reads what was written and
 * how far to trust it before accepting: the case fills every variable of the prompt, it asks something new (not a repeat of an
 * existing case or of another proposed one), and, when the source names things (the operations of a spec, the requests of a
 * collection, the inputs of History) the case is about one of them. Nothing is applied here: accepting adds the cases to the
 * evaluation's test cases (`ai.applyProposal`, `testpion ai apply`, `ai_apply_proposal`), with one undo.
 *
 * This file only defines the task and its apply step; the call that runs it is runner/eval-cases-generate.ts. It imports
 * functions only (no task runner), so an import cycle through the registry cannot reach a constant that is not yet defined.
 */
import { casesToJsonl, datasetRecords } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { loadOpenApi } from '../openapi/contract.js';
import { specOperations } from '../openapi/spec-gaps.js';
import { historyResponse } from '../storage/history-compare.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { EVALUATIONS_LIBRARY, type SavedEvaluation } from '../runner/saved-evaluations.js';
import { shortId } from '../util/ids.js';
import { jaccard, termSet } from '../eval/rag/testset/lexical.js';
import { contextOfItem } from './item-context.js';
import type { ProposalItem, ProposalUndo, VerificationBadge } from './proposal.js';
import { registerVerifier } from './verify.js';
import type { AiTaskInput, DraftItem, PreparedItem, ProposalDescription } from './tasks/registry.js';
import { readFileSync } from 'node:fs';

export const CASE_SOURCES = ['prompt', 'spec', 'collection', 'documents', 'history'] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];
export const EVAL_CASES_VERSION = 1;
/** The most cases one call writes. */
export const MAX_GENERATED_CASES = 30;
export const DEFAULT_GENERATED_CASES = 10;

/** The task's context holds `"existingCount"`: what a scripted or offline demo model (a mock rule matches the last message) recognises the task by. */
export const EVAL_CASES_MARKER = 'eval-cases-v1';

export const EVAL_CASES_INSTRUCTION = [
  `You write test cases (${EVAL_CASES_MARKER}) for an evaluation of an AI prompt or chatbot, as JSON.`,
  'The context has `source` (what the cases are made from: prompt, spec, collection or history), `count` (how many cases), `evaluation` (the prompt under test with its `variables`, the `expectedField` name, the `checks` that will grade replies, `cases` already there and how many: `existingCount`) and `material` (the source: the operations of an API definition, the saved requests of a collection or folder, or real calls from History).',
  'Write exactly `count` cases (fewer only when the material cannot support more). Each case is { inputs, expected, tags, why }: `inputs` fills EVERY variable of the prompt (use the names in `evaluation.variables`, values are text), `expected` is the answer a correct reply would give (short, in the form the checks expect: a label, a value, a phrase), `tags` is one or two words, `why` says in a sentence what the case tests.',
  'Cover the typical cases first, then the edges: the unclear message, a very short or very long input, a different wording of the same thing, and one that should be refused or answered "other" when the prompt has such a way out. Never repeat a case that is already in `evaluation.cases` or one you wrote. Never invent facts about the person\'s business: take them from the prompt and the material.',
  'source spec: each case is a question or request a user could make about the API; `expected` is the operation it is about, written exactly as in `material.operations[].operation` (for example "POST /orders"). source collection: each case is a request a user could make; `expected` is the name of the saved request that does it, exactly as in `material.requests[].name`. source history: reuse the real inputs of `material.calls` (shorten or tidy them; remove names, e-mail addresses and numbers that identify a person) and take `expected` from the reply when it was right, or correct it.',
  'Values shown as *** or [REDACTED…] were hidden by TestPion; never ask for them. Output only the JSON object.',
].join('\n');

export const EVAL_CASES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['cases'],
  properties: {
    summary: { type: 'string', description: 'What the cases cover, in a sentence' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['inputs', 'expected'],
        properties: {
          inputs: { type: 'object', description: 'One text value for each variable of the prompt', additionalProperties: { type: 'string' } },
          expected: { type: 'string', description: 'The answer a correct reply gives' },
          tags: { type: 'array', items: { type: 'string' } },
          why: { type: 'string', description: 'What this case tests, in a sentence' },
        },
      },
    },
  },
};

/** The evaluation as the task reads it (the draft as edited: it may not be saved). */
export type CasesDraft = Pick<SavedEvaluation, 'prompt' | 'dataset' | 'datasetFormat' | 'expectedField' | 'evaluators'> & Partial<Pick<SavedEvaluation, 'name' | 'system'>>;

/** What the caller chooses (the task's `context`). */
export interface EvalCasesContext {
  source: CaseSource;
  count?: number;
  /** The saved evaluation the cases are added to (none: the proposal only returns them, the window adds them to its draft). */
  evaluation?: string;
  draft: CasesDraft;
  spec?: string;
  collection?: string;
  folder?: string;
  history?: { limit?: number };
}

interface EvalCasesLocal {
  token: string;
  source: CaseSource;
  count: number;
  evaluation?: string;
  variables: string[];
  expectedField: string;
  needsExpected: boolean;
  existing: string[];
  /** The names the expected answer must be one of (the operations of a spec, the requests of a collection). */
  allowed?: string[];
  /** History: the inputs of the calls. */
  calls?: string[];
}

const LOCALS = new Map<string, EvalCasesLocal>(); // bounded: the 24 newest calls; a verifier that finds none says "not checked"
const remember = (l: EvalCasesLocal) => {
  LOCALS.set(l.token, l);
  while (LOCALS.size > 24) LOCALS.delete(LOCALS.keys().next().value!);
};

const newToken = () => shortId('ec-');

/** The names of the `{{variables}}` of a text, in order of first use. */
export function promptVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!))];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const textOf = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** True when a check grades against the expected answer (it names `{{expected}}` or the expected column). */
function needsExpected(draft: CasesDraft): boolean {
  const field = draft.expectedField || 'expected';
  return (draft.evaluators ?? []).some((e) => JSON.stringify(e).includes(`{{${field}}}`) || /^(exact-match|equals|similarity|token-f1|rouge|bleu)/i.test(e.type) && e.expected !== undefined);
}

const callInput = (req: unknown): string => {
  const r = (req ?? {}) as { prompt?: unknown; input?: unknown; messages?: unknown };
  const input = r.input && typeof r.input === 'object' ? Object.values(r.input as Record<string, unknown>).map(textOf).join(' | ') : '';
  return input || textOf(r.prompt) || textOf(r.messages);
};

/** The calls of History the cases are made from: the latest prompts sent to a model (kind llm), newest first. */
function historyCalls(store: WorkspaceStore, limit: number) {
  const out: Array<{ input: string; reply?: string }> = [];
  for (const h of store.meta.listHistory({ kind: 'llm', limit: Math.min(Math.max(limit * 3, 10), 200) }).items) {
    const input = callInput(h.request).trim();
    if (!input) continue;
    let reply: string | undefined;
    try {
      const b = historyResponse(store, h).body;
      reply = b === undefined ? undefined : clip(textOf(b), 400);
    } catch {
      /* the reply is not kept: the call is still an input */
    }
    out.push({ input: clip(input, 400), ...(reply ? { reply } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Reads the workspace for the source the caller chose; what is returned is what is sent, `local` stays on this computer. */
export async function prepareEvalCases(store: WorkspaceStore, context: Record<string, unknown>): Promise<PreparedItem> {
  const c = context as unknown as EvalCasesContext;
  if (!CASE_SOURCES.includes(c.source) || c.source === 'documents') throw new ApsError('ValidationError', `Cases are made from: ${CASE_SOURCES.filter((s) => s !== 'documents').join(', ')} (documents go through the test-set generator)`);
  if (!c.draft || typeof c.draft.prompt !== 'string') throw new ApsError('ValidationError', 'Name the evaluation the cases are for: its prompt is what the cases are written for');
  const draft = c.draft;
  const count = Math.max(1, Math.min(MAX_GENERATED_CASES, Math.floor(Number(c.count ?? DEFAULT_GENERATED_CASES)) || DEFAULT_GENERATED_CASES));
  const expectedField = draft.expectedField || 'expected';
  const rows = datasetRecords(draft.dataset ?? '', draft.datasetFormat ?? 'jsonl', 400);
  const variables = promptVariables(`${draft.system ?? ''}\n${draft.prompt}`).filter((v) => v !== expectedField);
  const local: EvalCasesLocal = {
    token: newToken(),
    source: c.source,
    count,
    ...(c.evaluation ? { evaluation: c.evaluation } : {}),
    variables: variables.length ? variables : ['input'],
    expectedField,
    needsExpected: needsExpected(draft),
    existing: rows.map((r) => variables.map((v) => textOf(r[v])).join(' ').trim() || Object.values(r).map(textOf).join(' ')),
  };
  let material: Record<string, unknown> = {};
  let label = `${c.source}`;
  if (c.source === 'spec') {
    if (!c.spec) throw new ApsError('ValidationError', 'Name the API definition (a file under specs/)');
    const text = readFileSync(store.safePath(c.spec), 'utf8');
    const ops = specOperations(loadOpenApi(text)).slice(0, 60);
    if (!ops.length) throw new ApsError('ValidationError', `${c.spec} has no operations to write cases about`);
    local.allowed = ops.map((o) => o.key);
    material = { spec: c.spec, operations: ops.map((o) => ({ operation: o.key, ...(o.operationId ? { operationId: o.operationId } : {}), ...(o.summary ? { summary: o.summary } : {}), tag: o.tag, parameters: o.params.map((p) => p.name).slice(0, 8) })) };
    label = c.spec;
  } else if (c.source === 'collection') {
    if (!c.collection) throw new ApsError('ValidationError', 'Name the collection (and a folder of it, if you like)');
    const ic = await contextOfItem(store, c.folder ? { kind: 'folder', collectionId: c.collection, folderId: c.folder } : { kind: 'collection', collectionId: c.collection });
    const requests = ((ic.context.requests as Array<Record<string, unknown>> | undefined) ?? []).slice(0, 60);
    if (!requests.length) throw new ApsError('ValidationError', 'That collection has no saved requests to write cases about');
    local.allowed = requests.map((r) => String(r.name));
    material = { collection: ic.context.collection, ...(ic.context.folder ? { folder: ic.context.folder } : {}), requests: requests.map((r) => ({ name: r.name, method: r.method, url: r.url, ...(r.folder ? { folder: r.folder } : {}) })) };
    label = ic.label;
  } else if (c.source === 'history') {
    const calls = historyCalls(store, Math.max(1, Math.min(50, Math.floor(Number(c.history?.limit ?? 20)) || 20)));
    if (!calls.length) throw new ApsError('ValidationError', 'History holds no prompts sent to a model yet', { suggestions: ['Send a prompt from Try a prompt first, or write the cases from the prompt.'] });
    local.calls = calls.map((x) => x.input);
    material = { calls };
    label = `${calls.length} real calls`;
  }
  remember(local);
  return {
    label,
    local,
    context: {
      source: c.source,
      count,
      evaluation: {
        ...(draft.name ? { name: draft.name } : {}),
        prompt: clip(draft.prompt, 3000),
        ...(draft.system ? { system: clip(draft.system, 1500) } : {}),
        variables: local.variables,
        expectedField,
        checks: (draft.evaluators ?? []).slice(0, 8).map((e) => ({ type: e.type, ...(e.expected !== undefined ? { expected: clip(textOf(e.expected), 80) } : {}), ...(e.criteria ? { criteria: clip(String(e.criteria), 200) } : {}) })),
        existingCount: rows.length,
        cases: local.existing.slice(0, 8).map((x) => clip(x, 160)),
      },
      material,
    },
  };
}

interface RawCase {
  inputs?: Record<string, unknown>;
  expected?: unknown;
  tags?: unknown;
  why?: unknown;
}

/** The record a raw case becomes: one column per variable, then the expected answer. */
export function recordOfCase(raw: RawCase, local: Pick<EvalCasesLocal, 'variables' | 'expectedField'>): Record<string, string> {
  const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {};
  const rec: Record<string, string> = {};
  const entries = Object.entries(inputs);
  for (const v of local.variables) {
    // a model that wrote one input under another name still fills a prompt that has a single variable
    const val = inputs[v] ?? (local.variables.length === 1 && entries.length === 1 ? entries[0]![1] : undefined);
    rec[v] = textOf(val).trim();
  }
  rec[local.expectedField] = textOf(raw.expected).trim();
  return rec;
}

export function proposeEvalCases(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems: string[] } {
  const local = input.local as EvalCasesLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'Cases are written for an evaluation: name its prompt');
  const raw = ((a.value as { cases?: RawCase[] } | undefined)?.cases ?? []).filter((c) => c && typeof c === 'object');
  const notes: string[] = [];
  const problems: string[] = [];
  const items: DraftItem[] = [];
  const seen: Array<Set<string>> = [];
  for (const c of raw.slice(0, MAX_GENERATED_CASES)) {
    const record = recordOfCase(c, local);
    // a repeat of a case proposed just before is left out and said so (a repeat of a case already in the evaluation stays, unticked, with its reason)
    const terms = termSet(local.variables.map((v) => record[v]).join(' '));
    if (seen.some((s) => jaccard(s, terms) >= 0.8)) {
      notes.push(`Left out a repeat: “${clip(record[local.variables[0]!] ?? '', 80)}”.`);
      continue;
    }
    seen.push(terms);
    const tags = Array.isArray(c.tags) ? c.tags.map(String).filter(Boolean).slice(0, 3) : [];
    const title = clip(record[local.variables[0]!] || '(empty case)', 90);
    items.push({
      kind: 'eval-case',
      title,
      after: `${JSON.stringify({ ...record, ...(tags.length ? { tags: tags.join(', ') } : {}) })}\n`,
      language: 'json',
      data: { token: local.token, source: local.source, evaluation: local.evaluation, record, ...(typeof c.why === 'string' && c.why ? { why: clip(c.why, 240) } : {}) },
    });
  }
  if (raw.length > MAX_GENERATED_CASES) notes.push(`Only the first ${MAX_GENERATED_CASES} cases are kept.`);
  if (!items.length) problems.push('No usable case: answer with {"cases": [{ "inputs": { … }, "expected": "…" }]}.');
  return { items, notes, problems };
}

export function describeEvalCases(value: unknown, items: ProposalItem[]): ProposalDescription {
  const source = (items[0]?.data as { source?: CaseSource } | undefined)?.source ?? 'prompt';
  const from = { prompt: 'the prompt', spec: 'the API definition', collection: 'the saved requests', documents: 'your documents', history: 'real calls from History' }[source];
  return {
    summary: `${items.length} proposed test case${items.length === 1 ? '' : 's'} made from ${from}.`,
    assumptions: ['The expected answers were written by a model: read them before you rely on them. A case with a failed check is left unticked.'],
    ...(typeof (value as { summary?: unknown } | undefined)?.summary === 'string' ? { notes: [String((value as { summary: string }).summary)] } : {}),
  };
}

/* ------------------------------------------------------------------ the verifiers */

const dataOf = (item: ProposalItem) => item.kind === 'eval-case' ? (item.data as { token?: string; record?: Record<string, string>; source?: CaseSource }) : undefined;
const localOf = (token: string | undefined) => (token ? LOCALS.get(token) : undefined);
const bad = (verifier: string, label: string, detail?: string): VerificationBadge => ({ verifier, status: 'fail', label, ...(detail ? { detail } : {}) });
const good = (verifier: string, label: string, detail?: string): VerificationBadge => ({ verifier, status: 'pass', label, ...(detail ? { detail } : {}) });

registerVerifier('eval-case-shape', (item) => {
  const d = dataOf(item);
  if (!d?.record) return undefined;
  const local = localOf(d.token);
  const record = parseEdited(item) ?? d.record;
  const vars = local?.variables ?? Object.keys(record).slice(0, -1);
  const field = local?.expectedField ?? 'expected';
  const empty = vars.filter((v) => !String(record[v] ?? '').trim());
  if (empty.length) return bad('eval-case-shape', `${empty.join(', ')} ${empty.length === 1 ? 'is' : 'are'} empty`, 'Every variable of the prompt needs a value in each case.');
  if ((local?.needsExpected ?? true) && !String(record[field] ?? '').trim()) return bad('eval-case-shape', 'has no expected answer', `A check of this evaluation compares the reply with the ${field} column.`);
  return good('eval-case-shape', 'fills every variable', local?.needsExpected === false ? 'No check needs an expected answer.' : `The ${field} column is filled.`);
});

registerVerifier('eval-case-duplicate', (item) => {
  const d = dataOf(item);
  if (!d?.record) return undefined;
  const local = localOf(d.token);
  if (!local) return { verifier: 'eval-case-duplicate', status: 'skip', label: 'not checked', detail: 'The evaluation this was made for is no longer in memory; generate again to check for repeats.' };
  const text = local.variables.map((v) => (parseEdited(item) ?? d.record!)[v] ?? '').join(' ');
  const mine = termSet(text);
  const norm = text.trim().toLowerCase();
  for (const e of local.existing) {
    if (e.trim().toLowerCase() === norm || jaccard(mine, termSet(e)) >= 0.8) return bad('eval-case-duplicate', 'repeats a case already there', `“${clip(e, 120)}”`);
  }
  return good('eval-case-duplicate', 'asks something new', `${local.existing.length} existing case${local.existing.length === 1 ? '' : 's'} compared.`);
});

registerVerifier('eval-case-grounded', (item) => {
  const d = dataOf(item);
  if (!d?.record) return undefined;
  const local = localOf(d.token);
  if (!local || local.source === 'prompt') return undefined;
  const record = parseEdited(item) ?? d.record;
  const expected = String(record[local.expectedField] ?? '').trim();
  if (local.allowed) {
    const ok = local.allowed.some((a) => a.toLowerCase() === expected.toLowerCase());
    return ok ? good('eval-case-grounded', local.source === 'spec' ? 'names an operation of the definition' : 'names a saved request', expected) : bad('eval-case-grounded', local.source === 'spec' ? 'names an operation the definition does not have' : 'names a request the collection does not have', `“${clip(expected, 80)}” is not one of the ${local.allowed.length} ${local.source === 'spec' ? 'operations' : 'requests'}.`);
  }
  if (local.calls) {
    const mine = termSet(local.variables.map((v) => record[v] ?? '').join(' '));
    const best = Math.max(0, ...local.calls.map((c) => jaccard(mine, termSet(c))));
    return best >= 0.35 ? good('eval-case-grounded', 'based on a real call', `Closest call: ${Math.round(best * 100)} % of the same words.`) : { verifier: 'eval-case-grounded', status: 'warn', label: 'does not look like a real call', detail: 'No call in History uses similar words: it may be invented.' };
  }
  return undefined;
});

/** The case as the person may have edited it in the review (the item's text). */
function parseEdited(item: ProposalItem): Record<string, string> | undefined {
  try {
    const v = JSON.parse(item.after) as Record<string, unknown>;
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, textOf(x)]));
  } catch {
    /* the original record stands */
  }
  return undefined;
}

/* ------------------------------------------------------------------ applying */

/** Add an accepted case to a saved evaluation's test cases (as JSONL, whatever format they were in); the library item before is kept for undo. */
export function applyEvalCaseItem(store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  const d = item.data as { evaluation?: string; record?: Record<string, string> } | undefined;
  if (!d?.evaluation) throw new ApsError('ValidationError', `"${item.title}" names no saved evaluation`, { suggestions: ['Save the evaluation first, then generate again; or add the case in the window, which holds the unsaved evaluation.'] });
  const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
  const it = lib.items.find((i) => i.id === d.evaluation);
  if (!it) throw new ApsError('ConfigurationError', `The evaluation of "${item.title}" is no longer there`);
  const row = { ...(d.record ?? {}), ...(parseEdited(item) ?? {}) };
  if (!Object.values(row).some((v) => String(v).trim())) throw new ApsError('ValidationError', `"${item.title}" is an empty case`);
  const text = it.data.dataset ?? '';
  const rows = datasetRecords(text, it.data.datasetFormat ?? 'jsonl');
  if (text.trim() && !rows.length) throw new ApsError('ConfigurationError', `The test cases of "${it.name}" cannot be read, so nothing was added`, { suggestions: ['Fix them in the Test cases tab first.'] });
  const dataset = casesToJsonl([...rows, row]);
  store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => (i === it ? { ...i, data: { ...i.data, dataset, datasetFormat: 'jsonl' as const }, updatedAt: new Date().toISOString() } : i)) });
  return { item: item.id, evaluation: { id: it.id, before: it } };
}
