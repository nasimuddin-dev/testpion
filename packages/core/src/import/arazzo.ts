import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseYaml, yaml } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { deref } from '../util/json-ref.js';

/**
 * Arazzo 1.x (the OpenAPI Initiative's workflow format) → TestPion flow files. Each workflow becomes one test file:
 * its steps in order, each depending on the one before; an operation (operationId or operationPath) becomes the
 * method and URL from the OpenAPI document (base URL as {{baseUrl}}); runtime expressions become {{variables}}
 * (`$inputs.z` → {{z}}, `$steps.x.outputs.y` → {{x_y}} with an `extract` on step x); success criteria become checks;
 * a retry on failure becomes `retries`. What a flow file cannot say (goto, xpath criteria …) stays as a comment in
 * the file and is listed in `notes`.
 */

export type ArazzoJson = Record<string, any>;

/** An OpenAPI document the workflows refer to, by its source description name. */
export interface ArazzoSource {
  name: string;
  url: string;
  type: string;
  /** The parsed OpenAPI document, when it was found. */
  doc?: ArazzoJson;
}

export interface ArazzoFlowFile {
  workflowId: string;
  /** Where the file goes, relative to the workspace (tests/arazzo/<workflow>.yaml). */
  path: string;
  text: string;
  steps: number;
}

export interface ArazzoImportResult {
  title: string;
  version?: string;
  flows: ArazzoFlowFile[];
  /** What did not come over, or came over only in part. */
  notes: string[];
  /** Source descriptions whose document was not found (operationId steps that use them are left to fill in). */
  unresolvedSources: string[];
  /** Base URL variables the flows use, with the server URL of their OpenAPI document when it has one. */
  baseUrls: Record<string, string | undefined>;
}

export interface ArazzoImportOptions {
  /** OpenAPI documents (text or parsed) by source description name, found by the caller (resolveArazzoSources). */
  sources?: Record<string, string | ArazzoJson | undefined>;
  /** The folder the files go to, relative to the workspace (default tests/arazzo). */
  folder?: string;
}

/** Whether a parsed document is an Arazzo description (`arazzo: 1.x` at the top). */
export function isArazzo(d: unknown): boolean {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const v = (d as ArazzoJson).arazzo;
  return (typeof v === 'string' || typeof v === 'number') && /^1(\.|$)/.test(String(v)) && Array.isArray((d as ArazzoJson).workflows);
}

export function parseArazzo(text: string): ArazzoJson {
  let d: unknown;
  try {
    d = text.trimStart().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ApsError('ValidationError', `Invalid Arazzo document: ${(e as Error).message}`);
  }
  if (!isArazzo(d)) throw new ApsError('ValidationError', 'Not an Arazzo 1.x document: it needs arazzo: 1.0.x and a workflows list at the top');
  return d as ArazzoJson;
}

const parseDoc = (v: string | ArazzoJson | undefined): ArazzoJson | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return v;
  try {
    const d = v.trimStart().startsWith('{') ? JSON.parse(v) : parseYaml(v);
    return d && typeof d === 'object' ? (d as ArazzoJson) : undefined;
  } catch {
    return undefined;
  }
};

/** A variable name from parts (step id and output name): letters, digits and _. */
export const arazzoVarName = (...parts: string[]) =>
  parts
    .join('_')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1');

