/**
 * AI-8 · Security tests for an API (OWASP API Security Top 10), generated as ordinary test files whose verdicts are
 * deterministic: "AI to understand, deterministic to decide".
 *
 * The model only PROPOSES which saved requests to probe, with which probe kind from a fixed catalogue, which field of
 * the owner's response identifies their data, which privileged field names to try and which variables hold the two
 * principals' credentials (names, never values). TestPion writes every step itself from the saved requests and the
 * catalogue, and the verdict of each step is a check computed from the response by the runner — a status that must be
 * one of 401 / 403 / 404, a value the owner's response had that the other principal's must not contain, a privileged
 * field the response must not echo — never an opinion of the model.
 *
 *   API1 BOLA     the owner reads the object (2xx, a marker is extracted), the other principal repeats the request and
 *                 must be refused and must not see the marker
 *   API2 auth     no credentials, and an invalid token: refused (401 / 403)
 *   API3 BOPLA    (write verbs) a privileged field (role, isAdmin, balance …) added to the body must not come back
 *   API5 BFLA     a function of the owner's (an admin path, a delete) called by the other principal must be refused
 *
 * Safe by design: GET / HEAD / OPTIONS only unless write or delete verbs are asked for; every step is paced (a rate
 * limit across the file); at most `max` probes; the steps are the collection's own requests with credentials changed,
 * nothing else; the probes refuse a production environment (see security-run.ts for the executor, which refuses too).
 */
