/**
 * AI-4 · Tests from an OpenAPI document, driven by the gaps in what is tested (planning/ai-features.md).
 *
 * Deterministic first (principle 4): `specGapReport` (openapi/spec-gaps.ts) says what the workspace's tests and
 * collections never prove; `deterministicCases` builds the tests that close those gaps without a model — positive (the
 * documented example and its status, the OpenAPI contract, a shallow JSON Schema), negative (the fuzz mutations: a
 * required field left out, a wrong type …), boundary (a value at and beyond a documented limit), security (no
 * credentials → 401/403) and not-found (an unknown id → 404). The model only adds case *ideas*: it answers with cases
 * that name an operation of the document and say what to change in its valid example (a body field, a query value, a
 * header) and the status to expect. TestPion builds every request itself from the document's valid example:
 *
 * - an operation the document does not have is dropped and reported (a hallucinated path never becomes a test)
 * - the expected status must be one the document documents, or a status class (`4xx`): any other is replaced by the class
 * - a case that should be accepted must satisfy the document (the body against its schema, the required parameters);
 *   a case that should be refused must break something or be flagged (it needs a business rule the document does not state)
 * - checks come from the document, never from the model: status, the `openapi` contract check, a shallow JSON Schema
 *
 * The files are linted and every test is validated against the document (`spec-tests` verifier) before the review; the
 * proposal says the coverage before → after, computed with the same gap report over the existing and the proposed tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { stringifyYaml, parseYaml } from '../util/lazy-yaml.js';
import { type ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { fuzzCases } from '../openapi/fuzz.js';
import { findOperation, loadOpenApi, type OpenApiDoc } from '../openapi/contract.js';
import { bodySchemaOf, existingRequests, matchUrl, propertiesOf, requestsOfTestFile, SPEC_CATEGORIES, specGapReport, specOperations, type SpecCategory, type SpecGapReport, type SpecOperation } from '../openapi/spec-gaps.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { deref, typeOf } from '../util/json-ref.js';
import { slugify } from '../util/ids.js';
import type { AiSurface } from '../storage/ai-usage.js';
import type { AiPrivacy } from './ai-settings.js';
import { newProposalId, proposedTestFilePath, PROPOSAL_TTL_MS, saveProposal, type Proposal, type ProposalItem } from './proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { registerVerifier, verifyItems, type VerifyContext } from './verify.js';
import {
  MAX_CONTEXT_OPERATIONS,
  MAX_SPEC_BYTES,
  SPEC_MAX_CASES,
  caseIssues,
  clone,
  deterministicCases,
  jsonBody,
  normalizeExpect,
  stepOf,
  successExpect,
  titleOf,
  urlWithPath,
  viewOfCase,
  viewOfStep,
  withJsonBody,
  type CaseView,
  type Json,
  type SpecCase,
  type SpecLocal,
  type SpecTestOptions,
} from './spec-cases.js';

// the public names that lived in this module before the cases moved out (the package exports them from here)
export { SPEC_MAX_CASES, caseIssues, deterministicCases, normalizeExpect, shallowSchema, viewOfCase, viewOfStep } from './spec-cases.js';
export type { CaseIssue, CaseView, SpecCase, SpecLocal, SpecTestOptions } from './spec-cases.js';

/* ------------------------------------------------------------------ a model's cases */

export interface PlanCase {
  operation: string;
  category: string;
  name: string;
  expectStatus: number | string | Array<number | string>;
  why?: string;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  bodyPatch?: Array<{ field: string; value?: unknown; remove?: boolean }>;
  noAuth?: boolean;
}

export interface SpecPlan {
  summary?: string;
  assumptions?: string[];
  cases: PlanCase[];
}