/** A JSON Pointer (/a/0/b) → a JSONPath ($.a[0].b). */
export function pointerToJsonPath(ptr: string): string {
  const p = ptr.replace(/^#/, '');
  if (p === '' || p === '/') return '$';
  const parts = p
    .replace(/^\//, '')
    .split('/')
    .map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  return '$' + parts.map((x) => (/^\d+$/.test(x) ? `[${x}]` : /^[A-Za-z_$][\w$]*$/.test(x) ? `.${x}` : `['${x.replace(/'/g, "\\'")}']`)).join('');
}

/** A simple JSONPath ($.a[0].b, $['x-y']) → a JSON Pointer (/a/0/b); undefined for filters, wildcards and the like. */
export function jsonPathToPointer(path: string): string | undefined {
  if (path === '$') return '';
  if (!path.startsWith('$')) return undefined;
  const parts: string[] = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['((?:[^'\\]|\\.)*)'\]|\["((?:[^"\\]|\\.)*)"\]/y;
  let i = 1;
  while (i < path.length) {
    re.lastIndex = i;
    const m = re.exec(path);
    if (!m) return undefined;
    parts.push((m[1] ?? m[2] ?? (m[3] ?? m[4])!.replace(/\\(.)/g, '$1')).replace(/~/g, '~0').replace(/\//g, '~1'));
    i = re.lastIndex;
  }
  return '/' + parts.join('/');
}

/** `$response.body.a.b[0]` (dotted form) → JSONPath `$.a.b[0]`. */
const dottedToJsonPath = (rest: string) => '$' + (rest.startsWith('.') || rest.startsWith('[') ? rest : rest ? `.${rest}` : '');

/** Where a response value comes from, for an extract: a JSONPath, $status, $text, or a header. */
type ResponseRef = { path: string } | { header: string } | undefined;
function responseRef(expr: string): ResponseRef {
  const e = expr.trim();
  if (e === '$statusCode') return { path: '$status' };
  if (e === '$response.body') return { path: '$' };
  let m = /^\$response\.body#(.*)$/.exec(e);
  if (m) return { path: pointerToJsonPath(m[1]!) };
  m = /^\$response\.body((?:\.|\[).*)$/.exec(e);
  if (m) return { path: dottedToJsonPath(m[1]!) };
  m = /^\$response\.header\.(.+)$/.exec(e);
  if (m) return { header: m[1]! };
  return undefined;
}

/** A literal of a simple condition: number, 'text' (quotes doubled inside), true, false, null. */
function parseLiteral(s: string): { value: unknown } | undefined {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return { value: Number(t) };
  if (t === 'true' || t === 'false') return { value: t === 'true' };
  if (t === 'null') return { value: null };
  const q = /^'((?:[^']|'')*)'$/.exec(t) ?? /^"((?:[^"]|"")*)"$/.exec(t);
  if (q) return { value: q[1]!.replace(/''/g, "'").replace(/""/g, '"') };
  return undefined;
}

/** Split a condition on top-level && (outside quotes and parentheses); undefined when it has || or grouping. */
function splitAnd(cond: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < cond.length; i++) {
    const c = cond[i]!;
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth === 0 && cond.startsWith('&&', i)) {
      out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    if (cond.startsWith('||', i) && !quote) return undefined;
    cur += c;
  }
  out.push(cur.trim());
  const parts = out.filter(Boolean).map((p) => (/^\((.*)\)$/.test(p) && !/[()]/.test(p.slice(1, -1)) ? p.slice(1, -1).trim() : p));
  return parts.some((p) => /[()]/.test(p.replace(/'(?:[^']|'')*'/g, ''))) ? undefined : parts;
}

/** A check (assertion) of a test file. */
export type ArazzoCheck = Record<string, unknown>;

/**
 * Arazzo success criteria → checks. Simple conditions joined by && (each part one check), jsonpath criteria on the
 * body (an `exists` check) and regex criteria on the body; anything else is returned in `unsupported`.
 */
export function criteriaToChecks(criteria: unknown[]): { checks: ArazzoCheck[]; unsupported: string[] } {
  const checks: ArazzoCheck[] = [];
  const unsupported: string[] = [];
  for (const raw of criteria ?? []) {
    const c = (raw ?? {}) as ArazzoJson;
    const cond = String(c.condition ?? '');
    const type = typeof c.type === 'object' && c.type ? String(c.type.type) : String(c.type ?? 'simple');
    const ctx = c.context === undefined ? undefined : String(c.context);
    const say = () => unsupported.push(`${type !== 'simple' ? `${type} ` : ''}criterion ${JSON.stringify(cond)}${ctx ? ` on ${ctx}` : ''}`);
    if (type === 'jsonpath') {
      const ref = ctx ? responseRef(ctx) : { path: '$' };
      if (ref && 'path' in ref && ref.path === '$') checks.push({ type: 'exists', path: cond });
      else say();
      continue;
    }
    if (type === 'regex') {
      const ref = ctx ? responseRef(ctx) : undefined;
      if (ref && 'path' in ref && ref.path !== '$status') checks.push({ type: 'regex', ...(ref.path === '$' ? {} : { path: ref.path }), expected: cond });
      else say();
      continue;
    }
    if (type !== 'simple' || ctx) {
      say();
      continue;
    }
    const parts = splitAnd(cond);
    if (!parts) {
      say();
      continue;
    }
    const mine: ArazzoCheck[] = [];
    let statusMin: number | undefined;
    let statusMax: number | undefined;
    let ok = true;
    for (const p of parts) {
      const m = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(p);
      const lit = m ? parseLiteral(m[3]!) : undefined;
      if (!m || !lit) {
        ok = false;
        break;
      }
      const [, left, op] = m;
      const value = lit.value;
      const ref = responseRef(left!);
      if (!ref) {
        ok = false;
        break;
      }
      if ('header' in ref) {
        if (op === '==' && value !== null) mine.push({ type: 'header', header: ref.header, expected: value });
        else if (op === '!=' && value === null) mine.push({ type: 'header', header: ref.header });
        else ok = false;
      } else if (ref.path === '$status') {
        if (typeof value !== 'number') ok = false;
        else if (op === '==') mine.push({ type: 'status', expected: value });
        else if (op === '>=') statusMin = value;
        else if (op === '>') statusMin = value + 1;
        else if (op === '<') statusMax = value - 1;
        else if (op === '<=') statusMax = value;
        else ok = false;
      } else {
        const path = ref.path;
        if (op === '==') mine.push({ type: 'equals', path, expected: value });
        else if (op === '!=') mine.push(value === null ? { type: 'exists', path } : { type: 'not-equals', path, expected: value });
        else if (typeof value !== 'number') ok = false;
        else if (op === '>') mine.push({ type: 'greater-than', path, expected: value });
        else if (op === '<') mine.push({ type: 'less-than', path, expected: value });
        else if (op === '>=') mine.push({ type: 'threshold', path, min: value });
        else mine.push({ type: 'threshold', path, max: value });
      }
      if (!ok) break;
    }
    if (ok && (statusMin !== undefined || statusMax !== undefined)) {
      // $statusCode >= 200 && $statusCode < 300 is the 2xx class
      if (statusMin !== undefined && statusMax !== undefined && statusMin % 100 === 0 && statusMax === statusMin + 99) mine.push({ type: 'status', expected: `${statusMin / 100}xx` });
      else ok = false;
    }
    if (ok) checks.push(...mine);
    else say();
  }
  return { checks, unsupported };
}

