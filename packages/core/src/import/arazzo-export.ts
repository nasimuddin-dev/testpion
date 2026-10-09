import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseYaml, stringifyYaml } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { listSpecs } from '../openapi/spec-files.js';
import { ARAZZO_SOURCE_MARK, ARAZZO_WORKFLOW_MARK, jsonPathToPointer, readSourceFile, type ArazzoSource, type ArazzoJson } from './arazzo.js';

/**
 * A flow file → an Arazzo 1.0 document (the reverse of arazzo.ts). Each HTTP step becomes a step whose operation is
 * found in an OpenAPI source by method and path (operationId when the operation has one, else operationPath); a
 * request no source describes keeps its raw request in `x-testpion-request`. Extracts become outputs, {{variables}}
 * become runtime expressions ($steps.x.outputs.y for values a step extracts, $inputs.z for the rest), status and
 * body checks become successCriteria, retries a retry action. What Arazzo cannot say is kept under x-testpion-*
 * keys and listed in `notes`.
 */

export interface ArazzoExportOptions {
  /** The flow file's name (for the workflow id when the file has no arazzo-workflow comment). */
  file?: string;
  /** OpenAPI sources to match requests against; default: the arazzo-source comments of the file. */
  sources?: ArazzoSource[];
  workflowId?: string;
  /** The Arazzo version to write (default 1.0.1). */
  version?: string;
}

export interface ArazzoExportResult {
  document: ArazzoJson;
  /** The document as YAML. */
  text: string;
  notes: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** `# arazzo-workflow: x` and `# arazzo-source: name type url` comments an Arazzo import leaves at the top. */
export function arazzoMarks(text: string): { workflowId?: string; sources: ArazzoSource[] } {
  const sources: ArazzoSource[] = [];
  let workflowId: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#')) {
      if (line.trim()) break;
      continue;
    }
    const body = line.replace(/^#\s*/, '');
    if (body.startsWith(ARAZZO_WORKFLOW_MARK)) workflowId = body.slice(ARAZZO_WORKFLOW_MARK.length).trim() || undefined;
    else if (body.startsWith(ARAZZO_SOURCE_MARK)) {
      const [name, type, ...url] = body.slice(ARAZZO_SOURCE_MARK.length).trim().split(/\s+/);
      if (name) sources.push({ name, type: type ?? 'openapi', url: url.join(' ') });
    }
  }
  return { workflowId, sources };
}

const isRecord = (v: unknown): v is ArazzoJson => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
/** key/value maps or lists of { key, value } → entries. */
const kv = (v: unknown): Array<[string, unknown]> =>
  Array.isArray(v) ? v.filter((x) => isRecord(x) && x.enabled !== false).map((x) => [String((x as ArazzoJson).key), (x as ArazzoJson).value]) : isRecord(v) ? Object.entries(v) : [];

/** A simple-condition literal. */
function literal(v: unknown): string | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  return undefined;
}

/** The body expression of a JSONPath: $response.body#/a/0 (undefined when the path is not a plain one). */
function bodyExpr(path: unknown): string | undefined {
  const ptr = jsonPathToPointer(String(path ?? '$'));
  return ptr === undefined ? undefined : ptr === '' ? '$response.body' : `$response.body#${ptr}`;
}

