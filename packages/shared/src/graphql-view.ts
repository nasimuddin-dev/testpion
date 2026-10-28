/**
 * GraphQL in the Debugger (FG-20): is this exchange a GraphQL call, which operation (type and name), its variables, the query
 * laid out, and the errors the response carried. A light reader, not a validator (the engine's `graphql_operation` tool
 * validates against a schema; this package runs in the window too, where the graphql library is not loaded): it cuts the
 * document into tokens, finds the operation keyword and name, and indents by braces. Bounded: a document over 256 KB is
 * summarised without being laid out.
 */

export interface GraphqlOperation {
  type: 'query' | 'mutation' | 'subscription';
  /** The operation's name; undefined for an anonymous one. */
  name?: string;
  /** The query text laid out, one selection per line. */
  query: string;
  variables?: unknown;
  /** The first field in the selection set: what the operation is mostly about. */
  rootField?: string;
}

export interface GraphqlError {
  message: string;
  path?: string;
  line?: number;
  column?: number;
  code?: string;
}

export interface GraphqlView {
  operations: GraphqlOperation[];
  /** From the response: the errors array, and whether `data` came back. */
  errors: GraphqlError[];
  hasData?: boolean;
  partial?: boolean;
  /** The short text for a list column: `query GetUser`, `mutation (2 batched)`. */
  label: string;
}

export interface GraphqlInput {
  method?: string;
  url?: string;
  requestContentType?: string;
  requestBody?: string;
  responseBody?: string;
}

const MAX_LAYOUT_CHARS = 256 * 1024;

type Tok = { t: 'name' | 'punct' | 'string' | 'other'; s: string };

function tokens(q: string): Tok[] {
  const out: Tok[] = [];
  const re = /#[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|[A-Za-z_][A-Za-z0-9_]*|\.\.\.|[{}()[\]:=!$@|&,]|-?\d[\w.+-]*|\S/g;
  for (const m of q.matchAll(re)) {
    const s = m[0];
    if (s[0] === '#') continue;
    out.push({ t: s[0] === '"' ? 'string' : /^[A-Za-z_]/.test(s) ? 'name' : /^[{}()[\]:=!$@|&,]$|^\.\.\.$/.test(s) ? 'punct' : 'other', s });
  }
  return out;
}

/** Splits a document into its definitions (a query document may hold fragments and several operations). */
function definitions(toks: Tok[]): Tok[][] {
  const defs: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    cur.push(t);
    if (t.s === '{') depth++;
    else if (t.s === '}' && --depth === 0) {
      defs.push(cur);
      cur = [];
    }
  }
  if (cur.length) defs.push(cur);
  return defs;
}