interface Op {
  method: string;
  path: string;
  source?: ArazzoSource;
  op?: ArazzoJson;
  pathItem?: ArazzoJson;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** `{$sourceDescriptions.petstore.url}#/paths/~1pets~1{petId}/get` → the source name, the path and the method. */
export function parseOperationPath(p: string): { source?: string; path: string; method: string } | undefined {
  const m = /^(?:\{\$sourceDescriptions\.([^.}]+)\.url\}|[^#]*)#\/paths\/([^/]+)\/([a-z]+)$/i.exec(p.trim());
  if (!m) return undefined;
  return { source: m[1], path: decodeURIComponent(m[2]!).replace(/~1/g, '/').replace(/~0/g, '~'), method: m[3]!.toLowerCase() };
}

/** The base URL variable of a source: {{baseUrl}} for the first OpenAPI source, {{<name>_baseUrl}} for others. */
function baseVar(sources: ArazzoSource[], s: ArazzoSource | undefined): string {
  const first = sources.find((x) => x.type === 'openapi') ?? sources[0];
  return !s || s === first ? 'baseUrl' : arazzoVarName(s.name, 'baseUrl');
}

function serverUrl(doc: ArazzoJson | undefined): string | undefined {
  if (!doc) return undefined;
  if (doc.swagger) return doc.host ? `${(doc.schemes ?? ['https'])[0]}://${doc.host}${doc.basePath ?? ''}` : undefined;
  let u = doc.servers?.[0]?.url as string | undefined;
  if (!u) return undefined;
  for (const [k, v] of Object.entries<any>(doc.servers[0].variables ?? {})) u = u.replace(`{${k}}`, v?.default ?? '');
  return u;
}

function findOperation(sources: ArazzoSource[], step: ArazzoJson): { op?: Op; problem?: string } {
  if (step.operationPath) {
    const p = parseOperationPath(String(step.operationPath));
    if (!p) return { problem: `operationPath ${JSON.stringify(step.operationPath)} is not {$sourceDescriptions.<name>.url}#/paths/<path>/<method>` };
    const source = p.source ? sources.find((s) => s.name === p.source) : (sources.find((s) => s.type === 'openapi') ?? sources[0]);
    const pathItem = source?.doc?.paths?.[p.path];
    return { op: { method: p.method, path: p.path, source, pathItem, op: pathItem?.[p.method] } };
  }
  const raw = String(step.operationId);
  const m = /^\$sourceDescriptions\.([^.]+)\.(.+)$/.exec(raw);
  const id = m ? m[2]! : raw;
  const candidates = m ? sources.filter((s) => s.name === m[1]) : sources;
  for (const s of candidates)
    for (const [path, item] of Object.entries<any>(s.doc?.paths ?? {}))
      for (const method of METHODS) if (item?.[method]?.operationId === id) return { op: { method, path, source: s, pathItem: item, op: item[method] } };
  const missing = candidates.filter((s) => !s.doc).map((s) => s.name);
  return { problem: `operation ${id} was not found${missing.length ? ` (the document of ${missing.join(', ')} was not found)` : ' in the OpenAPI documents'}` };
}

/** Converts runtime expressions to {{variables}} for one workflow. */
class Expressions {
  /** step id → output name → the variable that holds it. */
  outputs = new Map<string, Map<string, string>>();
  constructor(private notes: (s: string) => void) {}

  /** One expression ($inputs.x, $steps.a.outputs.b …) → a {{variable}}; undefined when it has no equivalent. */
  template(expr: string): string | undefined {
    const e = expr.trim();
    let m = /^\$inputs\.([A-Za-z0-9_.-]+)$/.exec(e);
    if (m) {
      const [name, ...rest] = m[1]!.split('.');
      if (rest.length) this.notes(`${e}: only the input ${name} is used (a part of an input is not a variable)`);
      return `{{${name}}}`;
    }
    m = /^\$steps\.([^.]+)\.outputs\.([A-Za-z0-9_-]+)(.*)$/.exec(e);
    if (m) {
      if (m[3]) this.notes(`${e}: only the output ${m[2]} of ${m[1]} is used`);
      return `{{${this.outputs.get(m[1]!)?.get(m[2]!) ?? arazzoVarName(m[1]!, m[2]!)}}}`;
    }
    m = /^\$workflows\.([^.]+)\.(?:outputs|inputs)\.([A-Za-z0-9_-]+)$/.exec(e);
    if (m) {
      this.notes(`${e}: another workflow's value is read as the variable {{${m[2]}}} (run that flow first, or call it as a sub-flow step)`);
      return `{{${m[2]}}}`;
    }
    return undefined;
  }

  /** A value with expressions (whole, or embedded as {$…} in a text) → the same value with {{variables}}. */
  value(v: unknown, where: string): unknown {
    if (typeof v === 'string') {
      if (v.startsWith('$')) {
        const t = this.template(v);
        if (t) return t;
        if (/^\$[a-zA-Z]/.test(v)) this.notes(`${where}: ${v} has no equivalent in a flow file; kept as text`);
        return v;
      }
      return v.replace(/\{(\$[^{}]+)\}/g, (all, expr: string) => {
        const t = this.template(expr);
        if (t) return t;
        this.notes(`${where}: ${expr} has no equivalent in a flow file; kept as text`);
        return all;
      });
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x, where));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.value(x, where)]));
    return v;
  }
}