/** Checks → success criteria; the checks with no Arazzo form come back in `rest`. */
export function checksToCriteria(checks: ArazzoJson[]): { criteria: ArazzoJson[]; rest: ArazzoJson[] } {
  const criteria: ArazzoJson[] = [];
  const rest: ArazzoJson[] = [];
  for (const c of checks) {
    const type = String(c.type ?? '');
    const lit = literal(c.expected);
    const body = bodyExpr(c.path);
    if (type === 'status' || type === 'http-status') {
      const list = Array.isArray(c.expected) ? c.expected : [c.expected ?? 200];
      const parts = list.map((e) => {
        const cls = typeof e === 'string' ? /^(\d)xx$/i.exec(e) : null;
        if (cls) return `$statusCode >= ${cls[1]}00 && $statusCode < ${Number(cls[1]) + 1}00`;
        return Number.isFinite(Number(e)) ? `$statusCode == ${Number(e)}` : undefined;
      });
      if (parts.some((p) => p === undefined) || (parts.length > 1 && parts.some((p) => p!.includes('&&')))) rest.push(c);
      else criteria.push({ condition: parts.join(' || ') });
    } else if ((type === 'equals' || type === 'json-path') && c.path && body && lit !== undefined) criteria.push({ condition: `${body} == ${lit}` });
    else if (type === 'not-equals' && c.path && body && lit !== undefined) criteria.push({ condition: `${body} != ${lit}` });
    else if (type === 'exists' && body) criteria.push({ condition: `${body} != null` });
    else if (type === 'exists' && c.path) criteria.push({ context: '$response.body', condition: String(c.path), type: 'jsonpath' });
    else if ((type === 'greater-than' || type === 'less-than') && body && typeof c.expected === 'number') criteria.push({ condition: `${body} ${type === 'greater-than' ? '>' : '<'} ${c.expected}` });
    else if (type === 'threshold' && body && (c.min !== undefined || c.max !== undefined)) {
      if (c.min !== undefined) criteria.push({ condition: `${body} >= ${Number(c.min)}` });
      if (c.max !== undefined) criteria.push({ condition: `${body} <= ${Number(c.max)}` });
    } else if (type === 'header' && c.header) {
      const e = `$response.header.${String(c.header)}`;
      if (c.expected === undefined) criteria.push({ condition: `${e} != null` });
      else if (lit !== undefined) criteria.push({ condition: `${e} == ${lit}` });
      else rest.push(c);
    } else if ((type === 'regex' || type === 'matches') && body && !c.flags) criteria.push({ context: body, condition: String(c.pattern ?? c.expected ?? ''), type: 'regex' });
    else rest.push(c);
  }
  return { criteria, rest };
}

/** A URL path template match: /pets/{{id}} or /pets/42 against /pets/{petId}; returns the path parameter values. */
function matchPath(template: string, actual: string): Record<string, string> | undefined {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (t.length !== a.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const m = /^\{([^}]+)\}$/.exec(t[i]!);
    if (m) params[m[1]!] = a[i]!;
    else if (t[i] !== a[i]) return undefined;
  }
  return params;
}

function serverPaths(doc: ArazzoJson): string[] {
  const out = new Set<string>(['']);
  for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
    try {
      const u = String(s?.url ?? '').replace(/\{[^}]+\}/g, 'x');
      out.add(new URL(u, 'http://x').pathname.replace(/\/+$/, ''));
    } catch {
      /* ignore */
    }
  }
  if (doc.basePath) out.add(String(doc.basePath).replace(/\/+$/, ''));
  return [...out];
}

function serverOrigins(doc: ArazzoJson): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(doc.servers) ? doc.servers : []) if (/^https?:\/\//i.test(String(s?.url ?? ''))) out.push(String(s.url).replace(/\/+$/, ''));
  if (doc.host) out.push(`${(doc.schemes ?? ['https'])[0]}://${doc.host}${doc.basePath ?? ''}`);
  return out;
}

/** The operation of a source a request calls, by method and path. */
function matchOperation(sources: ArazzoSource[], method: string, url: string): { source: ArazzoSource; path: string; op: ArazzoJson; pathParams: Record<string, string> } | undefined {
  const m = method.toLowerCase();
  if (!METHODS.includes(m)) return undefined;
  for (const s of sources) {
    if (!s.doc || s.type !== 'openapi') continue;
    // the request's path: after a {{…baseUrl}} prefix, or after one of the document's server URLs
    let rest: string | undefined;
    const v = /^\{\{[A-Za-z0-9_.-]*\}\}(.*)$/.exec(url);
    if (v) rest = v[1];
    else for (const o of serverOrigins(s.doc)) if (url.startsWith(o)) rest = url.slice(o.length);
    if (rest === undefined) {
      try {
        rest = new URL(url).pathname;
      } catch {
        continue;
      }
    }
    rest = rest.split('?')[0]!.split('#')[0]!;
    for (const prefix of serverPaths(s.doc)) {
      if (prefix && !rest.startsWith(prefix)) continue;
      const p = rest.slice(prefix.length) || '/';
      for (const [path, item] of Object.entries<any>(s.doc.paths ?? {})) {
        const op = item?.[m];
        if (!op) continue;
        const pathParams = matchPath(path, p);
        if (pathParams) return { source: s, path, op, pathParams };
      }
    }
  }
  return undefined;
}

