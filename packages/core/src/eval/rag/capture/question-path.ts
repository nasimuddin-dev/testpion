/**
 * Where the question is in a RAG target's request, and the same place in a captured call. The target's step writes the
 * question as `{{question}}` (`{{questionJson}}`, `{{questionEscaped}}`); the place is found from that, so a captured
 * request is read the way the target writes it. A path given by the person (`$.input.q`, `query:q`) overrides it.
 */
import type { RagTarget } from '@testpion/shared';
import { ApsError } from '../../../errors.js';
import { queryAll } from '../../../util/jsonpath.js';
import type { CapturedCall, QuestionLocator } from './types.js';

const PLACEHOLDER = /\{\{\s*(question|questionJson|questionEscaped)\s*\}\}/;
const ANY_PLACEHOLDER = /\{\{[^}]*\}\}/g;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

const encodingOf = (name: string): QuestionLocator['encoding'] => (name === 'questionJson' ? 'json' : name === 'questionEscaped' ? 'escaped' : 'plain');

/** The first string leaf of a JSON value holding the question placeholder: its path and text. */
function findInJson(v: unknown, path: string[] = []): { path: string[]; text: string } | undefined {
  if (typeof v === 'string') return PLACEHOLDER.test(v) ? { path, text: v } : undefined;
  if (Array.isArray(v))
    for (let i = 0; i < v.length; i++) {
      const r = findInJson(v[i], [...path, String(i)]);
      if (r) return r;
    }
  else if (isRec(v))
    for (const [k, x] of Object.entries(v)) {
      const r = findInJson(x, [...path, k]);
      if (r) return r;
    }
  return undefined;
}

const nameOf = (text: string) => PLACEHOLDER.exec(text)![1]!;

/** The request part of a target's step (`request:` nested or the step itself). */
const requestOf = (step: Rec): Rec => (isRec(step.request) ? step.request : step);

/** Where the question is in the target's request; undefined when the request has no placeholder (the question is set elsewhere). */
export function questionLocator(target: Pick<RagTarget, 'step' | 'protocol'>, override?: string): QuestionLocator | undefined {
  const o = override?.trim();
  if (o) {
    if (o.startsWith('query:')) return { where: 'query', path: [o.slice(6)], template: '{{question}}', encoding: 'plain' };
    return { where: 'body-json', path: [o], template: '{{question}}', encoding: 'plain' };
  }
  const r = requestOf(isRec(target.step) ? target.step : {});
  const json = r.json !== undefined ? r.json : isRec(r.body) && 'content' in r.body ? undefined : r.body;
  if (json !== undefined && typeof json !== 'string') {
    const f = findInJson(json);
    if (f) return { where: 'body-json', path: f.path, template: f.text, encoding: encodingOf(nameOf(f.text)) };
  }
  const bodyText = typeof json === 'string' ? json : isRec(r.body) && typeof r.body.content === 'string' ? r.body.content : undefined;
  if (bodyText && PLACEHOLDER.test(bodyText)) {
    // a JSON body written as text: the field is found by parsing it with the placeholder as an ordinary string
    try {
      const f = findInJson(JSON.parse(bodyText));
      if (f) return { where: 'body-json', path: f.path, template: f.text, encoding: encodingOf(nameOf(f.text)) };
    } catch {
      /* not JSON: the whole text is the template */
    }
    return { where: 'body-text', template: bodyText, encoding: encodingOf(nameOf(bodyText)) };
  }
  const params = r.params ?? r.query;
  const kv: Array<[string, string]> = Array.isArray(params)
    ? params.filter(isRec).map((p) => [String(p.key ?? p.name ?? ''), String(p.value ?? '')] as [string, string])
    : isRec(params)
      ? Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string])
      : [];
  for (const [k, v] of kv) if (PLACEHOLDER.test(v)) return { where: 'query', path: [k], template: v, encoding: encodingOf(nameOf(v)) };
  const url = typeof r.url === 'string' ? r.url : '';
  if (PLACEHOLDER.test(url)) return { where: 'url', template: url, encoding: encodingOf(nameOf(url)) };
  return undefined;
}

