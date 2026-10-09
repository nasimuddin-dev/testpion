/**
 * The flow designer's edits of a test file: add, change, connect, disconnect, rename, duplicate and remove steps, and
 * place them (the file's `layout:`). Each operation takes the file's text and returns the new text, with the `yaml`
 * Document API so comments, key order and line endings stay (the same approach as exposed-flows.ts setExposure).
 * The app's Flow tab, `testpion flow edit` and the flow_* MCP tools all go through applyFlowEdit / editFlowFile.
 */
import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Document, Node, Pair, YAMLMap, YAMLSeq } from 'yaml';
import { isMap, isScalar, isSeq, parseDocument } from '../util/lazy-yaml.js';
import { ApsError } from '../errors.js';
import type { Collection, CollectionNode, SavedExample } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { requireCollection } from '../storage/env-edit.js';
import { slugify } from '../util/ids.js';
import { isSuiteFile, normalizeTest } from './loader.js';
import { testObjectFromRequest } from './test-from.js';
import { flowStepOf } from './flow-steps.js';
import type { FlowStep } from '@testpion/shared';

/** A step as written in a test file: name, type, method, url, extract, assertions … (the keys of a test). */
export type FlowStepInput = Record<string, unknown>;

/** One edit of a flow. Steps are named by id (their `id:`, or the id the runner gives them; a step's name works too). */
export type FlowEditOp =
  /** Add a step at the end, or right after `after` (it then waits for it); `at` places it on the canvas. */
  | { op: 'addStep'; step: FlowStepInput; after?: string; at?: [number, number] }
  /** Add several steps; `chain`: each waits for the one before it (the first for `after`). */
  | { op: 'addSteps'; steps: FlowStepInput[]; after?: string; chain?: boolean; at?: [number, number] }
  /** Set keys of a step (null removes one). name and id rename it; dependsOn replaces what it waits for. */
  | { op: 'updateStep'; id: string; set: Record<string, unknown> }
  /** Remove steps; the steps that waited for them no longer do. */
  | { op: 'removeStep'; id: string | string[] }
  /** Rename a step (its name, and with newId its id); every dependsOn that names it follows. */
  | { op: 'renameStep'; id: string; name?: string; newId?: string }
  /** `to` waits for `from` (refused when it would make a cycle). */
  | { op: 'connect'; from: string; to: string }
  | { op: 'disconnect'; from: string; to: string }
  /** Place steps on the canvas (null removes one's place); positions null removes the whole layout (auto-arrange). */
  | { op: 'setLayout'; positions: Record<string, [number, number] | null> | null }
  /** A copy of each step right after it, with a new id and " copy" after its name. */
  | { op: 'duplicateStep'; id: string | string[] }
  /** The whole text (an AI draft that was reviewed, or undo). */
  | { op: 'replace'; text: string }
  /** Steps from a saved collection: requests (or every request of folders) by id or name, in order, chained. Needs the workspace. */
  | { op: 'addFromCollection'; collection: string; items?: string[]; after?: string; at?: [number, number]; chain?: boolean }
  /** Copy steps of another test file (copy / paste between flows); dependsOn among the copied steps is kept. Needs the workspace. */
  | { op: 'pasteSteps'; from: string; ids: string[]; after?: string; at?: [number, number] };

export interface FlowEditResult {
  text: string;
  /** The ids of the steps an add, duplicate or paste made. */
  added?: string[];
}

const REQUEST_KEYS = new Set(['method', 'url', 'params', 'query', 'headers', 'cookies', 'auth', 'body', 'json', 'settings']);
/** New keys of a step go before these (the checks and scripts close a test). */
const TAIL_KEYS = ['assertions', 'checks', 'evaluators', 'preRequestScript', 'testScript'];
const GAP_X = 284;

interface Ctx {
  doc: Document;
  /** The tests list. */
  seq: YAMLSeq;
  file?: string;
}

const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));
const pairOf = (m: YAMLMap, k: string) => (m.items as Pair[]).find((p) => keyOf(p) === k);
const valueOf = (m: YAMLMap, k: string): unknown => {
  const p = pairOf(m, k);
  return p && p.value && typeof p.value === 'object' && 'toJSON' in p.value ? (p.value as Node).toJSON() : isScalar(p?.value) ? (p!.value as { value: unknown }).value : p?.value;
};

