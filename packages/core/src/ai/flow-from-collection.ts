/**
 * AI-1 · An integration flow from a collection or one of its folders (the owner's request: name a collection or a
 * folder, and the configured model writes the flow, so nobody writes it by hand).
 *
 * Deterministic first (planning/ai-features.md, principle 4): `flowsFromCollection` / `collectionSteps` give a draft
 * that is already a valid flow; the model *improves* it — order (create → read → update → delete), what each step
 * extracts for the next, the checks, one or two negative cases, its assumptions — and answers with a plan (JSON,
 * structured output) that names saved requests by id. TestPion builds the flow file from the saved requests itself: a
 * step naming a request that is not in the collection / folder is dropped (and said so), a URL may only gain
 * {{variables}} on the saved request's path (never another host), the request's own and inherited auth is kept.
 *
 * What is sent (through the context builder: redaction, privacy level, budgets): the requests (method, URL, header
 * names, auth type, body or its shape, saved example responses), the draft, the matching OpenAPI operations when the
 * workspace has a definition, and variable names (never values). The answer is verified (lint: cycles, unknown
 * dependsOn; every {{variable}} extracted by a step it waits for; a run on a mock of the collection) and repaired at
 * most twice; the proposal is reviewed before anything is written. Without a model the draft itself is offered
 * (`draftFlowProposal`): AI is an upgrade, not a dependency.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { templatedText, templateVariables, type ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { AuthConfig, CheckConfig, Collection, CollectionFolder, CollectionNode, KeyValue } from '../model/types.js';
import { flowsFromCollection } from '../openapi/flows-from-spec.js';
import { loadOpenApi, requestBodySchema } from '../openapi/contract.js';
import { listSpecs } from '../openapi/spec-files.js';
import { stepFromSavedRequest } from '../runner/flow-steps-from-requests.js';
import { findCollection } from '../storage/env-edit.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { parseYaml, stringifyYaml } from '../util/lazy-yaml.js';
import type { AiSurface } from '../storage/ai-usage.js';
import { newProposalId, proposedTestFilePath, PROPOSAL_TTL_MS, saveProposal, type Proposal, type ProposalItem } from './proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { flowVariableProblems, registerVerifier, verifyItems, type VerifyContext } from './verify.js';

type Saved = Exclude<CollectionNode, { kind: 'folder' }>;

/** At most this many requests are sent; a bigger folder is sampled (the draft's requests first, then one per endpoint). */
export const FLOW_MAX_REQUESTS = 60;
const MAX_SPEC_BYTES = 1024 * 1024;

/** A step of a flow plan: what the model answers (and what the deterministic draft is). */
export interface FlowPlanStep {
  id: string;
  /** The id of a saved request of the collection / folder. */
  request: string;
  name?: string;
  dependsOn?: string[];
  /** The saved URL with {{variables}} in its path or query (the host is always the saved one). */
  url?: string;
  /** A JSON body instead of the saved one. */
  body?: unknown;
  extract?: Record<string, string>;
  assertions?: CheckConfig[];
  /** An error case (a missing id, an invalid body): it extracts nothing. */
  negative?: boolean;
}

export interface FlowPlan {
  name?: string;
  summary?: string;
  assumptions?: string[];
  steps: FlowPlanStep[];
}

/** What `prepare` keeps on this computer for building the flow (never sent). */
export interface FlowLocal {
  label: string;
  collectionId: string;
  collectionName: string;
  folderId?: string;
  ref: ItemRef;
  requests: Record<string, { node: Saved; auth?: AuthConfig }>;
  /** Variables the source's requests and the collection already use (the user's own): a flow may use them. */
  known: string[];
  draft: FlowPlan;
  path: string;
}

/** A step name's longest length (a longer one is cut). */
export const STEP_NAME_MAX = 60;

/** A plan's step name made safe for the canvas: one line, no control characters, at most STEP_NAME_MAX characters; none when empty. */
export function cleanStepName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > STEP_NAME_MAX ? `${s.slice(0, STEP_NAME_MAX - 1).trimEnd()}…` : s;
}

