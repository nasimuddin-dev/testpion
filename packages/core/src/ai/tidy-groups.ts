/** TestPion's own draft of a tidy plan: the noise of an import, the ids that repeat, the groups of requests by their path. See tidy-import.ts. */
import type { AuthConfig, Collection, KeyValue } from '../model/types.js';
import { tidyCollection } from '../storage/collection-tidy.js';
import { FlatRequest, Saved, TidyGroup, TidyOp, VAR_NAME, flatRequests, urlOf } from './tidy-ops.js';


/** Hosts whose requests are not the API's behaviour: analytics, ads, session recorders, error and performance beacons. */
const TRACKING_HOST =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|googletagservices\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|connect\.facebook\.com|hotjar\.(com|io)|segment\.(io|com)|mixpanel\.com|amplitude\.com|clarity\.ms|fullstory\.com|newrelic\.com|nr-data\.net|datadoghq\.com|browser-intake-datadoghq\.com|sentry\.io|bugsnag\.com|intercom\.(io|com)|hubspot\.com|hs-analytics\.net|optimizely\.com|scorecardresearch\.com|quantserve\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|heap(analytics)?\.(com|io)|logrocket\.(com|io)|crazyegg\.com|mouseflow\.com|statcounter\.com|plausible\.io|cloudflareinsights\.com|adservice\.google\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/i;

const STATIC_PATH = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf)$/i;

/** Why a request is noise for an API collection, or undefined. */
export function importNoiseReason(n: Saved): string | undefined {
  const url = urlOf(n);
  const method = n.kind === 'http' ? n.request.method.toUpperCase() : 'POST';
  let host = '';
  let path = '';
  try {
    const u = new URL(url.replace(/\{\{[^}]+\}\}/g, 'x'));
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* a template, not a URL */
  }
  if (host && TRACKING_HOST.test(host)) return `${host} is an analytics, advertising or monitoring service`;
  if (method === 'GET' && STATIC_PATH.test(path)) return `a static file (${path.split('/').pop()})`;
  if (method === 'OPTIONS') return 'a browser preflight request';
  return undefined;
}