function open(text: string, file?: string): Ctx {
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
    } else if (['type', 'url', 'request', 'query', 'prompt', 'tool', 'method'].some((k) => pairOf(root as YAMLMap, k))) {
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
function isSuiteLike(root: YAMLMap): boolean {
  const t = pairOf(root, 'tests')?.value;
  return isSeq(t) && t.items.length > 0 && t.items.every((x) => isScalar(x) && typeof x.value === 'string');
}

function finish(ctx: Ctx, original: string): string {
  const crlf = original.includes('\r\n');
  let out: string;
  if (ctx.file && extname(ctx.file).toLowerCase() === '.json') {
    const indent = /\n( +)\S/.exec(original)?.[1]?.length ?? 2;
    out = JSON.stringify(ctx.doc.toJS(), null, indent) + '\n';
  } else out = ctx.doc.toString({ lineWidth: 0 });
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

const items = (ctx: Ctx): YAMLMap[] => ctx.seq.items.map((n, i) => (isMap(n) ? n : fail(`Step ${i + 1} is not a map of keys`)));
const fail = (m: string): never => {
  throw new ApsError('ConfigurationError', m);
};

/** The id the runner gives each step: its id:, else <file>:<name> (as the loader does). */
function idsOf(ctx: Ctx): string[] {
  const prefix = ctx.file ? `${slugify(basename(ctx.file).replace(/\.[^.]+$/, ''))}:` : '';
  return items(ctx).map((m, i) => {
    const id = valueOf(m, 'id');
    if (id !== undefined && id !== null && id !== '') return String(id);
    const name = valueOf(m, 'name');
    return `${prefix}${slugify(String(name ?? `${ctx.file ? basename(ctx.file) : 'test'} #${i + 1}`))}`;
  });
}

function indexOf(ctx: Ctx, ref: string): number {
  const ids = idsOf(ctx);
  let i = ids.indexOf(ref);
  if (i < 0) i = items(ctx).findIndex((m) => valueOf(m, 'name') === ref);
  if (i < 0) fail(`No step "${ref}" in the flow. Steps: ${ids.join(', ') || 'none'}`);
  return i;
}

const depsOf = (m: YAMLMap): string[] => {
  const v = valueOf(m, 'dependsOn');
  return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String);
};

/** Set a key of a map; a new key goes first (id), second (name) or before the checks and scripts. */
function setKey(ctx: Ctx, m: YAMLMap, key: string, value: unknown) {
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

function setDeps(ctx: Ctx, m: YAMLMap, deps: string[]) {
  const unique = [...new Set(deps)];
  setKey(ctx, m, 'dependsOn', unique.length ? unique : null);
}

/** Replace a step id everywhere it is named: dependsOn of every step and the layout. */
function renameRefs(ctx: Ctx, from: string, to: string) {
  if (from === to) return;
  for (const m of items(ctx)) {
    const d = depsOf(m);
    if (d.includes(from))
      setDeps(
        ctx,
        m,
        d.map((x) => (x === from ? to : x)),
      );
  }
  const layout = layoutMap(ctx, false);
  const p = layout && pairOf(layout, from);
  if (p) p.key = ctx.doc.createNode(to);
}

function uniqueId(ctx: Ctx, base: string, taken = new Set(idsOf(ctx))): string {
  const b = slugify(base) || 'step';
  let id = b;
  for (let n = 2; taken.has(id); n++) id = `${b}-${n}`;
  return id;
}

function uniqueName(ctx: Ctx, base: string): string {
  const names = new Set(items(ctx).map((m) => String(valueOf(m, 'name') ?? '')));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  return name;
}

/** Give the step an id: of its own (so dependsOn names stay short and survive a rename); references follow. */
function ensureId(ctx: Ctx, i: number): string {
  const m = items(ctx)[i]!;
  const own = valueOf(m, 'id');
  if (own !== undefined && own !== null && own !== '') return String(own);
  const old = idsOf(ctx)[i]!;
  const taken = new Set(idsOf(ctx));
  taken.delete(old);
  const id = uniqueId(ctx, String(valueOf(m, 'name') ?? 'step'), taken);
  setKey(ctx, m, 'id', id);
  renameRefs(ctx, old, id);
  return id;
}

/** Whether `a` waits for `b`, directly or through other steps. */
function waitsFor(ctx: Ctx, a: string, b: string): boolean {
  const ids = idsOf(ctx);
  const all = items(ctx);
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === b) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const i = ids.indexOf(id);
    return i >= 0 && depsOf(all[i]!).some(walk);
  };
  return depsOf(all[ids.indexOf(a)]!).some(walk);
}