/** Resolve `{ reference: $components.parameters.x, value }` objects. */
function resolveReusable(item: unknown, components: ArazzoJson | undefined): ArazzoJson | undefined {
  const it = (item ?? {}) as ArazzoJson;
  if (typeof it.reference !== 'string') return it;
  const m = /^\$components\.([A-Za-z]+)\.([A-Za-z0-9._-]+)$/.exec(it.reference);
  const found = m ? components?.[m[1]!]?.[m[2]!] : undefined;
  if (!found) return undefined;
  return it.value !== undefined ? { ...found, value: it.value } : found;
}

/** JSON Pointer set (for requestBody replacements). */
function setPointer(obj: unknown, ptr: string, value: unknown): boolean {
  const parts = ptr
    .replace(/^#?\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = obj as ArazzoJson;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return false;
    cur = cur[parts[i]!];
  }
  if (!cur || typeof cur !== 'object') return false;
  cur[parts.at(-1)!] = value;
  return true;
}

/** The documented input properties of a workflow (inputs is a JSON Schema, maybe a $components.inputs reference). */
function inputsOf(wf: ArazzoJson, components: ArazzoJson | undefined): Array<{ name: string; description?: string; default?: string; required?: boolean }> {
  let schema = wf.inputs as ArazzoJson | undefined;
  if (schema?.$ref && typeof schema.$ref === 'string') {
    const m = /^#\/components\/inputs\/(.+)$/.exec(schema.$ref);
    schema = m ? components?.inputs?.[m[1]!] : undefined;
  }
  if (!schema || typeof schema !== 'object') return [];
  const req = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries<any>(schema.properties ?? {}).map(([name, p]) => ({
    name,
    ...(p?.description ? { description: String(p.description) } : {}),
    ...(p?.default !== undefined ? { default: typeof p.default === 'object' ? JSON.stringify(p.default) : String(p.default) } : {}),
    ...(req.has(name) ? { required: true } : {}),
  }));
}