export const originOf = (url: string): string | undefined => /^(https?:\/\/[^/?#\s{}]+)/i.exec(url.trim())?.[1];

export const looksLikeUrlName = (n: string): boolean => !n.trim() || /^https?:\/\//i.test(n.trim());

export const pathOf = (url: string): string => {
  const p = url.trim().replace(/^https?:\/\/[^/?#]*/i, '').replace(/^\{\{[^}]+\}\}/, '').split(/[?#]/)[0]!;
  return p || '/';
};

/** An id-like path segment or value: a number, a UUID, a hash, or a short word with digits (`ord-1`, `job_42`). */
const ID_LIKE = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{2,64})$/i;

export const singular = (w: string) => (/ies$/i.test(w) ? w.slice(0, -3) + 'y' : /s$/i.test(w) && !/ss$/i.test(w) ? w.slice(0, -1) : w);

export const camel = (w: string) => w.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''));

/** The JSON paths in a body where a value equals the literal. */
export function pathsOfValue(body: unknown, literal: string, prefix = '$', depth = 0): string[] {
  if (depth > 8) return [];
  if (body === null || body === undefined) return [];
  if (typeof body === 'string' || typeof body === 'number') return String(body) === literal ? [prefix] : [];
  if (Array.isArray(body)) return body.slice(0, 20).flatMap((v, i) => pathsOfValue(v, literal, `${prefix}[${i}]`, depth + 1));
  if (typeof body === 'object')
    return Object.entries(body as Record<string, unknown>)
      .slice(0, 60)
      .flatMap(([k, v]) => pathsOfValue(v, literal, /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `${prefix}.${k}` : `${prefix}['${k}']`, depth + 1));
  return [];
}

export const exampleBody = (e: { body: string }): unknown => {
  try {
    return JSON.parse(e.body);
  } catch {
    return undefined;
  }
};

/** The literal ids typed into the requests (path segments and query values) and where an earlier saved response returns them. */
export interface IdCandidate {
  literal: string;
  /** Requests that use it, in collection order. */
  usedBy: string[];
  /** The earlier request and path whose saved response holds it. */
  found?: { request: string; example: string; path: string; status: number };
  suggestedVariable: string;
}

export function idCandidates(reqs: FlatRequest[]): IdCandidate[] {
  const byLiteral = new Map<string, { users: number[]; hint: string }>();
  reqs.forEach((r, i) => {
    const url = urlOf(r.node);
    const segs = pathOf(url).split('/').filter(Boolean);
    segs.forEach((s, k) => {
      if (/^\{\{.*\}\}$|^:/.test(s) || !ID_LIKE.test(s)) return;
      // a version segment (v1, 2024) or a number that is part of the resource's name is not an id
      if (/^v\d+$/i.test(s)) return;
      const e = byLiteral.get(s) ?? { users: [], hint: segs[k - 1] ?? '' };
      if (!e.users.includes(i)) e.users.push(i);
      byLiteral.set(s, e);
    });
  });
  const out: IdCandidate[] = [];
  const names = new Set<string>();
  for (const [literal, e] of byLiteral) {
    let found: IdCandidate['found'];
    const first = Math.min(...e.users);
    for (let i = 0; i < first && !found; i++) {
      const n = reqs[i]!.node;
      if (n.kind !== 'http') continue;
      for (const ex of n.examples ?? []) {
        if (ex.status >= 400) continue;
        const hit = pathsOfValue(exampleBody(ex), literal)[0];
        if (hit) {
          found = { request: n.id, example: ex.name, path: hit, status: ex.status };
          break;
        }
      }
    }
    let name = `${camel(singular(e.hint) || 'resource')}Id`;
    for (let k = 2; names.has(name); k++) name = `${camel(singular(e.hint) || 'resource')}Id${k}`;
    names.add(name);
    out.push({ literal, usedBy: e.users.map((i) => reqs[i]!.node.id), ...(found ? { found } : {}), suggestedVariable: name });
  }
  // the ones a saved response confirms first
  return out.sort((a, b) => Number(!!b.found) - Number(!!a.found)).slice(0, 40);
}

/** Literal credentials typed into several requests: `Authorization: Bearer …` and bearer auth. */
function repeatedTokens(reqs: FlatRequest[]): Array<{ value: string; header: string; prefix: string; count: number }> {
  const counts = new Map<string, { header: string; prefix: string; value: string; ids: Set<string> }>();
  const add = (id: string, header: string, prefix: string, value: string) => {
    if (!value || /\{\{/.test(value) || value.length < 8) return;
    const k = `${header}\n${prefix}\n${value}`;
    const e = counts.get(k) ?? { header, prefix, value, ids: new Set<string>() };
    e.ids.add(id);
    counts.set(k, e);
  };
  for (const r of reqs) {
    const req = r.node.request as { headers?: KeyValue[]; auth?: AuthConfig };
    for (const h of req.headers ?? []) {
      if (h.enabled === false) continue;
      const m = /^(Bearer\s+)(\S+)$/i.exec(h.value);
      if (h.key.toLowerCase() === 'authorization' && m) add(r.node.id, 'Authorization', m[1]!, m[2]!);
      else if (/^(x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i.test(h.key)) add(r.node.id, h.key, '', h.value);
    }
    const a = req.auth;
    if (a?.type === 'bearer' && typeof a.token === 'string') add(r.node.id, 'Authorization', 'Bearer ', a.token);
  }
  return [...counts.values()].filter((e) => e.ids.size >= 2).map((e) => ({ value: e.value, header: e.header, prefix: e.prefix, count: e.ids.size }));
}

/** The groups TestPion finds without a model. */
export function draftGroups(c: Collection): { groups: TidyGroup[]; candidates: IdCandidate[]; taken: Set<string> } {
  const reqs = flatRequests(c);
  const taken = new Set((c.variables ?? []).map((v) => v.key));
  const reserve = (base: string): string => {
    let name = VAR_NAME.test(base) ? base : 'value';
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    return name;
  };
  const groups: TidyGroup[] = [];
  let n = 0;
  const gid = () => `g${++n}`;

  // noise, then duplicates (the first of each stays)
  const noise = reqs.flatMap((r) => {
    const why = importNoiseReason(r.node);
    return why ? [{ id: r.node.id, why }] : [];
  });
  if (noise.length)
    groups.push({
      id: gid(),
      kind: 'drop',
      title: `Drop ${noise.length} tracking, static or preflight request${noise.length === 1 ? '' : 's'}`,
      ops: noise.map((x) => ({ op: 'drop', id: x.id })),
      reason: [...new Set(noise.map((x) => x.why))].slice(0, 4).join('; '),
      source: 'draft',
    });
  const dropped = new Set(noise.map((x) => x.id));
  const dups = tidyCollection(c).filter((f) => f.kind === 'duplicate');
  const dupIds = dups.flatMap((f) => f.ids.slice(1)).filter((id) => !dropped.has(id));
  if (dupIds.length) groups.push({ id: gid(), kind: 'dedupe', title: `Remove ${dupIds.length} duplicate request${dupIds.length === 1 ? '' : 's'}`, ops: dupIds.map((id) => ({ op: 'drop', id })), reason: 'the same method, URL, headers and body as an earlier request', source: 'draft' });
  for (const id of dupIds) dropped.add(id);

  // names that are URLs
  const rename: TidyOp[] = [];
  for (const r of reqs)
    if (!dropped.has(r.node.id) && looksLikeUrlName(r.node.name)) rename.push({ op: 'rename', id: r.node.id, name: `${r.node.kind === 'http' ? r.node.request.method.toUpperCase() : 'GraphQL'} ${pathOf(urlOf(r.node))}`.slice(0, 80) });
  if (rename.length) groups.push({ id: gid(), kind: 'names', title: `Name ${rename.length} request${rename.length === 1 ? '' : 's'} that are named by their URL`, ops: rename, source: 'draft' });

  // hosts typed into URLs
  const kept = reqs.filter((r) => !dropped.has(r.node.id));
  const origins = new Map<string, number>();
  for (const r of kept) {
    const o = originOf(urlOf(r.node));
    if (o) origins.set(o.toLowerCase(), (origins.get(o.toLowerCase()) ?? 0) + 1);
  }
  const sorted = [...origins.entries()].sort((a, b) => b[1] - a[1]);
  sorted.forEach(([origin, count], i) => {
    if (count < 2 && sorted.length > 1) return;
    // an existing variable that already holds the origin is used as it is
    const existing = (c.variables ?? []).find((v) => v.value.toLowerCase() === origin);
    const name = existing?.key ?? reserve(i === 0 ? 'baseUrl' : `${camel(new URL(origin).hostname.split('.')[0] ?? 'api')}Url`);
    groups.push({ id: gid(), kind: 'host', title: `${origin} → {{${name}}} in ${count} request${count === 1 ? '' : 's'}`, ops: [{ op: 'host', origin, variable: name }], source: 'draft' });
  });

  // credentials typed into many requests
  for (const t of repeatedTokens(kept)) {
    const name = reserve(/authorization/i.test(t.header) ? 'token' : camel(t.header.replace(/^x-/i, '')) || 'apiKey');
    groups.push({
      id: gid(),
      kind: 'token',
      title: `The ${/authorization/i.test(t.header) ? 'bearer token' : t.header} typed into ${t.count} requests → {{${name}}}`,
      ops: [{ op: 'token', variable: name, value: t.value, header: t.header, prefix: t.prefix }],
      reason: 'one variable to change when it is rotated; its value stays in the collection until you move it to an environment secret (Collections ▸ Move variables to environments)',
      source: 'draft',
    });
  }

  // ids an earlier saved response returns
  const candidates = idCandidates(kept);
  for (const k of candidates) {
    if (!k.found) continue;
    const to = k.usedBy.filter((id) => id !== k.found!.request && kept.findIndex((r) => r.node.id === id) > kept.findIndex((r) => r.node.id === k.found!.request));
    if (!to.length) continue;
    const from = kept.find((r) => r.node.id === k.found!.request)!;
    const variable = reserve(k.suggestedVariable);
    groups.push({
      id: gid(),
      kind: 'chain',
      title: `${variable}: ${from.node.name} → ${to.length} request${to.length === 1 ? '' : 's'}`,
      ops: [{ op: 'chain', variable, from: from.node.id, to, path: k.found.path, literal: k.literal }],
      source: 'draft',
      evidence: { confirmed: true, example: k.found.example, value: k.literal },
    });
  }
  return { groups, candidates, taken };
}

/* ------------------------------------------------------------------ the model's plan */