const escapePointer = (p: string) => p.replace(/~/g, '~0').replace(/\//g, '~1');

/** Convert a flow file's text into an Arazzo document. */
export function exportArazzo(text: string, opts: ArazzoExportOptions = {}): ArazzoExportResult {
  let data: ArazzoJson;
  try {
    data = (opts.file && extname(opts.file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text)) as ArazzoJson;
  } catch (e) {
    throw new ApsError('ValidationError', `The flow file does not parse: ${(e as Error).message}`);
  }
  if (!isRecord(data)) throw new ApsError('ValidationError', 'A flow file is a map with tests: (or one test)');
  const notes: string[] = [];
  const marks = arazzoMarks(text);
  const sources = (opts.sources?.length ? opts.sources : marks.sources).filter((s) => s.name);
  const workflowId = opts.workflowId ?? marks.workflowId ?? (opts.file ? basename(opts.file).replace(/\.(ya?ml|json)$/i, '') : 'flow').replace(/[^A-Za-z0-9_-]+/g, '-');
  const defaults = isRecord(data.defaults) ? data.defaults : {};
  const tests: ArazzoJson[] = (Array.isArray(data.tests) ? data.tests : data.tests ? [] : [data]).filter(isRecord).map((t) => ({ ...defaults, ...t }));
  const idOf = (t: ArazzoJson, i: number) => String(t.id ?? (t.name ? String(t.name).replace(/[^A-Za-z0-9_-]+/g, '-') : `step-${i + 1}`));
  const ids = tests.map(idOf);

  // steps in an order that respects dependsOn (the file's order where it is free)
  const order: number[] = [];
  const placed = new Set<number>();
  const visit = (i: number, stack: Set<number>) => {
    if (placed.has(i) || stack.has(i)) return;
    stack.add(i);
    for (const d of asList(tests[i]!.dependsOn)) {
      const j = ids.indexOf(d);
      if (j >= 0) visit(j, stack);
    }
    placed.add(i);
    order.push(i);
  };
  tests.forEach((_, i) => visit(i, new Set()));

  // which step extracts each variable, and under which output name
  const producer = new Map<string, { step: string; output: string }>();
  tests.forEach((t, i) => {
    const sid = ids[i]!;
    const prefix = `${sid.replace(/[^A-Za-z0-9_]/g, '_')}_`;
    for (const name of Object.keys(isRecord(t.extract) ? t.extract : {}))
      producer.set(name, { step: sid, output: name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name });
    // header outputs an import turned into tp.variables.set('x', tp.response.headers.get('H'))
    for (const m of String(t.testScript ?? '').matchAll(/tp\.variables\.set\('([^']+)',\s*tp\.response\.headers\.get\('([^']+)'\)\)/g))
      producer.set(m[1]!, { step: sid, output: m[1]!.startsWith(prefix) ? m[1]!.slice(prefix.length) : m[1]! });
  });
  const expose = isRecord(data.expose) ? data.expose : undefined;
  const declared = new Map<string, ArazzoJson>(
    (Array.isArray(expose?.inputs) ? expose!.inputs : [])
      .map((x: unknown) => (typeof x === 'string' ? { name: x } : (x as ArazzoJson)))
      .filter((x: ArazzoJson) => x?.name)
      .map((x: ArazzoJson) => [String(x.name), x]),
  );
  const usedInputs = new Set<string>();
  const BASE = /^\w*baseUrl$/i;

  /** {{variable}} → a runtime expression ($steps.x.outputs.y or $inputs.z). */
  const exprOf = (name: string): string => {
    const p = producer.get(name);
    if (p) return `$steps.${p.step}.outputs.${p.output}`;
    if (name.startsWith('$')) {
      notes.push(`{{${name}}} (a built-in value) has no Arazzo form; it is an input`);
    }
    usedInputs.add(name);
    return `$inputs.${name}`;
  };
  /** A value with {{variables}} → the same with runtime expressions (a whole {{x}} → the bare expression). */
  const valueOf = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(v);
      if (whole) return exprOf(whole[1]!);
      return v.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_, n: string) => `{${exprOf(n)}}`);
    }
    if (Array.isArray(v)) return v.map(valueOf);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, valueOf(x)]));
    return v;
  };

  const steps: ArazzoJson[] = [];
  let prev: string | undefined;
  for (const i of order) {
    const t = tests[i]!;
    const sid = ids[i]!;
    const step: ArazzoJson = { stepId: sid };
    if (t.description || (t.name && t.name !== sid)) step.description = String(t.description ?? t.name);
    const type = String(t.type ?? (t.request || t.url ? 'http' : ''));
    const deps = asList(t.dependsOn);
    if (deps.length && !(deps.length === 1 && deps[0] === prev)) step['x-testpion-dependsOn'] = deps;
    const extras: ArazzoJson = {};
    for (const k of ['if', 'when', 'repeat', 'forEach', 'skip', 'timeout', 'vars', 'preRequestScript', 'tags']) if (t[k] !== undefined) extras[k] = t[k];
    if (type === 'http') {
      const r = isRecord(t.request) ? { ...t, ...t.request } : t;
      const method = String(r.method ?? 'GET').toUpperCase();
      const url = String(r.url ?? '');
      const match = matchOperation(sources, method, url);
      const parameters: ArazzoJson[] = [];
      if (match) {
        const single = sources.filter((s) => s.doc).length === 1;
        if (match.op.operationId) step.operationId = single ? String(match.op.operationId) : `$sourceDescriptions.${match.source.name}.${match.op.operationId}`;
        else step.operationPath = `{$sourceDescriptions.${match.source.name}.url}#/paths/${escapePointer(match.path)}/${method.toLowerCase()}`;
        for (const [name, value] of Object.entries(match.pathParams)) parameters.push({ name, in: 'path', value: valueOf(decodeURIComponent(value)) });
        const qs = url.split('?')[1];
        if (qs) for (const [name, value] of new URLSearchParams(qs)) parameters.push({ name, in: 'query', value: valueOf(value) });
        for (const [name, value] of kv(r.params ?? r.query)) parameters.push({ name, in: 'query', value: valueOf(value) });
        for (const [name, value] of kv(r.headers)) parameters.push({ name, in: 'header', value: valueOf(value) });
        for (const [name, value] of kv(r.cookies)) parameters.push({ name, in: 'cookie', value: valueOf(value) });
        if (parameters.length) step.parameters = parameters;
        if (r.auth) {
          extras.auth = r.auth;
          notes.push(`${sid}: auth is kept under x-testpion (Arazzo gives credentials as header parameters)`);
        }
      } else {
        step['x-testpion-request'] = Object.fromEntries(
          Object.entries({ method, url, params: r.params ?? r.query, headers: r.headers, cookies: r.cookies, auth: r.auth, body: r.body ?? r.json }).filter(([, v]) => v !== undefined),
        );
        notes.push(
          `${sid}: ${method} ${url} matches no operation of ${sources.some((s) => s.doc) ? 'the OpenAPI sources' : sources.length ? 'an OpenAPI source (their documents were not found)' : 'an OpenAPI source (none was given)'}; the request is kept in x-testpion-request`,
        );
      }
      const body = r.json !== undefined ? r.json : r.body;
      if (match && body !== undefined && body !== null) {
        if (isRecord(body) && typeof body.type === 'string' && ['json', 'text', 'xml', 'html', 'form-urlencoded', 'multipart', 'none', 'binary'].includes(body.type)) {
          if (body.type === 'json') {
            let payload: unknown = body.content;
            try {
              payload = typeof body.content === 'string' ? JSON.parse(body.content) : body.content;
            } catch {
              /* a JSON body with {{variables}} outside strings stays text */
            }
            step.requestBody = { contentType: 'application/json', payload: valueOf(payload) };
          } else if (body.type === 'form-urlencoded' || body.type === 'multipart')
            step.requestBody = { contentType: body.type === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded', payload: valueOf(Object.fromEntries(kv(body.fields))) };
          else if (body.type === 'text' || body.type === 'xml' || body.type === 'html') {
            const ct = kv(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
            step.requestBody = {
              contentType: String(ct ?? (body.type === 'xml' ? 'application/xml' : body.type === 'html' ? 'text/html' : 'text/plain')),
              payload: valueOf(String(body.content ?? '')),
            };
          } else if (body.type !== 'none') {
            extras.body = body;
            notes.push(`${sid}: a ${body.type} body is kept under x-testpion`);
          }
        } else step.requestBody = { contentType: 'application/json', payload: valueOf(body) };
        // the content type is the request body's, not a header parameter
        if (step.requestBody && Array.isArray(step.parameters)) {
          step.parameters = (step.parameters as ArazzoJson[]).filter((p) => !(p.in === 'header' && String(p.name).toLowerCase() === 'content-type'));
          if (!step.parameters.length) delete step.parameters;
        }
      }
    } else if (type === 'flow' && (t.file || t.flow)) {
      const target = basename(String(t.file ?? t.flow)).replace(/\.(ya?ml|json)$/i, '');
      step.workflowId = target;
      const params = Object.entries(isRecord(t.inputs) ? t.inputs : {}).map(([name, value]) => ({ name, value: valueOf(value) }));
      if (params.length) step.parameters = params;
      notes.push(`${sid}: runs the flow ${String(t.file ?? t.flow)} as workflow ${target}: export that file into the same document`);
    } else {
      step['x-testpion-step'] = t;
      notes.push(`${sid}: a ${type || 'non-HTTP'} step has no Arazzo form; it is kept in x-testpion-step`);
    }
    const outputs: ArazzoJson = {};
    for (const [name, path] of Object.entries(isRecord(t.extract) ? t.extract : {})) {
      const out = producer.get(name)!.output;
      const p = String(path);
      if (p === '$status') outputs[out] = '$statusCode';
      else if (p === '$text') outputs[out] = '$response.body';
      else {
        const e = bodyExpr(p);
        outputs[out] = e ?? { context: '$response.body', selector: p, type: 'jsonpath' };
      }
    }
    for (const m of String(t.testScript ?? '').matchAll(/tp\.variables\.set\('([^']+)',\s*tp\.response\.headers\.get\('([^']+)'\)\)/g))
      outputs[producer.get(m[1]!)!.output] = `$response.header.${m[2]}`;
    const otherScript = String(t.testScript ?? '')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\s*tp\.variables\.set\('[^']+',\s*tp\.response\.headers\.get\('[^']+'\)\);?\s*$/.test(l))
      .join('\n');
    if (otherScript) extras.testScript = otherScript;
    if (Object.keys(outputs).length) step.outputs = outputs;
    const checks = (Array.isArray(t.assertions) ? t.assertions : Array.isArray(t.checks) ? t.checks : []).filter(isRecord);
    if (checks.length) {
      const { criteria, rest } = checksToCriteria(checks);
      if (criteria.length) step.successCriteria = criteria;
      if (rest.length) {
        step['x-testpion-assertions'] = rest;
        notes.push(`${sid}: ${rest.length} check${rest.length > 1 ? 's' : ''} (${[...new Set(rest.map((c) => c.type))].join(', ')}) kept in x-testpion-assertions`);
      }
    }
    const retries = Number(t.retries ?? 0);
    if (retries > 0) step.onFailure = [{ name: 'retry', type: 'retry', retryLimit: retries }];
    if (Object.keys(extras).length) {
      step['x-testpion'] = extras;
      const flow = ['if', 'when', 'repeat', 'forEach'].filter((k) => extras[k] !== undefined);
      if (flow.length) notes.push(`${sid}: ${flow.join(', ')} kept under x-testpion (Arazzo steps have no such keys)`);
    }
    steps.push(step);
    prev = sid;
  }

  // inputs: the flow's exposed inputs and any other variable a step reads that no step extracts
  const properties: ArazzoJson = {};
  const required: string[] = [];
  for (const [name, i] of declared) {
    properties[name] = { type: 'string', ...(i.description ? { description: String(i.description) } : {}), ...(i.default !== undefined ? { default: i.default } : {}) };
    if (i.required === true || (i.required === undefined && i.default === undefined)) required.push(name);
  }
  for (const name of usedInputs) if (!declared.has(name) && !BASE.test(name)) properties[name] = { type: 'string' };
  const workflow: ArazzoJson = { workflowId };
  if (data.name && data.name !== workflowId) workflow.summary = String(data.name);
  if (data.description) workflow.description = String(data.description);
  if (Object.keys(properties).length) workflow.inputs = { type: 'object', properties, ...(required.length ? { required } : {}) };
  workflow.steps = steps;
  if (isRecord(data.output)) workflow.outputs = Object.fromEntries(Object.entries(data.output).map(([k, v]) => [k, valueOf(v)]));

  const sourceDescriptions = sources.map((s) => ({ name: s.name, url: s.url, type: s.type || 'openapi' }));
  if (!sourceDescriptions.length) {
    sourceDescriptions.push({ name: 'api', url: './openapi.yaml', type: 'openapi' });
    notes.unshift('no OpenAPI source was given: sourceDescriptions has a placeholder (api, ./openapi.yaml); point it at the API description');
  }
  const document: ArazzoJson = {
    arazzo: opts.version ?? '1.0.1',
    info: { title: String(data.name ?? workflowId), version: '1.0.0', ...(data.description ? { description: String(data.description) } : {}) },
    sourceDescriptions,
    workflows: [workflow],
  };
  return { document, text: stringifyYaml(document, { lineWidth: 0 }), notes };
}