import { templatedText, templateVariables, type ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { AuthConfig, CheckConfig } from '../model/types.js';
import { stepFromSavedRequest } from '../runner/flow-steps-from-requests.js';
import { findEnvironment } from '../storage/env-edit.js';
import type { AiSurface } from '../storage/ai-usage.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { exists, query } from '../util/jsonpath.js';
import { stringifyYaml } from '../util/lazy-yaml.js';
import { jsonClone } from '../util/json-clone.js';
import { tryParseYaml } from '../util/yaml-doc.js';
import { freePath, isValueSegment, requestContext, sameEndpoint, segmentsOf, sourceRequests, type Saved } from './flow-from-collection.js';
import { proposedTestFilePath, saveDraftProposal, type Proposal, type ProposalItem } from './proposal.js';
import type { AiTaskInput, DraftItem, PreparedItem, ProposalDescription } from './tasks/registry.js';
import { stringList } from '../util/collections.js';
import { registerVerifier, verifyItems, type VerifyContext } from './verify.js';

export const SECURITY_PROBES = ['bola', 'auth', 'mass-assignment', 'bfla'] as const;
export type SecurityProbe = (typeof SECURITY_PROBES)[number];

/** What each probe tests, in the words of OWASP's API Security Top 10 (2023). */
export const SECURITY_CATALOGUE: Record<SecurityProbe, { owasp: string; title: string; text: string }> = {
  bola: { owasp: 'API1', title: 'Broken object level authorization', text: "A second user repeats the owner's request for the owner's object and must be refused (401, 403 or 404) and must not see the owner's data." },
  auth: { owasp: 'API2', title: 'Broken authentication', text: 'The request without credentials, and with an invalid token, must be refused (401 or 403).' },
  'mass-assignment': {
    owasp: 'API3',
    title: 'Broken object property level authorization (mass assignment)',
    text: 'A privileged field (role, isAdmin, balance …) added to a create or update body must not be accepted and returned.',
  },
  bfla: { owasp: 'API5', title: 'Broken function level authorization', text: "A function of the owner's (an admin path, a delete) called by the other user must be refused (401 or 403)." },
};

const KIND_NAME: Record<SecurityProbe, string> = { bola: 'BOLA', auth: 'broken authentication', 'mass-assignment': 'mass assignment', bfla: 'BFLA' };

/** Statuses a refused request may carry: not authenticated, forbidden, or hidden as not found. */
const DENIED_OBJECT = [401, 403, 404];
const DENIED_FUNCTION = [401, 403];

/** Defaults: a probe every 250 ms (four requests a second) and at most 40 probes (up to ~80 requests). */
const SECURITY_DEFAULTS = { rate: 4, max: 40 } as const;
/** An invalid token that is no secret: the API must refuse it. */
const INVALID_TOKEN = 'tp-invalid-token';

interface SecurityIdentities {
  /** The variable that holds the credentials the saved requests were written for (a token, an API key). */
  owner?: string;
  /** The variable of another user (BOLA) or a lower-privilege one (BFLA). */
  other?: string;
}

interface SecurityOptions {
  probes?: SecurityProbe[];
  identities?: SecurityIdentities;
  /** POST / PUT / PATCH probes (mass assignment, writes of the other user); they change data. */
  includeWrite?: boolean;
  /** DELETE probes; they destroy data. */
  includeDelete?: boolean;
  /** Requests a second (the file's `pace:`), default 4. */
  rate?: number;
  /** Most probes in the file, default 40. */
  max?: number;
  /** The environment the tests are for: a production one is refused unless `allowProduction`. */
  environment?: string;
  allowProduction?: boolean;
}

/** A probe as the model proposes it (and as the deterministic draft makes it). */
interface SecurityPlanProbe {
  kind: SecurityProbe;
  /** The id of a saved request of the collection / folder. */
  request: string;
  /** bola: a JSONPath of the owner's response that identifies their data (an email, a name, an id). */
  ownerField?: string;
  /** mass-assignment: privileged field names to add. */
  fields?: string[];
  why?: string;
}

interface SecurityPlan {
  summary?: string;
  assumptions?: string[];
  identities?: SecurityIdentities;
  probes: SecurityPlanProbe[];
}

/** What `prepare` keeps on this computer. */
interface SecurityLocal {
  label: string;
  collectionId: string;
  folderId?: string;
  ref: ItemRef;
  requests: Record<string, { node: Saved; auth?: AuthConfig }>;
  options: Required<Pick<SecurityOptions, 'includeWrite' | 'includeDelete' | 'rate' | 'max'>> & { probes: SecurityProbe[]; identities: SecurityIdentities; environment?: string };
  /** Variable names the environment, the collection and its requests have (never values). */
  known: string[];
  /** The collection's own (non-secret) variables, which the file carries when its steps use them: a test file does not see a collection's variables. */
  collectionVars: Record<string, string>;
  /** Variables the environment has: they win over the collection's. */
  envKeys: string[];
  draft: SecurityPlanProbe[];
  /** Probes the draft cannot make, with the reason (shown, never hidden). */
  skipped: string[];
  path: string;
}

/* ------------------------------------------------------------------ the catalogue's rules */

const READ = /^(GET|HEAD|OPTIONS)$/i;
const WRITE = /^(POST|PUT|PATCH)$/i;
const CRED_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token)$/i;
const CRED_PARAM = /^(api[_-]?key|apikey|access[_-]?token|token|auth|key|signature|sig)$/i;
/** A function only some users should reach, by its path. */
const PRIVILEGED = /(^|\/)(admin|administrator|internal|manage|management|superuser|root|debug|config|settings|roles|permissions|audit|billing|impersonate)(\/|$|\{)/i;

/** Privileged field names a mass-assignment probe may add, with the value each kind of name gets (the model picks names, never values). */
const MASS_FIELDS: Array<{ name: RegExp; value: unknown }> = [
  { name: /^(is_?admin|isadmin|admin|is_?superuser|superuser|is_?staff|staff|is_?root|root)$/i, value: true },
  { name: /^(roles|permissions?|scopes?|groups|authorities)$/i, value: ['admin'] },
  { name: /^(role|user_?type|account_?type|type|level|plan|tier|privilege)$/i, value: 'admin' },
  { name: /^(verified|is_?verified|active|is_?active|approved|confirmed|enabled|premium|is_?premium|paid|trusted|email_?verified)$/i, value: true },
  { name: /^(balance|credits?|points|price|amount|discount|limit|quota|salary|total)$/i, value: 999999 },
  { name: /^(owner|owner_?id|user_?id|account_?id|org|org_?id|tenant|tenant_?id|created_?by|author|author_?id)$/i, value: 'tp-injected-owner' },
  { name: /^(id|uuid|_id)$/i, value: 'tp-injected-id' },
];
/** The default fields when nothing else is known. */
const DEFAULT_MASS = ['role', 'isAdmin', 'verified', 'balance'];

/** The value a privileged field name gets, or undefined when the name is not one the catalogue knows. */
function massFieldValue(name: string): unknown {
  if (!/^[A-Za-z_][\w]{0,40}$/.test(name)) return undefined;
  return MASS_FIELDS.find((f) => f.name.test(name))?.value;
}

const allowedVerb = (method: string, o: { includeWrite: boolean; includeDelete: boolean }): boolean =>
  READ.test(method) || (WRITE.test(method) && o.includeWrite) || (/^DELETE$/i.test(method) && o.includeDelete);

const endpointKey = (n: Saved): string =>
  n.kind === 'http'
    ? `${n.request.method.toUpperCase()} ${segmentsOf(n.request.url)
        .map((s) => (isValueSegment(s) ? '*' : s))
        .join('/')}`
    : n.name;

/** A request names one object: an id in its path, or an `id`-like query parameter. */
function hasObjectId(n: Extract<Saved, { kind: 'http' }>): boolean {
  if (segmentsOf(n.request.url).some(isValueSegment)) return true;
  return (n.request.params ?? []).some((p) => p.enabled !== false && /(^|_)id$/i.test(p.key));
}

const jsonBodyOf = (n: Extract<Saved, { kind: 'http' }>): Record<string, unknown> | undefined => {
  const b = n.request.body as { type?: string; content?: string } | undefined;
  if (!b || b.type !== 'json' || typeof b.content !== 'string') return undefined;
  try {
    const v = JSON.parse(b.content);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Whether the request sends credentials: its own or inherited auth, or an Authorization-like header. */
const hasCredentials = (n: Extract<Saved, { kind: 'http' }>, auth: AuthConfig | undefined): boolean =>
  (!!auth && auth.type !== 'none' && auth.type !== 'inherit') || (n.request.headers ?? []).some((h) => h.enabled !== false && CRED_HEADER.test(h.key));

/** A JSONPath into a body that a marker may be read from: plain keys and indexes only. */
const MARKER_PATH = /^\$(\.[A-Za-z_][\w-]*|\[\d+\]|\['[^'\]]+'\])+$/;

/** A value in the saved example's response that identifies the owner's data (an email, a name, a title), when there is one. */
function exampleMarker(n: Extract<Saved, { kind: 'http' }>): string | undefined {
  const ex = (n.examples ?? []).find((e) => e.status < 400 && e.body);
  if (!ex) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(ex.body);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  // names that identify a person or a thing, before ids
  for (const k of ['email', 'username', 'name', 'title', 'phone', 'address', 'id']) {
    const v = (body as Record<string, unknown>)[k];
    if ((typeof v === 'string' && v.length >= 3) || typeof v === 'number') return `$.${k}`;
  }
  return undefined;
}

/** Whether a marker path reads a plain, non-trivial value in the request's saved example (the only way to prove it on this computer). */
function markerHolds(n: Extract<Saved, { kind: 'http' }>, path: string): boolean {
  if (!MARKER_PATH.test(path)) return false;
  const ex = (n.examples ?? []).find((e) => e.status < 400 && e.body);
  if (!ex) return false;
  try {
    const body = JSON.parse(ex.body);
    if (!exists(body, path)) return false;
    const v = query(body, path);
    const x = Array.isArray(v) ? v[0] : v;
    return (typeof x === 'string' && x.length >= 3) || typeof x === 'number';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the deterministic draft */

/**
 * The probes TestPion makes without a model (see the module comment). A probe it cannot make is listed in `skipped` with
 * the reason (no two principals, a write verb not asked for …), so a short file is never a silent one.
 */
function deterministicProbes(requests: Array<{ node: Saved; auth?: AuthConfig }>, o: SecurityLocal['options']): { probes: SecurityPlanProbe[]; skipped: string[] } {
  const probes: SecurityPlanProbe[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const two = !!o.identities.owner && !!o.identities.other;
  const want = new Set(o.probes);
  let needsPrincipals = false;
  let writeSkipped = 0;
  let deleteSkipped = 0;
  for (const { node, auth } of requests) {
    if (node.kind !== 'http') continue;
    const method = node.request.method.toUpperCase();
    const key = endpointKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!allowedVerb(method, o)) {
      if (/^DELETE$/i.test(method)) deleteSkipped++;
      else writeSkipped++;
      continue;
    }
    if (want.has('bola') && hasObjectId(node)) {
      if (two) probes.push({ kind: 'bola', request: node.id, ...(exampleMarker(node) ? { ownerField: exampleMarker(node) } : {}) });
      else needsPrincipals = true;
    }
    if (want.has('auth') && hasCredentials(node, auth)) probes.push({ kind: 'auth', request: node.id });
    if (want.has('mass-assignment') && WRITE.test(method) && jsonBodyOf(node)) probes.push({ kind: 'mass-assignment', request: node.id, fields: DEFAULT_MASS });
    if (want.has('bfla') && (PRIVILEGED.test(segmentsOf(node.request.url).join('/')) || /^DELETE$/i.test(method))) {
      if (o.identities.other) probes.push({ kind: 'bfla', request: node.id });
      else needsPrincipals = true;
    }
  }
  if (needsPrincipals) skipped.push('BOLA and BFLA probes need two principals: name the variables that hold their credentials (--identities owner=tokenA,other=tokenB).');
  if (writeSkipped) skipped.push(`${writeSkipped} POST / PUT / PATCH request${writeSkipped === 1 ? '' : 's'} not probed: they change data (ask for write probes to include them).`);
  if (deleteSkipped) skipped.push(`${deleteSkipped} DELETE request${deleteSkipped === 1 ? '' : 's'} not probed: they destroy data (ask for delete probes to include them).`);
  return { probes, skipped };
}

/* ------------------------------------------------------------------ the file */

const clone = jsonClone;

type Principal = { var: string } | 'none' | 'invalid';

/** The saved request as a probe step: the same method, URL, params and body; the credentials are the principal's. */
function probeStep(node: Extract<Saved, { kind: 'http' }>, auth: AuthConfig | undefined, who: Principal | 'keep', head: Record<string, unknown>): Record<string, unknown> {
  const base = clone(stepFromSavedRequest(node)) as { request?: Record<string, unknown> };
  const req: Record<string, unknown> = base.request && typeof base.request === 'object' ? base.request : {};
  delete req.auth;
  delete req.cookies;
  if (req.headers && typeof req.headers === 'object')
    for (const k of Object.keys(req.headers as object)) if (CRED_HEADER.test(k)) delete (req.headers as Record<string, unknown>)[k];
  if (req.params && typeof req.params === 'object' && !Array.isArray(req.params))
    for (const k of Object.keys(req.params as object)) if (CRED_PARAM.test(k)) delete (req.params as Record<string, unknown>)[k];
  const apiKey = auth && auth.type === 'apiKey' ? auth : undefined;
  if (who === 'keep') {
    if (auth && auth.type !== 'none' && auth.type !== 'inherit') req.auth = auth;
  } else if (who === 'invalid') req.auth = { type: 'bearer', token: INVALID_TOKEN };
  else if (who !== 'none') req.auth = apiKey ? { type: 'apiKey', key: apiKey.key, value: `{{${who.var}}}`, in: apiKey.in } : { type: 'bearer', token: `{{${who.var}}}` };
  if (head.body !== undefined) req.body = head.body;
  const { body: _b, ...rest } = head;
  const out: Record<string, unknown> = { ...rest, type: 'http', request: Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined && !(v && typeof v === 'object' && !Object.keys(v).length))) };
  return out;
}

const route = (n: Extract<Saved, { kind: 'http' }>) => `${n.request.method.toUpperCase()} ${segmentsOf(n.request.url).join('/') ? '/' + segmentsOf(n.request.url).join('/') : '/'}`;

/** What a built file says it contains: the steps a verifier can compare the YAML with. */
interface SecurityExpected {
  steps: Array<{ id: string; method: string; url: string; probe: SecurityProbe }>;
}

interface BuiltSecurity {
  yaml: string;
  probes: number;
  steps: number;
  byKind: Partial<Record<SecurityProbe, number>>;
  notes: string[];
  expected: SecurityExpected;
}

/** The test file of a plan, built from the saved requests and the catalogue (see the module comment). */
function buildSecurityFile(plan: SecurityPlan, local: SecurityLocal, o: { by: string; ai: boolean }): BuiltSecurity {
  const notes: string[] = [];
  const ids = local.options.identities;
  const steps: Array<Record<string, unknown>> = [];
  const expected: SecurityExpected['steps'] = [];
  const byKind: Partial<Record<SecurityProbe, number>> = {};
  const seen = new Set<string>();
  const want = new Set(local.options.probes);
  let n = 0;
  const add = (probe: SecurityProbe, node: Extract<Saved, { kind: 'http' }>, step: Record<string, unknown>) => {
    steps.push(step);
    expected.push({ id: String(step.id), method: node.request.method.toUpperCase(), url: node.request.url, probe });
  };
  for (const p of Array.isArray(plan?.probes) ? plan.probes : []) {
    if (!p || typeof p !== 'object') continue;
    if (n >= local.options.max) {
      notes.push(`Stopped at ${local.options.max} probes (the most per file): ask for fewer requests or raise the limit.`);
      break;
    }
    const kind = p.kind;
    if (!(SECURITY_PROBES as readonly string[]).includes(kind) || !want.has(kind)) {
      notes.push(`Dropped a probe of kind "${String(kind)}": the catalogue has ${local.options.probes.join(', ')}.`);
      continue;
    }
    const r = local.requests[String(p.request)];
    if (!r || r.node.kind !== 'http') {
      notes.push(`Dropped ${kind} probe: request "${String(p.request)}" is not an HTTP request of ${local.label}.`);
      continue;
    }
    const node = r.node;
    const method = node.request.method.toUpperCase();
    if (!allowedVerb(method, local.options)) {
      notes.push(`Dropped ${kind} probe of ${route(node)}: ${method} changes or destroys data and was not asked for.`);
      continue;
    }
    const dup = `${kind}|${endpointKey(node)}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    const label = `${SECURITY_CATALOGUE[kind].owasp} ${KIND_NAME[kind]}`;
    const where = route(node);
    const stem = `sec-${n + 1}-${kind}`;
    if (kind === 'bola' || kind === 'bfla') {
      if (!ids.owner || !ids.other) {
        notes.push(`Dropped ${kind} probe of ${where}: it needs two principals (the variables that hold the owner's and the other user's credentials).`);
        continue;
      }
    }
    if (kind === 'bola') {
      if (!hasObjectId(node)) {
        notes.push(`Dropped bola probe of ${where}: the request names no object (no id in its path or query).`);
        continue;
      }
      // the marker: what the owner's response holds that the other user's must not (verified on the saved example, else left out)
      let marker = typeof p.ownerField === 'string' ? p.ownerField.trim() : '';
      if (marker && !markerHolds(node, marker)) {
        notes.push(`${where}: "${marker}" is not a plain value in the saved example, so only the status decides.`);
        marker = '';
      }
      const mvar = `secMarker${n + 1}`;
      add(kind, node, probeStep(node, r.auth, { var: ids.owner! }, { id: `${stem}-owner`, name: `${label} setup: owner reads ${where}`, ...(marker ? { extract: { [mvar]: marker } } : {}), assertions: [{ type: 'status', expected: '2xx', name: `${label} setup: the owner can read it` }] }));
      const checks: CheckConfig[] = [{ type: 'status', expected: DENIED_OBJECT, name: `${label}: another user is refused (401, 403 or 404)` }];
      if (marker) checks.push({ type: 'not-contains', expected: `{{${mvar}}}`, name: `${label}: another user does not see the owner's data` });
      add(kind, node, probeStep(node, r.auth, { var: ids.other! }, { id: `${stem}-other`, name: `${label}: other user ${where}`, dependsOn: [`${stem}-owner`], assertions: checks }));
    } else if (kind === 'auth') {
      if (!hasCredentials(node, r.auth)) {
        notes.push(`Dropped auth probe of ${where}: the request sends no credentials, so there is nothing to remove.`);
        continue;
      }
      add(kind, node, probeStep(node, r.auth, 'none', { id: `${stem}-none`, name: `${label}: no credentials ${where}`, assertions: [{ type: 'status', expected: DENIED_FUNCTION, name: `${label}: no credentials are refused (401 or 403)` }] }));
      add(kind, node, probeStep(node, r.auth, 'invalid', { id: `${stem}-invalid`, name: `${label}: invalid token ${where}`, assertions: [{ type: 'status', expected: DENIED_FUNCTION, name: `${label}: an invalid token is refused (401 or 403)` }] }));
    } else if (kind === 'mass-assignment') {
      const body = jsonBodyOf(node);
      if (!WRITE.test(method) || !body) {
        notes.push(`Dropped mass-assignment probe of ${where}: it needs a POST, PUT or PATCH with a JSON object body.`);
        continue;
      }
      const picked = [...new Set((Array.isArray(p.fields) && p.fields.length ? p.fields : DEFAULT_MASS).map(String))].slice(0, 6);
      const fields = picked.filter((f) => massFieldValue(f) !== undefined);
      for (const f of picked.filter((x) => !fields.includes(x))) notes.push(`${where}: "${f}" is not a privileged field name the catalogue knows, so it is not sent.`);
      if (!fields.length) continue;
      const merged: Record<string, unknown> = { ...body };
      for (const f of fields) merged[f] = massFieldValue(f);
      add(
        kind,
        node,
        probeStep(node, r.auth, ids.owner ? { var: ids.owner } : 'keep', {
          id: stem,
          name: `${label}: ${fields.join(', ')} ${where}`,
          body: { type: 'json', content: JSON.stringify(merged, null, 2) },
          assertions: fields.map((f) => ({ type: 'not-equals', path: `$.${f}`, expected: massFieldValue(f), name: `${label}: ${f} is not accepted` })),
        }),
      );
    } else {
      add(kind, node, probeStep(node, r.auth, { var: ids.other! }, { id: stem, name: `${label}: lower-privilege user ${where}`, assertions: [{ type: 'status', expected: DENIED_FUNCTION, name: `${label}: a lower-privilege user is refused (401 or 403)` }] }));
    }
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    n++;
  }
  if (!steps.length)
    throw new ApsError('ValidationError', `No probe could be made from ${local.label}`, {
      why: [...local.skipped, ...notes].slice(0, 4).join(' ') || 'The requests offer nothing to probe with the options given.',
      suggestions: ['Name the two principals (--identities owner=tokenA,other=tokenB), or allow write / delete probes, or pick a folder with GET requests that name an object.'],
    });
  const pace = `${Math.max(1, Math.round(1000 / Math.max(0.1, local.options.rate)))}ms`;
  // the collection's variables the steps use (a patient id, a page size) travel with the file, unless the environment has them
  const used = new Set(templateVariables(templatedText(steps)));
  const carried = Object.fromEntries(Object.entries(local.collectionVars).filter(([k]) => used.has(k) && !local.envKeys.includes(k)));
  if (Object.keys(carried).length) notes.push(`The file carries the collection variables its steps use (${Object.keys(carried).join(', ')}) in defaults.vars: an environment variable of the same name wins.`);
  const head = [
    o.ai
      ? `# AI-assisted security tests (OWASP API Security Top 10) by TestPion (${o.by}) from ${local.label}: the model chose what to probe; the verdicts are the checks below.`
      : `# Security tests (OWASP API Security Top 10) made by TestPion without AI from ${local.label}.`,
    '# Authorised testing only: run them against an environment you own and may test, never production.',
    `# Every step is paced (${pace}); BOLA and BFLA steps need ${ids.owner && ids.other ? `{{${ids.owner}}} and {{${ids.other}}}` : 'two principals'}. Run: testpion security run <this file> -e <environment>`,
    '',
  ].join('\n');
  const yaml =
    head +
    stringifyYaml(
      { name: `Security: ${local.label}`, defaults: { pace, tags: ['security'], ...(Object.keys(carried).length ? { vars: carried } : {}) }, tests: steps },
      { lineWidth: 0, aliasDuplicateObjects: false },
    );
  return { yaml, probes: n, steps: steps.length, byKind, notes, expected: { steps: expected } };
}

/* ------------------------------------------------------------------ the task */

export const SECURITY_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['probes'],
  properties: {
    summary: { type: 'string', description: 'What the probes cover, one or two sentences' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'What you assumed that the context does not say (which user owns the saved objects, which paths are admin only)' },
    identities: {
      type: 'object',
      description: 'Only when context.identities is empty: the variables (from context.variables) that hold the credentials of the owner of the saved objects and of another user',
      properties: { owner: { type: 'string' }, other: { type: 'string' } },
    },
    probes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'request'],
        properties: {
          kind: { type: 'string', enum: [...SECURITY_PROBES], description: 'One of the catalogue (context.catalogue); nothing else exists' },
          request: { type: 'string', description: 'The id of a request in context.requests (never invented)' },
          ownerField: { type: 'string', description: 'bola: a JSONPath into the owner\'s response that identifies their data, e.g. $.email' },
          fields: { type: 'array', items: { type: 'string' }, description: 'mass-assignment: privileged field names to add (role, isAdmin, balance …)' },
          why: { type: 'string', description: 'Why this request is worth this probe' },
        },
      },
    },
  },
};

