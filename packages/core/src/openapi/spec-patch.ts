/**
 * Patching an OpenAPI document for the drift the traffic showed (AI-9): the change that makes the document say what the
 * API does, made from what was observed — never from a model's text. A finding becomes a small, serialisable operation
 * (add a property, set a type, make it nullable, drop a required entry, add an enum value, add a response) located in
 * the document's own structure (a `$ref` is followed to the schema it names), and the operations are applied to the
 * document's text: YAML keeps its comments and order (the `yaml` Document API), JSON is re-written with two spaces.
 *
 * Operations are idempotent and independent (adding what is already there changes nothing), so a reviewer can accept any
 * subset of them, and applying them to a document that changed since the proposal still does the right thing.
 */
import { isSeq, parseDocument } from '../util/lazy-yaml.js';
import type { OpenApiDoc } from './contract.js';
import { jsonType, resolveRef, type DriftFinding } from './drift.js';
import { isRecord } from '@testpion/shared';

type Json = Record<string, unknown>;

export type PatchOp =
  | { op: 'add-property'; at: Array<string | number>; name: string; schema: Json }
  | { op: 'set-type'; at: Array<string | number>; type: string }
  | { op: 'make-nullable'; at: Array<string | number>; style: 'nullable' | 'type-list' | 'x-nullable'; type?: string }
  | { op: 'remove-required'; at: Array<string | number>; name: string }
  | { op: 'add-enum'; at: Array<string | number>; value: unknown }
  | { op: 'add-response'; at: Array<string | number>; status: string; description: string; media?: string; schema?: Json };

interface PlannedPatch {
  ops: PatchOp[];
  /** What the change says in words: "add `nickname` (string) to the schema of GET /patients/{id} 200". */
  summary: string;
}

/* ------------------------------------------------------------------ inferring a schema from a value */

/** A schema for an observed value: types and, for objects, their properties (three levels deep); formats for the obvious strings. */
function inferSchemaOf(v: unknown, depth = 0): Json {
  const t = jsonType(v);
  if (t === 'string') {
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return { type: 'string', format: 'date-time' };
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return { type: 'string', format: 'uuid' };
    return { type: 'string' };
  }
  if (t === 'integer' || t === 'number' || t === 'boolean') return { type: t };
  if (t === 'null') return { nullable: true };
  if (t === 'array') return depth < 3 && (v as unknown[]).length ? { type: 'array', items: inferSchemaOf((v as unknown[])[0], depth + 1) } : { type: 'array', items: {} };
  if (isRecord(v)) {
    if (depth >= 3) return { type: 'object' };
    return { type: 'object', properties: Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, inferSchemaOf(x, depth + 1)])) };
  }
  return {};
}

/* ------------------------------------------------------------------ locating a schema in the document */

/** `$.items[].price` → [{ prop: 'items' }, { items: true }, { prop: 'price' }] (an array's elements are `[]`). */
function segmentsOf(pointer: string): Array<{ prop: string } | { items: true }> | undefined {
  const rest = pointer.replace(/^\$/, '');
  const out: Array<{ prop: string } | { items: true }> = [];
  const re = /\.([^.[\]]+)|\[\]|\['([^']+)'\]/g;
  let m: RegExpExecArray | null;
  let used = 0;
  while ((m = re.exec(rest))) {
    used += m[0].length;
    out.push(m[0] === '[]' ? { items: true } : { prop: (m[1] ?? m[2])! });
  }
  return used === rest.length ? out : undefined;
}

const at = (doc: unknown, path: Array<string | number>): unknown => path.reduce<unknown>((o, k) => (o !== undefined && o !== null && typeof o === 'object' ? (o as Json)[k as string] : undefined), doc);

/** Follow `$ref`s: the schema and the path it lives at (a component's path when it was a reference). */
function follow(doc: OpenApiDoc, path: Array<string | number>): { path: Array<string | number>; schema: Json } | undefined {
  let p = path;
  for (let i = 0; i < 12; i++) {
    const s = at(doc, p);
    if (!isRecord(s)) return undefined;
    if (typeof s.$ref !== 'string') return { path: p, schema: s };
    const r = resolveRef(doc, s);
    if (!r?.path) return undefined;
    p = r.path;
  }
  return undefined;
}

