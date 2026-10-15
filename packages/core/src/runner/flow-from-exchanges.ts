/**
 * Record a flow: exchanges the HTTP Debugger captured (or a HAR file's entries) become the steps of a flow file, in
 * the order they happened. Each step is the request as sent, with its origin as a {{baseUrl}} variable, the noise
 * headers a browser adds left out, and the values that flowed from an earlier response into it (a token, an id, a
 * cursor) replaced by {{variables}}: the producing step extracts them (a JSONPath, or a response header through a
 * script line) and the using step waits for it. Static assets, preflights and analytics are left out, and listed.
 * Secrets are never written: credentials and values the redactor knows become variables to set in an environment.
 * The Debugger's "Create flow from selection", `testpion flow from-har` and the flow_from_exchanges MCP tool share it.
 */
import type { DebuggerExchange } from '../debugger/proxy.js';
import { exchangesFromHar } from '../debugger/har.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import type { Redactor } from '../util/redact.js';
import { applyFlowEdit, type FlowStepInput } from './flow-edit.js';

/** What a recorded exchange needs to become a step (the Debugger's exchanges and a HAR file's entries both have it). */
export type FlowSourceExchange = Pick<DebuggerExchange, 'id' | 'method' | 'url' | 'startedAt' | 'requestHeaders'> &
  Partial<Pick<DebuggerExchange, 'requestBody' | 'status' | 'responseHeaders' | 'responseBody' | 'contentType' | 'kind' | 'error'>>;

/** Hosts whose requests are telemetry, not the API under test (a host matches itself and its subdomains). */
export const DEFAULT_NOISE_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'hotjar.io',
  'sentry.io',
  'nr-data.net',
  'newrelic.com',
  'datadoghq.com',
  'datadoghq.eu',
  'fullstory.com',
  'clarity.ms',
  'bat.bing.com',
  'connect.facebook.net',
  'intercom.io',
  'posthog.com',
  'heap.io',
  'heapanalytics.com',
  'launchdarkly.com',
  'optimizely.com',
  'cloudflareinsights.com',
  'plausible.io',
];

export interface FlowFromExchangesOptions {
  /** The flow's name (the file's `name:`). */
  name?: string;
  /** An environment to propose variables from: a variable whose value is an origin (or a secret) that was sent is used by name. */
  environment?: { name?: string; variables: Array<{ key: string; value?: string; enabled?: boolean; secret?: boolean }> };
  /** Values it knows are secrets (an environment's secrets, tokens it saw) become variables too. */
  redactor?: Redactor;
  /** Hosts to leave out as telemetry (default DEFAULT_NOISE_HOSTS); `extraNoiseHosts` adds to the default. */
  noiseHosts?: string[];
  extraNoiseHosts?: string[];
  /** Keep static assets, preflights and telemetry (only tunnels and failed exchanges are still left out). */
  keepNoise?: boolean;
  /** Exchanges (by id) to leave out (the dialog's unticked steps). */
  drop?: string[];
  /** When the recording was made (the file's first comment); default now. */
  recordedAt?: string;
  /** Where it came from, for the comment: "the HTTP Debugger", "session.har". */
  source?: string;
}

/** A value that flowed from one step's response into a later step's request. */
export interface FlowLink {
  variable: string;
  /** The producing step: its id and its place (1 is the first step). */
  from: string;
  fromIndex: number;
  to: string;
  toIndex: number;
  /** Where it was read: a JSONPath ($.access_token), `header <name>`, or `cookie jar`. */
  source: string;
  /** Where it was used: `Authorization header`, `URL path`, `query cursor`, `body $.petId` … */
  target: string;
}

export interface FlowVariableNote {
  name: string;
  kind: 'origin' | 'secret';
  /** An origin's value (written in the file's defaults unless the environment has it); never a secret's. */
  value?: string;
  /** The environment already has it (the name was taken from there). */
  fromEnvironment?: boolean;
  /** Where the steps use it. */
  usedBy: string[];
  /** For secrets: what it stands for (`Authorization header`, `body $.password`). */
  what?: string;
}

export interface DroppedExchange {
  id: string;
  method: string;
  url: string;
  reason: string;
}

export interface RecordedStepSummary {
  id: string;
  name: string;
  method: string;
  url: string;
  exchangeId: string;
  status?: number;
  dependsOn: string[];
  extract: Record<string, string>;
  uses: string[];
}

