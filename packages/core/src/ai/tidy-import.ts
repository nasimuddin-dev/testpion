/**
 * AI-10 · Tidy an import: after Postman, curl, HAR, Insomnia or Bruno came in, the collection has generic names, no
 * folders, hosts and tokens typed into every request, ids typed into paths that an earlier response returned, and (a
 * HAR) the analytics and image requests of a whole page load. "Tidy this import" proposes the clean-up as separate,
 * reviewable changes — never a rewrite:
 *
 * - names and folders (the model: "List orders", an Orders folder)
 * - a host typed into many URLs → a collection variable ({{baseUrl}}), a repeated token → a variable
 * - a hard-coded id an earlier response returned → chained: the earlier request gets a `tp.*` script that sets the
 *   variable, the later ones use {{orderId}} (confirmed against the saved example of the earlier response when there is one)
 * - tracking, static and duplicate requests → dropped (what the model adds beyond TestPion's own list is opt-in)
 * - optionally a flow that wires the requests
 *
 * Deterministic first (principle 4): hosts, tokens, noise, duplicates and the chains the saved examples confirm are found
 * without a model (`--no-ai`); the model only names, groups and picks. Every change is a declarative operation
 * (`TidyOp`) applied to the collection as it is when the proposal is accepted, and a verifier proves, for each change,
 * that the collection stays valid and that **every request that remains sends exactly what it sent before** once the
 * proposed variables are resolved: the only differences allowed are the substitutions themselves.
 */
import { existsSync } from 'node:fs';
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { AuthConfig, Collection, KeyValue } from '../model/types.js';
import { runScript } from '../scripts/sandbox.js';
import type { AiSurface } from '../storage/ai-usage.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { query } from '../util/jsonpath.js';
import { maskSensitiveText } from '../util/redact.js';
import { buildFlowFile, cleanStepName, type FlowLocal, type FlowPlan } from './flow-from-collection.js';
import { saveDraftProposal, type Proposal, type ProposalItem } from './proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem, ProposalDescription } from './tasks/registry.js';
import { stringList } from '../util/collections.js';
import { registerVerifier, verifyItems, type VerifyContext } from './verify.js';
import { type Saved, TIDY_MAX_REQUESTS, type TidyGroup, type TidyOp, VAR_NAME, applyTidyOps, chainScript, collectionProblems, flatRequests, literalRe, pathAccessor, sendDifferences, urlOf } from './tidy-ops.js';
import { camel, draftGroups, exampleBody, looksLikeUrlName, originOf, pathOf, singular } from './tidy-groups.js';
export { type FlatRequest, TIDY_MAX_REQUESTS, type TidyGroup, type TidyOp, applyTidyOps, chainScript, collectionProblems, flatRequests, pathAccessor, resolvedRequest, sendDifferences } from './tidy-ops.js';
export { type IdCandidate, draftGroups, idCandidates, importNoiseReason, pathsOfValue } from './tidy-groups.js';

export interface TidyPlan {
  summary?: string;
  assumptions?: string[];
  requests?: Array<{ id: string; name?: string; folder?: string }>;
  hosts?: Array<{ origin: string; variable?: string }>;
  chains?: Array<{ variable?: string; from: string; to?: string[]; path: string; literal: string }>;
  drop?: Array<{ id: string; reason?: string }>;
  flow?: FlowPlan;
}

export const TIDY_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What the clean-up does, in one or two sentences' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'What you assumed that the context does not say' },
    requests: {
      type: 'array',
      description: 'Only the requests that need a better name or a folder',
      items: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'A request id of context.requests (never invented)' }, name: { type: 'string', description: 'A short name: a verb and the resource, e.g. "List orders"' }, folder: { type: 'string', description: 'A folder by resource, e.g. "Orders" or "Orders/Refunds" (at most two levels)' } } },
    },
    hosts: { type: 'array', items: { type: 'object', required: ['origin'], properties: { origin: { type: 'string', description: 'An origin of context.findings.origins' }, variable: { type: 'string', description: 'Its variable name, camelCase, e.g. baseUrl, authUrl' } } } },
    chains: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'path', 'literal'],
        properties: {
          variable: { type: 'string', description: 'camelCase, e.g. orderId' },
          from: { type: 'string', description: 'The earlier request whose response returns the value' },
          path: { type: 'string', description: 'JSONPath into that response: $.id, $.data.items[0].id' },
          literal: { type: 'string', description: 'The hard-coded value as it is typed in the later requests' },
          to: { type: 'array', items: { type: 'string' }, description: 'The later requests that use it (default: every request that contains the literal)' },
        },
      },
    },
    drop: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
    flow: {
      type: 'object',
      description: 'Only when context.options.flow is true: a flow that wires the requests',
      required: ['steps'],
      properties: {
        name: { type: 'string' },
        summary: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'request'],
            properties: {
              id: { type: 'string' },
              request: { type: 'string', description: 'A request id of context.requests' },
              name: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              extract: { type: 'object', additionalProperties: { type: 'string' } },
              assertions: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, path: { type: 'string' }, expected: {} } } },
            },
          },
        },
      },
    },
  },
};