const VAR_NAME = /^[A-Za-z_][\w.-]{0,80}$/;

/** `owner=tokenA,other=tokenB` (or `tokenA,tokenB`): the principals' variables, from the CLI / MCP / RPC. */
function parseIdentities(v: unknown): SecurityIdentities | undefined {
  if (!v) return undefined;
  let owner: string | undefined;
  let other: string | undefined;
  if (typeof v === 'string') {
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    const kv = parts.map((p) => /^(owner|other)\s*[=:]\s*(.+)$/.exec(p));
    if (kv.every(Boolean) && kv.length) for (const m of kv) m![1] === 'owner' ? (owner = m![2]!.trim()) : (other = m![2]!.trim());
    else [owner, other] = parts;
  } else if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    owner = typeof o.owner === 'string' ? o.owner : undefined;
    other = typeof o.other === 'string' ? o.other : undefined;
  }
  for (const [k, x] of [['owner', owner], ['other', other]] as const)
    if (x && !VAR_NAME.test(x.replace(/^\{\{|\}\}$/g, '')))
      throw new ApsError('ValidationError', `The ${k} identity "${x}" is not a variable name`, { suggestions: ['Name the variable that holds the credentials (tokenA), never the credentials themselves.'] });
  const clean = (x?: string) => x?.replace(/^\{\{\s*|\s*\}\}$/g, '').trim() || undefined;
  const out = { owner: clean(owner), other: clean(other) };
  return out.owner || out.other ? out : undefined;
}