/** snake_case tool name from a workflow id (exposed flows need one). */
const toolName = (id: string) =>
  (
    id
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'w_$1') || 'workflow'
  ).slice(0, 64);

/** The file a workflow goes to. */
export const arazzoFlowPath = (folder: string, workflowId: string) => `${folder.replace(/\/+$/, '')}/${slugify(workflowId)}.yaml`;

/** Header comments of an imported flow file: export reads them back (the workflow id and the sources). */
export const ARAZZO_WORKFLOW_MARK = 'arazzo-workflow:';
export const ARAZZO_SOURCE_MARK = 'arazzo-source:';

/** Convert an Arazzo document's workflows into flow files (nothing is written: the caller saves `flows`). */
export function importArazzo(text: string, opts: ArazzoImportOptions = {}): ArazzoImportResult {
  const d = parseArazzo(text);
  const folder = opts.folder ?? 'tests/arazzo';
  const notes: string[] = [];
  const sources: ArazzoSource[] = (Array.isArray(d.sourceDescriptions) ? d.sourceDescriptions : []).map((s: ArazzoJson) => ({
    name: String(s.name ?? 'source'),
    url: String(s.url ?? ''),
    type: String(s.type ?? 'openapi'),
    doc: parseDoc(opts.sources?.[String(s.name)]),
  }));
  const unresolvedSources = sources.filter((s) => s.type === 'openapi' && !s.doc).map((s) => s.name);
  const baseUrls: Record<string, string | undefined> = {};
  for (const s of sources.filter((x) => x.type === 'openapi')) baseUrls[baseVar(sources, s)] = serverUrl(s.doc);
  for (const s of sources.filter((x) => x.type !== 'openapi' && x.type !== 'arazzo')) notes.push(`source ${s.name} is ${s.type}: only OpenAPI operations become requests`);
  const components = d.components as ArazzoJson | undefined;
  const workflows: ArazzoJson[] = d.workflows;
  const fileOf = new Map(workflows.map((w) => [String(w.workflowId), arazzoFlowPath(folder, String(w.workflowId))]));
  const flows: ArazzoFlowFile[] = [];

  for (const wf of workflows) {
    const wid = String(wf.workflowId ?? 'workflow');
    const note = (s: string) => notes.push(`${wid}: ${s}`);
    const ex = new Expressions(note);
    const steps: ArazzoJson[] = Array.isArray(wf.steps) ? wf.steps : [];
    // first pass: every step's outputs and the variable that will hold each
    for (const st of steps) {
      const sid = String(st.stepId);
      const map = new Map<string, string>();
      for (const [name, expr] of Object.entries<any>(st.outputs ?? {})) {
        // a sub-flow step's $outputs.x is the sub-flow's own output variable x
        const sub = typeof expr === 'string' ? /^\$outputs\.([A-Za-z0-9_-]+)$/.exec(expr) : null;
        map.set(name, st.workflowId && sub ? sub[1]! : arazzoVarName(sid, name));
      }
      ex.outputs.set(sid, map);
    }
    if (wf.dependsOn?.length) note(`depends on workflow ${[].concat(wf.dependsOn).join(', ')}: run that flow first (a flow file does not chain files)`);
    if (wf.successActions?.length || wf.failureActions?.length) note('workflow-level success and failure actions are not imported');
    const wfParams: ArazzoJson[] = (Array.isArray(wf.parameters) ? wf.parameters : []).map((p: unknown) => resolveReusable(p, components)).filter(Boolean) as ArazzoJson[];

    const tests: ArazzoJson[] = [];
    const comments: string[][] = [];
    let prev: string | undefined;
    for (const st of steps) {
      const sid = String(st.stepId);
      const where = `step ${sid}`;
      const kept: string[] = [];
      const keep = (s: string) => {
        kept.push(s);
        note(`${where}: ${s}`);
      };
      const t: ArazzoJson = { id: sid, name: st.description ? String(st.description).split('\n')[0]!.slice(0, 120) : sid };
      if (st.description && String(st.description).length > t.name.length) t.description = String(st.description);
      if (prev) t.dependsOn = prev;
      const params: ArazzoJson[] = [...wfParams, ...(Array.isArray(st.parameters) ? st.parameters : [])]
        .map((p) => resolveReusable(p, components))
        .filter((p): p is ArazzoJson => {
          if (!p) keep('a parameter reference was not found in components');
          return !!p;
        });
      const extract: Record<string, string> = {};
      const scriptLines: string[] = [];
      for (const [name, expr] of Object.entries<any>(st.outputs ?? {})) {
        const v = ex.outputs.get(sid)!.get(name)!;
        if (st.workflowId) {
          if (!(typeof expr === 'string' && /^\$outputs\./.test(expr))) keep(`output ${name} (${JSON.stringify(expr)}) of a sub-flow step is not imported`);
          continue;
        }
        if (expr && typeof expr === 'object' && expr.selector) {
          const ctxRef = responseRef(String(expr.context ?? ''));
          const st2 = typeof expr.type === 'object' ? expr.type?.type : expr.type;
          if (ctxRef && 'path' in ctxRef && ctxRef.path === '$' && st2 === 'jsonpath') extract[v] = String(expr.selector);
          else keep(`output ${name}: a ${st2 ?? ''} selector on ${expr.context} is not imported`);
          continue;
        }
        const ref = typeof expr === 'string' ? responseRef(expr) : undefined;
        if (ref && 'path' in ref) extract[v] = ref.path;
        else if (ref && 'header' in ref) scriptLines.push(`tp.variables.set('${v}', tp.response.headers.get('${ref.header.replace(/'/g, "\\'")}'));`);
        else keep(`output ${name} (${JSON.stringify(expr)}) is not a response value; not imported`);
      }

      if (st.workflowId) {
        // a call to another workflow: a sub-flow step running that workflow's file
        const target = String(st.workflowId).replace(/^\$sourceDescriptions\.[^.]+\./, '');
        const file = fileOf.get(target);
        t.type = 'flow';
        if (file) t.file = `./${basename(file)}`;
        else {
          t.file = `./${slugify(target)}.yaml`;
          keep(`workflow ${st.workflowId} is in another document: import it too (it is expected at ${t.file})`);
        }
        const inputs: ArazzoJson = {};
        for (const p of params) inputs[String(p.name)] = ex.value(p.value, where);
        if (Object.keys(inputs).length) t.inputs = inputs;
      } else if (st.operationId || st.operationPath) {
        const { op, problem } = findOperation(sources, st);
        if (problem || !op) {
          keep(`${problem ?? 'operation not found'}: fill in the method and URL`);
          t.method = 'GET';
          t.url = `{{baseUrl}}/${String(st.operationId ?? st.operationPath)}`;
          t.skip = true;
        } else {
          t.method = op.method.toUpperCase();
          const declared = [...(op.pathItem?.parameters ?? []), ...(op.op?.parameters ?? [])].map((p: ArazzoJson) => (p?.$ref ? deref(op.source?.doc, p) : p)) as ArazzoJson[];
          const pathValues = new Map<string, string>();
          const query: ArazzoJson = {};
          const headers: ArazzoJson = {};
          const cookies: ArazzoJson = {};
          for (const p of params) {
            const name = String(p.name);
            const inn = String(p.in ?? declared.find((x) => x?.name === name)?.in ?? '');
            const value = ex.value(p.value, `${where} parameter ${name}`);
            const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
            if (inn === 'path') pathValues.set(name, text);
            else if (inn === 'query') query[name] = text;
            else if (inn === 'header') headers[name] = text;
            else if (inn === 'cookie') cookies[name] = text;
            else keep(`parameter ${name}${inn ? ` (in: ${inn})` : ''} has no place in the request; not imported`);
          }
          // path parameters the step does not give stay {{variables}}
          const path = op.path.replace(/\{([^}]+)\}/g, (_, n: string) => pathValues.get(n) ?? `{{${n}}}`);
          t.url = `{{${baseVar(sources, op.source)}}}${path}`;
          if (Object.keys(query).length) t.params = query;
          if (Object.keys(headers).length) t.headers = headers;
          if (Object.keys(cookies).length) t.cookies = cookies;
        }
        if (st.requestBody) {
          const rb = st.requestBody as ArazzoJson;
          let payload = rb.payload === undefined ? undefined : JSON.parse(JSON.stringify(rb.payload));
          for (const r of Array.isArray(rb.replacements) ? rb.replacements : []) {
            if (payload && typeof payload === 'object' && typeof r?.target === 'string' && r.target.startsWith('/') && setPointer(payload, r.target, r.value)) continue;
            keep(`request body replacement at ${JSON.stringify(r?.target)} is not imported`);
          }
          payload = ex.value(payload, `${where} request body`);
          const ct = String(rb.contentType ?? (typeof payload === 'object' ? 'application/json' : 'text/plain'));
          if (payload !== undefined) {
            if (/json/i.test(ct) && typeof payload === 'object') t.body = payload;
            else if (/x-www-form-urlencoded/i.test(ct) && payload && typeof payload === 'object' && !Array.isArray(payload))
              t.body = { type: 'form-urlencoded', fields: Object.entries(payload).map(([key, value]) => ({ key, value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '') })) };
            else if (/multipart/i.test(ct) && payload && typeof payload === 'object' && !Array.isArray(payload))
              t.body = { type: 'multipart', fields: Object.entries(payload).map(([key, value]) => ({ key, value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '') })) };
            else {
              t.body = { type: /json/i.test(ct) ? 'json' : /xml/i.test(ct) ? 'xml' : 'text', content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) };
              if (!/^(application\/json|text\/plain)$/i.test(ct)) t.headers = { 'Content-Type': ct, ...(t.headers ?? {}) };
            }
          }
        }
      } else if (st.channelPath) {
        keep('an AsyncAPI channel step is not imported (TestPion tests channels as websocket steps)');
        t.type = 'log';
        t.message = `AsyncAPI channel ${String(st.channelPath)}`;
      } else keep('the step has no operationId, operationPath or workflowId');

      if (Object.keys(extract).length) t.extract = extract;
      if (scriptLines.length) t.testScript = scriptLines.join('\n');
      if (st.successCriteria?.length) {
        const { checks, unsupported } = criteriaToChecks(st.successCriteria);
        if (t.type !== 'flow' && checks.length) t.assertions = checks;
        for (const u of unsupported) keep(`${u} is not a check here`);
        if (t.type === 'flow' && checks.length) keep('success criteria of a sub-flow step are not imported');
      }
      // actions: retry → retries; end on failure is what a flow does anyway; goto is kept as a comment
      for (const a0 of Array.isArray(st.onFailure) ? st.onFailure : []) {
        const a = resolveReusable(a0, components);
        if (!a) keep('a failure action reference was not found in components');
        else if (a.type === 'retry') {
          t.retries = Math.max(Number(t.retries ?? 0), Number(a.retryLimit ?? 1));
          if (a.retryAfter) keep(`retry after ${a.retryAfter}s: TestPion waits a short, growing pause between tries`);
          if (a.criteria?.length) keep(`the retry action "${a.name}" has criteria: the step is retried on any failure`);
        } else if (a.type === 'goto') keep(`on failure goto ${a.stepId ?? a.workflowId} ("${a.name}") is not supported`);
        else if (a.type === 'end' && a.criteria?.length) keep(`on failure end ("${a.name}") with criteria: a failed step ends its dependants anyway`);
      }
      for (const a0 of Array.isArray(st.onSuccess) ? st.onSuccess : []) {
        const a = resolveReusable(a0, components);
        if (!a) keep('a success action reference was not found in components');
        else keep(`on success ${[a.type, a.stepId ?? a.workflowId].filter(Boolean).join(' ')} ("${a.name}") is not supported`);
      }
      tests.push(t);
      comments.push(kept);
      prev = sid;
    }

    const file: ArazzoJson = { name: wf.summary ? String(wf.summary) : wid };
    if (wf.description) file.description = String(wf.description);
    const inputs = inputsOf(wf, components);
    if (inputs.length) file.expose = { tool: toolName(wid), ...(wf.summary || wf.description ? { description: String(wf.summary ?? wf.description) } : {}), inputs };
    file.defaults = { type: 'http' };
    file.tests = tests;
    const out: ArazzoJson = {};
    for (const [name, expr] of Object.entries<any>(wf.outputs ?? {})) {
      const v = typeof expr === 'string' ? ex.template(expr) : undefined;
      if (v) out[name] = v;
      else note(`workflow output ${name} (${JSON.stringify(expr)}) is not imported`);
    }
    if (Object.keys(out).length) file.output = out;

    const Y = yaml();
    const doc = new Y.Document(file);
    const header = [
      ` Imported from Arazzo: ${String(d.info?.title ?? 'workflows')}${d.info?.version ? ` ${d.info.version}` : ''}`,
      ` ${ARAZZO_WORKFLOW_MARK} ${wid}`,
      ...sources.map((s) => ` ${ARAZZO_SOURCE_MARK} ${s.name} ${s.type} ${s.url}`),
    ];
    const used = new Set<string>();
    for (const t of tests) for (const m of JSON.stringify(t).matchAll(/\{\{(\w*baseUrl)\}\}/g)) used.add(m[1]!);
    for (const b of used) header.push(` Set {{${b}}} in an environment${baseUrls[b] ? ` (the API's server: ${baseUrls[b]})` : ''}.`);
    doc.commentBefore = header.join('\n');
    const seq = doc.get('tests', true) as unknown as { items: Array<{ commentBefore?: string }> };
    comments.forEach((c, i) => {
      if (c.length && seq.items[i]) seq.items[i]!.commentBefore = c.map((x) => ` Arazzo, not imported: ${x}`.replace(/\n/g, ' ')).join('\n');
    });
    flows.push({ workflowId: wid, path: fileOf.get(wid)!, text: doc.toString({ lineWidth: 0 }), steps: tests.length });
  }
  for (const s of unresolvedSources)
    notes.unshift(`the OpenAPI document of source ${s} (${sources.find((x) => x.name === s)?.url}) was not found: operationId steps that use it are skipped until their method and URL are filled in`);
  return { title: String(d.info?.title ?? 'Arazzo'), version: d.info?.version ? String(d.info.version) : undefined, flows, notes, unresolvedSources, baseUrls };
}