/** The path of the schema at `segments` below the documented response schema (see the module comment); undefined when it is not locatable (a choice, an unknown property). */
function locate(doc: OpenApiDoc, start: Array<string | number>, segments: Array<{ prop: string } | { items: true }>): { path: Array<string | number>; schema: Json } | undefined {
  let cur = follow(doc, start);
  for (const seg of segments) {
    if (!cur) return undefined;
    if ('items' in seg) {
      const items = cur.schema.items;
      if (!isRecord(items)) return undefined;
      cur = follow(doc, [...cur.path, 'items']);
      continue;
    }
    // the property may be declared by the schema or by one of its allOf parts
    const direct = isRecord(cur.schema.properties) && seg.prop in cur.schema.properties;
    if (direct) {
      cur = follow(doc, [...cur.path, 'properties', seg.prop]);
      continue;
    }
    const parts = Array.isArray(cur.schema.allOf) ? cur.schema.allOf : [];
    let next: ReturnType<typeof follow>;
    for (let i = 0; i < parts.length && !next; i++) {
      const part = follow(doc, [...cur.path, 'allOf', i]);
      if (part && isRecord(part.schema.properties) && seg.prop in part.schema.properties) next = follow(doc, [...part.path, 'properties', seg.prop]);
    }
    cur = next;
  }
  return cur;
}

/** Where a response's schema starts: the media type's schema (OpenAPI 3) or the response's (Swagger 2). */
function responseSchemaPath(doc: OpenApiDoc, op: { path: string; method: string; operation: Json }, status: string): Array<string | number> | undefined {
  const responses = isRecord(op.operation.responses) ? op.operation.responses : {};
  const key = [status, `${status[0]}XX`, `${status[0]}xx`, 'default'].find((k) => isRecord(responses[k]));
  if (!key) return undefined;
  const base: Array<string | number> = ['paths', op.path, op.method, 'responses', key];
  const resp = responses[key] as Json;
  if (isRecord(resp.content)) {
    const media = Object.keys(resp.content).find((k) => /json/.test(k)) ?? Object.keys(resp.content)[0];
    return media ? [...base, 'content', media, 'schema'] : undefined;
  }
  return doc.swagger ? [...base, 'schema'] : undefined;
}

const operationOf = (doc: OpenApiDoc, name: string): { path: string; method: string; operation: Json } | undefined => {
  const m = /^([A-Z]+) (.+)$/.exec(name);
  if (!m) return undefined;
  const item = (doc.paths ?? {})[m[2]!];
  const operation = item?.[m[1]!.toLowerCase()];
  return isRecord(operation) ? { path: m[2]!, method: m[1]!.toLowerCase(), operation } : undefined;
};

/* ------------------------------------------------------------------ planning */

/**
 * The patch for a finding, or why there is none. `sample` is a value that was observed at the finding's place (for the
 * type of a new property or a new response).
 */