function layoutMap(ctx: Ctx, create: true): YAMLMap;
function layoutMap(ctx: Ctx, create: false): YAMLMap | undefined;
function layoutMap(ctx: Ctx, create: boolean): YAMLMap | undefined {
  const root = ctx.doc.contents;
  if (!isMap(root)) return create ? fail('Positions need a test file written as a map (name, tests: …), not a bare list') : undefined;
  const p = pairOf(root, 'layout');
  if (p && isMap(p.value)) return p.value;
  if (!create) return undefined;
  const m = ctx.doc.createNode({}) as YAMLMap;
  if (p) p.value = m;
  else {
    const pair = ctx.doc.createPair('layout', m);
    (pair.key as Node).spaceBefore = true;
    root.items.push(pair);
  }
  return m;
}

function place(ctx: Ctx, id: string, at: [number, number] | null) {
  if (!at) {
    const m = layoutMap(ctx, false);
    const p = m && pairOf(m, id);
    if (p) m!.items.splice(m!.items.indexOf(p), 1);
    return;
  }
  if (!at.every((n) => typeof n === 'number' && Number.isFinite(n))) fail(`A position is [x, y] in numbers (${id})`);
  const node = ctx.doc.createNode([Math.max(0, Math.round(at[0])), Math.max(0, Math.round(at[1]))]) as YAMLSeq;
  node.flow = true;
  const m = layoutMap(ctx, true);
  const p = pairOf(m, id);
  if (p) p.value = node;
  else m.items.push(ctx.doc.createPair(id, node));
}

function dropEmptyLayout(ctx: Ctx) {
  const root = ctx.doc.contents;
  if (!isMap(root)) return;
  const p = pairOf(root, 'layout');
  if (p && isMap(p.value) && !p.value.items.length) root.items.splice(root.items.indexOf(p), 1);
}

/** Add one step; returns its id. */
function addOne(ctx: Ctx, input: FlowStepInput, after: string | undefined, at: [number, number] | undefined): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('A step is a map of keys: { name, type, method, url, … }');
  const { id: givenId, name: givenName, type, dependsOn, ...rest } = input as Record<string, unknown>;
  const name = uniqueName(ctx, String(givenName ?? '').trim() || 'New step');
  const taken = new Set(idsOf(ctx));
  const id = givenId && !taken.has(String(givenId)) ? String(givenId) : uniqueId(ctx, givenId ? String(givenId) : name, taken);
  const deps = dependsOn === undefined || dependsOn === null ? [] : (Array.isArray(dependsOn) ? dependsOn : [dependsOn]).map(String);
  let pos = ctx.seq.items.length;
  if (after) {
    const i = indexOf(ctx, after);
    deps.unshift(ensureId(ctx, i));
    pos = i + 1;
    // after the steps that already follow it right away (a chain of adds keeps its order)
  }
  const value: Record<string, unknown> = { id, name, ...(type ? { type } : {}), ...rest };
  if (deps.length) value.dependsOn = [...new Set(deps)];
  // dependsOn among the keys, before the checks
  const ordered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (k !== 'dependsOn' && !TAIL_KEYS.includes(k)) ordered[k] = v;
  if (value.dependsOn) ordered.dependsOn = value.dependsOn;
  for (const [k, v] of Object.entries(value)) if (TAIL_KEYS.includes(k)) ordered[k] = v;
  const node = ctx.doc.createNode(ordered) as YAMLMap;
  const d = pairOf(node, 'dependsOn');
  if (d && isSeq(d.value)) d.value.flow = true;
  ctx.seq.items.splice(pos, 0, node);
  // the step must load (a type the runner knows, a URL …): what it refuses is said now, not at run time
  try {
    normalizeTest(node.toJSON() as Record<string, unknown>, ctx.file);
  } catch (e) {
    ctx.seq.items.splice(pos, 1);
    throw e;
  }
  if (at) place(ctx, id, at);
  return id;
}