/** A name no other step of the flow has (case-insensitive): "Get patient", "Get patient (2)" … */
function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const tail = ` (${i})`;
    name = (base.length + tail.length > STEP_NAME_MAX ? base.slice(0, STEP_NAME_MAX - tail.length).trimEnd() : base) + tail;
  }
  used.add(name.toLowerCase());
  return name;
}

/** The answer's JSON Schema (structured output). */
export const FLOW_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['steps'],
  properties: {
    name: { type: 'string', description: 'The flow name' },
    summary: { type: 'string', description: 'What the flow proves, in one or two sentences' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'What you assumed that the context does not say' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'request'],
        properties: {
          id: { type: 'string', description: 'Step id, kebab-case, unique' },
          request: { type: 'string', description: 'The id of a request in context.requests (never invented)' },
          name: { type: 'string', description: `The step name on the canvas: short (at most ${STEP_NAME_MAX} characters), unique in the flow; an error case says so (e.g. "Get order — missing id")` },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of steps that must run first (every step whose extracted value this one uses)' },
          url: { type: 'string', description: "Only to put {{variables}} into the saved URL's path or query" },
          body: { description: 'Only to replace the saved JSON body' },
          extract: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variable name → JSONPath into the response, e.g. {"orderId": "$.id"}' },
          assertions: {
            type: 'array',
            items: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, path: { type: 'string' }, expected: {} } },
          },
          negative: { type: 'boolean', description: 'An error case (expects a 4xx)' },
        },
      },
    },
  },
};

/* ------------------------------------------------------------------ the source */

function findFolder(items: CollectionNode[], want: string, path: string[] = []): { folder: CollectionFolder; path: string[] } | undefined {
  for (const n of items)
    if (n.kind === 'folder') {
      if (n.id === want || n.name === want || [...path, n.name].join('/') === want.replace(/\s*\/\s*/g, '/')) return { folder: n, path: [...path, n.name] };
      const r = findFolder(n.items, want, [...path, n.name]);
      if (r) return r;
    }
  return undefined;
}

/** The item a flow is generated from, by collection and folder names or ids (CLI `--collection/--folder`, MCP). */
export function flowSourceRef(store: WorkspaceStore, o: { collection: string; folder?: string }): ItemRef {
  const c = findCollection(store, o.collection);
  if (!c)
    throw new ApsError('ConfigurationError', `No collection "${o.collection}" in this workspace`, {
      suggestions: [
        `Collections: ${
          store
            .listCollections()
            .map((x) => x.name)
            .slice(0, 20)
            .join(', ') || 'none'
        }`,
      ],
    });
  if (!o.folder) return { kind: 'collection', collectionId: c.id };
  const full = store.getCollection(c.id);
  const f = findFolder(full.items, o.folder);
  if (!f)
    throw new ApsError('ConfigurationError', `No folder "${o.folder}" in ${full.name}`, { suggestions: ['Give its name, its path (Orders/Refunds) or its id (testpion list-requests shows them).'] });
  return { kind: 'folder', collectionId: c.id, folderId: f.folder.id };
}

/** The requests of the source with the auth each inherits (its own, the nearest folder's, the collection's). */
function sourceRequests(c: Collection, folderId?: string): { label: string; folder?: CollectionFolder; list: Array<{ node: Saved; folder: string[]; auth?: AuthConfig }> } {
  const list: Array<{ node: Saved; folder: string[]; auth?: AuthConfig }> = [];
  const own = (a: AuthConfig | undefined) => (a && a.type !== 'inherit' ? a : undefined);
  let label = c.name;
  let found: CollectionFolder | undefined;
  const walk = (nodes: CollectionNode[], path: string[], auth: AuthConfig | undefined, inside: boolean) => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        const hit = inside || n.id === folderId;
        if (n.id === folderId) {
          found = n;
          label = [c.name, ...path, n.name].join(' / ');
        }
        walk(n.items, [...path, n.name], own(n.auth) ?? auth, hit);
      } else if (inside) list.push({ node: n, folder: path, auth: n.kind === 'http' ? (own(n.request.auth) ?? auth) : (own(n.request.auth as AuthConfig | undefined) ?? auth) });
    }
  };
  walk(c.items, [], own(c.auth), !folderId);
  if (folderId && !found) throw new ApsError('ConfigurationError', `No folder "${folderId}" in ${c.name}`);
  return { label, folder: found, list };
}

