/** The parsed flow file an edit works on (its YAML document, the steps sequence, ids and connections) and the small helpers every edit operation shares. See flow-edit.ts. */
import { basename, extname } from 'node:path';
import type { Document, Node, Pair, YAMLMap, YAMLSeq } from 'yaml';
import { isMap, isScalar, isSeq, parseDocument } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { spliceYaml } from '../util/yaml-splice.js';
import { normalizeTest } from './loader.js';
import { TAIL_KEYS } from './flow-steps-from-requests.js';
import { flowStepOf, markDatasetLoops } from './flow-steps.js';
import { type FlowStep } from '@testpion/shared';

export const REQUEST_KEYS = new Set(['method', 'url', 'params', 'query', 'headers', 'cookies', 'auth', 'body', 'json', 'settings']);

/** New keys of a step go before these (the checks and scripts close a test). */
export const GAP_X = 284;

export interface Ctx {
  doc: Document;
  /** The tests list. */
  seq: YAMLSeq;
  file?: string;
}

export const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));

export const pairOf = (m: YAMLMap, k: string) => (m.items as Pair[]).find((p) => keyOf(p) === k);

export const valueOf = (m: YAMLMap, k: string): unknown => {
  const p = pairOf(m, k);
  return p && p.value && typeof p.value === 'object' && 'toJSON' in p.value ? (p.value as Node).toJSON() : isScalar(p?.value) ? (p!.value as { value: unknown }).value : p?.value;
};

export function open(text: string, file?: string): Ctx {
  const doc = parseDocument(text.replace(/\r\n/g, '\n'));
  if (doc.errors.length) throw new ApsError('ConfigurationError', `The file does not parse: ${doc.errors[0]!.message.split('\n')[0]}`);
  let root = doc.contents as Node | null;
  if (!root || (isScalar(root) && (root.value === null || root.value === ''))) {
    doc.contents = doc.createNode({ tests: [] }) as never;
    root = doc.contents as Node;
  }
  let seq: YAMLSeq;
  if (isSeq(root)) seq = root;
  else if (isMap(root)) {
    const tests = pairOf(root, 'tests');
    if (tests && isSeq(tests.value)) seq = tests.value;
    else if (tests) {
      seq = doc.createNode([]) as YAMLSeq;
      tests.value = seq;
    } else if (['type', 'url', 'request', 'query', 'prompt', 'tool', 'method', 'dataset'].some((k) => pairOf(root as YAMLMap, k))) {
      // one test at the top: it becomes the first step of a tests: list
      seq = doc.createNode([]) as YAMLSeq;
      seq.items.push(root);
      const map = doc.createNode({}) as YAMLMap;
      map.items.push(doc.createPair('tests', seq));
      doc.contents = map as never;
    } else {
      seq = doc.createNode([]) as YAMLSeq;
      root.items.push(doc.createPair('tests', seq));
    }
  } else throw new ApsError('ConfigurationError', 'A flow is a test file: name, tests: [ … ]');
  if (isMap(doc.contents) && pairOf(doc.contents, 'tests') && isScalar(pairOf(doc.contents, 'tests')!.key) && isSuiteLike(doc.contents))
    throw new ApsError('ConfigurationError', 'This is a suite (it names other test files); open one of its files to design its flow');
  seq.flow = false;
  return { doc, seq, file };
}

/** A suite's tests: are paths (texts), not tests. */
export function isSuiteLike(root: YAMLMap): boolean {
  const t = pairOf(root, 'tests')?.value;
  return isSeq(t) && t.items.length > 0 && t.items.every((x) => isScalar(x) && typeof x.value === 'string');
}

