import type { Node } from 'yaml';
import { isMap, isScalar, isSeq, lineCounter, parseDocument } from '../util/lazy-yaml.js';
import { schemaProblems, type OpenApiDoc } from './contract.js';
import { jsonPointerGet } from '../util/json-ref.js';

/**
 * Lint an OpenAPI 3.x / Swagger 2.0 document: mistakes that break tools and clients (a $ref to nothing, a path
 * parameter nobody declares, two operations with one operationId, a security scheme that isn't defined, an example
 * that doesn't match its schema) and gaps that make an API hard to use (no operationId, no success response, a
 * response without a schema). Every problem has its place in the text (line and column) for the editor, the CLI
 * (`testpion openapi-lint`) and agents (`openapi_lint`).
 */
export type OpenApiLintSeverity = 'error' | 'warning' | 'info';

export interface OpenApiLintProblem {
  rule: string;
  severity: OpenApiLintSeverity;
  message: string;
  /** `GET /pets/{id}`, `components.schemas.Pet`, `info` … */
  where: string;
  /** 1-based, for the editor. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface OpenApiLintResult {
  problems: OpenApiLintProblem[];
  counts: Record<OpenApiLintSeverity, number>;
  operations: number;
}

export interface OpenApiLintRule {
  id: string;
  severity: OpenApiLintSeverity;
  description: string;
}

export const OPENAPI_LINT_RULES: OpenApiLintRule[] = [
  { id: 'syntax', severity: 'error', description: 'The document is valid YAML or JSON and is an OpenAPI 3 or Swagger 2 document.' },
  { id: 'info', severity: 'error', description: 'info has a title and a version.' },
  { id: 'ref-unresolved', severity: 'error', description: 'Every local $ref points at something in the document.' },
  { id: 'path-ambiguous', severity: 'error', description: 'Two paths that differ only in their parameter names (/pets/{id} and /pets/{petId}) are the same path.' },
  { id: 'path-param-undeclared', severity: 'error', description: 'Every {parameter} in a path is declared as a path parameter.' },
  { id: 'path-param-unused', severity: 'error', description: 'Every path parameter appears in the path.' },
  { id: 'path-param-required', severity: 'error', description: 'Path parameters are required: true.' },
  { id: 'parameter-duplicate', severity: 'error', description: 'An operation does not declare the same parameter (name and in) twice.' },
  { id: 'operation-id-unique', severity: 'error', description: 'operationIds are unique (code generators and links use them).' },
  { id: 'operation-responses', severity: 'error', description: 'Every operation documents at least one response.' },
  { id: 'security-scheme-defined', severity: 'error', description: 'Security requirements name defined security schemes.' },
  { id: 'example-valid', severity: 'warning', description: 'Examples match their schema.' },
  { id: 'operation-id', severity: 'warning', description: 'Every operation has an operationId.' },
  { id: 'operation-success-response', severity: 'warning', description: 'Every operation documents a success (2xx / 3xx) or default response.' },
  { id: 'response-schema', severity: 'warning', description: 'A success response with content has a schema.' },
  { id: 'request-body-on-get', severity: 'warning', description: 'GET, HEAD and DELETE have no request body (many clients and proxies drop it).' },
  { id: 'path-trailing-slash', severity: 'warning', description: 'Paths do not end with a slash.' },
  { id: 'server-not-https', severity: 'warning', description: 'Servers other than localhost use https.' },
  { id: 'operation-summary', severity: 'info', description: 'Every operation has a summary or a description.' },
  { id: 'operation-tags', severity: 'info', description: 'Every operation has a tag, and tags used are declared at the top.' },
  { id: 'servers', severity: 'info', description: 'The document names its servers.' },
  { id: 'component-unused', severity: 'info', description: 'Every component is used somewhere.' },
];

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
type Json = Record<string, any>;
type Seg = string | number;

const RANK: Record<OpenApiLintSeverity, number> = { error: 0, warning: 1, info: 2 };

export function lintOpenApi(text: string, opts: { disable?: string[]; minSeverity?: OpenApiLintSeverity } = {}): OpenApiLintResult {
  const severityOf = new Map(OPENAPI_LINT_RULES.map((r) => [r.id, r.severity]));
  const off = new Set(opts.disable ?? []);
  const min = RANK[opts.minSeverity ?? 'info'];
  const problems: OpenApiLintProblem[] = [];
  const lc = lineCounter();
  const yd = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: false });

  const pos = (offset: number) => lc.linePos(Math.max(0, Math.min(offset, text.length)));
  /** The place of a key (or of the deepest part of the path that exists). */
  const locate = (path: Seg[]) => {
    let node: unknown = yd.contents;
    let range: [number, number] = [0, Math.min(text.length, (text.indexOf('\n') + 1 || text.length + 1) - 1)];
    for (const seg of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(seg));
        if (!pair) break;
        const k = pair.key as Node | undefined;
        if (k?.range) range = [k.range[0], k.range[1]];
        node = pair.value;
      } else if (isSeq(node) && typeof seg === 'number' && node.items[seg]) {
        const it = node.items[seg] as Node;
        if (it.range) range = [it.range[0], Math.min(it.range[1], it.range[0] + 80)];
        node = it;
      } else break;
    }
    const a = pos(range[0]);
    const b = pos(range[1]);
    return { line: a.line, column: a.col, endLine: b.line, endColumn: b.line === a.line ? Math.max(b.col, a.col + 1) : b.col };
  };
  const add = (rule: string, message: string, path: Seg[], where: string) => {
    const severity = severityOf.get(rule) ?? 'warning';
    if (off.has(rule) || RANK[severity] > min) return;
    problems.push({ rule, severity, message, where, ...locate(path) });
  };

  const done = (operations = 0): OpenApiLintResult => {
    problems.sort((a, b) => a.line - b.line || a.column - b.column);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const p of problems) counts[p.severity]++;
    return { problems, counts, operations };
  };

  if (yd.errors.length) {
    for (const e of yd.errors.slice(0, 5)) {
      const at = pos(e.pos[0]);
      if (!off.has('syntax'))
        problems.push({ rule: 'syntax', severity: 'error', message: e.message.split('\n')[0]!, where: 'document', line: at.line, column: at.col, endLine: at.line, endColumn: at.col + 1 });
    }
    return done();
  }
  const doc = yd.toJS({ maxAliasCount: 1000 }) as Json;
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger)) {
    add('syntax', 'Not an OpenAPI 3 or Swagger 2 document: there is no "openapi" (or "swagger") version', [], 'document');
    return done();
  }
  if (!doc.paths || typeof doc.paths !== 'object') {
    add('syntax', 'The document has no "paths"', [doc.openapi ? 'openapi' : 'swagger'], 'document');
    return done();
  }
  const v2 = !!doc.swagger;

  // info
  if (!doc.info?.title) add('info', 'info has no title', doc.info ? ['info'] : [], 'info');
  if (!doc.info?.version) add('info', 'info has no version', doc.info ? ['info'] : [], 'info');

  // servers
  const servers: Array<{ url?: string }> = v2
    ? doc.host
      ? [{ url: `${(doc.schemes as string[] | undefined)?.[0] ?? 'https'}://${doc.host}` }]
      : []
    : ((doc.servers as Array<{ url?: string }>) ?? []);
  if (!servers.length) add('servers', v2 ? 'No host: clients must be told where the API is' : 'No servers: clients must be told where the API is', [v2 ? 'swagger' : 'openapi'], 'servers');
  servers.forEach((s, i) => {
    if (s?.url && /^http:\/\//i.test(s.url) && !/^http:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(s.url))
      add('server-not-https', `${s.url} is plain http: credentials and data travel unencrypted`, v2 ? ['host'] : ['servers', i, 'url'], 'servers');
  });

  // $refs: every local one resolves; remember what is used
  const used = new Set<string>();
  const resolve = (ref: string): unknown => jsonPointerGet(doc, ref);
  const walk = (node: unknown, path: Seg[], depth: number) => {
    if (depth > 60 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, [...path, i], depth + 1));
    const o = node as Json;
    if (typeof o.$ref === 'string') {
      if (o.$ref.startsWith('#/')) {
        used.add(o.$ref);
        if (resolve(o.$ref) === undefined) add('ref-unresolved', `${o.$ref} points at nothing in this document`, [...path, '$ref'], where(path));
      }
    }
    for (const [k, v] of Object.entries(o)) {
      // example values are literal data, not the document (a property named "example" or "value" is a schema)
      const literal = (k === 'example' && path.at(-1) !== 'properties') || (k === 'value' && path.at(-2) === 'examples');
      if (!literal) walk(v, [...path, k], depth + 1);
    }
  };
  const where = (path: Seg[]): string => {
    if (path[0] === 'paths' && typeof path[1] === 'string') return typeof path[2] === 'string' && METHODS.includes(path[2]) ? `${path[2].toUpperCase()} ${path[1]}` : path[1];
    return path.slice(0, 3).join('.') || 'document';
  };
  walk(doc, [], 0);
  const deref = (x: any, seen = 0): any => (x && typeof x.$ref === 'string' && seen < 20 ? deref(resolve(x.$ref), seen + 1) : x);

  // components
  const sections: Array<[string, Json | undefined, Seg[]]> = v2
    ? [
        ['definitions', doc.definitions, ['definitions']],
        ['parameters', doc.parameters, ['parameters']],
        ['responses', doc.responses, ['responses']],
      ]
    : ['schemas', 'parameters', 'responses', 'requestBodies', 'headers', 'examples'].map((k) => [k, doc.components?.[k], ['components', k]] as [string, Json | undefined, Seg[]]);
  const schemes: Json = (v2 ? doc.securityDefinitions : doc.components?.securitySchemes) ?? {};

  // security requirements, at the top and per operation
  const usedSchemes = new Set<string>();
  const checkSecurity = (reqs: unknown, path: Seg[], label: string) => {
    if (!Array.isArray(reqs)) return;
    reqs.forEach((r, i) => {
      for (const name of Object.keys((r as Json) ?? {})) {
        usedSchemes.add(name);
        if (!(name in schemes)) add('security-scheme-defined', `Security scheme "${name}" is not defined in ${v2 ? 'securityDefinitions' : 'components.securitySchemes'}`, [...path, i, name], label);
      }
    });
  };
  checkSecurity(doc.security, ['security'], 'security');

  // examples against their schemas
  const checkExample = (schema: unknown, value: unknown, path: Seg[], label: string) => {
    if (!schema || value === undefined) return;
    let errs: string[] = [];
    try {
      errs = schemaProblems(doc as OpenApiDoc, deref(schema), value);
    } catch {
      return; // a schema the validator can't compile is not the example's fault
    }
    if (errs.length) add('example-valid', `The example does not match its schema: ${errs.join('; ')}`, path, label);
  };
  if (!v2)
    for (const [name, s] of Object.entries((doc.components?.schemas as Json) ?? {}))
      if (s && typeof s === 'object' && (s as Json).example !== undefined) checkExample(s, (s as Json).example, ['components', 'schemas', name, 'example'], `components.schemas.${name}`);

  // operations
  const tagsDeclared = new Set(((doc.tags as Array<{ name?: string }>) ?? []).map((t) => t?.name));
  const opIds = new Map<string, string>();
  const shapes = new Map<string, string>();
  let operations = 0;
  for (const [path, item0] of Object.entries(doc.paths as Json)) {
    const item = deref(item0) as Json;
    if (!item || typeof item !== 'object') continue;
    const at: Seg[] = ['paths', path];
    if (path.length > 1 && path.endsWith('/')) add('path-trailing-slash', `${path} ends with a slash`, at, path);
    const shape = path.replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '');
    const same = shapes.get(shape);
    if (same && same !== path) add('path-ambiguous', `${path} is the same path as ${same}: only the parameter names differ`, at, path);
    else shapes.set(shape, path);
    const template = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const pathParams = ((item.parameters as unknown[]) ?? []).map((p, i) => ({ p: deref(p) as Json, at: [...at, 'parameters', i] as Seg[] }));

    for (const m of METHODS) {
      const op = item[m] as Json | undefined;
      if (!op || typeof op !== 'object') continue;
      operations++;
      const label = `${m.toUpperCase()} ${path}`;
      const oat: Seg[] = [...at, m];
      const own = ((op.parameters as unknown[]) ?? []).map((p, i) => ({ p: deref(p) as Json, at: [...oat, 'parameters', i] as Seg[] }));
      // an operation's parameter replaces the path item's one of the same name and place
      const params = [...own, ...pathParams.filter((x) => !own.some((o) => o.p?.name === x.p?.name && o.p?.in === x.p?.in))];
      const seen = new Set<string>();
      for (const { p, at: pat } of own) {
        if (!p) continue;
        const key = `${p.in}:${p.name}`;
        if (seen.has(key)) add('parameter-duplicate', `Parameter "${p.name}" (in ${p.in}) is declared twice`, pat, label);
        seen.add(key);
      }
      for (const name of template)
        if (!params.some((x) => x.p?.in === 'path' && x.p?.name === name)) add('path-param-undeclared', `{${name}} is in the path but not declared as a path parameter`, oat, label);
      for (const { p, at: pat } of params) {
        if (p?.in !== 'path') continue;
        if (!template.includes(p.name)) add('path-param-unused', `Path parameter "${p.name}" is not in the path ${path}`, pat, label);
        if (p.required !== true) add('path-param-required', `Path parameter "${p.name}" must be required: true`, pat, label);
      }
      for (const { p, at: pat } of own) if (p && p.example !== undefined && p.schema) checkExample(p.schema, p.example, [...pat, 'example'], label);

      if (typeof op.operationId === 'string' && op.operationId) {
        const before = opIds.get(op.operationId);
        if (before) add('operation-id-unique', `operationId "${op.operationId}" is also used by ${before}`, [...oat, 'operationId'], label);
        else opIds.set(op.operationId, label);
      } else add('operation-id', `${label} has no operationId`, oat, label);
      if (!op.summary && !op.description) add('operation-summary', `${label} has no summary or description`, oat, label);
      const tags = (op.tags as string[]) ?? [];
      if (!tags.length) add('operation-tags', `${label} has no tag`, oat, label);
      else if (tagsDeclared.size) for (const t of tags) if (!tagsDeclared.has(t)) add('operation-tags', `Tag "${t}" is not declared in the top-level tags`, [...oat, 'tags'], label);

      if (['get', 'head', 'delete'].includes(m)) {
        if (!v2 && op.requestBody) add('request-body-on-get', `${m.toUpperCase()} with a request body: many clients and proxies drop it`, [...oat, 'requestBody'], label);
        if (v2 && params.some((x) => x.p?.in === 'body')) add('request-body-on-get', `${m.toUpperCase()} with a body parameter: many clients and proxies drop it`, oat, label);
      }
      if (!v2 && op.requestBody) {
        const rb = deref(op.requestBody) as Json;
        for (const [mt, media] of Object.entries((rb?.content as Json) ?? {})) mediaExamples(media as Json, [...oat, 'requestBody', 'content', mt], label);
      }

      const responses = op.responses as Json | undefined;
      if (!responses || !Object.keys(responses).length) add('operation-responses', `${label} documents no response`, oat, label);
      else {
        const codes = Object.keys(responses);
        if (!codes.some((c) => /^[23]/.test(c) || c === 'default')) add('operation-success-response', `${label} documents no success response (2xx / 3xx) or default`, [...oat, 'responses'], label);
        for (const code of codes) {
          const r = deref(responses[code]) as Json;
          if (!r || v2) continue;
          for (const [mt, media0] of Object.entries((r.content as Json) ?? {})) {
            const media = media0 as Json;
            if (/^2/.test(code) && code !== '204' && !media?.schema && !/^(text\/|application\/octet-stream|\*\/\*)/.test(mt))
              add('response-schema', `The ${code} response (${mt}) has no schema`, [...oat, 'responses', code, 'content', mt], label);
            mediaExamples(media, [...oat, 'responses', code, 'content', mt], label);
          }
        }
      }
      checkSecurity(op.security, [...oat, 'security'], label);
    }
  }

  function mediaExamples(media: Json | undefined, at: Seg[], label: string) {
    if (!media?.schema) return;
    if (media.example !== undefined) checkExample(media.schema, media.example, [...at, 'example'], label);
    for (const [name, ex0] of Object.entries((media.examples as Json) ?? {})) {
      const ex = deref(ex0) as Json;
      if (ex && ex.value !== undefined) checkExample(media.schema, ex.value, [...at, 'examples', name], label);
    }
  }

  // components nobody uses
  for (const [kind, entries, base] of sections) {
    for (const name of Object.keys(entries ?? {})) {
      const ref = `#/${base.join('/')}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!used.has(ref)) add('component-unused', `${base.join('.')}.${name} is not used`, [...base, name], `${base.join('.')}.${name}`);
    }
    void kind;
  }
  for (const name of Object.keys(schemes))
    if (!usedSchemes.has(name))
      add('component-unused', `Security scheme "${name}" is not used by any security requirement`, [...(v2 ? ['securityDefinitions'] : ['components', 'securitySchemes']), name], 'security');

  return done(operations);
}