const bodyContent = (b: unknown): string | undefined => (b && typeof b === 'object' && typeof (b as { content?: unknown }).content === 'string' ? (b as { content: string }).content : undefined);
const jsonOrText = (s: string | undefined): unknown => {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const enabled = (kv: KeyValue[] | undefined) => (kv ?? []).filter((h) => h.enabled !== false && h.key);

/** A path's segments without the origin: `{{baseUrl}}/orders/{{id}}?x=1` → ['orders', '{{id}}']. */
const segmentsOf = (url: string) =>
  url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .replace(/^\{\{[^}]+\}\}/, '')
    .split(/[?#]/)[0]!
    .split('/')
    .filter(Boolean);
/** A segment that stands for a value: a variable, a path parameter, or an id that was typed in (42, 7f3a-…, job-1). */
const isValueSegment = (s: string) => /^\{\{.*\}\}$|^:|^\{.*\}$/.test(s) || /^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || (/\d/.test(s) && /^[\w-]{1,64}$/.test(s));

/** Two URLs name the same endpoint: the same number of segments, the literal ones equal (values may differ). */
export function sameEndpoint(a: string, b: string): boolean {
  const x = segmentsOf(a);
  const y = segmentsOf(b);
  return x.length === y.length && x.every((s, i) => s === y[i] || isValueSegment(s) || isValueSegment(y[i]!));
}

const originOf = (url: string) => /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*|\{\{[^}]+\}\})/i.exec(url.trim())?.[0] ?? '';
const restOf = (url: string) => url.trim().slice(originOf(url).length);

/** The draft TestPion makes without AI: the CRUD flows of the source's resources, else its requests in order, chained. */
function deterministicDraft(c: Collection, folder: CollectionFolder | undefined, requests: Saved[]): FlowPlan {
  const steps: FlowPlanStep[] = [];
  try {
    const flows = flowsFromCollection({ ...c, items: folder ? folder.items : c.items });
    for (const f of flows.files) {
      const doc = parseYaml(f.yaml) as { defaults?: { dependsOn?: string }; tests?: Array<Record<string, unknown>> } | Record<string, unknown> | null;
      const list = (doc && 'tests' in doc && Array.isArray(doc.tests) ? doc.tests : doc ? [doc] : []) as Array<Record<string, unknown>>;
      const defaultsDep = doc && 'defaults' in doc ? (doc.defaults as { dependsOn?: string } | undefined)?.dependsOn : undefined;
      for (const s of list) {
        const method = String(s.method ?? (s.request as { method?: string } | undefined)?.method ?? 'GET').toUpperCase();
        const url = String(s.url ?? (s.request as { url?: string } | undefined)?.url ?? '');
        const match = requests
          .filter((r): r is Extract<Saved, { kind: 'http' }> => r.kind === 'http' && r.request.method.toUpperCase() === method && sameEndpoint(r.request.url, url))
          .sort((a, b) => literalScore(b, url) - literalScore(a, url))[0];
        if (!match) continue;
        const deps = [...(Array.isArray(s.dependsOn) ? s.dependsOn : s.dependsOn ? [s.dependsOn] : []), ...(defaultsDep ? [defaultsDep] : [])].map(String);
        steps.push({
          id: String(s.id ?? slugify(String(s.name ?? match.name))),
          request: match.id,
          name: String(s.name ?? match.name),
          ...(deps.length ? { dependsOn: deps } : {}),
          ...(url && url !== match.request.url ? { url } : {}),
          ...(s.extract ? { extract: s.extract as Record<string, string> } : {}),
          ...(Array.isArray(s.assertions) ? { assertions: s.assertions as CheckConfig[] } : {}),
        });
      }
    }
  } catch {
    /* the collection is not one an OpenAPI document can be made of: the requests in order */
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) if (s.dependsOn) s.dependsOn = s.dependsOn.filter((d) => ids.has(d));
  if (steps.length) return { name: undefined, steps };
  // the requests in order, each after the one before (as the flow designer chains a folder)
  const out: FlowPlanStep[] = [];
  const picked = requests.slice(0, 40);
  picked.forEach((r, i) => {
    const id = uniqueId(slugify(r.name), new Set(out.map((s) => s.id)));
    out.push({ id, request: r.id, name: r.name, ...(i ? { dependsOn: [out[i - 1]!.id] } : {}) });
  });
  return { steps: out };
}