/** Options from the context a caller passes (`context.options`), checked. */
function securityOptions(raw: Record<string, unknown> | undefined): SecurityLocal['options'] & { allowProduction: boolean } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const probes = (Array.isArray(o.probes) ? o.probes : typeof o.probes === 'string' ? o.probes.split(',') : [])
    .map((x) => String(x).trim())
    .filter(Boolean) as SecurityProbe[];
  const bad = probes.filter((p) => !(SECURITY_PROBES as readonly string[]).includes(p));
  if (bad.length) throw new ApsError('ValidationError', `Unknown probe ${bad.join(', ')}: use ${SECURITY_PROBES.join(', ')}`);
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    probes: probes.length ? probes : [...SECURITY_PROBES],
    identities: parseIdentities(o.identities) ?? {},
    includeWrite: o.includeWrite === true,
    includeDelete: o.includeDelete === true,
    rate: num(o.rate, SECURITY_DEFAULTS.rate, 0.1, 50),
    max: Math.round(num(o.max, SECURITY_DEFAULTS.max, 1, 200)),
    ...(typeof o.environment === 'string' && o.environment.trim() ? { environment: o.environment.trim() } : {}),
    allowProduction: o.allowProduction === true,
  };
}

/** A production environment is refused for security tests (they send other users' and no credentials), unless the caller consents. */
export function assertNotProduction(store: Pick<WorkspaceStore, 'listEnvironments'>, environment: string | undefined, allowProduction: boolean | undefined): void {
  if (!environment) return;
  const env = findEnvironment(store, environment);
  if (!env?.isProduction || allowProduction) return;
  throw new ApsError('ConfigurationError', `"${env.name}" is a production environment: security tests are refused there`, {
    why: 'They send requests without credentials, with invalid ones and as another user, and may change data; environments marked as production are not probed unless you allow it.',
    suggestions: ['Generate and run them against a test or staging environment.', 'CLI: --allow-production; MCP: allowProduction: true; only when you own the system and accept the risk.'],
    details: { code: 'SECURITY_PRODUCTION' },
  });
}