export interface FlowFromExchangesResult {
  /** The flow file's YAML. */
  text: string;
  steps: RecordedStepSummary[];
  links: FlowLink[];
  variables: FlowVariableNote[];
  /** The secret variables to set in an environment before running (none of their values is in the file). */
  secrets: string[];
  dropped: DroppedExchange[];
  notes: string[];
}

/* ------------------------------------------------------------------ noise */

const STATIC_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|css|js|mjs|cjs|map|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|m4a|pdf|zip|wasm)$/i;
const STATIC_TYPE = /^(image|font|video|audio)\/|^text\/css|javascript|ecmascript|^application\/(font|x-font|wasm)/i;
const BROWSER_DEST = new Set(['document', 'image', 'style', 'script', 'font', 'iframe', 'frame', 'audio', 'video', 'manifest', 'worker', 'serviceworker', 'sharedworker', 'track', 'object', 'embed']);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Why an exchange is not a step, or undefined when it is one. */
export function noiseReason(e: FlowSourceExchange, opts: Pick<FlowFromExchangesOptions, 'noiseHosts' | 'extraNoiseHosts' | 'keepNoise'> = {}): string | undefined {
  if (e.kind === 'tunnel' || e.method === 'CONNECT') return 'an HTTPS tunnel (not decrypted)';
  if (e.kind === 'websocket') return 'a WebSocket (not an HTTP step)';
  let u: URL;
  try {
    u = new URL(e.url);
  } catch {
    return 'not a URL';
  }
  if (!/^https?:$/.test(u.protocol)) return `a ${u.protocol.replace(':', '')} URL`;
  if (e.status === undefined && e.error) return `no response (${e.error})`;
  if (opts.keepNoise) return undefined;
  const h = (k: string) => e.requestHeaders?.[k] ?? e.requestHeaders?.[k.toLowerCase()];
  if (e.method === 'OPTIONS') return 'a CORS preflight';
  const host = u.hostname.toLowerCase();
  const hosts = [...(opts.noiseHosts ?? DEFAULT_NOISE_HOSTS), ...(opts.extraNoiseHosts ?? [])].map((x) => x.toLowerCase().replace(/^\*\./, ''));
  if (hosts.some((x) => host === x || host.endsWith(`.${x}`))) return 'analytics / telemetry';
  if (STATIC_EXT.test(u.pathname)) return 'a static asset';
  const ct = (e.contentType ?? e.responseHeaders?.['content-type'] ?? '').toLowerCase();
  if (STATIC_TYPE.test(ct)) return 'a static asset';
  const dest = String(h('sec-fetch-dest') ?? '').toLowerCase();
  if (BROWSER_DEST.has(dest)) return `a browser ${dest} load`;
  if (e.method === 'GET' && /^text\/html/.test(ct)) return 'a web page';
  return undefined;
}

/* ------------------------------------------------------------------ helpers */

/** Headers a step never needs: hop-by-hop, set by the HTTP client, or a browser's fingerprint. */
const NOISE_HEADER =
  /^(:.*|host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|accept-encoding|accept-language|user-agent|sec-.*|origin|referer|dnt|upgrade-insecure-requests|pragma|cache-control|if-none-match|if-modified-since|priority|x-forwarded-.*|via|purpose|x-client-data)$/i;
/** Response headers that are never a value a later request uses. */
const PLAIN_RESPONSE_HEADER =
  /^(date|server|content-type|content-length|content-encoding|connection|keep-alive|vary|cache-control|expires|last-modified|age|pragma|transfer-encoding|set-cookie|access-control-.*|strict-transport-security|x-powered-by|x-content-type-options|x-frame-options|x-xss-protection|content-security-policy.*|referrer-policy|permissions-policy|alt-svc|report-to|nel|via|accept-ranges|timing-allow-origin|cross-origin-.*|x-ratelimit-.*|ratelimit-.*|retry-after|www-authenticate)$/i;
/** Values too common to be a value that flowed. */
const COMMON = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'application/json',
  'text/plain',
  'text/html',
  'application/xml',
  'utf-8',
  'bearer',
  'basic',
  'none',
  'ok',
  'success',
  'active',
  'enabled',
  'disabled',
  'default',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEY = /^(id|uuid|guid|key|.*[a-z0-9]Id|.*_id|.*Ids?|.*token|.*Token|.*_key|cursor|.*Cursor|.*_cursor|next|etag|location)$/;