const literalScore = (r: Saved, url: string) => {
  if (r.kind !== 'http') return 0;
  const a = segmentsOf(r.request.url);
  const b = segmentsOf(url);
  return a.filter((s, i) => s === b[i]).length;
};

function uniqueId(base: string, used: Set<string>): string {
  let id = base || 'step';
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

/** The workspace's OpenAPI documents, parsed once, and the operation each request matches. */
function specOperations(store: WorkspaceStore, requests: Saved[]): { spec: string; operations: Array<Record<string, unknown>> } | undefined {
  let specs: string[];
  try {
    specs = listSpecs(store).sort();
  } catch {
    return undefined;
  }
  for (const spec of specs) {
    let doc: ReturnType<typeof loadOpenApi>;
    try {
      const file = store.safePath(spec);
      if (statSync(file).size > MAX_SPEC_BYTES) continue;
      doc = loadOpenApi(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const operations: Array<Record<string, unknown>> = [];
    for (const r of requests) {
      if (r.kind !== 'http') continue;
      try {
        const op = requestBodySchema(doc, r.request.method, r.request.url.replace(/^\{\{[^}]+\}\}/, 'http://api.local'));
        if (op)
          operations.push({
            request: r.id,
            path: op.path,
            ...(op.operationId ? { operationId: op.operationId } : {}),
            ...(op.summary ? { summary: op.summary } : {}),
            ...(op.schema ? { bodySchema: op.schema } : {}),
          });
      } catch {
        /* no match */
      }
    }
    if (operations.length) return { spec, operations };
  }
  return undefined;
}

/** A free file name under tests/ (an existing file is never the default target). */
function freePath(store: WorkspaceStore, base: string): string {
  const tests = store.path('tests');
  for (let i = 1; i < 200; i++) {
    const p = `${base}${i === 1 ? '' : `-${i}`}.yaml`;
    if (!existsSync(store.safePath(p, tests))) return p;
  }
  return `${base}-${Date.now().toString(36)}.yaml`;
}

/** Up to FLOW_MAX_REQUESTS: the draft's requests first, then one per endpoint, then the rest in order. */
function sampleRequests(list: Saved[], draft: FlowPlan): Saved[] {
  if (list.length <= FLOW_MAX_REQUESTS) return list;
  const pick = new Set<string>(draft.steps.map((s) => s.request));
  const seen = new Set<string>();
  for (const r of list) {
    const key =
      r.kind === 'http'
        ? `${r.request.method} ${segmentsOf(r.request.url)
            .map((s) => (isValueSegment(s) ? '*' : s))
            .join('/')}`
        : `gql ${r.name}`;
    if (!seen.has(key) && pick.size < FLOW_MAX_REQUESTS) pick.add(r.id);
    seen.add(key);
  }
  for (const r of list) if (pick.size < FLOW_MAX_REQUESTS) pick.add(r.id);
  return list.filter((r) => pick.has(r.id));
}

/** A request as the model sees it: names and shapes it needs, never header values or secrets. */
function requestContext(r: { node: Saved; folder: string[]; auth?: AuthConfig }): Record<string, unknown> {
  const n = r.node;
  const where = r.folder.length ? { folder: r.folder.join(' / ') } : {};
  const auth = r.auth && r.auth.type !== 'none' ? { auth: r.auth.type } : {};
  if (n.kind === 'graphql')
    return {
      id: n.id,
      name: n.name,
      graphql: true,
      method: 'POST',
      url: n.request.endpoint,
      ...where,
      ...auth,
      query: n.request.query,
      ...(n.request.variables ? { variables: n.request.variables } : {}),
    };
  const examples = (n.examples ?? []).slice().sort((a, b) => Number(a.status >= 400) - Number(b.status >= 400));
  const keep = [examples.find((e) => e.status < 400), examples.find((e) => e.status >= 400)].filter((e): e is NonNullable<typeof e> => !!e);
  const body = bodyContent(n.request.body);
  return {
    id: n.id,
    name: n.name,
    method: n.request.method,
    url: n.request.url,
    ...where,
    ...(enabled(n.request.params).length ? { query: enabled(n.request.params).map((p) => p.key) } : {}),
    ...(enabled(n.request.headers).length ? { headers: enabled(n.request.headers).map((h) => h.key) } : {}),
    ...auth,
    ...(body !== undefined ? { body: jsonOrText(body) } : n.request.body && n.request.body.type !== 'none' ? { bodyType: n.request.body.type } : {}),
    ...(keep.length ? { examples: keep.map((e) => ({ status: e.status, body: jsonOrText(e.body) })) } : {}),
  };
}

/**
 * The task's own context for a collection or folder (registry `prepare`): what is sent, and what is kept here to build
 * the flow from the saved requests.
 */
export function prepareFlowContext(store: WorkspaceStore, ref: ItemRef, o: { path?: string } = {}): PreparedItem {
  if (ref.kind !== 'collection' && ref.kind !== 'folder')
    throw new ApsError('ValidationError', `An integration flow is made from a collection or a folder, not a ${ref.kind}`, {
      suggestions: ['Pass collection:<id> or folder:<collectionId>:<folderId>.'],
    });
  const c = store.getCollection(ref.collectionId);
  const src = sourceRequests(c, ref.kind === 'folder' ? ref.folderId : undefined);
  if (!src.list.length)
    throw new ApsError('ConfigurationError', `${src.label} has no requests to make a flow of`, { suggestions: ['Add requests to it (or pick a folder that has some), then generate the flow.'] });
  const all = src.list.map((r) => r.node);
  const draft = deterministicDraft(c, src.folder, all);
  const sampled = sampleRequests(all, draft);
  const keep = new Set(sampled.map((r) => r.id));
  const known = new Set<string>([...c.variables.map((v) => v.key)]);
  const folderVars = (items: CollectionNode[]): void => items.forEach((n) => n.kind === 'folder' && ((n.variables ?? []).forEach((v) => known.add(v.key)), folderVars(n.items)));
  folderVars(c.items);
  for (const r of src.list) for (const v of templateVariables(templatedText({ r: r.node.request, a: r.auth }))) known.add(v);
  const api = specOperations(store, sampled);
  const base = slugify(src.label.replace(/ \/ /g, '-'));
  const local: FlowLocal = {
    label: src.label,
    collectionId: c.id,
    collectionName: c.name,
    ...(ref.kind === 'folder' ? { folderId: ref.folderId } : {}),
    ref,
    requests: Object.fromEntries(src.list.map((r) => [r.node.id, { node: r.node, auth: r.auth }])),
    known: [...known],
    draft,
    path: o.path?.trim() ? proposedTestFilePath(store, o.path) : freePath(store, `flows/${base}`),
  };
  return {
    label: src.label,
    collection: c,
    path: local.path,
    local,
    context: {
      source: {
        collection: c.name,
        ...(src.folder ? { folder: src.label.split(' / ').slice(1).join(' / ') } : {}),
        requests: all.length,
        ...(sampled.length < all.length ? { sampled: `${sampled.length} of ${all.length} requests sent (every endpoint once, the draft's first)` } : {}),
      },
      requests: src.list.filter((r) => keep.has(r.node.id)).map(requestContext),
      draft: {
        steps: draft.steps.map((s) => ({
          id: s.id,
          request: s.request,
          name: s.name,
          ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
          ...(s.url ? { url: s.url } : {}),
          ...(s.extract ? { extract: s.extract } : {}),
        })),
      },
      ...(api ? { api } : {}),
      ...(known.size ? { collectionVariables: [...known].filter((k) => !k.startsWith('$')).slice(0, 200) } : {}),
    },
  };
}

/* ------------------------------------------------------------------ building the flow */

const STEP_KEYS = ['id', 'name', 'dependsOn'];

/** The flow file a plan describes, built from the saved requests (see the module comment). */
export function buildFlowFile(plan: FlowPlan, local: FlowLocal, o: { by: string; ai: boolean }): { yaml: string; steps: number; notes: string[] } {
  const notes: string[] = [];
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  const kept: Array<{ ps: FlowPlanStep; id: string; r: FlowLocal['requests'][string] }> = [];
  const dropped = new Set<string>();
  for (const ps of Array.isArray(plan?.steps) ? plan.steps : []) {
    if (!ps || typeof ps !== 'object') continue;
    const r = local.requests[String(ps.request)];
    if (!r) {
      dropped.add(String(ps.id));
      notes.push(`Dropped step "${String(ps.id ?? ps.name ?? '?')}": it names request "${String(ps.request)}", which is not in ${local.label}.`);
      continue;
    }
    const id = uniqueId(slugify(String(ps.id || ps.name || r.node.name)), used);
    if (!idOf.has(String(ps.id))) idOf.set(String(ps.id), id);
    kept.push({ ps, id, r });
  }
  if (!kept.length)
    throw new ApsError('ValidationError', `No step of the answer names a request of ${local.label}`, { suggestions: ['Each step needs `request`: the id of one of context.requests.'] });
  const names = new Set<string>();
  const steps = kept.map(({ ps, id, r }) => {
    const base = stepFromSavedRequest(r.node) as Record<string, unknown>;
    const { name: _name, extract: suggested, assertions: savedChecks, preRequestScript, testScript, ...head } = base;
    const deps = [...new Set((Array.isArray(ps.dependsOn) ? ps.dependsOn : ps.dependsOn ? [ps.dependsOn] : []).map(String))].flatMap((d) => {
      const to = idOf.get(d);
      if (to && to !== id) return [to];
      if (!dropped.has(d)) notes.push(`Step "${id}": dependsOn "${d}" is not a step of the flow (left out).`);
      return [];
    });
    // the plan's name (cleaned), else the request's; an error case says so — and no two steps share a name on the canvas
    const name = uniqueName(cleanStepName(ps.name) ?? cleanStepName(ps.negative ? `${r.node.name} — error case` : r.node.name) ?? id, names);
    const step: Record<string, unknown> = { id, name, ...(deps.length ? { dependsOn: deps } : {}), ...head };
    const req = step.request && typeof step.request === 'object' ? (step.request as Record<string, unknown>) : undefined;
    if (req && r.node.kind === 'http') {
      // the URL: only the path and query may change, on the saved request's own host
      if (typeof ps.url === 'string' && ps.url.trim() && ps.url !== r.node.request.url) {
        if (sameEndpoint(r.node.request.url, ps.url)) req.url = originOf(r.node.request.url) + restOf(ps.url).replace(/^(?=[^/?])/, '/');
        else notes.push(`Step "${id}": the URL ${ps.url} is not ${r.node.request.method} ${r.node.request.url}; the saved URL is kept.`);
      }
      if (ps.body !== undefined && ps.body !== null) {
        const savedType = (r.node.request.body as { type?: string } | undefined)?.type;
        req.body =
          typeof ps.body === 'string' && (savedType === 'text' || savedType === 'xml')
            ? { type: savedType, content: ps.body }
            : { type: 'json', content: typeof ps.body === 'string' ? ps.body : JSON.stringify(ps.body, null, 2) };
      }
      if (!req.auth && r.auth && r.auth.type !== 'none' && r.auth.type !== 'inherit') req.auth = r.auth;
    } else if (r.node.kind === 'graphql' && !step.auth && r.auth && r.auth.type !== 'none') step.auth = r.auth;
    const extract =
      ps.extract && typeof ps.extract === 'object' && !Array.isArray(ps.extract)
        ? Object.fromEntries(Object.entries(ps.extract).filter(([k, v]) => /^[A-Za-z_][\w.-]*$/.test(k) && typeof v === 'string' && v.trim()))
        : undefined;
    // the model says what each step extracts; the draft (no model) keeps the ids and tokens its examples suggest
    const ex = extract && Object.keys(extract).length ? extract : o.ai || ps.negative || ps.extract ? undefined : (suggested as Record<string, string> | undefined);
    if (ex && Object.keys(ex).length) step.extract = ex;
    const checks = Array.isArray(ps.assertions) ? ps.assertions.filter((c) => c && typeof c === 'object' && typeof c.type === 'string') : [];
    step.assertions = checks.length ? checks : savedChecks;
    if (preRequestScript) step.preRequestScript = preRequestScript;
    if (testScript) step.testScript = testScript;
    return Object.fromEntries([...STEP_KEYS.filter((k) => k in step).map((k) => [k, step[k]]), ...Object.entries(step).filter(([k]) => !STEP_KEYS.includes(k))]);
  });
  const name = typeof plan.name === 'string' && plan.name.trim() ? plan.name.trim() : `${local.label} integration flow`;
  const head = o.ai
    ? `# AI-generated by TestPion (${o.by}) from ${local.label}: review the steps, extracts and checks before running it.\n`
    : `# Generated by TestPion without AI (the deterministic draft) from ${local.label}: review it before running it.\n`;
  return { yaml: head + stringifyYaml({ name, tests: steps }, { lineWidth: 0, aliasDuplicateObjects: false }), steps: steps.length, notes };
}

/** The proposal item of a plan (registry `propose`). */
export function proposeFlow(a: { value?: unknown }, input: AiTaskInput): DraftItem[] {
  const local = input.local as FlowLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'An integration flow needs the collection or folder it is made from');
  const plan = (a.value ?? {}) as FlowPlan;
  const built = buildFlowFile(plan, local, { by: input.model, ai: true });
  return [flowItem(local, built)];
}

function flowItem(local: FlowLocal, built: ReturnType<typeof buildFlowFile>): DraftItem {
  return {
    kind: 'flow',
    title: `tests/${local.path}`,
    path: local.path,
    after: built.yaml,
    language: 'yaml',
    target: { kind: 'flow', path: local.path },
    data: { source: local.ref, known: local.known, steps: built.steps, notes: built.notes },
  };
}

/** The summary, assumptions and notes of the proposal (registry `describe`). */
export function describeFlow(value: unknown, items: ProposalItem[]): { summary?: string; assumptions?: string[]; notes?: string[] } {
  const v = (value ?? {}) as FlowPlan;
  const notes = items.flatMap((i) => ((i.data as { notes?: string[] } | undefined)?.notes ?? []).filter((n) => typeof n === 'string'));
  return {
    summary: typeof v.summary === 'string' ? v.summary : undefined,
    assumptions: Array.isArray(v.assumptions) ? v.assumptions.map(String) : [],
    notes,
  };
}

/* ------------------------------------------------------------------ verification */

const stepsOf = (text: string): Array<Record<string, unknown>> => {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  return (Array.isArray(doc) ? doc : ((doc as { tests?: unknown[] })?.tests ?? [])).filter((s): s is Record<string, unknown> => !!s && typeof s === 'object');
};

/** A step uses a value another step extracts without waiting for that step (dependsOn, directly or through others). */
export function flowOrderProblems(text: string): string[] {
  const steps = stepsOf(text);
  const idOf = (s: Record<string, unknown>) => String(s.id ?? s.name ?? '');
  const deps = new Map(steps.map((s) => [idOf(s), (Array.isArray(s.dependsOn) ? s.dependsOn : s.dependsOn ? [s.dependsOn] : []).map(String)]));
  const extractedBy = new Map<string, string>();
  for (const s of steps) for (const k of Object.keys((s.extract as Record<string, unknown>) ?? {})) if (!extractedBy.has(k)) extractedBy.set(k, idOf(s));
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const d of deps.get(id) ?? []) if (!seen.has(d)) (seen.add(d), ancestors(d, seen));
    return seen;
  };
  const out: string[] = [];
  for (const s of steps) {
    const { extract: _e, ...rest } = s;
    const id = idOf(s);
    const before = ancestors(id);
    // what the step sends and checks (the shared definition: not its scripts, descriptions or Handlebars blocks)
    for (const m of templateVariables(templatedText(rest))) {
      const by = extractedBy.get(m);
      if (by && by !== id && !before.has(by)) out.push(`step "${id}" uses {{${m}}} but does not wait for "${by}", which extracts it: add "${by}" to its dependsOn`);
    }
  }
  return out;
}