export function finish(ctx: Ctx, original: string): string {
  const crlf = original.includes('\r\n');
  let out: string;
  if (ctx.file && extname(ctx.file).toLowerCase() === '.json') {
    const indent = /\n( +)\S/.exec(original)?.[1]?.length ?? 2;
    out = JSON.stringify(ctx.doc.toJS(), null, indent) + '\n';
  } else out = spliceYaml(original.replace(/\r\n/g, '\n'), ctx.doc, ctx.doc.toString({ lineWidth: 0 })); // only what the edit changed is written anew
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

export const items = (ctx: Ctx): YAMLMap[] => ctx.seq.items.map((n, i) => (isMap(n) ? n : fail(`Step ${i + 1} is not a map of keys`)));

export const fail = (m: string): never => {
  throw new ApsError('ConfigurationError', m);
};

/** The id the runner gives each step: its id:, else <file>:<name> (as the loader does). */
export function idsOf(ctx: Ctx): string[] {
  const prefix = ctx.file ? `${slugify(basename(ctx.file).replace(/\.[^.]+$/, ''))}:` : '';
  return items(ctx).map((m, i) => {
    const id = valueOf(m, 'id');
    if (id !== undefined && id !== null && id !== '') return String(id);
    const name = valueOf(m, 'name');
    return `${prefix}${slugify(String(name ?? `${ctx.file ? basename(ctx.file) : 'test'} #${i + 1}`))}`;
  });
}

export function indexOf(ctx: Ctx, ref: string): number {
  const ids = idsOf(ctx);
  let i = ids.indexOf(ref);
  if (i < 0) i = items(ctx).findIndex((m) => valueOf(m, 'name') === ref);
  if (i < 0) fail(`No step "${ref}" in the flow. Steps: ${ids.join(', ') || 'none'}`);
  return i;
}

export const depsOf = (m: YAMLMap): string[] => {
  const v = valueOf(m, 'dependsOn');
  return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String);
};

/** Set a key of a map; a new key goes first (id), second (name) or before the checks and scripts. */
export function setKey(ctx: Ctx, m: YAMLMap, key: string, value: unknown) {
  const existing = pairOf(m, key);
  if (value === null || value === undefined) {
    if (existing) m.items.splice(m.items.indexOf(existing), 1);
    return;
  }
  const node = ctx.doc.createNode(value) as Node;
  if (isSeq(node) && (key === 'dependsOn' || key === 'tags') && node.items.every((x) => isScalar(x))) node.flow = true;
  if (existing) {
    existing.value = node;
    return;
  }
  const pair = ctx.doc.createPair(key, node);
  const list = m.items as Pair[];
  if (key === 'id') list.unshift(pair);
  else if (key === 'name') list.splice(pairOf(m, 'id') ? 1 : 0, 0, pair);
  else {
    const tail = list.findIndex((p) => TAIL_KEYS.includes(keyOf(p)));
    if (tail >= 0) list.splice(tail, 0, pair);
    else list.push(pair);
  }
}

export function setDeps(ctx: Ctx, m: YAMLMap, deps: string[]) {
  const unique = [...new Set(deps)];
  setKey(ctx, m, 'dependsOn', unique.length ? unique : null);
}

/** The ids of the condition steps of the flow. */
export function conditionIds(ctx: Ctx): Set<string> {
  const ids = idsOf(ctx);
  return new Set(items(ctx).flatMap((m, i) => (valueOf(m, 'type') === 'condition' ? [ids[i]!] : [])));
}

/** A step that no longer waits for any condition has no branch: its `when:` goes. */
export function dropStrayWhen(ctx: Ctx) {
  const conds = conditionIds(ctx);
  for (const m of items(ctx)) if (pairOf(m, 'when') && !depsOf(m).some((d) => conds.has(d))) setKey(ctx, m, 'when', null);
}

export function uniqueId(ctx: Ctx, base: string, taken = new Set(idsOf(ctx))): string {
  const b = slugify(base) || 'step';
  let id = b;
  for (let n = 2; taken.has(id); n++) id = `${b}-${n}`;
  return id;
}

export function uniqueName(ctx: Ctx, base: string): string {
  const names = new Set(items(ctx).map((m) => String(valueOf(m, 'name') ?? '')));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** The steps of a test file's text (as the loader reads them), for an edit's answer. */
export function flowStepsOfText(text: string, file?: string): FlowStep[] {
  let data: unknown;
  try {
    data = file && extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseDocument(text).toJS();
  } catch {
    return [];
  }
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
  const list = Array.isArray(data) ? data : Array.isArray(root?.tests) ? (root!.tests as unknown[]) : root && (root.type || root.url || root.request || root.prompt || root.dataset) ? [root] : [];
  const defaults = (!Array.isArray(data) && root?.defaults && typeof root.defaults === 'object' ? root.defaults : {}) as Record<string, unknown>;
  const out: FlowStep[] = [];
  list.forEach((t, i) => {
    try {
      out.push(flowStepOf(normalizeTest({ ...defaults, ...(t as Record<string, unknown>) }, file, i)));
    } catch {
      const raw = (t ?? {}) as Record<string, unknown>;
      out.push({ id: String(raw.id ?? raw.name ?? `#${i + 1}`), name: String(raw.name ?? `#${i + 1}`), type: String(raw.type ?? '?') });
    }
  });
  markDatasetLoops(out, data);
  return out;
}