export function planPatch(doc: OpenApiDoc, f: Pick<DriftFinding, 'kind' | 'operation' | 'status' | 'pointer' | 'observed'> & { seenTypes?: string[] }, sample?: unknown): PlannedPatch | { skip: string } {
  if (f.kind === 'undocumented-endpoint') return { skip: 'a whole endpoint is a decision about the API, not a patch: document it yourself, or ignore it' };
  if (f.kind === 'undocumented-content-type') return { skip: 'a content type is a decision about the API (is it meant to answer this way?), not a patch' };
  const op = operationOf(doc, f.operation);
  if (!op) return { skip: `${f.operation} is not in the document` };
  const where = `${f.operation}${f.status ? ` ${f.status}` : ''}`;
  if (f.kind === 'undocumented-status') {
    const status = f.status ?? '';
    const path: Array<string | number> = ['paths', op.path, op.method, 'responses'];
    const json = isRecord(sample) || Array.isArray(sample);
    return {
      ops: [{ op: 'add-response', at: path, status, description: 'Observed in traffic', ...(json ? { media: 'application/json', schema: inferSchemaOf(sample) } : {}) }],
      summary: `document the ${status} response of ${f.operation}${json ? ' with the shape that was observed' : ''}`,
    };
  }
  const start = responseSchemaPath(doc, op, f.status ?? '');
  const segs = f.pointer ? segmentsOf(f.pointer) : undefined;
  if (!start || !segs) return { skip: `the response schema of ${where} cannot be found in the document` };
  if (f.kind === 'undocumented-field') {
    const last = segs[segs.length - 1];
    if (!last || !('prop' in last)) return { skip: 'the new field is not a property of an object' };
    const parent = locate(doc, start, segs.slice(0, -1));
    if (!parent) return { skip: `the schema that should hold "${last.prop}" is a choice (oneOf / anyOf) or not in the document` };
    return {
      ops: [{ op: 'add-property', at: parent.path, name: last.prop, schema: inferSchemaOf(sample ?? defaultOf(f.observed[0])) }],
      summary: `add \`${last.prop}\` (${f.observed.join(' | ')}) to the schema of ${where}${parent.path[0] === 'components' || parent.path[0] === 'definitions' ? ` (${String(parent.path[parent.path.length - 1])})` : ''}`,
    };
  }
  if (f.kind === 'missing-required') {
    const last = segs[segs.length - 1];
    if (!last || !('prop' in last)) return { skip: 'the missing field is not a property of an object' };
    const parent = locate(doc, start, segs.slice(0, -1));
    if (!parent) return { skip: `the schema that requires "${last.prop}" is a choice or not in the document` };
    // required may be declared by the schema or by an allOf part
    const holders = [parent.path, ...(Array.isArray(parent.schema.allOf) ? parent.schema.allOf.map((_, i) => [...parent.path, 'allOf', i]) : [])];
    const holder = holders.map((p) => follow(doc, p)).find((h) => h && Array.isArray(h.schema.required) && h.schema.required.includes(last.prop));
    if (!holder) return { skip: `"${last.prop}" is not in a required list that can be found` };
    return { ops: [{ op: 'remove-required', at: holder.path, name: last.prop }], summary: `make \`${last.prop}\` optional in the schema of ${where}` };
  }
  const node = locate(doc, start, segs);
  if (!node) return { skip: `the schema of ${f.pointer} in ${where} is a choice or not in the document` };
  // every type the place had in the traffic, conforming or not (null is a nullable question); an integer is a number
  const types = (f.seenTypes ?? f.observed).filter((o) => o !== 'null');
  const distinct = [...new Set(types.map((t) => (t === 'integer' ? 'number' : t)))];
  const seen = distinct.length === 1 ? [distinct[0] === 'number' && types.every((t) => t === 'integer') ? 'integer' : distinct[0]!] : distinct;
  if (f.kind === 'nullable') {
    const style = doc.swagger ? 'x-nullable' : String(doc.openapi ?? '').startsWith('3.1') ? 'type-list' : 'nullable';
    return { ops: [{ op: 'make-nullable', at: node.path, style, ...(typeof node.schema.type === 'string' ? { type: node.schema.type } : {}) }], summary: `allow null for \`${f.pointer}\` in the schema of ${where}` };
  }
  if (f.kind === 'type-change') {
    if (seen.length !== 1) return { skip: `the API answers this field with ${types.join(' and ')}: that is a bug to fix or a type to decide, not a document to bless` };
    const type = seen[0]!;
    if (!['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(type)) return { skip: `the observed type "${type}" is not one the document can name` };
    return { ops: [{ op: 'set-type', at: node.path, type }], summary: `set the type of \`${f.pointer}\` to ${type} in the schema of ${where}` };
  }
  if (f.kind === 'enum-value') {
    if (!Array.isArray(node.schema.enum)) return { skip: 'the schema has no enum to add to' };
    const v = sample ?? f.observed[0];
    return { ops: [{ op: 'add-enum', at: node.path, value: v }], summary: `add ${JSON.stringify(v)} to the enum of \`${f.pointer}\` in the schema of ${where}` };
  }
  return { skip: 'nothing to patch' };
}

const defaultOf = (type: string | undefined): unknown => (type === 'integer' ? 0 : type === 'number' ? 0.5 : type === 'boolean' ? true : type === 'array' ? [] : type === 'object' ? {} : type === 'null' ? null : '');

/* ------------------------------------------------------------------ applying */

interface Editor {
  get(path: Array<string | number>): unknown;
  set(path: Array<string | number>, v: unknown): void;
  del(path: Array<string | number>): void;
  push(path: Array<string | number>, v: unknown): void;
  text(): string;
}

function plainEditor(root: Json): Editor {
  const walk = (path: Array<string | number>, create: boolean): unknown => {
    let o: unknown = root;
    for (const k of path) {
      if (!o || typeof o !== 'object') return undefined;
      const c = o as Json;
      if (c[k as string] === undefined && create) c[k as string] = {};
      o = c[k as string];
    }
    return o;
  };
  return {
    get: (p) => walk(p, false),
    set: (p, v) => {
      const parent = walk(p.slice(0, -1), true) as Json;
      parent[p[p.length - 1] as string] = v;
    },
    del: (p) => {
      const parent = walk(p.slice(0, -1), false);
      if (Array.isArray(parent)) parent.splice(Number(p[p.length - 1]), 1);
      else if (parent && typeof parent === 'object') delete (parent as Json)[p[p.length - 1] as string];
    },
    push: (p, v) => {
      const list = walk(p, false);
      if (Array.isArray(list)) list.push(v);
      else (walk(p.slice(0, -1), true) as Json)[p[p.length - 1] as string] = [v];
    },
    text: () => `${JSON.stringify(root, null, 2)}\n`,
  };
}

function yamlEditor(text: string): Editor {
  const doc = parseDocument(text);
  return {
    get: (p) => {
      const n = doc.getIn(p, false);
      return n && typeof n === 'object' && 'toJSON' in (n as object) ? (n as { toJSON(): unknown }).toJSON() : n;
    },
    set: (p, v) => void doc.setIn(p, doc.createNode(v)),
    del: (p) => void doc.deleteIn(p),
    push: (p, v) => {
      const node = doc.getIn(p, true);
      if (isSeq(node)) node.add(doc.createNode(v));
      else doc.setIn(p, doc.createNode([v]));
    },
    text: () => doc.toString({ lineWidth: 0 }),
  };
}

/** The document's text with the operations applied; `json` re-writes the JSON file, otherwise YAML keeps its comments and order. */
export function applyPatchOps(text: string, json: boolean, ops: PatchOp[]): string {
  const ed = json ? plainEditor(JSON.parse(text) as Json) : yamlEditor(text);
  for (const o of ops) {
    switch (o.op) {
      case 'add-property':
        if (ed.get([...o.at, 'properties', o.name]) === undefined) ed.set([...o.at, 'properties', o.name], o.schema);
        break;
      case 'set-type':
        ed.set([...o.at, 'type'], o.type);
        // a nullable the old type carried stays (the type changed, not whether null is allowed)
        break;
      case 'make-nullable':
        if (o.style === 'nullable') ed.set([...o.at, 'nullable'], true);
        else if (o.style === 'x-nullable') ed.set([...o.at, 'x-nullable'], true);
        else {
          const cur = ed.get([...o.at, 'type']);
          if (Array.isArray(cur)) {
            if (!cur.includes('null')) ed.push([...o.at, 'type'], 'null');
          } else ed.set([...o.at, 'type'], [typeof cur === 'string' ? cur : (o.type ?? 'object'), 'null']);
        }
        break;
      case 'remove-required': {
        const list = ed.get([...o.at, 'required']);
        if (Array.isArray(list)) {
          const i = list.map(String).indexOf(o.name);
          if (i >= 0) {
            if (list.length === 1) ed.del([...o.at, 'required']);
            else ed.del([...o.at, 'required', i]);
          }
        }
        break;
      }
      case 'add-enum': {
        const list = ed.get([...o.at, 'enum']);
        if (Array.isArray(list) && !list.some((x) => JSON.stringify(x) === JSON.stringify(o.value))) ed.push([...o.at, 'enum'], o.value);
        break;
      }
      case 'add-response':
        if (ed.get([...o.at, o.status]) === undefined && ed.get([...o.at, `'${o.status}'`]) === undefined)
          ed.set([...o.at, o.status], { description: o.description, ...(o.media && o.schema ? { content: { [o.media]: { schema: o.schema } } } : {}) });
        break;
    }
  }
  return ed.text();
}

/** Whether a path is a JSON document (by its extension). */
export const isJsonSpec = (path: string): boolean => /\.json$/i.test(path);