/**
 * Find the OpenAPI documents of an Arazzo document's sources: a workspace file (the URL as a path, relative to the
 * Arazzo file's folder or the workspace, or a file of the same name in specs/), else, when `fetch` is allowed, the
 * URL itself. Returns the documents found by source name and what could not be found.
 */
export async function resolveArazzoSources(
  text: string,
  opts: { workspace?: string; baseDir?: string; fetch?: (url: string) => Promise<string> } = {},
): Promise<{ sources: Record<string, string>; missing: string[]; fetched: string[] }> {
  const local = resolveArazzoSourcesLocally(text, opts);
  const fetched: string[] = [];
  const missing: string[] = [];
  const d = parseArazzo(text);
  for (const s of (d.sourceDescriptions ?? []) as ArazzoJson[]) {
    const name = String(s.name);
    if (local.sources[name] !== undefined || (s.type ?? 'openapi') !== 'openapi') continue;
    const url = String(s.url ?? '');
    if (/^https?:\/\//i.test(url) && opts.fetch) {
      try {
        local.sources[name] = await opts.fetch(url);
        fetched.push(url);
        continue;
      } catch {
        /* reported below */
      }
    }
    missing.push(`${name} (${url})`);
  }
  return { sources: local.sources, missing, fetched };
}

/** The local part of resolveArazzoSources (no network): what the sync import of `testpion import` uses. */
export function resolveArazzoSourcesLocally(text: string, opts: { workspace?: string; baseDir?: string } = {}): { sources: Record<string, string> } {
  const d = parseArazzo(text);
  const sources: Record<string, string> = {};
  for (const s of (d.sourceDescriptions ?? []) as ArazzoJson[]) {
    if ((s.type ?? 'openapi') !== 'openapi') continue;
    const found = readSourceFile(String(s.url ?? ''), { ...opts, name: String(s.name ?? '') });
    if (found !== undefined) sources[String(s.name)] = found;
  }
  return { sources };
}