/** The answer's JSON Schema (structured output). */
export const SPEC_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['cases'],
  properties: {
    summary: { type: 'string', description: 'What the new tests cover, in one or two sentences' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'Rules you assumed that the document does not state (e.g. "a duplicate name is refused with 409")' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['operation', 'category', 'name', 'expectStatus'],
        properties: {
          operation: { type: 'string', description: 'An operation of context.operations: "POST /patients" or its operationId (never invented)' },
          category: { type: 'string', enum: ['positive', 'negative', 'boundary', 'security'] },
          name: { type: 'string', description: 'What the test checks, short' },
          expectStatus: { description: 'A status the operation documents (e.g. 422), or a class ("4xx"); an array for several' },
          why: { type: 'string', description: 'The rule of the document it tests' },
          path: { type: 'object', description: 'Path parameter values to use instead of the example\'s' },
          query: { type: 'object', description: 'Query values to set; null removes one' },
          headers: { type: 'object', description: 'Header values to set; null removes one' },
          body: { description: 'A whole JSON body instead of the valid example\'s' },
          bodyPatch: { type: 'array', items: { type: 'object', required: ['field'], properties: { field: { type: 'string', description: 'A body field, "address.city" for a nested one' }, value: {}, remove: { type: 'boolean' } } } },
          noAuth: { type: 'boolean', description: 'Send no credentials' },
        },
      },
    },
  },
};

const resolveOp = (local: Pick<SpecLocal, 'ops'>, wantedOp: string): SpecOperation | undefined => {
  const w = String(wantedOp ?? '').trim();
  const norm = w.replace(/\s+/g, ' ');
  for (const op of local.ops.values()) {
    if (op.key.toLowerCase() === norm.toLowerCase() || (op.operationId && op.operationId.toLowerCase() === norm.toLowerCase())) return op;
    // "POST {{baseUrl}}/patients" or "POST /patients/"
    const m = /^([A-Za-z]+)\s+(?:\{\{[^}]+\}\})?(\S+?)\/?$/.exec(norm);
    if (m && m[1]!.toUpperCase() === op.method && m[2] === op.path) return op;
  }
  return undefined;
};

const setPath = (target: Json, path: string, f: (obj: Json, key: string) => void): void => {
  const keys = path.split('.').filter(Boolean);
  if (!keys.length) return;
  let cur = target;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  f(cur, keys[keys.length - 1]!);
};