const cleanFolderPart = (s: string) => s.replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
const cleanRequestName = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = cleanStepName(s);
  return t && !looksLikeUrlName(t) ? t : undefined;
};

/** The groups after the model's plan: its names, folders, host variable names, chains and drops, validated. */
export function applyPlan(c: Collection, draft: ReturnType<typeof draftGroups>, plan: TidyPlan): { groups: TidyGroup[]; notes: string[] } {
  const notes: string[] = [];
  const reqs = flatRequests(c);
  const byId = new Map(reqs.map((r) => [r.node.id, r]));
  const order = new Map(reqs.map((r, i) => [r.node.id, i]));
  const taken = new Set(draft.taken);
  let groups = draft.groups.map((g) => ({ ...g, ops: [...g.ops] }));
  let n = groups.length;
  const gid = () => `g${++n}`;
  const dropped = new Set(groups.filter((g) => g.kind === 'drop' || g.kind === 'dedupe').flatMap((g) => g.ops.flatMap((o) => (o.op === 'drop' ? [o.id] : []))));
  const free = (base: string): string => {
    let name = VAR_NAME.test(base) ? base : 'value';
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    return name;
  };

  // names and folders
  const nameOps = new Map<string, TidyOp[]>();
  for (const g of groups.filter((x) => x.kind === 'names')) for (const o of g.ops) if (o.op === 'rename') nameOps.set(o.id, [o]);
  let renamed = 0;
  let moved = 0;
  for (const rq of plan.requests ?? []) {
    const r = rq && typeof rq.id === 'string' ? byId.get(rq.id) : undefined;
    if (!r) {
      notes.push(`Skipped a name for "${String(rq?.id)}": it is not a request of ${c.name}.`);
      continue;
    }
    if (dropped.has(r.node.id)) continue;
    const ops: TidyOp[] = [];
    const name = cleanRequestName(rq.name);
    if (name && name !== r.node.name) (ops.push({ op: 'rename', id: r.node.id, name }), renamed++);
    if (typeof rq.folder === 'string' && rq.folder.trim()) {
      const folder = rq.folder.split('/').map(cleanFolderPart).filter(Boolean).slice(0, 2);
      if (folder.length && folder.join('/') !== r.folder.join('/')) (ops.push({ op: 'move', id: r.node.id, folder }), moved++);
    }
    if (ops.length) nameOps.set(r.node.id, ops);
  }
  groups = groups.filter((g) => g.kind !== 'names');
  const all = [...nameOps.values()].flat();
  if (all.length) {
    const rn = all.filter((o) => o.op === 'rename').length;
    const mv = all.filter((o) => o.op === 'move').length;
    groups.unshift({ id: gid(), kind: 'names', title: `${[rn ? `Rename ${rn}` : '', mv ? `Move ${mv} into folders` : ''].filter(Boolean).join(', ')}`, ops: all, source: renamed || moved ? 'ai' : 'draft' });
  }

  // host variable names
  for (const h of plan.hosts ?? []) {
    const origin = typeof h?.origin === 'string' ? h.origin.trim().replace(/\/+$/, '').toLowerCase() : '';
    const g = groups.find((x) => x.kind === 'host' && x.ops[0]?.op === 'host' && x.ops[0].origin.toLowerCase() === origin);
    if (!g) {
      notes.push(`Skipped the variable for ${String(h?.origin)}: TestPion found no such host typed into at least two requests.`);
      continue;
    }
    const op = g.ops[0] as Extract<TidyOp, { op: 'host' }>;
    if (typeof h.variable === 'string' && VAR_NAME.test(h.variable) && h.variable !== op.variable && !taken.has(h.variable) && !(c.variables ?? []).some((v) => v.key === op.variable)) {
      taken.delete(op.variable);
      taken.add(h.variable);
      op.variable = h.variable;
      g.title = g.title.replace(/\{\{[^}]+\}\}/, `{{${h.variable}}}`);
      g.source = 'ai';
    }
  }

  // chains
  for (const ch of plan.chains ?? []) {
    const from = ch && typeof ch.from === 'string' ? byId.get(ch.from) : undefined;
    const literal = typeof ch?.literal === 'string' ? ch.literal : '';
    if (!from || from.node.kind !== 'http' || !literal || typeof ch.path !== 'string') {
      notes.push(`Skipped a chain from "${String(ch?.from)}": it needs an HTTP request of ${c.name}, a path and the literal.`);
      continue;
    }
    if (!pathAccessor(ch.path)) {
      notes.push(`Skipped the chain ${String(ch.variable ?? literal)}: "${ch.path}" is not a path of plain keys and indexes ($.id, $.data.items[0].id).`);
      continue;
    }
    const re = literalRe(literal, '');
    const wanted = (ch.to?.length ? ch.to : reqs.filter((r) => re.test(JSON.stringify(r.node.request))).map((r) => r.node.id)).filter((id) => id !== from.node.id && byId.has(id) && !dropped.has(id));
    const later = wanted.filter((id) => (order.get(id) ?? -1) > (order.get(from.node.id) ?? 0));
    const usable = later.filter((id) => re.test(JSON.stringify(byId.get(id)!.node.request)));
    if (!usable.length) {
      notes.push(`Skipped the chain ${String(ch.variable ?? literal)}: no later request contains "${literal}".`);
      continue;
    }
    // already found by TestPion with the same literal: the model only names it
    const same = groups.find((g) => g.kind === 'chain' && g.ops[0]?.op === 'chain' && g.ops[0].literal === literal);
    if (same && same.ops[0]?.op === 'chain') {
      if (typeof ch.variable === 'string' && VAR_NAME.test(ch.variable) && !taken.has(ch.variable)) {
        taken.delete(same.ops[0].variable);
        taken.add(ch.variable);
        same.ops[0].variable = ch.variable;
        same.title = same.title.replace(/^[^:]+/, ch.variable);
        same.source = 'ai';
      }
      continue;
    }
    const variable = free(typeof ch.variable === 'string' && VAR_NAME.test(ch.variable) ? ch.variable : `${camel(singular(slugify(from.node.name)))}Id`);
    const confirmed = chainEvidence(from.node, ch.path, literal);
    groups.push({
      id: gid(),
      kind: 'chain',
      title: `${variable}: ${from.node.name} → ${usable.length} request${usable.length === 1 ? '' : 's'}`,
      ops: [{ op: 'chain', variable, from: from.node.id, to: usable, path: ch.path, literal }],
      source: 'ai',
      optIn: !confirmed.confirmed,
      evidence: confirmed,
    });
  }

  // drops beyond TestPion's own list: the person opts in
  const extra = (plan.drop ?? []).filter((d) => d && typeof d.id === 'string');
  const extraOps: TidyOp[] = [];
  const reasons: string[] = [];
  for (const d of extra) {
    if (!byId.has(d.id)) {
      notes.push(`Skipped dropping "${d.id}": it is not a request of ${c.name}.`);
      continue;
    }
    if (dropped.has(d.id)) continue;
    dropped.add(d.id);
    extraOps.push({ op: 'drop', id: d.id });
    if (d.reason) reasons.push(`${byId.get(d.id)!.node.name}: ${String(d.reason).slice(0, 80)}`);
  }
  if (extraOps.length) groups.push({ id: gid(), kind: 'drop', title: `Drop ${extraOps.length} more request${extraOps.length === 1 ? '' : 's'} the model thinks are not part of the API`, ops: extraOps, reason: reasons.slice(0, 5).join('; '), source: 'ai', optIn: true });
  return { groups, notes };
}