function addMany(ctx: Ctx, steps: FlowStepInput[], after: string | undefined, chain: boolean, at: [number, number] | undefined): string[] {
  if (!Array.isArray(steps) || !steps.length) fail('No steps to add');
  // ids the steps give each other (a paste) are renamed with them when they are taken
  const renamed = new Map<string, string>();
  const taken = new Set(idsOf(ctx));
  const prepared = steps.map((s) => {
    const own = s.id ? String(s.id) : undefined;
    if (own && taken.has(own)) {
      const id = uniqueId(ctx, own, taken);
      taken.add(id);
      renamed.set(own, id);
      return { ...s, id };
    }
    if (own) taken.add(own);
    return s;
  });
  const local = new Set(prepared.map((s) => (s.id ? String(s.id) : '')).filter(Boolean));
  const added: string[] = [];
  let prev = after;
  prepared.forEach((s, i) => {
    const deps = (s.dependsOn === undefined || s.dependsOn === null ? [] : Array.isArray(s.dependsOn) ? s.dependsOn : [s.dependsOn]).map((d) => renamed.get(String(d)) ?? String(d));
    const keep = deps.filter((d) => local.has(d) || taken.has(d));
    const id = addOne(ctx, { ...s, dependsOn: keep.length ? keep : undefined }, chain ? prev : i === 0 ? after : undefined, at ? [at[0] + i * GAP_X, at[1]] : undefined);
    added.push(id);
    prev = id;
  });
  return added;
}