/** A key that holds a credential (beyond the redactor's fields). */
const CREDENTIAL = /(pass(word)?|secret|token|api[-_]?key|apikey|auth|credential|session|signature|private[-_]?key)$/i;
/** Cookies a browser keeps for analytics, never part of an API flow. */
const ANALYTICS_COOKIE = /^(_ga.*|_gid|_gat.*|_fbp|_fbc|_hj.*|ajs_.*|mp_.*|amplitude.*|_clck|_clsk|_uetsid|_uetvid|intercom-.*|optimizely.*|ph_.*|__utm.*|_dd_s)$/i;

const camel = (s: string) =>
  s
    .replace(/^x-/i, '')
    .replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, (c) => c.toLowerCase())
    .replace(/^(\d)/, '_$1') || 'value';
const singular = (s: string) => (/ies$/i.test(s) ? s.slice(0, -3) + 'y' : /(ss|us)$/i.test(s) ? s : /s$/i.test(s) && s.length > 3 ? s.slice(0, -1) : s);
const headerName = (k: string) => k.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase());
const pathKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `['${k.replace(/'/g, "\\'")}']`);
const isTemplate = (s: string) => /^\{\{[^}]+\}\}$/.test(s);

/** A response value worth following: an id, a token, a uuid, a long number, a long string. */
function worth(v: unknown, key?: string): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) >= 1000 ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v;
  if (!s || s.length > 4096 || COMMON.has(s.toLowerCase())) return undefined;
  if (UUID.test(s) || /^\d{4,}$/.test(s)) return s;
  if (s.length >= 8) return s;
  // an id field may be shorter: job-7, a1b2
  if (key && ID_KEY.test(key) && s.length >= 4 && /[A-Za-z]/.test(s) && /\d|-|_/.test(s)) return s;
  return undefined;
}

interface Producer {
  step: number;
  /** $.path, or a header name. */
  source: { kind: 'json'; path: string } | { kind: 'header'; name: string };
  /** The suggested variable name. */
  name: string;
}

interface StepDraft {
  e: FlowSourceExchange;
  id: string;
  index: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  extract: Record<string, string>;
  scriptLines: string[];
  deps: Set<number>;
  uses: Set<string>;
}

/* ------------------------------------------------------------------ the conversion */