/** Does a saved example of the request return `literal` at `path`? */
export function chainEvidence(n: Saved, path: string, literal: string): NonNullable<TidyGroup['evidence']> {
  if (n.kind !== 'http') return { confirmed: false };
  for (const ex of n.examples ?? []) {
    if (ex.status >= 400) continue;
    const body = exampleBody(ex);
    if (body === undefined) continue;
    try {
      const v = query(body, path);
      if (v !== undefined && v !== null && String(v) === literal) return { confirmed: true, example: ex.name, value: literal };
    } catch {
      /* a path the engine cannot read */
    }
  }
  return { confirmed: false };
}

/* ------------------------------------------------------------------ texts for the review */

/** The requests a group touches, in collection order. */
function touched(c: Collection, ops: TidyOp[]): Set<string> {
  const ids = new Set<string>();
  const reqs = flatRequests(c);
  for (const o of ops) {
    if (o.op === 'rename' || o.op === 'move' || o.op === 'drop') ids.add(o.id);
    else if (o.op === 'host') {
      for (const r of reqs) if (urlOf(r.node).toLowerCase().startsWith(o.origin.toLowerCase())) ids.add(r.node.id);
    } else if (o.op === 'token') {
      for (const r of reqs) if (JSON.stringify(r.node.request).includes(o.value)) ids.add(r.node.id);
    } else if (o.op === 'chain') [o.from, ...o.to].forEach((id) => ids.add(id));
  }
  return ids;
}