/** The task's own context for a collection or folder (registry `prepare`). */
export function prepareSecurityContext(store: WorkspaceStore, ref: ItemRef, o: { path?: string; context?: Record<string, unknown> } = {}): PreparedItem {
  if (ref.kind !== 'collection' && ref.kind !== 'folder')
    throw new ApsError('ValidationError', `Security tests are made from a collection or a folder, not a ${ref.kind}`, { suggestions: ['Pass collection:<id> or folder:<collectionId>:<folderId>.'] });
  const options = securityOptions(o.context?.options as Record<string, unknown> | undefined);
  assertNotProduction(store, options.environment, options.allowProduction);
  const c = store.getCollection(ref.collectionId);
  const src = sourceRequests(c, ref.kind === 'folder' ? ref.folderId : undefined);
  const http = src.list.filter((r) => r.node.kind === 'http');
  if (!http.length) throw new ApsError('ConfigurationError', `${src.label} has no HTTP requests to probe`, { suggestions: ['Add requests to it, or pick a folder that has some.'] });
  const known = new Set<string>(c.variables.map((v) => v.key));
  if (options.environment) for (const v of findEnvironment(store, options.environment)?.variables ?? []) known.add(v.key);
  const { probes: draft, skipped } = deterministicProbes(http, options);
  // the requests the model may choose from: the ones with something to probe first, then the rest (at most 40)
  const chosen = new Set(draft.map((d) => d.request));
  const sent = [...http.filter((r) => chosen.has(r.node.id)), ...http.filter((r) => !chosen.has(r.node.id))].slice(0, 40);
  const local: SecurityLocal = {
    label: src.label,
    collectionId: c.id,
    ...(ref.kind === 'folder' ? { folderId: ref.folderId } : {}),
    ref,
    requests: Object.fromEntries(http.map((r) => [r.node.id, { node: r.node, auth: r.auth }])),
    options: { probes: options.probes, identities: options.identities, includeWrite: options.includeWrite, includeDelete: options.includeDelete, rate: options.rate, max: options.max, environment: options.environment },
    known: [...known],
    collectionVars: Object.fromEntries(c.variables.filter((v) => v.enabled !== false && v.key && !/secret|token|password|passwd|api[_-]?key|credential/i.test(v.key)).map((v) => [v.key, String(v.value ?? '')])),
    envKeys: options.environment ? (findEnvironment(store, options.environment)?.variables ?? []).map((v) => v.key) : [],
    draft,
    skipped,
    path: o.path?.trim() ? proposedTestFilePath(store, o.path) : freePath(store, `security/${slugify(src.label.replace(/ \/ /g, '-'))}`),
  };
  return {
    label: src.label,
    collection: c,
    path: local.path,
    local,
    context: {
      source: { collection: c.name, ...(src.folder ? { folder: src.label.split(' / ').slice(1).join(' / ') } : {}), requests: http.length, ...(sent.length < http.length ? { sampled: `${sent.length} of ${http.length} requests sent` } : {}) },
      requests: sent.map(requestContext),
      draft: { probes: draft.map((d) => ({ kind: d.kind, request: d.request })), skipped },
      catalogue: Object.fromEntries(SECURITY_PROBES.map((k) => [k, SECURITY_CATALOGUE[k].text])),
      identities: options.identities,
      options: { includeWrite: options.includeWrite, includeDelete: options.includeDelete, probes: options.probes },
      ...(known.size ? { variables: [...known].filter((k) => !k.startsWith('$')).slice(0, 200) } : {}),
    },
  };
}