/** The document as indented text: a brace opens a level, a field starts a line, the arguments stay on its line. */
export function formatGraphql(query: string): string {
  if (query.length > MAX_LAYOUT_CHARS) return query;
  const toks = tokens(query);
  const lines: string[] = [];
  let line = '';
  let indent = 0;
  let parens = 0;
  const flush = () => {
    if (line.trim()) lines.push('  '.repeat(indent) + line.trim());
    line = '';
  };
  let prev: Tok | undefined;
  let prev2: Tok | undefined;
  for (const t of toks) {
    if (t.s === '{' && parens === 0) {
      line += (line.trim() ? ' ' : '') + '{';
      flush();
      indent++;
    } else if (t.s === '}' && parens === 0) {
      flush();
      indent = Math.max(0, indent - 1);
      line = '}';
      flush();
    } else {
      const startsField =
        parens === 0 &&
        indent > 0 &&
        (t.t === 'name' || t.s === '...') &&
        !!prev &&
        !/^[:@$]$/.test(prev.s) &&
        prev.s !== '...' &&
        !(prev.s === 'on' && prev2?.s === '...') &&
        line.trim() !== '';
      if (startsField) flush();
      if (t.s === '(' || t.s === '[') parens++;
      if (t.s === ')' || t.s === ']') parens = Math.max(0, parens - 1);
      const tight = !prev || /^[(\[$@]$/.test(prev.s) || /^[)\],:!(\[]$/.test(t.s) || (prev.s === '...' && t.s !== 'on') || line === '';
      const afterColon = prev?.s === ':' || prev?.s === ',';
      const eq = t.s === '=' || prev?.s === '=';
      line += (afterColon || eq ? ' ' : tight ? '' : ' ') + t.s;
    }
    prev2 = prev;
    prev = t;
  }
  flush();
  return lines.join('\n');
}

function operationsOf(query: string, variables: unknown, operationName?: string): GraphqlOperation[] {
  const out: GraphqlOperation[] = [];
  const toks = tokens(query);
  const defs = definitions(toks);
  for (const d of defs) {
    const first = d[0];
    if (!first) continue;
    let type: GraphqlOperation['type'] | undefined;
    let name: string | undefined;
    if (first.s === '{') type = 'query';
    else if (first.t === 'name' && (first.s === 'query' || first.s === 'mutation' || first.s === 'subscription')) {
      type = first.s;
      const n = d[1];
      if (n && n.t === 'name') name = n.s;
    }
    if (!type) continue;
    const open = d.findIndex((t) => t.s === '{');
    const body = open >= 0 ? d.slice(open + 1) : [];
    const rootField = body.find((t) => t.t === 'name')?.s;
    out.push({ type, name, query: formatGraphql(d.map((t) => t.s).join(' ')), variables, rootField });
  }
  // a document of several operations: the named one is the one run
  if (operationName && out.length > 1) {
    const i = out.findIndex((o) => o.name === operationName);
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  // the whole document, laid out, when nothing could be told apart (a fragment-only or unusual document)
  return out.length ? out : [];
}

const parse = (s?: string): unknown => {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const qs = (url: string | undefined, key: string) => {
  const q = url?.split('#')[0]?.split('?')[1];
  if (!q) return undefined;
  for (const p of q.split('&')) {
    const i = p.indexOf('=');
    if ((i < 0 ? p : p.slice(0, i)) === key) {
      try {
        return decodeURIComponent((i < 0 ? '' : p.slice(i + 1)).replace(/\+/g, ' '));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

/** The GraphQL payloads of a request: the JSON body (or its batch), a raw `application/graphql` body, or a GET's query string. */
function requestPayloads(i: GraphqlInput): Array<{ query: string; variables?: unknown; operationName?: string }> {
  const ct = (i.requestContentType ?? '').toLowerCase();
  if (i.requestBody && ct.includes('application/graphql') && !ct.includes('json')) return [{ query: i.requestBody }];
  const body = parse(i.requestBody);
  const list = Array.isArray(body) ? body : body ? [body] : [];
  const out: Array<{ query: string; variables?: unknown; operationName?: string }> = [];
  for (const x of list.slice(0, 50)) {
    const o = x as Record<string, unknown> | null;
    if (o && typeof o === 'object' && typeof o.query === 'string') out.push({ query: o.query, variables: typeof o.variables === 'string' ? parse(o.variables) ?? o.variables : o.variables, operationName: typeof o.operationName === 'string' ? o.operationName : undefined });
  }
  if (!out.length && (i.method ?? 'GET').toUpperCase() === 'GET') {
    const q = qs(i.url, 'query');
    if (q) out.push({ query: q, variables: parse(qs(i.url, 'variables')), operationName: qs(i.url, 'operationName') });
  }
  return out;
}

/** Quick test, cheap enough for every row: does this look like a GraphQL call? */
export function looksLikeGraphql(i: Pick<GraphqlInput, 'url' | 'requestContentType' | 'requestBody'>): boolean {
  if (/graphql/i.test(i.url ?? '') || /application\/graphql/i.test(i.requestContentType ?? '')) return true;
  return !!i.requestBody && i.requestBody.length < 2_000_000 && /"query"\s*:\s*"/.test(i.requestBody) && /\b(query|mutation|subscription)\b|\{/.test(i.requestBody.slice(0, 600));
}

const errorsOf = (resp: unknown): GraphqlError[] => {
  const arr = Array.isArray(resp) ? resp : [resp];
  const out: GraphqlError[] = [];
  for (const r of arr.slice(0, 50)) {
    const errs = (r as { errors?: unknown } | null)?.errors;
    if (!Array.isArray(errs)) continue;
    for (const e of errs.slice(0, 100)) {
      const o = (e ?? {}) as Record<string, unknown>;
      const loc = Array.isArray(o.locations) ? (o.locations[0] as { line?: number; column?: number } | undefined) : undefined;
      const ext = o.extensions as { code?: unknown } | undefined;
      out.push({
        message: typeof o.message === 'string' ? o.message : JSON.stringify(e),
        path: Array.isArray(o.path) ? o.path.join('.') : undefined,
        line: loc?.line,
        column: loc?.column,
        code: typeof ext?.code === 'string' ? ext.code : undefined,
      });
    }
  }
  return out;
};

/** The GraphQL reading of an exchange, or undefined when it is not one. */
export function graphqlOf(i: GraphqlInput): GraphqlView | undefined {
  if (!looksLikeGraphql(i)) return undefined;
  const payloads = requestPayloads(i);
  if (!payloads.length) return undefined;
  const operations = payloads.flatMap((p) => operationsOf(p.query, p.variables, p.operationName).slice(0, 1));
  if (!operations.length) return undefined;
  const resp = parse(i.responseBody);
  const errors = errorsOf(resp);
  const first = Array.isArray(resp) ? resp[0] : resp;
  const hasData = first && typeof first === 'object' ? (first as { data?: unknown }).data != null : undefined;
  const o = operations[0]!;
  const label = operations.length > 1 ? `${o.type} ${o.name ?? o.rootField ?? ''} (+${operations.length - 1} batched)`.replace(/\s+/g, ' ') : `${o.type} ${o.name ?? o.rootField ?? ''}`.trim();
  return { operations, errors, hasData, partial: errors.length > 0 && hasData === true ? true : undefined, label };
}