/**
 * Export a flow file of a workspace (a path under tests/, or relative to the workspace) as Arazzo. The OpenAPI
 * sources are, in order: `spec` (a workspace file, e.g. specs/petstore.json), the arazzo-source comments an import
 * left in the file (found in the workspace), else the workspace's spec that describes the most of its requests.
 */
export function exportArazzoFromWorkspace(
  store: Pick<WorkspaceStore, 'root' | 'path' | 'safePath'>,
  file: string,
  opts: { spec?: string; workflowId?: string } = {},
): ArazzoExportResult & { file: string; sources: string[] } {
  const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates = rel.startsWith('tests/') ? [rel] : [`tests/${rel}`, rel];
  const found = candidates.find((c) => existsSync(store.safePath(c)));
  if (!found) throw new ApsError('ConfigurationError', `No flow file ${file} in the workspace (tests/…)`);
  const text = readFileSync(store.safePath(found), 'utf8');
  const load = (name: string, url: string, path: string): ArazzoSource | undefined => {
    const raw = readSourceFile(path, { workspace: store.root, name });
    if (raw === undefined) return undefined;
    try {
      const doc = (raw.trimStart().startsWith('{') ? JSON.parse(raw) : parseYaml(raw)) as ArazzoJson;
      return { name, url, type: 'openapi', doc };
    } catch {
      return undefined;
    }
  };
  const nameOf = (path: string) =>
    basename(path)
      .replace(/\.(openapi|swagger)?\.?(ya?ml|json)$/i, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-') || 'api';
  let sources: ArazzoSource[] | undefined;
  if (opts.spec) {
    const s = load(nameOf(opts.spec), `./${opts.spec.replace(/\\/g, '/')}`, opts.spec);
    if (!s) throw new ApsError('ConfigurationError', `No OpenAPI document ${opts.spec} in the workspace`);
    sources = [s];
  } else {
    const marks = arazzoMarks(text).sources;
    if (marks.length) sources = marks.map((m) => (m.type === 'openapi' ? load(m.name, m.url, m.url) : undefined) ?? m);
    else {
      // the workspace spec that describes the most requests of the flow
      let best: { s: ArazzoSource; n: number } | undefined;
      for (const spec of listSpecs(store)) {
        const s = load(nameOf(spec), `./${spec}`, spec);
        if (!s) continue;
        const n = exportArazzo(text, { file: found, sources: [s] }).document.workflows[0].steps.filter((x: ArazzoJson) => x.operationId || x.operationPath).length;
        if (n > (best?.n ?? 0)) best = { s, n };
      }
      if (best) sources = [best.s];
    }
  }
  const r = exportArazzo(text, { file: found, sources, workflowId: opts.workflowId });
  return { ...r, file: found, sources: (sources ?? []).map((s) => `${s.name}: ${s.url}${s.doc ? '' : ' (not found)'}`) };
}