/** Apply one edit to a test file's text and return the new text (comments, key order and line endings kept). */
export function applyFlowEdit(text: string, op: FlowEditOp, opts: { file?: string } = {}): FlowEditResult {
  if (!op || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string')
    fail('An edit is { op: addStep | addSteps | updateStep | removeStep | renameStep | connect | disconnect | setLayout | duplicateStep | replace, … }');
  if (opts.file && isSuiteFile(opts.file)) fail('A suite names other test files; open one of them to design its flow');
  if (op.op === 'replace') {
    if (typeof op.text !== 'string') fail('replace needs the text');
    const doc = parseDocument(op.text);
    if (doc.errors.length) fail(`The new text does not parse: ${doc.errors[0]!.message.split('\n')[0]}`);
    return { text: text.includes('\r\n') && !op.text.includes('\r\n') ? op.text.replace(/\n/g, '\r\n') : op.text };
  }
  const ctx = open(text, opts.file);
  let added: string[] | undefined;
  switch (op.op) {
    case 'addStep':
      added = [addOne(ctx, op.step, op.after, op.at)];
      break;
    case 'addSteps':
      added = addMany(ctx, op.steps, op.after, op.chain ?? false, op.at);
      break;
    case 'updateStep': {
      indexOf(ctx, op.id);
      if (!op.set || typeof op.set !== 'object') fail('updateStep needs set: { key: value } (null removes a key)');
      const { name, id, dependsOn, ...rest } = op.set;
      let ref = op.id;
      if (name !== undefined || id !== undefined) ref = renameStep(ctx, ref, name === undefined || name === null ? undefined : String(name), id === undefined || id === null ? undefined : String(id));
      const m = items(ctx)[indexOf(ctx, ref)]!;
      const request = pairOf(m, 'request');
      for (const [k, v] of Object.entries(rest)) {
        const target = request && isMap(request.value) && REQUEST_KEYS.has(k) ? request.value : m;
        setKey(ctx, target, k, v);
        // one body: body: replaces the json: shorthand and the other way round
        if (k === 'body' && v !== null) setKey(ctx, target, 'json', null);
        if (k === 'json' && v !== null) setKey(ctx, target, 'body', null);
      }
      if (dependsOn !== undefined) {
        const list = dependsOn === null ? [] : (Array.isArray(dependsOn) ? dependsOn : [dependsOn]).map(String);
        const ids = idsOf(ctx);
        const self = ids[indexOf(ctx, ref)]!;
        const resolved = list.map((d) => ids[indexOf(ctx, d)]!);
        const own = resolved.map((d) => ensureId(ctx, idsOf(ctx).indexOf(d)));
        if (own.includes(self)) fail(`"${self}" cannot wait for itself`);
        setDeps(ctx, items(ctx)[indexOf(ctx, ref)]!, own);
        for (const d of own) if (waitsFor(ctx, d, self)) fail(`"${self}" cannot wait for "${d}": "${d}" already waits for "${self}" (a cycle)`);
      }
      break;
    }
    case 'removeStep': {
      const refs = Array.isArray(op.id) ? op.id : [op.id];
      const ids = refs.map((r) => idsOf(ctx)[indexOf(ctx, r)]!);
      for (const id of ids) {
        const at = idsOf(ctx).indexOf(id);
        ctx.seq.items.splice(at, 1);
        for (const m of items(ctx)) {
          const d = depsOf(m);
          if (d.includes(id))
            setDeps(
              ctx,
              m,
              d.filter((x) => x !== id),
            );
        }
        place(ctx, id, null);
      }
      dropEmptyLayout(ctx);
      break;
    }
    case 'renameStep':
      renameStep(ctx, op.id, op.name, op.newId);
      break;
    case 'connect': {
      const from = idsOf(ctx)[indexOf(ctx, op.from)]!;
      const to = idsOf(ctx)[indexOf(ctx, op.to)]!;
      if (from === to) fail(`A step cannot wait for itself ("${from}")`);
      if (waitsFor(ctx, from, to)) fail(`Connecting "${from}" to "${to}" would make a cycle: "${from}" already waits for "${to}"`);
      const own = ensureId(ctx, idsOf(ctx).indexOf(from));
      const m = items(ctx)[indexOf(ctx, to)]!;
      setDeps(ctx, m, [...depsOf(m), own]);
      break;
    }
    case 'disconnect': {
      const ids = idsOf(ctx);
      const from = ids[indexOf(ctx, op.from)]!;
      const m = items(ctx)[indexOf(ctx, op.to)]!;
      const d = depsOf(m);
      if (!d.includes(from)) fail(`"${op.to}" does not wait for "${from}"`);
      setDeps(
        ctx,
        m,
        d.filter((x) => x !== from),
      );
      break;
    }
    case 'setLayout': {
      if (op.positions === null) {
        const root = ctx.doc.contents;
        const p = isMap(root) ? pairOf(root, 'layout') : undefined;
        if (p) (root as YAMLMap).items.splice((root as YAMLMap).items.indexOf(p), 1);
        break;
      }
      if (typeof op.positions !== 'object') fail('setLayout needs positions: { step id: [x, y] } (or null to auto-arrange)');
      const ids = idsOf(ctx);
      for (const [ref, at] of Object.entries(op.positions)) place(ctx, ids[indexOf(ctx, ref)]!, at);
      dropEmptyLayout(ctx);
      break;
    }
    case 'duplicateStep': {
      added = [];
      for (const ref of Array.isArray(op.id) ? op.id : [op.id]) {
        const i = indexOf(ctx, ref);
        const src = items(ctx)[i]!;
        const copy = src.toJSON() as Record<string, unknown>;
        const srcId = idsOf(ctx)[i]!;
        const name = uniqueName(ctx, `${String(copy.name ?? 'step')} copy`);
        const id = uniqueId(ctx, name);
        const node = ctx.doc.createNode({ ...copy, id, name }) as YAMLMap;
        // keep the copied keys in their order, id first
        node.items.sort((a, b) => (keyOf(a) === 'id' ? -1 : keyOf(b) === 'id' ? 1 : 0));
        const d = pairOf(node, 'dependsOn');
        if (d && isSeq(d.value)) d.value.flow = true;
        ctx.seq.items.splice(i + 1, 0, node);
        const layout = layoutMap(ctx, false);
        const pos = layout && valueOf(layout, srcId);
        if (Array.isArray(pos) && pos.length === 2) place(ctx, id, [Number(pos[0]) + 32, Number(pos[1]) + 32]);
        added.push(id);
      }
      break;
    }
    case 'addFromCollection':
    case 'pasteSteps':
      fail(`${op.op} reads the workspace: use editFlowFile`);
      break;
    default:
      fail(
        `Unknown flow edit "${(op as { op: string }).op}": addStep, addSteps, updateStep, removeStep, renameStep, connect, disconnect, setLayout, duplicateStep, replace, addFromCollection, pasteSteps`,
      );
  }
  return { text: finish(ctx, text), ...(added ? { added } : {}) };
}

/** Rename a step; returns its id afterwards. */
function renameStep(ctx: Ctx, ref: string, name?: string, newId?: string): string {
  const i = indexOf(ctx, ref);
  const m = items(ctx)[i]!;
  const before = idsOf(ctx)[i]!;
  if (name !== undefined) {
    const n = name.trim();
    if (!n) fail('A step needs a name');
    const other = items(ctx).findIndex((x, j) => j !== i && valueOf(x, 'name') === n);
    if (other >= 0) fail(`Another step is called "${n}"`);
    setKey(ctx, m, 'name', n);
  }
  if (newId !== undefined) {
    const id = newId.trim();
    if (!/^[\w.:-]+$/.test(id)) fail(`"${newId}" is not an id: letters, digits, - _ . :`);
    const ids = idsOf(ctx);
    if (ids.some((x, j) => j !== i && x === id)) fail(`Another step has the id "${id}"`);
    setKey(ctx, m, 'id', id);
  }
  const after = idsOf(ctx)[i]!;
  renameRefs(ctx, before, after);
  return after;
}

/* ------------------------------------------------------------------ steps from saved requests */

const ID_FIELD = /^(id|uuid|.*[a-z0-9]Id|.*_id|.*token|.*Token|.*_key|key)$/;

/** Extracts worth suggesting from a saved example's JSON body: ids and tokens at the top or one level down. */
export function suggestedExtracts(examples: SavedExample[] | undefined, stepName: string): Record<string, string> {
  const ex = (examples ?? []).find((e) => e.status < 400 && e.body) ?? (examples ?? [])[0];
  if (!ex?.body) return {};
  let body: unknown;
  try {
    body = JSON.parse(ex.body);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const noun = slugify(stepName)
    .split('-')
    .filter((w) => !['get', 'create', 'a', 'an', 'the', 'new', 'add', 'post', 'list', 'one', 'read'].includes(w))[0];
  const visit = (v: unknown, path: string, depth: number) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 1) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}['${k}']`;
      if ((typeof x === 'string' || typeof x === 'number') && ID_FIELD.test(k)) {
        const name = k === 'id' || k === 'uuid' ? `${noun ? noun.replace(/-./g, (m) => m[1]!.toUpperCase()) : 'item'}Id` : k;
        if (!(name in out)) out[name] = p;
      } else visit(x, p, depth + 1);
    }
  };
  visit(body, '$', 0);
  return Object.fromEntries(Object.entries(out).slice(0, 4));
}

type Saved = Exclude<CollectionNode, { kind: 'folder' }>;

/** A saved request as a step (the same conversion as Save as test), with extracts suggested from its saved examples. */
export function stepFromSavedRequest(node: Saved): FlowStepInput {
  const { test } =
    node.kind === 'graphql'
      ? testObjectFromRequest(
          node.name,
          {
            kind: 'graphql',
            endpoint: node.request.endpoint,
            query: node.request.query,
            variables: node.request.variables as Record<string, unknown> | undefined,
            operationName: node.request.operationName,
            headers: node.request.headers,
            auth: node.request.auth,
          },
          node.assertions,
        )
      : testObjectFromRequest(node.name, { kind: 'http', request: node.request, preRequestScript: node.preRequestScript, testScript: node.testScript }, node.assertions);
  const extract = node.kind === 'http' ? suggestedExtracts(node.examples, node.name) : {};
  if (!Object.keys(extract).length) return test;
  // extract: before the checks
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(test)) {
    if (TAIL_KEYS.includes(k) && !('extract' in out)) out.extract = extract;
    out[k] = v;
  }
  if (!('extract' in out)) out.extract = extract;
  return out;
}

/** The requests of a collection to add: the named requests and every request of the named folders, in collection order. */
export function collectionSteps(collection: Collection, refs?: string[]): FlowStepInput[] {
  const picked: Saved[] = [];
  const all = (nodes: CollectionNode[]): Saved[] => nodes.flatMap((n) => (n.kind === 'folder' ? all(n.items) : [n]));
  if (!refs?.length) picked.push(...all(collection.items));
  else {
    const want = new Set(refs);
    const found = new Set<string>();
    const walk = (nodes: CollectionNode[], inside: boolean) => {
      for (const n of nodes) {
        const hit = want.has(n.id) || want.has(n.name);
        if (hit) found.add(want.has(n.id) ? n.id : n.name);
        if (n.kind === 'folder') walk(n.items, inside || hit);
        else if (inside || hit) picked.push(n);
      }
    };
    walk(collection.items, false);
    const missing = refs.filter((r) => !found.has(r));
    if (missing.length) fail(`Not in "${collection.name}": ${missing.join(', ')}`);
  }
  if (!picked.length) fail(`Nothing to add: no requests in ${refs?.length ? 'what was picked' : `"${collection.name}"`}`);
  if (picked.length > 100) fail(`${picked.length} requests: pick a folder of at most 100`);
  return picked.map(stepFromSavedRequest);
}

/* ------------------------------------------------------------------ the file */

export interface FlowFileEdit extends FlowEditResult {
  /** The file inside tests/. */
  file: string;
  /** The text before the edit (the designer's undo keeps it). */
  before: string;
  /** The steps after the edit (as `testpion flow` lists them). */
  steps: FlowStep[];
  /** Written to the file (false with dryRun). */
  written: boolean;
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
  const list = Array.isArray(data) ? data : Array.isArray(root?.tests) ? (root!.tests as unknown[]) : root && (root.type || root.url || root.request) ? [root] : [];
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
  return out;
}

/**
 * Apply an edit to a test file inside tests/ and save it: what the app's Flow tab (RPC tests.flowEdit), `testpion flow
 * edit` and the flow_* MCP tools do. Steps from a collection and pasted steps are read from the workspace here.
 */
export function editFlowFile(store: WorkspaceStore, file: string, op: FlowEditOp, opts: { dryRun?: boolean } = {}): FlowFileEdit {
  const rel = file.replace(/\\/g, '/').replace(/^tests\//, '');
  const abs = store.safePath(rel, store.path('tests'));
  if (!existsSync(abs)) fail(`No such test file: tests/${rel}`);
  if (isSuiteFile(rel)) fail('A suite names other test files; open one of them to design its flow');
  const before = store.readTestFile(rel);
  let resolved: FlowEditOp = op;
  if (op?.op === 'addFromCollection') {
    const c = requireCollection(store, String(op.collection ?? ''), { loadable: true });
    resolved = { op: 'addSteps', steps: collectionSteps(c, op.items), after: op.after, at: op.at, chain: op.chain ?? true };
  } else if (op?.op === 'pasteSteps') {
    const src = String(op.from ?? '')
      .replace(/\\/g, '/')
      .replace(/^tests\//, '');
    const srcText = src === rel ? before : store.readTestFile(src);
    const ctx = open(srcText, src);
    const ids = idsOf(ctx);
    const picked = (op.ids ?? []).map((ref) => indexOf(ctx, ref));
    // a step without an id of its own gets one from its name; dependsOn among the pasted steps follows
    const newIds = new Map(picked.map((i) => [ids[i]!, String(items(ctx)[i]!.toJSON().id ?? '') || slugify(String(valueOf(items(ctx)[i]!, 'name') ?? 'step'))]));
    const steps = picked.map((i) => {
      const raw = items(ctx)[i]!.toJSON() as Record<string, unknown>;
      const deps = depsOf(items(ctx)[i]!).map((d) => newIds.get(d) ?? d);
      return { ...raw, id: newIds.get(ids[i]!), ...(deps.length ? { dependsOn: deps } : {}) };
    });
    resolved = { op: 'addSteps', steps, after: op.after, at: op.at };
  }
  const r = applyFlowEdit(before, resolved, { file: rel });
  if (!opts.dryRun && r.text !== before) store.writeTestFile(rel, r.text);
  return { file: rel, before, ...r, steps: flowStepsOfText(r.text, rel), written: !opts.dryRun && r.text !== before };
}