/** The principals the plan may use: the caller's, else the plan's when both are variables the workspace has. */
function planIdentities(plan: SecurityPlan, local: SecurityLocal, notes: string[]): SecurityLocal {
  if (local.options.identities.owner && local.options.identities.other) return local;
  const asked = plan.identities;
  if (!asked) return local;
  const ok = (v?: string) => !!v && VAR_NAME.test(v) && local.known.includes(v);
  const owner = local.options.identities.owner ?? (ok(asked.owner) ? asked.owner : undefined);
  const other = local.options.identities.other ?? (ok(asked.other) ? asked.other : undefined);
  for (const [k, v] of [['owner', asked.owner], ['other', asked.other]] as const) if (v && !ok(v) && !local.options.identities[k]) notes.push(`The model named "${v}" for the ${k}, which is not a variable of this workspace: ignored.`);
  if (owner && other && owner === other) {
    notes.push('The owner and the other user are the same variable, so BOLA and BFLA are not probed.');
    return local;
  }
  return { ...local, options: { ...local.options, identities: { owner, other } } };
}

function securityItem(local: SecurityLocal, built: BuiltSecurity, o: { ai: boolean }): DraftItem {
  return {
    kind: 'flow',
    title: `tests/${local.path}`,
    path: local.path,
    after: built.yaml,
    language: 'yaml',
    target: { kind: 'flow', path: local.path },
    data: { security: { expected: built.expected, byKind: built.byKind, probes: built.probes, ai: o.ai, options: local.options }, source: local.ref, known: local.known, notes: built.notes },
  };
}