/** What the locator reads, in words (the report and the dialog). */
export const describeLocator = (l: QuestionLocator): string =>
  l.where === 'body-json' ? `request body ${l.path!.length ? `$.${l.path!.join('.')}` : '(whole)'}` : l.where === 'query' ? `query parameter ${l.path![0]}` : l.where === 'url' ? 'the URL' : 'the request body text';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text that stood in the placeholder of `template` in `actual`, or undefined when `actual` does not fit it. */
function fromTemplate(template: string, actual: string, enc: QuestionLocator['encoding']): string | undefined {
  const parts = template.split(PLACEHOLDER);
  // split() with a capture group yields [before, name, after, ...]; only the first placeholder is the question
  const before = parts[0]!;
  const after = template.slice(before.length + (PLACEHOLDER.exec(template)?.[0].length ?? 0));
  const wild = (s: string) => s.split(ANY_PLACEHOLDER).map(escapeRe).join('[\\s\\S]*?');
  const m = new RegExp(`^${wild(before)}([\\s\\S]*?)${wild(after)}$`).exec(actual);
  if (!m) return undefined;
  let q = m[1]!;
  if (enc === 'json') {
    try {
      const v = JSON.parse(q);
      if (typeof v === 'string') q = v;
    } catch {
      /* kept as written */
    }
  } else if (enc === 'escaped') {
    try {
      q = JSON.parse(`"${q}"`) as string;
    } catch {
      /* kept as written */
    }
  }
  return q;
}

const parseJson = (s: string | undefined): unknown => {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const queryParam = (url: string | undefined, name: string): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://x.invalid').searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
};

/** The question of a captured call, or undefined when its request does not carry one. */
export function readQuestion(loc: QuestionLocator, call: CapturedCall): string | undefined {
  let q: string | undefined;
  if (loc.where === 'body-json') {
    const body = parseJson(call.requestBody);
    if (body === undefined) return undefined;
    const expr = loc.path!.length === 1 && loc.path![0]!.startsWith('$') ? loc.path![0]! : undefined;
    // a path the person gave is a JSONPath and the field is the question itself; one found from the step is read with the step's template
    const v = expr ? queryAll(body, expr)[0] : loc.path!.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Rec)[k] : undefined), body);
    if (typeof v !== 'string') return undefined;
    q = expr ? v : fromTemplate(loc.template, v, loc.encoding);
  } else if (loc.where === 'body-text') q = call.requestBody === undefined ? undefined : fromTemplate(loc.template, call.requestBody, loc.encoding);
  else if (loc.where === 'query') {
    const v = queryParam(call.url, loc.path![0]!);
    q = v === undefined ? undefined : (fromTemplate(loc.template, v, 'plain') ?? undefined);
  } else q = call.url === undefined ? undefined : fromTemplate(loc.template, call.url, loc.encoding);
  q = q?.trim();
  return q ? q : undefined;
}

/** Whether a call went to the target's URL and method (variables in the target's URL stand for anything). */
export function matchesTarget(target: Pick<RagTarget, 'step'>, call: CapturedCall): boolean {
  const r = requestOf(isRec(target.step) ? target.step : {});
  const url = typeof r.url === 'string' ? r.url : '';
  if (!url || !call.url) return false;
  const method = String(r.method ?? 'GET').toUpperCase();
  if (call.method && call.method.toUpperCase() !== method) return false;
  const strip = (u: string) => u.split(/[?#]/)[0]!.replace(/\/+$/, '');
  const tpl = strip(url);
  const re = new RegExp(`^${tpl.split(ANY_PLACEHOLDER).map(escapeRe).join('.*?')}$`, 'i');
  return re.test(strip(call.url));
}

/** The target must be a protocol a call can be read for: HTTP (also streamed). */
export function assertCapturable(target: Pick<RagTarget, 'protocol'>): void {
  if (target.protocol !== 'http' && target.protocol !== 'sse')
    throw new ApsError('ValidationError', `Captured calls are HTTP exchanges; this target is ${target.protocol}`, { suggestions: ['A WebSocket, gRPC or MCP target cannot be built from History or a HAR file yet.'] });
}