/** The cases of a model's plan: built from each operation's valid example, validated; what cannot be is dropped with a reason. */
export function casesFromPlan(plan: SpecPlan, local: SpecLocal, doc: OpenApiDoc): { cases: SpecCase[]; notes: string[] } {
  const notes: string[] = [];
  const cases: SpecCase[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(plan?.cases) ? plan.cases : []) {
    if (!raw || typeof raw !== 'object') continue;
    const label = String(raw.name ?? raw.operation ?? '?').slice(0, 80);
    const op = resolveOp(local, raw.operation);
    if (!op) {
      notes.push(`Dropped "${label}": ${String(raw.operation)} is not an operation of ${local.spec}.`);
      continue;
    }
    if (op.method === 'DELETE' && !local.options.includeDelete) {
      notes.push(`Dropped "${label}": DELETE operations are left out (they destroy data); ask for them explicitly.`);
      continue;
    }
    const valid = local.valid.get(op.key);
    if (!valid) {
      notes.push(`Dropped "${label}": ${op.key} has no valid example to start from.`);
      continue;
    }
    const category = (SPEC_CATEGORIES as readonly string[]).includes(raw.category) ? (raw.category as SpecCategory) : 'negative';
    if (!local.options.categories.includes(category)) continue;
    const r = clone(valid.request);
    const asString = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
    if (raw.path && typeof raw.path === 'object') {
      const current = findOperation(doc, op.method, matchUrl(r.url))?.params ?? {};
      const values = { ...current, ...Object.fromEntries(Object.entries(raw.path).map(([k, v]) => [k, String(v)])) };
      r.url = urlWithPath(op, values);
    }
    if (raw.query && typeof raw.query === 'object') {
      let params = [...(r.params ?? [])];
      for (const [k, v] of Object.entries(raw.query)) {
        params = params.filter((p) => p.key !== k);
        if (v !== null && v !== undefined) params.push({ key: k, value: asString(v), enabled: true });
      }
      r.params = params;
    }
    if (raw.headers && typeof raw.headers === 'object') {
      let headers = [...(r.headers ?? [])];
      for (const [k, v] of Object.entries(raw.headers)) {
        headers = headers.filter((h) => h.key.toLowerCase() !== k.toLowerCase());
        if (v !== null && v !== undefined) headers.push({ key: k, value: asString(v), enabled: true });
      }
      r.headers = headers;
    }
    let out = r;
    if (raw.body !== undefined) out = raw.body === null ? { ...r, body: undefined } : withJsonBody(r, raw.body);
    else if (Array.isArray(raw.bodyPatch) && raw.bodyPatch.length) {
      const base = jsonBody(r);
      if (base && typeof base === 'object' && !Array.isArray(base)) {
        const b = clone(base) as Json;
        for (const p of raw.bodyPatch) if (p && typeof p.field === 'string') setPath(b, p.field, (obj, k) => (p.remove ? delete obj[k] : (obj[k] = p.value)));
        out = withJsonBody(r, b);
      }
    }
    if (raw.noAuth) {
      out.auth = undefined;
      out.headers = (out.headers ?? []).filter((h) => h.key.toLowerCase() !== 'authorization');
    }
    const accept = category === 'positive' || (category === 'boundary' && [raw.expectStatus].flat().every((s) => String(s).startsWith('2')));
    const ex = normalizeExpect(raw.expectStatus, op, accept);
    if (!ex) {
      notes.push(`Dropped "${label}": expected status ${JSON.stringify(raw.expectStatus)} does not fit a ${accept ? 'valid' : 'refused'} ${category} case.`);
      continue;
    }
    const c: SpecCase = {
      operation: op.key,
      category: raw.noAuth && category !== 'security' && !accept ? 'security' : category,
      name: String(raw.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || `${titleOf(op)} (${category})`,
      mutation: 'ai',
      request: out,
      expect: ex.expect,
      accept,
      origin: 'ai',
      ...(typeof raw.why === 'string' && raw.why.trim() ? { why: raw.why.trim().slice(0, 300) } : {}),
    };
    const verdict = caseIssues(doc, viewOfCase(c), viewOfCase({ ...c, request: valid.request, expect: successExpect(op), accept: true }));
    const fail = verdict.issues.find((i) => i.level === 'fail');
    if (fail) {
      notes.push(`Dropped "${c.name}": ${fail.message}.`);
      continue;
    }
    if (ex.note) notes.push(`"${c.name}": ${ex.note}.`);
    const sig = JSON.stringify([c.operation, c.request.url, c.request.params, c.request.headers, c.request.body, c.request.auth, c.expect]);
    if (seen.has(sig)) continue;
    seen.add(sig);
    cases.push(c);
  }
  return { cases, notes };
}

/* ------------------------------------------------------------------ files */

/** The proposed files: a test file per tag under tests/<api>/, never over a file that exists. */
export function buildSpecFiles(
  cases: SpecCase[],
  local: Pick<SpecLocal, 'spec' | 'api' | 'path' | 'ops' | 'store'>,
  doc: OpenApiDoc,
  o: { store?: WorkspaceStore; by: string; ai: boolean },
): Array<{ path: string; yaml: string; cases: SpecCase[] }> {
  const groups = new Map<string, SpecCase[]>();
  for (const c of cases.slice(0, SPEC_MAX_CASES)) {
    const tag = local.path ? '' : (local.ops.get(c.operation)?.tag ?? 'default');
    groups.set(tag, [...(groups.get(tag) ?? []), c]);
  }
  const used = new Set<string>();
  const store = o.store ?? local.store;
  const free = (base: string): string => {
    for (let i = 1; i < 200; i++) {
      const p = `${base}${i === 1 ? '' : `-${i}`}.yaml`;
      if (!used.has(p) && !(store && existsSync(store.safePath(p, store.path('tests'))))) return p;
    }
    return `${base}-${Date.now().toString(36)}.yaml`;
  };
  const files: Array<{ path: string; yaml: string; cases: SpecCase[] }> = [];
  for (const [tag, list] of groups) {
    const path = local.path ?? free(`${local.api}/${slugify(tag) || 'default'}-gaps`);
    used.add(path);
    const ids = new Set<string>();
    const steps = list.map((c) => {
      let id = slugify(`${c.operation} ${c.category} ${c.mutation === 'ai' ? c.name : c.mutation}`).slice(0, 56);
      for (let i = 2; ids.has(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
      ids.add(id);
      return stepOf(c, id, local.ops.get(c.operation), doc, local.spec);
    });
    const head = o.ai
      ? `# AI-generated by TestPion (${o.by}) from the gaps in the tests for ${local.spec}: review the cases, then run them. Checks come from the document.\n`
      : `# Generated by TestPion without AI from the gaps in the tests for ${local.spec}: review the cases, then run them. Checks come from the document.\n`;
    files.push({ path, yaml: head + stringifyYaml({ defaults: { type: 'http' }, tests: steps }, { lineWidth: 0, aliasDuplicateObjects: false }), cases: list });
  }
  return files;
}

const counts = (cases: SpecCase[]) => Object.fromEntries(SPEC_CATEGORIES.map((c) => [c, cases.filter((x) => x.category === c).length]).filter(([, n]) => (n as number) > 0)) as Partial<Record<SpecCategory, number>>;

/** The proposal items of built files (registry `propose`, and the draft). */
function itemsOf(files: ReturnType<typeof buildSpecFiles>, local: SpecLocal, notes: string[], coverage: Coverage): DraftItem[] {
  return files.map((f) => ({
    kind: 'file' as const,
    title: `tests/${f.path}`,
    path: f.path,
    after: f.yaml,
    language: 'yaml' as const,
    target: { kind: 'test', path: f.path } as ItemRef,
    data: {
      spec: local.spec,
      tests: f.cases.length,
      categories: counts(f.cases),
      cases: f.cases.map((c) => ({ name: c.name, category: c.category, operation: c.operation, origin: c.origin, ...(c.why ? { why: c.why } : {}) })),
      coverage,
      notes,
    },
  }));
}

export interface Coverage {
  before: { operationPct: number; statusPct: number; gaps: number };
  after: { operationPct: number; statusPct: number; gaps: number };
}

/** Coverage with the proposed files added to what exists: computed by the same gap report, never claimed by the model. */
export function coverageAfter(doc: OpenApiDoc, local: Pick<SpecLocal, 'spec' | 'existing' | 'report'>, files: Array<{ path: string; yaml: string }>): Coverage {
  const added = files.flatMap((f) => requestsOfTestFile(f.path, f.yaml));
  const after = specGapReport(doc, [...local.existing, ...added], { spec: local.spec });
  const sum = (r: SpecGapReport) => ({ operationPct: r.summary.operationPct, statusPct: r.summary.statusPct, gaps: r.summary.gaps });
  return { before: sum(local.report), after: sum(after) };
}

export const coverageLine = (c: Coverage): string =>
  `Coverage of the document: ${c.before.operationPct}% → ${c.after.operationPct}% of operations called, ${c.before.statusPct}% → ${c.after.statusPct}% of documented statuses asserted, ${c.before.gaps} → ${c.after.gaps} open gaps.`;

/* ------------------------------------------------------------------ the task's reading of a spec */

/** The spec a proposal is made for: its path under specs/ (an ItemRef `spec:`), read once. */
export function loadSpec(store: WorkspaceStore, spec: string): { text: string; doc: OpenApiDoc } {
  const rel = spec.replace(/\\/g, '/');
  if (!/\.(json|ya?ml)$/i.test(rel)) throw new ApsError('ValidationError', `"${spec}" is not an API definition file`, { suggestions: ['Pass a file of specs/ (specs/clinic.yaml) (the API definitions of the workspace).'] });
  let text: string;
  try {
    const file = store.safePath(rel);
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ApsError('ConfigurationError', `Cannot read ${rel}: ${(e as Error).message}`, { suggestions: ['The path is relative to the workspace (specs/clinic.yaml).'] });
  }
  if (text.length > MAX_SPEC_BYTES) throw new ApsError('ValidationError', `${rel} is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB`);
  return { text, doc: loadOpenApi(text) };
}

const apiOf = (spec: string, title?: string) => slugify(spec.replace(/^specs\//, '').replace(/\.(openapi|swagger)?\.?(ya?ml|json)$/i, '') || title || 'api') || 'api';

/** What the gap analysis and the draft need, from a spec file of the workspace. */
export function analyseSpec(store: WorkspaceStore, spec: string, options: SpecTestOptions & { path?: string } = {}): { local: SpecLocal; doc: OpenApiDoc } {
  const { text, doc } = loadSpec(store, spec);
  const existing = existingRequests(store);
  const report = specGapReport(doc, existing, { spec });
  const ops = new Map(specOperations(doc).map((o) => [o.key, o]));
  const opts = {
    categories: (options.categories?.length ? options.categories.filter((c) => (SPEC_CATEGORIES as readonly string[]).includes(c)) : [...SPEC_CATEGORIES]) as SpecCategory[],
    gapsOnly: options.gapsOnly !== false,
    includeDelete: options.includeDelete === true,
    ...(options.operations?.length ? { operations: options.operations } : {}),
  };
  const asked = (options.operations ?? []).map((x) => x.toLowerCase());
  const scope: string[] = [];
  for (const g of report.operations) {
    const op = ops.get(g.operation)!;
    if (asked.length && !asked.includes(g.operation.toLowerCase()) && !asked.includes((g.operationId ?? '').toLowerCase())) continue;
    if (op.method === 'DELETE' && !opts.includeDelete) continue;
    if (!asked.length && opts.gapsOnly && !g.gaps.some((x) => x.kind !== 'param')) continue;
    scope.push(g.operation);
  }
  const fuzz = fuzzCases(text, { baseUrl: '{{baseUrl}}', includeDelete: opts.includeDelete, maxPerOperation: 80 }).cases;
  const valid = new Map(fuzz.filter((c) => c.mutation === 'valid').map((c) => [c.operation, c]));
  const local: SpecLocal = { store, spec, text, api: apiOf(spec, report.title), existing, report, options: opts, scope, ops, valid, fuzz, draft: [], path: options.path };
  local.draft = deterministicCases(doc, local).slice(0, SPEC_MAX_CASES);
  return { local, doc };
}

/** Why there is nothing to propose: the operations asked for are not in the document, or the tests already cover every gap. */
function nothingToGenerate(local: SpecLocal, spec: string): ApsError {
  if (local.options.operations?.length)
    return new ApsError('ConfigurationError', `No operation of ${spec} matches ${local.options.operations.join(', ')}`, { suggestions: ['Name an operation as "POST /patients" or by its operationId (testpion generate gaps --spec … lists them).'] });
  return new ApsError('ConfigurationError', local.options.gapsOnly ? `Nothing to generate: the tests already cover every operation of ${spec}` : `${spec} has no operation to test`, {
    suggestions: [local.options.gapsOnly ? 'Ask for every category with gapsOnly: false (CLI --no-gaps-only) to add more cases.' : 'DELETE operations are left out unless includeDelete is set.'],
  });
}

/** One operation as the model sees it. */
function operationContext(doc: OpenApiDoc, local: SpecLocal, key: string): Record<string, unknown> {
  const d = doc as Json;
  const op = local.ops.get(key)!;
  const gap = local.report.operations.find((o) => o.operation === key)!;
  const body = bodySchemaOf(d, op.op, op.item);
  const props = body ? propertiesOf(d, body.schema) : undefined;
  const responses = op.responses.map((code) => {
    const r = deref(d, (op.op.responses as Json)[code]) as Json;
    return { status: code, ...(r?.description ? { description: String(r.description).slice(0, 80) } : {}) };
  });
  return {
    operation: key,
    ...(op.operationId ? { operationId: op.operationId } : {}),
    ...(op.summary ? { summary: op.summary } : {}),
    ...(op.secured ? { auth: op.securitySchemes.join(' or ') || 'required' } : {}),
    ...(op.params.length ? { parameters: op.params.map((p) => ({ name: p.name, in: p.in, required: p.required, ...(p.constraints.length ? { constraints: p.constraints } : {}) })) } : {}),
    ...(body && props
      ? {
          body: {
            required: body.required,
            requiredFields: props.required,
            fields: Object.fromEntries(
              Object.entries(props.properties)
                .slice(0, 30)
                .map(([k, v]) => {
                  const s = deref(d, v) as Json;
                  return [k, [typeOf(s, { infer: true }) ?? 'any', ...(Array.isArray(s?.enum) ? [`enum ${s.enum.slice(0, 6).join('|')}`] : []), ...['minLength', 'maxLength', 'minimum', 'maximum', 'format', 'pattern'].filter((c) => s?.[c] !== undefined).map((c) => `${c} ${s[c]}`)].join(' ')];
                }),
            ),
          },
        }
      : {}),
    responses,
    gaps: gap.gaps.map((g) => g.message),
    ...(gap.tests.length ? { existingTests: gap.tests.map((t) => t.name) } : {}),
    draft: local.draft.filter((c) => c.operation === key).map((c) => `${c.category}: ${c.name}`),
  };
}

/** The task's own reading of a spec item (registry `prepare`). */
export function prepareSpecContext(store: WorkspaceStore, ref: ItemRef, o: { path?: string; privacy?: AiPrivacy; context?: Record<string, unknown> } = {}): PreparedItem {
  if (ref.kind !== 'spec') throw new ApsError('ValidationError', `Tests from a spec are made from an API definition, not a ${ref.kind}`, { suggestions: ['Pass spec:specs/<file>.yaml.'] });
  // the caller's choices: context.options { categories, operations, gapsOnly, includeDelete } (sent as they are: small)
  const c = (o.context?.options && typeof o.context.options === 'object' ? o.context.options : {}) as Record<string, unknown>;
  const { local, doc } = analyseSpec(store, ref.path, {
    categories: Array.isArray(c.categories) ? (c.categories as SpecCategory[]) : undefined,
    operations: Array.isArray(c.operations) ? (c.operations as unknown[]).map(String) : undefined,
    gapsOnly: c.gapsOnly === false ? false : undefined,
    includeDelete: c.includeDelete === true,
    path: o.path?.trim() ? proposedTestFilePath(store, o.path) : undefined,
  });
  if (!local.scope.length) throw nothingToGenerate(local, ref.path);
  // gaps first, then the rest; at most MAX_CONTEXT_OPERATIONS
  const order = [...local.scope].sort((a, b) => local.report.operations.find((x) => x.operation === b)!.gaps.length - local.report.operations.find((x) => x.operation === a)!.gaps.length);
  const picked = order.slice(0, MAX_CONTEXT_OPERATIONS);
  const info = ((doc as Json).info ?? {}) as { title?: string; version?: string };
  return {
    label: `${ref.path}`,
    path: local.path,
    local,
    context: {
      spec: { path: ref.path, title: info.title, version: info.version, operations: local.report.summary.operations, inScope: local.scope.length, ...(picked.length < local.scope.length ? { sampled: `${picked.length} of ${local.scope.length} operations sent (most gaps first)` } : {}) },
      categories: local.options.categories,
      coverage: { operationPct: local.report.summary.operationPct, statusPct: local.report.summary.statusPct },
      operations: picked.map((k) => operationContext(doc, local, k)),
    },
  };
}

/* ------------------------------------------------------------------ the task's answer */

/** The proposal items of a plan: TestPion's own cases for the gaps, plus the model's validated ones (registry `propose`). */
export function proposeSpecTests(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems?: string[] } {
  const local = input.local as SpecLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'Tests from a spec need the API definition they are made from');
  const doc = loadOpenApi(local.text);
  const plan = (a.value ?? { cases: [] }) as SpecPlan;
  const ai = casesFromPlan(plan, local, doc);
  const seen = new Set(local.draft.map((c) => JSON.stringify([c.operation, c.request.url, c.request.params, c.request.headers, c.request.body, c.request.auth, c.expect])));
  const extra = ai.cases.filter((c) => !seen.has(JSON.stringify([c.operation, c.request.url, c.request.params, c.request.headers, c.request.body, c.request.auth, c.expect])));
  const cases = [...local.draft, ...extra].slice(0, SPEC_MAX_CASES);
  const notes = [...ai.notes];
  if (!extra.length && (plan.cases ?? []).length) notes.push('None of the model’s cases was new and valid: the tests are TestPion’s own for the gaps.');
  if (local.draft.length + ai.cases.length > SPEC_MAX_CASES) notes.push(`Only the first ${SPEC_MAX_CASES} tests are proposed; ask again for the rest.`);
  if (!cases.length) return { items: [], notes, problems: ['no usable case: every case was dropped (see the notes), or the document has nothing to test'] };
  const files = buildSpecFiles(cases, local, doc, { by: input.model, ai: true });
  return { items: itemsOf(files, local, notes, coverageAfter(doc, local, files)), notes };
}

/** The summary, assumptions and notes of the proposal (registry `describe`). */
export function describeSpecTests(value: unknown, items: ProposalItem[]): { summary?: string; assumptions?: string[]; notes?: string[] } {
  const v = (value ?? {}) as SpecPlan;
  const data = items.map((i) => i.data as { tests?: number; categories?: Partial<Record<SpecCategory, number>>; coverage?: Coverage; notes?: string[] } | undefined);
  const total = data.reduce((n, d) => n + (d?.tests ?? 0), 0);
  const cats: Partial<Record<SpecCategory, number>> = {};
  for (const d of data) for (const [k, n] of Object.entries(d?.categories ?? {})) cats[k as SpecCategory] = (cats[k as SpecCategory] ?? 0) + (n ?? 0);
  const coverage = data.find((d) => d?.coverage)?.coverage;
  const line = `${total} test${total === 1 ? '' : 's'} (${Object.entries(cats).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}).${coverage ? ` ${coverageLine(coverage)}` : ''}`;
  return {
    summary: `${typeof v.summary === 'string' && v.summary.trim() ? `${v.summary.trim()} ` : ''}${line}`.trim(),
    assumptions: Array.isArray(v.assumptions) ? v.assumptions.map(String) : [],
    notes: data[0]?.notes ?? [],
  };
}

/* ------------------------------------------------------------------ verification */

/**
 * Every test of a generated file is judged by the document: its operation exists, the status it expects fits its
 * category, an accepted request satisfies the schema and the required parameters, a refused one differs from the valid
 * example and breaks something (else a warning: it needs a rule the document does not state). A failing case unticks the
 * file; the review says which.
 */
registerVerifier('spec-tests', (item, ctx: VerifyContext) => {
  if (item.kind !== 'file' && item.kind !== 'flow') return undefined;
  const spec = (item.data as { spec?: string } | undefined)?.spec;
  if (!spec) return undefined;
  if (!ctx.store) return { verifier: 'spec-tests', status: 'skip', label: 'not checked against the document (no workspace)' };
  const { text, doc } = loadSpec(ctx.store, spec);
  let parsed: unknown;
  try {
    parsed = parseYaml(item.after);
  } catch {
    return undefined; // the test-file verifier says why
  }
  const steps = ((parsed as Json | null)?.tests ?? []) as Json[];
  const defaults = ((parsed as Json | null)?.defaults ?? {}) as Json;
  const fails: string[] = [];
  const warns: string[] = [];
  let n = 0;
  const valid = new Map<string, CaseView>();
  for (const f of fuzzCases(text, { baseUrl: '{{baseUrl}}', includeDelete: true, maxPerOperation: 1 }).cases)
    if (f.mutation === 'valid') valid.set(f.operation, viewOfCase({ operation: f.operation, category: 'positive', name: '', mutation: 'valid', request: f.request, expect: [200], accept: true, origin: 'draft' }));
  for (const s of Array.isArray(steps) ? steps : []) {
    const v = s && typeof s === 'object' ? viewOfStep({ ...defaults, ...s }) : undefined;
    if (!v) continue;
    n++;
    const hit = findOperation(doc, v.method, matchUrl(v.url));
    const r = caseIssues(doc, v, hit ? valid.get(`${hit.method.toUpperCase()} ${hit.path}`) : undefined);
    for (const i of r.issues) (i.level === 'fail' ? fails : warns).push(`${String(s.name ?? s.id ?? n)}: ${i.message}`);
  }
  if (!n) return { verifier: 'spec-tests', status: 'fail', label: 'no HTTP test in the file', detail: 'A test file for a spec has steps with a method and a URL.' };
  if (fails.length) return { verifier: 'spec-tests', status: 'fail', label: `${fails.length} of ${n} tests do not fit the document`, detail: fails.slice(0, 8).join('\n') };
  if (warns.length) return { verifier: 'spec-tests', status: 'warn', label: `${n} tests match the document · ${warns.length} to look at`, detail: warns.slice(0, 8).join('\n') };
  return { verifier: 'spec-tests', status: 'pass', label: `${n} tests match the document (operations, statuses, requests)` };
});

export const SPEC_TEST_VERIFIERS = ['test-file', 'spec-tests'];

/**
 * The deterministic tests as a proposal, without any model (none set up, or `--no-ai`): the same review, verification
 * and apply as the AI's, labelled as made without AI.
 */
export async function draftSpecTestsProposal(store: WorkspaceStore, spec: string, o: SpecTestOptions & { path?: string; surface: AiSurface; reason?: string }): Promise<Proposal> {
  const { local, doc } = analyseSpec(store, spec, { ...o, path: o.path?.trim() ? proposedTestFilePath(store, o.path) : undefined });
  if (!local.scope.length) throw nothingToGenerate(local, spec);
  if (!local.draft.length)
    throw new ApsError('ConfigurationError', `Nothing to generate: the tests already cover the gaps of ${spec} that TestPion can close without a model`, {
      suggestions: ['A model can add cases for rules the document only hints at (set one up: testpion ai usage).', 'Ask for every category with gapsOnly: false (CLI --no-gaps-only).'],
    });
  const files = buildSpecFiles(local.draft, local, doc, { store, by: 'TestPion', ai: false });
  const notes = [o.reason ?? 'No AI model is set up: these are the tests TestPion builds from the document for the gaps. A model adds more negative, boundary and security ideas.'];
  const items: ProposalItem[] = itemsOf(files, local, notes, coverageAfter(doc, local, files)).map((d, i) => ({ ...d, id: `i${i + 1}`, verification: [], selected: true }));
  await verifyItems(items, SPEC_TEST_VERIFIERS, { store });
  const now = Date.now();
  const data = items.map((i) => i.data as { tests?: number; categories?: Partial<Record<SpecCategory, number>>; coverage?: Coverage });
  const cov = data[0]?.coverage;
  const p: Proposal = {
    schemaVersion: 1,
    id: newProposalId(),
    task: 'tests-from-spec',
    taskVersion: 0,
    title: `Tests from ${spec} (no AI)`,
    summary: `${local.draft.length} test${local.draft.length === 1 ? '' : 's'} for the gaps in the tests of ${spec}, built from the document without a model.${cov ? ` ${coverageLine(cov)}` : ''}`,
    assumptions: [],
    notes,
    items,
    provider: 'TestPion',
    model: 'no AI (deterministic cases)',
    surface: o.surface,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'open',
    usage: { inputTokens: 0, outputTokens: 0 },
    request: { item: { kind: 'spec', path: spec }, ...(local.path ? { path: local.path } : {}) },
  };
  return saveProposal(store, p);
}

/** The gap report for a spec file, with the tests TestPion could build for each category (counts only). */
export function specGapsWithDraft(store: WorkspaceStore, spec: string, options: SpecTestOptions = {}): { report: SpecGapReport; draft: { tests: number; byCategory: Partial<Record<SpecCategory, number>>; operations: number } } {
  const { local } = analyseSpec(store, spec, options);
  return { report: local.report, draft: { tests: local.draft.length, byCategory: counts(local.draft), operations: new Set(local.draft.map((c) => c.operation)).size } };
}