/** A readable outline of some requests (name with folder, method and URL, credentials, scripts): the diff the review shows. */
export function outlineOf(c: Collection, ids: Set<string>): string {
  const lines: string[] = [];
  for (const r of flatRequests(c)) {
    if (!ids.has(r.node.id)) continue;
    const n = r.node;
    lines.push(`${[...r.folder, n.name].join(' / ')}`);
    lines.push(`  ${n.kind === 'http' ? n.request.method.toUpperCase() : 'GraphQL'} ${urlOf(n)}`);
    const req = n.request as { headers?: KeyValue[]; auth?: AuthConfig };
    for (const h of req.headers ?? []) if (h.enabled !== false && (/^(authorization|x-api-key|api-key|apikey|x-auth-token)$/i.test(h.key) || /\{\{/.test(h.value))) lines.push(`  ${h.key}: ${h.value}`);
    if (req.auth && req.auth.type !== 'inherit' && req.auth.type !== 'none') lines.push(`  auth: ${req.auth.type}${'token' in req.auth && req.auth.token ? ` ${String(req.auth.token)}` : ''}`);
    const body = n.kind === 'http' && n.request.body && 'content' in n.request.body ? String((n.request.body as { content: string }).content) : '';
    if (body && /\{\{/.test(body)) lines.push(`  body: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
    if (n.testScript?.trim()) for (const l of n.testScript.trim().split('\n').slice(-3)) lines.push(`  script> ${l.slice(0, 140)}`);
  }
  return maskSensitiveText(lines.join('\n') || '(none)');
}

/* ------------------------------------------------------------------ the task */

/** What `prepare` keeps on this computer (never sent). */
export interface TidyLocal {
  collection: Collection;
  groups: TidyGroup[];
  draft: ReturnType<typeof draftGroups>;
  options: { flow: boolean };
  path?: string;
  /** The saved source of the import, when the caller knows it (`har`, `postman` …). */
  source?: string;
}

const exampleContext = (n: Saved): Array<{ status: number; body: unknown }> =>
  n.kind !== 'http'
    ? []
    : (n.examples ?? [])
        .filter((e) => e.status < 400)
        .slice(0, 1)
        .map((e) => {
          const b = exampleBody(e);
          const text = JSON.stringify(b ?? e.body);
          return { status: e.status, body: text.length > 700 ? `${text.slice(0, 700)}…` : (b ?? e.body) };
        });

/** The task's own reading of a collection (registry `prepare`). */
export function prepareTidyContext(store: WorkspaceStore, ref: ItemRef, o: { path?: string; context?: Record<string, unknown> } = {}): PreparedItem {
  if (ref.kind !== 'collection') throw new ApsError('ValidationError', `An import is tidied as a collection, not a ${ref.kind}`, { suggestions: ['Pass collection:<id> (the collection the import made).'] });
  const c = store.getCollection(ref.collectionId);
  const reqs = flatRequests(c);
  if (!reqs.length) throw new ApsError('ConfigurationError', `${c.name} has no requests to tidy`);
  const opts = (o.context?.options && typeof o.context.options === 'object' ? o.context.options : {}) as Record<string, unknown>;
  const draft = draftGroups(c);
  const noisy = new Set(draft.groups.filter((g) => g.kind === 'drop' || g.kind === 'dedupe').flatMap((g) => g.ops.flatMap((x) => (x.op === 'drop' ? [x.id] : []))));
  // a big import: the noise and the first of each endpoint, up to the limit
  let shown = reqs;
  if (reqs.length > TIDY_MAX_REQUESTS) {
    const seen = new Set<string>();
    const pick = new Set<string>();
    for (const r of reqs) {
      const k = `${r.node.kind === 'http' ? r.node.request.method : 'gql'} ${pathOf(urlOf(r.node)).replace(/\/[^/]*\d[^/]*/g, '/*')}`;
      if (!seen.has(k) && pick.size < TIDY_MAX_REQUESTS) pick.add(r.node.id);
      seen.add(k);
    }
    for (const r of reqs) if (pick.size < TIDY_MAX_REQUESTS) pick.add(r.node.id);
    shown = reqs.filter((r) => pick.has(r.node.id));
  }
  const origins = new Map<string, number>();
  for (const r of reqs) {
    const origin = originOf(urlOf(r.node));
    if (origin) origins.set(origin.toLowerCase(), (origins.get(origin.toLowerCase()) ?? 0) + 1);
  }
  const local: TidyLocal = { collection: c, groups: draft.groups, draft, options: { flow: opts.flow === true }, path: o.path, source: typeof opts.source === 'string' ? opts.source : undefined };
  return {
    label: c.name,
    local,
    context: {
      collection: { name: c.name, requests: reqs.length, ...(shown.length < reqs.length ? { sampled: `${shown.length} of ${reqs.length} requests sent (one per endpoint)` } : {}), variables: (c.variables ?? []).map((v) => v.key), ...(local.source ? { importedFrom: local.source } : {}) },
      requests: shown.map((r) => ({
        id: r.node.id,
        name: r.node.name,
        ...(r.folder.length ? { folder: r.folder.join(' / ') } : {}),
        method: r.node.kind === 'http' ? r.node.request.method : 'POST',
        url: urlOf(r.node),
        ...(noisy.has(r.node.id) ? { noise: true } : {}),
        ...(exampleContext(r.node).length ? { example: exampleContext(r.node)[0] } : {}),
      })),
      findings: {
        origins: [...origins.entries()].sort((a, b) => b[1] - a[1]).map(([origin, requests]) => ({ origin, requests })),
        alreadyFound: draft.groups.map((g) => g.title),
        idCandidates: draft.candidates.slice(0, 20).map((k) => ({ literal: k.literal, usedBy: k.usedBy.slice(0, 8), ...(k.found ? { returnedBy: `${k.found.request} at ${k.found.path}` } : {}) })),
      },
    },
  };
}

const groupItem = (g: TidyGroup, c: Collection): DraftItem | undefined => {
  let after: Collection;
  try {
    after = applyTidyOps(c, g.ops);
  } catch {
    return undefined;
  }
  const ids = touched(c, g.ops);
  return {
    kind: 'collection',
    title: g.title,
    target: { kind: 'collection', collectionId: c.id },
    before: outlineOf(c, ids),
    after: outlineOf(after, ids),
    language: 'text',
    data: { collectionId: c.id, group: g.kind, ops: g.ops, source: g.source, ...(g.optIn ? { optIn: true } : {}), ...(g.evidence ? { evidence: g.evidence } : {}), ...(g.reason ? { reason: g.reason } : {}), requests: ids.size },
  };
};

const freeFlowPath = (store: WorkspaceStore | undefined, base: string): string => {
  for (let i = 1; i < 100; i++) {
    const p = `flows/${base}${i === 1 ? '' : `-${i}`}.yaml`;
    if (!store || !existsSync(store.safePath(p, store.path('tests')))) return p;
  }
  return `flows/${base}-${Date.now().toString(36)}.yaml`;
};

/** The flow a plan describes, over the tidied collection's requests. */
function flowItem(plan: FlowPlan, c: Collection, groups: TidyGroup[], local: TidyLocal, store: WorkspaceStore | undefined, by: string, ai: boolean): { item?: DraftItem; notes: string[] } {
  let after = c;
  try {
    after = applyTidyOps(c, groups.filter((g) => !g.optIn).flatMap((g) => g.ops));
  } catch {
    /* the flow is built over the collection as it is */
  }
  const reqs = flatRequests(after);
  const fl: FlowLocal = {
    label: `${after.name} (tidied)`,
    collectionId: after.id,
    collectionName: after.name,
    ref: { kind: 'collection', collectionId: after.id },
    requests: Object.fromEntries(reqs.map((r) => [r.node.id, { node: r.node, auth: r.auth }])),
    known: [...new Set([...(after.variables ?? []).map((v) => v.key)])],
    draft: { steps: [] },
    path: local.path ?? freeFlowPath(store, `${slugify(after.name)}-tidied`),
  };
  try {
    const built = buildFlowFile(plan, fl, { by, ai });
    return {
      notes: built.notes,
      item: {
        kind: 'flow',
        title: `tests/${fl.path}`,
        path: fl.path,
        after: built.yaml,
        language: 'yaml',
        target: { kind: 'flow', path: fl.path },
        data: { source: fl.ref, known: fl.known, steps: built.steps, notes: built.notes, after: 'the tidied collection' },
      },
    };
  } catch (e) {
    return { notes: [`No flow: ${(e as Error).message}`] };
  }
}

/** The proposal items of a plan (registry `propose`). */
export function proposeTidy(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[]; problems?: string[] } {
  const local = input.local as TidyLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'Tidying an import needs the collection it is about');
  const plan = (a.value ?? {}) as TidyPlan;
  const { groups, notes } = applyPlan(local.collection, local.draft, plan);
  const items: DraftItem[] = [];
  for (const g of groups) {
    const it = groupItem(g, local.collection);
    if (it) items.push(it);
    else notes.push(`Skipped "${g.title}": it can no longer be applied to ${local.collection.name}.`);
  }
  if (local.options.flow && plan.flow && Array.isArray(plan.flow.steps)) {
    const f = flowItem(plan.flow, local.collection, groups, local, undefined, input.model, true);
    notes.push(...f.notes);
    if (f.item) items.push(f.item);
  }
  if (!items.length) return { items, notes, problems: ['nothing to tidy: no change was valid (see the notes)'] };
  return { items, notes };
}

/** The summary, assumptions and notes of the proposal (registry `describe`). */
export function describeTidy(value: unknown, items: ProposalItem[]): ProposalDescription {
  const v = (value ?? {}) as TidyPlan;
  const n = items.filter((i) => i.kind === 'collection').length;
  return { summary: `${typeof v.summary === 'string' && v.summary.trim() ? `${v.summary.trim()} ` : ''}${n} change${n === 1 ? '' : 's'} to review${items.some((i) => i.kind === 'flow') ? ', and a flow' : ''}.`.trim(), assumptions: stringList(v.assumptions) };
}

/* ------------------------------------------------------------------ verification */

/**
 * A tidy change keeps the collection valid, and every request that remains sends exactly what it sent before once the
 * collection's variables are resolved. A chain's script is run on the saved example of the earlier response: it must set
 * the variable to the id the later requests had typed in. A suggestion nothing confirms (a chain without an example, a
 * drop the model proposes) starts unticked.
 */
registerVerifier('tidy-import', async (item, ctx: VerifyContext) => {
  if (item.kind !== 'collection') return undefined;
  const d = item.data as { collectionId?: string; ops?: TidyOp[]; group?: string; optIn?: boolean; evidence?: { confirmed?: boolean; example?: string } } | undefined;
  if (!d?.collectionId || !Array.isArray(d.ops)) return { verifier: 'tidy-import', status: 'fail', label: 'not a tidy change' };
  if (!ctx.store) return { verifier: 'tidy-import', status: 'skip', label: 'not checked against the collection (no workspace)' };
  let before: Collection;
  try {
    before = ctx.store.getCollection(d.collectionId);
  } catch {
    return { verifier: 'tidy-import', status: 'fail', label: 'the collection is no longer in the workspace' };
  }
  let after: Collection;
  try {
    after = applyTidyOps(before, d.ops);
  } catch (e) {
    return { verifier: 'tidy-import', status: 'fail', label: 'cannot be applied to the collection as it is now', detail: (e as Error).message };
  }
  const problems = collectionProblems(after);
  if (problems.length) return { verifier: 'tidy-import', status: 'fail', label: `the result is not a valid collection (${problems.length} problem${problems.length === 1 ? '' : 's'})`, detail: problems.slice(0, 6).join('\n') };
  const dropped = new Set(d.ops.flatMap((o) => (o.op === 'drop' ? [o.id] : [])));
  const diffs = sendDifferences(before, after, dropped);
  if (diffs.length) return { verifier: 'tidy-import', status: 'fail', label: `changes what ${diffs.length} request${diffs.length === 1 ? '' : 's'} send${diffs.length === 1 ? 's' : ''}`, detail: diffs.slice(0, 6).join('\n') };
  const kept = flatRequests(after).length;
  const same = `valid collection · ${kept} request${kept === 1 ? '' : 's'} send exactly what they sent (variables resolved)${dropped.size ? ` · ${dropped.size} dropped on purpose` : ''}`;
  if (d.group === 'chain') {
    const op = d.ops.find((o): o is Extract<TidyOp, { op: 'chain' }> => o.op === 'chain')!;
    const from = flatRequests(before).find((r) => r.node.id === op.from)?.node;
    const usable = from?.kind === 'http' ? (from.examples ?? []).filter((e) => e.status < 400 && exampleBody(e) !== undefined) : [];
    const ex = usable.find((e) => e.name === d.evidence?.example) ?? usable[0];
    if (!ex) {
      item.selected = false;
      item.verification.push({ verifier: 'tidy-import', status: 'warn', label: `no saved example of "${from?.name ?? op.from}" confirms ${op.path} returns ${op.literal}`, detail: 'Send that request, save its response as an example, and tidy again to confirm the chain; or accept it and run the collection.' });
      return { verifier: 'tidy-import', status: 'pass', label: same };
    }
    const out = await runScript(chainScript(op.variable, op.path), { variables: {}, response: { status: ex.status, headers: ex.headers.map((h) => [h.key, h.value] as [string, string]), body: ex.body } }, { timeoutMs: 3000, maxRequests: 0 });
    const got = out.vars?.[op.variable];
    if (out.error || got === undefined || String(got) !== op.literal) {
      item.selected = false;
      item.verification.push({
        verifier: 'tidy-import',
        status: 'warn',
        label: `the script does not set ${op.variable} to ${op.literal} on the saved example "${ex.name}"`,
        detail: out.error ?? `It set ${got === undefined ? 'nothing' : JSON.stringify(got)}; the path may be wrong.`,
      });
    } else item.verification.push({ verifier: 'tidy-import', status: 'pass', label: `on the saved example "${ex.name}" the script sets ${op.variable} = ${op.literal}` });
  } else if (d.optIn) {
    item.selected = false;
    item.verification.push({ verifier: 'tidy-import', status: 'warn', label: 'the model’s suggestion, not TestPion’s own finding: tick it to opt in' });
  }
  return { verifier: 'tidy-import', status: 'pass', label: same };
});

export const TIDY_VERIFIERS = ['tidy-import', 'test-file', 'flow-vars'];

/** The tidy TestPion makes without a model (none set up, or `--no-ai`), as a proposal. */
export async function draftTidyProposal(store: WorkspaceStore, ref: ItemRef, o: { surface: AiSurface; reason?: string; source?: string }): Promise<Proposal> {
  const prepared = prepareTidyContext(store, ref, { context: { options: { source: o.source } } });
  const local = prepared.local as TidyLocal;
  const c = local.collection;
  const items: ProposalItem[] = local.groups.flatMap((g) => {
    const it = groupItem(g, c);
    return it ? [{ ...it, id: '', verification: [], selected: true }] : [];
  });
  items.forEach((it, i) => (it.id = `i${i + 1}`));
  if (!items.length) throw new ApsError('ConfigurationError', `${c.name} has nothing TestPion can tidy without a model`, { suggestions: ['A model can name requests, group them in folders and chain ids (set one up: testpion ai usage).'] });
  await verifyItems(items, TIDY_VERIFIERS, { store });
  return saveDraftProposal(store, {
    task: 'tidy-import',
    title: `Tidy ${c.name} (no AI)`,
    summary: `${items.length} change${items.length === 1 ? '' : 's'} TestPion finds without a model: hosts and tokens typed into requests, tracking and duplicate requests, ids a saved response returns.`,
    notes: [o.reason ?? 'No AI model is set up: these are the clean-ups TestPion finds itself. A model adds names, folders and chains it cannot confirm.'],
    items,
    model: 'no AI (deterministic findings)',
    surface: o.surface,
    request: { item: ref },
  });
}