/** Exchanges (in any order: they are put in time order) as a flow file. */
export function flowFromExchanges(exchanges: FlowSourceExchange[], opts: FlowFromExchangesOptions = {}): FlowFromExchangesResult {
  const red = opts.redactor;
  const dropIds = new Set(opts.drop ?? []);
  const ordered = exchanges
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (Date.parse(a.e.startedAt) || 0) - (Date.parse(b.e.startedAt) || 0) || a.i - b.i)
    .map((x) => x.e);
  const dropped: DroppedExchange[] = [];
  const kept: FlowSourceExchange[] = [];
  const safeUrl = (u: string) => (red ? red.redactUrl(u) : u);
  for (const e of ordered) {
    const why = dropIds.has(e.id) ? 'left out' : noiseReason(e, opts);
    if (why) dropped.push({ id: e.id, method: e.method, url: safeUrl(e.url), reason: why });
    else kept.push(e);
  }
  if (!kept.length)
    throw new ApsError(
      'ValidationError',
      dropped.length ? `Nothing to record: all ${dropped.length} exchanges were left out (${[...new Set(dropped.map((d) => d.reason))].join(', ')})` : 'Nothing to record: no exchanges',
    );
  if (kept.length > 200) throw new ApsError('ValidationError', `${kept.length} exchanges: select at most 200 to make a flow of`);

  const envVars = (opts.environment?.variables ?? []).filter((v) => v.enabled !== false && typeof v.value === 'string' && v.value !== '');
  /** Variable names in use, with the value each stands for (a name is never reused for another value). */
  const names = new Map<string, string>();
  const claim = (base: string, value: string): string => {
    const b = /^[A-Za-z_][\w]*$/.test(base) ? base : camel(base);
    for (let n = 1; ; n++) {
      const name = n === 1 ? b : `${b}${n}`;
      const had = names.get(name);
      if (had === undefined || had === value) {
        names.set(name, value);
        return name;
      }
    }
  };
  for (const v of envVars) names.set(v.key, v.value!);

  /* origins: one variable each, the environment's when it has one with that value */
  const variables = new Map<string, FlowVariableNote>();
  const note = (name: string, n: Omit<FlowVariableNote, 'name' | 'usedBy'>, step: string) => {
    const cur = variables.get(name) ?? { name, ...n, usedBy: [] };
    if (!cur.usedBy.includes(step)) cur.usedBy.push(step);
    variables.set(name, cur);
  };
  const originCount = new Map<string, number>();
  for (const e of kept) {
    const o = new URL(e.url).origin;
    originCount.set(o, (originCount.get(o) ?? 0) + 1);
  }
  const bases = envVars
    .map((v) => ({ key: v.key, value: v.value!.replace(/\/+$/, '') }))
    .filter((v) => /^https?:\/\/[^/]+/i.test(v.value))
    .sort((a, b) => b.value.length - a.value.length);
  const originVar = new Map<string, string>();
  [...originCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([origin], i) => {
      const env = bases.find((b) => b.value.toLowerCase() === origin.toLowerCase());
      if (env) return void originVar.set(origin, env.key);
      let base = 'baseUrl';
      if (i > 0) {
        const host = new URL(origin).hostname;
        const label = /^[\d.]+$|^\[|^localhost$/i.test(host) ? '' : (host.split('.').find((x) => !['www', 'api', 'app'].includes(x.toLowerCase())) ?? '');
        base = label ? `${camel(label)}Url` : 'baseUrl2';
      }
      originVar.set(origin, claim(base, origin));
    });

  /* the steps */
  // ids are given once the URLs are written (below); links name steps by their place until then
  const drafts: StepDraft[] = kept.map((e, index) => ({ e, id: `#${index + 1}`, index, method: e.method.toUpperCase(), url: e.url, headers: {}, extract: {}, scriptLines: [], deps: new Set(), uses: new Set() }));

  const producers = new Map<string, Producer>();
  const links: FlowLink[] = [];
  /** Everything the requests so far sent (a value already sent came from the client, not from a response). */
  let sentSoFar = '';
  /** Cookies set by the responses so far: name → the step that set it last. */
  const cookieSetBy = new Map<string, number>();

  const varFor = (p: Producer, value: string): string => {
    const producer = drafts[p.step]!;
    const src = p.source;
    if (src.kind === 'json') {
      const had = Object.entries(producer.extract).find(([, path]) => path === src.path)?.[0];
      if (had) return had;
      const name = claim(p.name, value);
      producer.extract[name] = src.path;
      return name;
    }
    const line = producer.scriptLines.find((l) => l.endsWith(`get('${src.name}'));`));
    if (line) return /set\('([^']+)'/.exec(line)![1]!;
    const name = claim(p.name, value);
    producer.scriptLines.push(`tp.variables.set('${name}', tp.response.headers.get('${src.name}'));`);
    return name;
  };
  /** A request value: the variable of the response it came from (with the link), else undefined. */
  const flowed = (d: StepDraft, value: string, target: string): string | undefined => {
    const p = producers.get(value);
    if (!p || p.step >= d.index) return undefined;
    const name = varFor(p, value);
    d.deps.add(p.step);
    d.uses.add(name);
    const from = drafts[p.step]!;
    if (!links.some((l) => l.variable === name && l.to === d.id && l.target === target))
      links.push({ variable: name, from: from.id, fromIndex: p.step + 1, to: d.id, toIndex: d.index + 1, source: p.source.kind === 'json' ? p.source.path : `header ${p.source.name}`, target });
    return `{{${name}}}`;
  };
  /** A secret value: the environment's variable that holds it, else a new variable left for an environment. */
  const secret = (d: StepDraft, value: string, base: string, what: string): string => {
    const env = envVars.find((v) => v.value === value);
    if (env) {
      note(env.key, { kind: 'secret', fromEnvironment: true, what }, d.id);
      d.uses.add(env.key);
      return `{{${env.key}}}`;
    }
    const name = claim(camel(base), `\u0000secret:${value}`);
    note(name, { kind: 'secret', what }, d.id);
    d.uses.add(name);
    return `{{${name}}}`;
  };
  const knownSecret = (v: string) => !!red && v.length >= 4 && red.redactString(v) !== v;
  const sensitiveKey = (k: string) => (red ? red.isSensitiveKey(k) : false) || CREDENTIAL.test(k);
  /** Long produced values inside a longer text (a header, a text body, a URL segment). */
  const replaceInside = (d: StepDraft, text: string, target: string): string => {
    let out = text;
    const found = [...producers.entries()].filter(([v, p]) => v.length >= 12 && p.step < d.index && out.includes(v)).sort((a, b) => b[0].length - a[0].length);
    for (const [v] of found) if (out.includes(v)) out = out.split(v).join(flowed(d, v, target) ?? v);
    return out;
  };
  /** One value of a request: what flowed into it, a secret, or itself. */
  const valueOf = (d: StepDraft, v: string, key: string, target: string): string => {
    if (!v || isTemplate(v)) return v;
    const f = flowed(d, v, target);
    if (f) return f;
    if (sensitiveKey(key) || knownSecret(v)) return secret(d, v, key, target);
    return replaceInside(d, v, target);
  };

  for (const d of drafts) {
    const e = d.e;
    const u = new URL(e.url);
    const reqHeaders = Object.fromEntries(Object.entries(e.requestHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    sentSoFar += `\n${e.url}\n${Object.values(reqHeaders).join('\n')}\n${e.requestBody ?? ''}`;

    /* the URL: the whole URL, the path, path segments and query values that flowed */
    let urlOut: string;
    const whole = flowed(d, e.url, 'URL');
    const envBase = bases.find((b) => e.url.toLowerCase().startsWith(b.value.toLowerCase()) && /^([/?#]|$)/.test(e.url.slice(b.value.length)));
    if (whole) urlOut = whole;
    else {
      let prefix: string;
      let rest: string;
      if (envBase && envBase.value.toLowerCase() !== u.origin.toLowerCase()) {
        prefix = `{{${envBase.key}}}`;
        rest = e.url.slice(envBase.value.length);
        note(envBase.key, { kind: 'origin', fromEnvironment: true }, d.id);
      } else {
        const ov = originVar.get(u.origin)!;
        prefix = `{{${ov}}}`;
        rest = `${u.pathname}${u.search}`;
        const env = bases.some((b) => b.key === ov);
        note(ov, { kind: 'origin', ...(env ? { fromEnvironment: true } : { value: u.origin }) }, d.id);
      }
      const q = rest.indexOf('?');
      const pathPart = (q >= 0 ? rest.slice(0, q) : rest).replace(/#.*$/, '');
      const queryPart = q >= 0 ? rest.slice(q + 1).replace(/#.*$/, '') : '';
      // a path that came whole from a response (a Location header), unless its parts came from a body (an id)
      const earlier = (v: string) => (producers.get(v)?.step ?? Infinity) < d.index;
      const partsFlow = pathPart.split('/').some((s) => {
        try {
          return earlier(decodeURIComponent(s));
        } catch {
          return earlier(s);
        }
      });
      const fullPath = partsFlow ? undefined : (flowed(d, `${u.pathname}${u.search}`, 'URL path') ?? (queryPart ? undefined : flowed(d, u.pathname, 'URL path')));
      if (fullPath && !envBase) urlOut = `${prefix}${fullPath}`;
      else {
        const segs = pathPart.split('/').map((s) => {
          if (!s) return s;
          let dec = s;
          try {
            dec = decodeURIComponent(s);
          } catch {
            /* as sent */
          }
          return flowed(d, dec, 'URL path') ?? (knownSecret(dec) ? secret(d, dec, 'pathSecret', 'URL path') : replaceInside(d, s, 'URL path'));
        });
        const params = queryPart
          ? queryPart.split('&').map((pair) => {
              const i = pair.indexOf('=');
              const k = i >= 0 ? pair.slice(0, i) : pair;
              if (i < 0) return pair;
              let v = pair.slice(i + 1);
              try {
                v = decodeURIComponent(v.replace(/\+/g, ' '));
              } catch {
                /* as sent */
              }
              let key = k;
              try {
                key = decodeURIComponent(k);
              } catch {
                /* as sent */
              }
              const out = valueOf(d, v, key, `query ${key}`);
              return `${k}=${out === v ? pair.slice(i + 1) : out}`;
            })
          : [];
        urlOut = `${prefix}${segs.join('/')}${params.length ? `?${params.join('&')}` : ''}`;
      }
    }
    d.url = urlOut;

    /* headers */
    for (const [k, v] of Object.entries(reqHeaders)) {
      if (NOISE_HEADER.test(k)) continue;
      if (k === 'accept' && /text\/html/.test(v)) continue;
      if (k === 'cookie') {
        const pairs = v.split(/;\s*/).filter(Boolean);
        const rest: string[] = [];
        for (const p of pairs) {
          const name = p.slice(0, Math.max(0, p.indexOf('='))).trim();
          const by = cookieSetBy.get(name);
          if (by !== undefined && by < d.index) {
            d.deps.add(by);
            if (!links.some((l) => l.to === d.id && l.source === 'cookie jar' && l.from === drafts[by]!.id))
              links.push({ variable: `cookie ${name}`, from: drafts[by]!.id, fromIndex: by + 1, to: d.id, toIndex: d.index + 1, source: 'cookie jar', target: 'Cookie header' });
          } else if (!ANALYTICS_COOKIE.test(name)) rest.push(p);
        }
        if (rest.length) d.headers.Cookie = secret(d, rest.join('; '), 'cookie', 'Cookie header');
        continue;
      }
      const name = headerName(k);
      if (k === 'authorization') {
        const m = /^(\w+)\s+(.+)$/.exec(v);
        if (m) {
          const scheme = m[1]!;
          const cred = m[2]!.trim();
          const f = flowed(d, cred, 'Authorization header');
          d.headers[name] = `${scheme} ${f ?? secret(d, cred, /^bearer$/i.test(scheme) ? 'token' : `${scheme.toLowerCase()}Credentials`, 'Authorization header')}`;
        } else d.headers[name] = flowed(d, v, 'Authorization header') ?? secret(d, v, 'authorization', 'Authorization header');
        continue;
      }
      d.headers[name] = valueOf(d, v, k, `${name} header`);
    }

    /* the body */
    const body = e.requestBody;
    const ct = (reqHeaders['content-type'] ?? '').toLowerCase();
    if (body !== undefined && body !== '') {
      let json: unknown;
      let isJson = false;
      if (/json/.test(ct) || /^\s*[[{]/.test(body)) {
        try {
          json = JSON.parse(body);
          isJson = typeof json === 'object' && json !== null;
        } catch {
          isJson = false;
        }
      }
      if (isJson) {
        let numeric = false;
        const walk = (x: unknown, path: string, key: string, depth: number): unknown => {
          if (depth > 12) return x;
          if (Array.isArray(x)) return x.map((y, i) => walk(y, `${path}[${i}]`, key, depth + 1));
          if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, walk(y, `${path}${pathKey(k)}`, k, depth + 1)]));
          if (typeof x === 'number') {
            const f = flowed(d, String(x), `body ${path}`);
            if (!f) return x;
            numeric = true;
            return `@@TPNUM@@${f}@@`;
          }
          if (typeof x === 'string') return valueOf(d, x, key, `body ${path}`);
          return x;
        };
        const out = walk(json, '$', '', 0);
        d.body = numeric ? { type: 'json', content: JSON.stringify(out, null, 2).replace(/"@@TPNUM@@(\{\{[^}"]+\}\})@@"/g, '$1') } : out;
      } else if (/x-www-form-urlencoded/.test(ct)) {
        const fields = [...new URLSearchParams(body)].map(([key, value]) => ({ key, value: valueOf(d, value, key, `form ${key}`) }));
        d.body = { type: 'form-urlencoded', fields };
      } else if (/multipart\//.test(ct)) {
        d.body = undefined;
      } else {
        let text = replaceInside(d, body, 'body');
        if (knownSecret(text)) text = secret(d, body, 'body', 'body');
        d.body = { type: /xml/.test(ct) ? 'xml' : 'text', content: text };
      }
    }

    /* what this step's response offers the later ones */
    const res = e.responseBody;
    const resCt = (e.contentType ?? e.responseHeaders?.['content-type'] ?? '').toLowerCase();
    const offer = (value: string, p: Omit<Producer, 'step'>) => {
      // where a value first showed is where it came from (a later response that repeats it is not)
      if (producers.has(value) || sentSoFar.includes(value)) return;
      producers.set(value, { step: d.index, ...p });
    };
    if (res && (/json/.test(resCt) || /^\s*[[{]/.test(res))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(res);
      } catch {
        parsed = undefined;
      }
      let leaves = 0;
      const noun = (() => {
        const segs = u.pathname.split('/').filter(Boolean);
        const s = [...segs].reverse().find((x) => !/^\d+$/.test(x) && !UUID.test(x) && !producers.has(x) && /^[A-Za-z][\w-]*$/.test(x));
        return s ? singular(camel(s)) : '';
      })();
      const visit = (x: unknown, path: string, key: string, parent: string, depth: number) => {
        if (depth > 8 || leaves > 5000) return;
        if (Array.isArray(x)) return x.slice(0, 50).forEach((y, i) => visit(y, `${path}[${i}]`, key, key || parent, depth + 1));
        if (x && typeof x === 'object') {
          for (const [k, y] of Object.entries(x as Record<string, unknown>)) visit(y, `${path}${pathKey(k)}`, k, key, depth + 1);
          return;
        }
        leaves++;
        const v = worth(x, key);
        if (!v) return;
        const idLike = /^(id|uuid|guid|_id)$/i.test(key);
        const owner = parent && parent !== 'data' && parent !== 'result' ? singular(camel(parent)) : noun;
        const name = idLike ? `${owner || 'item'}Id` : key ? camel(key) : `${owner || 'value'}`;
        offer(v, { source: { kind: 'json', path }, name });
      };
      if (parsed !== undefined) visit(parsed, '$', '', '', 0);
    }
    for (const [k, v] of Object.entries(e.responseHeaders ?? {})) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') {
        for (const m of String(v).matchAll(/(?:^|[\n,])\s*([^=;,\s]+)=/g)) {
          // a cookie's attributes (Path=, Expires=…) are not cookies
          if (!/^(path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i.test(m[1]!)) cookieSetBy.set(m[1]!, d.index);
        }
        continue;
      }
      if (PLAIN_RESPONSE_HEADER.test(key)) continue;
      const val = String(v);
      if (worth(val, key) || (key === 'location' && val.length >= 2)) offer(val, { source: { kind: 'header', name: key }, name: camel(key) });
    }
  }

  /* ids from the steps as written: a path segment that became a {{variable}} (an id) does not name the step */
  const finalIds = new Set<string>();
  for (const d of drafts) {
    const segs = d.url.replace(/^\{\{[^}]+\}\}/, '').replace(/[?#].*$/, '').split('/').filter(Boolean);
    const last = [...segs].reverse().find((s) => !s.includes('{{') && !/^\d+$/.test(s) && !UUID.test(s) && s.length < 40) ?? 'root';
    const base = slugify(`${d.method}-${last}`) || 'step';
    let id = base;
    for (let n = 2; finalIds.has(id); n++) id = `${base}-${n}`;
    finalIds.add(id);
    d.id = id;
  }
  for (const l of links) {
    l.from = drafts[l.fromIndex - 1]!.id;
    l.to = drafts[l.toIndex - 1]!.id;
  }

  /* dependsOn: the steps whose values a step uses; a step that uses none waits for the one before it */
  const steps: FlowStepInput[] = drafts.map((d) => {
    const deps = d.deps.size ? [...d.deps].sort((a, b) => a - b).map((i) => drafts[i]!.id) : d.index > 0 ? [drafts[d.index - 1]!.id] : [];
    const step: Record<string, unknown> = { id: d.id, name: `${d.method} ${pathOf(d.url)}`, type: 'http', method: d.method, url: d.url };
    if (Object.keys(d.headers).length) step.headers = d.headers;
    if (d.body !== undefined) step.body = d.body;
    if (Object.keys(d.extract).length) step.extract = d.extract;
    if (deps.length) step.dependsOn = deps;
    if (d.e.status) step.assertions = [{ type: 'status', expected: d.e.status }];
    if (d.scriptLines.length) step.testScript = d.scriptLines.join('\n') + '\n';
    return step;
  });

  const vars = [...variables.values()];
  const secrets = vars.filter((v) => v.kind === 'secret' && !v.fromEnvironment).map((v) => v.name);
  const defaults = Object.fromEntries(vars.filter((v) => v.kind === 'origin' && !v.fromEnvironment && v.value).map((v) => [v.name, v.value!]));
  const notes: string[] = [];
  if (secrets.length) notes.push(`Set ${secrets.map((s) => `{{${s}}}`).join(', ')} in an environment before running: secrets are never written to the file.`);
  if (Object.keys(defaults).length)
    notes.push(
      `${Object.keys(defaults)
        .map((k) => `{{${k}}}`)
        .join(
          ', ',
        )} ${Object.keys(defaults).length > 1 ? 'are' : 'is'} set in the file's defaults; an environment with the same name${Object.keys(defaults).length > 1 ? 's' : ''} can take ${Object.keys(defaults).length > 1 ? 'their' : 'its'} place once the defaults are removed.`,
    );
  if (drafts.some((d) => d.e.requestBody && /multipart\//.test(String(d.e.requestHeaders?.['content-type'] ?? ''))))
    notes.push('Multipart (file upload) bodies are not recorded: add the files to those steps.');
  const byReason = new Map<string, number>();
  for (const x of dropped) byReason.set(x.reason, (byReason.get(x.reason) ?? 0) + 1);

  const name = opts.name?.trim() || `Recorded flow ${(opts.recordedAt ?? new Date().toISOString()).slice(0, 10)}`;
  const header = [
    `# Recorded from ${opts.source ?? 'the HTTP Debugger'} on ${(opts.recordedAt ?? new Date().toISOString()).slice(0, 16).replace('T', ' ')} UTC: ${plural(drafts.length, 'step')}${dropped.length ? ` (${plural(dropped.length, 'exchange')} left out: ${[...byReason.entries()].map(([r, n]) => `${n} ${r}`).join(', ')})` : ''}.`,
    '# Values that flowed from a response into a later request are extracted and passed as {{variables}}; each step waits for the steps it uses.',
    ...notes.map((n) => `# ${n}`),
  ];
  const base = `${header.join('\n')}\nname: ${JSON.stringify(name)}\n${
    Object.keys(defaults).length
      ? `defaults:\n  variables:\n${Object.entries(defaults)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
          .join('\n')}\n`
      : ''
  }tests: []\n`;
  let text = applyFlowEdit(base, { op: 'addSteps', steps }).text;
  if (!text.endsWith('\n')) text += '\n';

  return {
    text,
    steps: drafts.map((d, i) => ({
      id: d.id,
      name: String(steps[i]!.name),
      method: d.method,
      url: d.url,
      exchangeId: d.e.id,
      status: d.e.status,
      dependsOn: (steps[i]!.dependsOn as string[] | undefined) ?? [],
      extract: {
        ...d.extract,
        ...Object.fromEntries(
          d.scriptLines
            .map((l) => /set\('([^']+)', tp\.response\.headers\.get\('([^']+)'\)/.exec(l))
            .filter(Boolean)
            .map((m) => [m![1]!, `header ${m![2]}`]),
        ),
      },
      uses: [...d.uses],
    })),
    links,
    variables: vars,
    secrets,
    dropped,
    notes,
  };
}

/** A step's name: its method and path as the step sends it, variables as {name} (the OpenAPI way), no query. */
function pathOf(url: string): string {
  const p =
    url
      .replace(/^\{\{[^}]+\}\}/, '')
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/[?#].*$/, '')
      .replace(/\{\{([^}]+)\}\}/g, '{$1}') || '/';
  return p.length > 60 ? `${p.slice(0, 57)}…` : p;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A HAR file's text as a flow (its entries as exchanges, then flowFromExchanges). */
export function flowFromHar(text: string, opts: FlowFromExchangesOptions = {}): FlowFromExchangesResult {
  let har: unknown;
  try {
    har = JSON.parse(text);
  } catch {
    throw new ApsError('ValidationError', 'Not a HAR file (JSON with log.entries)');
  }
  const exchanges = exchangesFromHar(har);
  if (!exchanges.length) throw new ApsError('ValidationError', 'No entries in that HAR file');
  return flowFromExchanges(exchanges, opts);
}

/** Where a recorded flow is saved: tests/recorded/<name>.yaml (the path inside tests/). */
export function recordedFlowPath(name: string): string {
  return `recorded/${slugify(name) || 'flow'}.yaml`;
}