/** A source URL as a local file: a path relative to baseDir or the workspace, a file of the same name in specs/, or specs/<source name>.json|yaml. */
export function readSourceFile(url: string, opts: { workspace?: string; baseDir?: string; name?: string }): string | undefined {
  const clean = url.replace(/^file:\/\//i, '').split('#')[0]!;
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^file:/i.test(url);
  const candidates: string[] = [];
  if (!isUrl && clean) {
    if (isAbsolute(clean) && opts.workspace && resolve(clean).startsWith(resolve(opts.workspace))) candidates.push(clean);
    if (opts.baseDir) candidates.push(resolve(opts.baseDir, clean));
    if (opts.workspace) candidates.push(resolve(opts.workspace, clean));
  }
  const name = basename(clean.split('?')[0]!);
  if (opts.workspace && name) candidates.push(join(opts.workspace, 'specs', name));
  // a spec kept under the source's name: specs/<name>.json, specs/<name>.openapi.yaml …
  if (opts.workspace && opts.name && /^[\w.-]+$/.test(opts.name))
    for (const ext of ['json', 'yaml', 'yml', 'openapi.json', 'openapi.yaml', 'openapi.yml']) candidates.push(join(opts.workspace, 'specs', `${opts.name}.${ext}`));
  for (const c of candidates) {
    // only files inside the workspace or next to the Arazzo file
    const inside = [opts.workspace, opts.baseDir].some((root) => root && resolve(c).startsWith(resolve(root)));
    if (inside && existsSync(c)) {
      try {
        return readFileSync(c, 'utf8');
      } catch {
        /* try the next */
      }
    }
  }
  return undefined;
}