/**
 * Every {{variable}} of a generated flow is extracted by a step it waits for, or is one the workspace already has (an
 * environment's, the collection's, one the saved requests use): a fail, so the repair turn tells the model which.
 */
registerVerifier('flow-vars', (item, ctx: VerifyContext) => {
  if (item.kind !== 'flow' && item.kind !== 'file') return undefined;
  const known = [...(ctx.variableNames ?? []), ...(((item.data as { known?: unknown } | undefined)?.known as string[] | undefined) ?? [])];
  const problems = [...flowVariableProblems(item.after, known), ...flowOrderProblems(item.after)];
  return problems.length
    ? { verifier: 'flow-vars', status: 'fail', label: `${problems.length} variable problem${problems.length === 1 ? '' : 's'}`, detail: problems.slice(0, 8).join('\n') }
    : { verifier: 'flow-vars', status: 'pass', label: 'every variable is extracted before it is used, or set in the workspace' };
});

export const FLOW_VERIFIERS = ['test-file', 'flow-vars', 'flow-mock'];

/**
 * The deterministic draft as a proposal, without any model (no AI set up, or offline): the same review, verification
 * and apply as the AI's flow, labelled as made without AI.
 */
export async function draftFlowProposal(store: WorkspaceStore, ref: ItemRef, o: { path?: string; surface: AiSurface; reason?: string; verify?: Omit<VerifyContext, 'response'> }): Promise<Proposal> {
  const prepared = prepareFlowContext(store, ref, { path: o.path });
  const local = prepared.local as FlowLocal;
  const built = buildFlowFile(local.draft, local, { by: 'TestPion', ai: false });
  const item: ProposalItem = { ...flowItem(local, built), id: 'i1', verification: [], selected: true };
  try {
    item.before = store.readTestFile(local.path);
  } catch {
    /* a new file */
  }
  await verifyItems([item], FLOW_VERIFIERS, { ...o.verify, collection: o.verify?.collection ?? prepared.collection });
  const now = Date.now();
  const p: Proposal = {
    schemaVersion: 1,
    id: newProposalId(),
    task: 'flow-from-collection',
    taskVersion: 0,
    title: `Integration flow (no AI): ${local.label}`,
    summary: `The flow TestPion builds without a model: ${built.steps} step${built.steps === 1 ? '' : 's'} from the saved requests of ${local.label}${local.draft.steps.some((s) => s.dependsOn?.length) ? ', chained' : ''}.`,
    assumptions: [],
    notes: [o.reason ?? 'No AI model is set up: this is the deterministic draft. Set up a model to have it improved (order, extracts, checks, error cases).', ...built.notes],
    items: [item],
    provider: 'TestPion',
    model: 'no AI (deterministic draft)',
    surface: o.surface,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'open',
    usage: { inputTokens: 0, outputTokens: 0 },
    request: { item: ref, path: local.path },
  };
  return saveProposal(store, p);
}

/** An error that means "no model is set up" (no key, no provider): the callers then offer the draft. */
export const isAiSetupError = (e: unknown): boolean => {
  const d = (e as { details?: { setup?: unknown } } | undefined)?.details;
  return !!d?.setup;
};