/** The proposal item of a plan (registry `propose`). */
export function proposeSecurity(a: { value?: unknown }, input: AiTaskInput): { items: DraftItem[]; notes: string[] } {
  const base = input.local as SecurityLocal | undefined;
  if (!base) throw new ApsError('ValidationError', 'Security tests need the collection or folder they are made from');
  const planNotes: string[] = [];
  const plan = (a.value ?? { probes: [] }) as SecurityPlan;
  const local = planIdentities(plan, base, planNotes);
  const built = buildSecurityFile(plan, local, { by: input.model, ai: true });
  return { items: [securityItem(local, built, { ai: true })], notes: [...planNotes, ...built.notes] };
}

/** The summary, assumptions and notes of the proposal (registry `describe`). */
export function describeSecurity(value: unknown, items: ProposalItem[]): ProposalDescription {
  const v = (value ?? {}) as SecurityPlan;
  const s = (items[0]?.data as { security?: { byKind: Partial<Record<SecurityProbe, number>>; probes: number } } | undefined)?.security;
  const counts = s ? Object.entries(s.byKind).map(([k, n]) => `${n} ${SECURITY_CATALOGUE[k as SecurityProbe].owasp} ${k}`) : [];
  return {
    summary: [typeof v.summary === 'string' ? v.summary : '', s ? `${s.probes} probes (${counts.join(', ')}). Verdicts are checks computed from the responses; run them against a test environment.` : ''].filter(Boolean).join(' '),
    assumptions: stringList(v.assumptions, 12),
  };
}

/* ------------------------------------------------------------------ verification */

/**
 * The file is the one that was built: every step is one of the expected probe steps (same method, same URL), the verbs
 * are the ones asked for, every step is paced, no literal credential is in it. A hand-edited file that adds a request,
 * a destructive verb or a real token fails here, before it is offered.
 */
registerVerifier('security-tests', (item) => {
  const sec = (item.data as { security?: { expected: SecurityExpected; options: SecurityLocal['options'] } } | undefined)?.security;
  if (!sec || (item.kind !== 'flow' && item.kind !== 'file')) return undefined;
  const problems: string[] = [];
  const parsed = tryParseYaml(item.after);
  if (!parsed.ok) return undefined; // the test-file verifier says why
  const d = parsed.value as { defaults?: Record<string, unknown>; tests?: Array<Record<string, unknown>> } | null;
  const tests = Array.isArray(d?.tests) ? d!.tests! : [];
  if (!tests.length) return undefined;
  const byId = new Map(sec.expected.steps.map((s) => [s.id, s]));
  for (const t of tests) {
    const id = String(t.id ?? '');
    const exp = byId.get(id);
    const req = (t.request && typeof t.request === 'object' ? t.request : t) as Record<string, unknown>;
    const method = String(req.method ?? 'GET').toUpperCase();
    const url = String(req.url ?? '');
    if (!exp) problems.push(`step "${id || t.name}" is not one of the probes TestPion built`);
    else if (exp.method !== method || !sameEndpoint(exp.url, url)) problems.push(`step "${id}" calls ${method} ${url}, not ${exp.method} ${exp.url}`);
    if (!allowedVerb(method, sec.options)) problems.push(`step "${id}": ${method} ${WRITE.test(method) ? 'changes' : 'destroys'} data and was not asked for`);
    if (!t.pace && !d?.defaults?.pace) problems.push(`step "${id}" is not paced (pace:)`);
  }
  if (tests.length > sec.options.max * 2) problems.push(`${tests.length} steps: more than the ${sec.options.max} probes allowed`);
  if (/(?:Bearer\s+|token:\s*|password:\s*|apikey:\s*|value:\s*)(?!\{\{|tp-invalid-token)["']?[A-Za-z0-9._~+/=-]{24,}/i.test(item.after)) problems.push('a literal credential is in the file: use {{variables}}');
  return problems.length
    ? { verifier: 'security-tests', status: 'fail', label: `${problems.length} safety problem${problems.length === 1 ? '' : 's'}`, detail: problems.slice(0, 8).join('\n') }
    : {
        verifier: 'security-tests',
        status: 'pass',
        label: `${sec.expected.steps.length} steps · saved requests only · ${sec.options.includeWrite || sec.options.includeDelete ? 'writes asked for' : 'read-only'} · paced`,
      };
});

export const SECURITY_VERIFIERS = ['test-file', 'security-tests'];

/* ------------------------------------------------------------------ without a model */

/** TestPion's own probes as a proposal, without any model (no AI set up, or asked for). */
export async function draftSecurityProposal(store: WorkspaceStore, ref: ItemRef, o: { options?: Record<string, unknown>; path?: string; surface: AiSurface; reason?: string }): Promise<Proposal> {
  const prepared = prepareSecurityContext(store, ref, { path: o.path, context: { options: o.options } });
  const local = prepared.local as SecurityLocal;
  const built = buildSecurityFile({ probes: local.draft }, local, { by: 'TestPion', ai: false });
  const item: ProposalItem = { ...securityItem(local, built, { ai: false }), id: 'i1', verification: [], selected: true };
  try {
    item.before = store.readTestFile(local.path);
  } catch {
    /* a new file */
  }
  await verifyItems([item], SECURITY_VERIFIERS, {} as VerifyContext);
  return saveDraftProposal(store, {
    task: 'security-tests',
    title: `Security tests (no AI): ${local.label}`,
    summary: `${built.probes} probes TestPion makes without a model from ${local.label}: ${Object.entries(built.byKind)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ')}.`,
    notes: [o.reason ?? 'No AI model is set up: these are the probes TestPion makes itself.', ...local.skipped, ...built.notes],
    items: [item],
    model: 'no AI (deterministic probes)',
    surface: o.surface,
    request: { item: ref, path: local.path },
  });
}
