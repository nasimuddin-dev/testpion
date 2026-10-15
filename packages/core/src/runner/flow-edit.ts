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
import type { WorkspaceStore } from '../storage/workspace.js';
import { requireCollection } from '../storage/env-edit.js';
import { slugify } from '../util/ids.js';
import { isSuiteFile, normalizeTest } from './loader.js';
import { collectionSteps, TAIL_KEYS } from './flow-steps-from-requests.js';
import { flowStepOf } from './flow-steps.js';
import { parseWebhook } from './flow-webhook-config.js';
import { FLOW_COLORS, flowGraph, freeSpot, STEP_SIZE, type FlowNote, type FlowStep } from '@testpion/shared';

export { collectionSteps, stepFromSavedRequest, suggestedExtracts } from './flow-steps-from-requests.js';

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
  /** `to` waits for `from` (refused when it would make a cycle); from a condition, `when` says on which branch (its true or false output). */
  | { op: 'connect'; from: string; to: string; when?: boolean }
  | { op: 'disconnect'; from: string; to: string }
  /** Place steps on the canvas (null removes one's place); positions null removes the whole layout (auto-arrange). */
  | { op: 'setLayout'; positions: Record<string, [number, number] | null> | null }
  /** A copy of each step right after it, with a new id and " copy" after its name. */
  | { op: 'duplicateStep'; id: string | string[] }
  /** The whole text (an AI draft that was reviewed, or undo). */
  | { op: 'replace'; text: string }
  /** What the flow returns (`output:` at the top: { name: "{{template}}" }); null removes it. */
  | { op: 'setOutput'; output: Record<string, unknown> | null }
  /** Serve the flow behind a webhook (`webhook:` at the top: { path, secret }; a text is the path, {} the default /hooks/<file>); null removes it. */
  | { op: 'setWebhook'; webhook: { path?: string | null; secret?: string | null } | string | null }
  /** Steps from a saved collection: requests (or every request of folders) by id or name, in order, chained. Needs the workspace. */
  | { op: 'addFromCollection'; collection: string; items?: string[]; after?: string; at?: [number, number]; chain?: boolean }
  /** Copy steps of another test file (copy / paste between flows); dependsOn among the copied steps is kept. Needs the workspace. */
  | { op: 'pasteSteps'; from: string; ids: string[]; after?: string; at?: [number, number] }
  /** Put steps in a parallel group (`parallel`: its name; null takes them out) or the Finally lane (`finally`: true or false). */
  | { op: 'group'; ids: string | string[]; parallel?: string | null; finally?: boolean }
  /** A sticky note on the canvas (`layout.notes`): Markdown text at x, y (w, h: its size; color: one of FLOW_COLORS). The runner ignores it. */
  | { op: 'addNote'; note: Partial<Omit<FlowNote, 'id'>> & { id?: string } }
  | { op: 'updateNote'; id: string; set: Partial<Omit<FlowNote, 'id'>> & { color?: string | null } }
  | { op: 'removeNote'; id: string }
  /** A coloured frame with a title around steps (`layout.frames`): visual only, it moves with its steps. */
  | { op: 'addFrame'; title?: string; color?: string; steps: string[]; id?: string }
  /** Change a frame's title, colour or steps (steps: replaces the list). */
  | { op: 'updateFrame'; id: string; set: { title?: string; color?: string | null; steps?: string[] } }
  | { op: 'removeFrame'; id: string }
  /** The flow's inputs (the Start node): expose.inputs when exposed, else defaults.vars. */
  | { op: 'setInputs'; inputs: FlowStartInput[] }
  /** Several edits as one (one undo step in the designer): each applies to the text the one before made. */
  | { op: 'batch'; ops: FlowEditOp[] }
  /**
   * Steps dropped on the canvas, as one edit: after a step (`after`, on a condition's branch with `when`), into a
   * connection (`between`: `to` then waits for the last new step), or alone; `chain` (default true) makes each wait for
   * the one before it (steps that name their own dependsOn among themselves keep it); `vars` are added to
   * defaults.vars where missing (a recorded origin); `at` places the first one (the others to its right).
   */
  | { op: 'insertSteps'; steps: FlowStepInput[]; chain?: boolean; after?: string; when?: boolean; between?: { from: string; to: string }; at?: [number, number]; vars?: Record<string, unknown> };

export interface FlowEditResult {
  text: string;
  /** The ids of the steps an add, duplicate or paste made (or of the note / frame addNote / addFrame made). */
  added?: string[];
}

const REQUEST_KEYS = new Set(['method', 'url', 'params', 'query', 'headers', 'cookies', 'auth', 'body', 'json', 'settings']);
/** New keys of a step go before these (the checks and scripts close a test). */
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

/** The ids of the condition steps of the flow. */
function conditionIds(ctx: Ctx): Set<string> {
  const ids = idsOf(ctx);
  return new Set(items(ctx).flatMap((m, i) => (valueOf(m, 'type') === 'condition' ? [ids[i]!] : [])));
}

/** A step that no longer waits for any condition has no branch: its `when:` goes. */
function dropStrayWhen(ctx: Ctx) {
  const conds = conditionIds(ctx);
  for (const m of items(ctx)) if (pairOf(m, 'when') && !depsOf(m).some((d) => conds.has(d))) setKey(ctx, m, 'when', null);
}

/** One input of a flow (the Start node's rows): its name, the value a run starts with, what it is. */
export interface FlowStartInput {
  name: string;
  default?: unknown;
  description?: string;
}

/**
 * Set the flow's inputs: in its `expose.inputs` when the file is exposed as an MCP tool (name, default, description),
 * else as `defaults.vars` (the values every step starts with: { name: default }). An empty list removes them.
 */
function setInputs(ctx: Ctx, inputs: FlowStartInput[]) {
  const root = ctx.doc.contents;
  if (!isMap(root)) fail('Inputs need a test file written as a map (name, tests: …), not a bare list');
  if (!Array.isArray(inputs)) fail('setInputs needs inputs: [{ name, default, description }]');
  const map = root as YAMLMap;
  const clean = inputs
    .filter((i) => i && typeof i.name === 'string' && i.name.trim())
    .map((i) => ({ name: i.name.trim(), ...(i.default !== undefined && i.default !== '' ? { default: i.default } : {}), ...(i.description?.trim() ? { description: i.description.trim() } : {}) }));
  const names = clean.map((i) => i.name);
  const dup = names.find((n, k) => names.indexOf(n) !== k);
  if (dup) fail(`Two inputs are called "${dup}"`);
  const bad = names.find((n) => !/^[A-Za-z_$][\w$.-]*$/.test(n));
  if (bad) fail(`"${bad}" is not a variable name: letters, digits, _ . - (not first)`);
  const expose = pairOf(map, 'expose');
  if (expose && isMap(expose.value)) {
    setKey(ctx, expose.value, 'inputs', clean.length ? clean : null);
    return;
  }
  const defaults = pairOf(map, 'defaults');
  if (!clean.length) {
    if (defaults && isMap(defaults.value)) {
      setKey(ctx, defaults.value, 'vars', null);
      if (!defaults.value.items.length) map.items.splice(map.items.indexOf(defaults), 1);
    }
    return;
  }
  const vars = Object.fromEntries(clean.map((i) => [i.name, i.default ?? '']));
  if (defaults && isMap(defaults.value)) setKey(ctx, defaults.value, 'vars', vars);
  else {
    const pair = ctx.doc.createPair('defaults', ctx.doc.createNode({ vars }));
    const tests = (map.items as Pair[]).findIndex((p) => keyOf(p) === 'tests');
    if (tests >= 0) map.items.splice(tests, 0, pair);
    else map.items.push(pair);
  }
}

/** Insert dropped steps (see the insertSteps op); returns their ids. */
function insertSteps(ctx: Ctx, op: Extract<FlowEditOp, { op: 'insertSteps' }>): string[] {
  if (!Array.isArray(op.steps) || !op.steps.length) fail('Nothing to insert');
  let after = op.after;
  let when = op.when;
  let into: { m: YAMLMap; from: string } | undefined;
  if (op.between) {
    // the connection from → to: `to` waits for the new steps instead of `from`
    const from = ensureId(ctx, indexOf(ctx, op.between.from));
    const m = items(ctx)[indexOf(ctx, op.between.to)]!;
    if (!depsOf(m).includes(from)) fail(`"${op.between.to}" does not wait for "${from}": there is no connection to insert into`);
    // a branch of a condition stays the branch: the first new step takes it
    if (when === undefined && pairOf(m, 'when')) when = valueOf(m, 'when') === true;
    into = { m, from };
    after = from;
  }
  const steps = when !== undefined ? [{ ...op.steps[0]!, when }, ...op.steps.slice(1)] : op.steps;
  const added = addMany(ctx, steps, after, op.chain ?? true, op.at);
  if (into) {
    const last = added[added.length - 1]!;
    // the step's map, found again by its place (ids may have been given while adding)
    const target = items(ctx).find((x) => x === into!.m)!;
    setDeps(ctx, target, depsOf(target).map((d) => (d === into!.from ? last : d)));
    if (pairOf(target, 'when')) setKey(ctx, target, 'when', null);
  }
  if (op.vars && Object.keys(op.vars).length) mergeDefaultVars(ctx, op.vars);
  dropStrayWhen(ctx);
  return added;
}

/** Add variables to defaults.vars, leaving the ones already there as they are. */
function mergeDefaultVars(ctx: Ctx, vars: Record<string, unknown>) {
  const root = ctx.doc.contents;
  if (!isMap(root)) return;
  const map = root as YAMLMap;
  let defaults = pairOf(map, 'defaults');
  if (!defaults || !isMap(defaults.value)) {
    const pair = ctx.doc.createPair('defaults', ctx.doc.createNode({}));
    const tests = (map.items as Pair[]).findIndex((p) => keyOf(p) === 'tests');
    if (tests >= 0) map.items.splice(tests, 0, pair);
    else map.items.push(pair);
    defaults = pair as Pair;
  }
  const d = defaults.value as YAMLMap;
  const have = (valueOf(d, 'vars') ?? {}) as Record<string, unknown>;
  const merged = { ...have };
  for (const [k, v] of Object.entries(vars)) if (!(k in merged)) merged[k] = v;
  setKey(ctx, d, 'vars', merged);
}

/** Set (or with null remove) the file's `output:`: before its tests, after name, description and expose. */
function setOutput(ctx: Ctx, output: Record<string, unknown> | null) {
  const root = ctx.doc.contents;
  if (!isMap(root)) fail('output: needs a test file written as a map (name, tests: …), not a bare list');
  const map = root as YAMLMap;
  const existing = pairOf(map, 'output');
  if (output === null || output === undefined) {
    if (existing) map.items.splice(map.items.indexOf(existing), 1);
    return;
  }
  if (typeof output !== 'object' || Array.isArray(output)) fail('output is a map { name: "{{template}}" }');
  const clean = Object.fromEntries(Object.entries(output).filter(([k]) => k.trim()));
  if (!Object.keys(clean).length) {
    if (existing) map.items.splice(map.items.indexOf(existing), 1);
    return;
  }
  const node = ctx.doc.createNode(clean) as Node;
  if (existing) {
    existing.value = node;
    return;
  }
  const pair = ctx.doc.createPair('output', node);
  const tests = (map.items as Pair[]).findIndex((p) => keyOf(p) === 'tests');
  if (tests >= 0) map.items.splice(tests, 0, pair);
  else map.items.push(pair);
}

/** Set (or with null remove) the file's `webhook:`: after name, description and expose, before output and the tests. */
function setWebhook(ctx: Ctx, webhook: { path?: string | null; secret?: string | null } | string | null) {
  const root = ctx.doc.contents;
  if (!isMap(root)) fail('webhook: needs a test file written as a map (name, tests: …), not a bare list');
  const map = root as YAMLMap;
  const existing = pairOf(map, 'webhook');
  if (webhook === null || webhook === undefined) {
    if (existing) map.items.splice(map.items.indexOf(existing), 1);
    return;
  }
  const raw = typeof webhook === 'string' ? { path: webhook } : webhook;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('webhook is { path, secret } (or a path, or null to remove it)');
  // keep what is not given (a secret stays when only the path changes); null removes a key
  const before = (existing && isMap(existing.value) ? (existing.value.toJSON() as Record<string, unknown>) : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...before };
  for (const k of ['path', 'secret'] as const) if (k in raw) merged[k] = (raw as Record<string, unknown>)[k];
  const clean = Object.fromEntries(Object.entries(merged).filter(([k, v]) => (k === 'path' || k === 'secret') && v !== null && v !== undefined && String(v).trim() !== ''));
  const parsed = parseWebhook(clean, ctx.file);
  const value: Record<string, unknown> = { ...(parsed?.path ? { path: parsed.path } : {}), ...(parsed?.secret ? { secret: parsed.secret } : {}) };
  const node = ctx.doc.createNode(value) as Node;
  if (existing) {
    existing.value = node;
    return;
  }
  const pair = ctx.doc.createPair('webhook', node);
  const at = (map.items as Pair[]).findIndex((p) => ['output', 'layout', 'defaults', 'tests'].includes(keyOf(p)));
  if (at >= 0) map.items.splice(at, 0, pair);
  else map.items.push(pair);
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
  const p = layout && !RESERVED.has(from) ? pairOf(layout, from) : undefined;
  if (p) {
    if (RESERVED.has(to)) layout!.items.splice(layout!.items.indexOf(p), 1);
    else p.key = ctx.doc.createNode(to);
  }
  // the frames name their steps by id: they follow too
  for (const f of extras(ctx, 'frames', false)?.items ?? []) {
    if (!isMap(f)) continue;
    const list = valueOf(f, 'steps');
    if (Array.isArray(list) && list.map(String).includes(from))
      setFlowList(
        ctx,
        f,
        'steps',
        list.map((x) => (String(x) === from ? to : String(x))),
      );
  }
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

/** Keys of `layout:` that are not a step's place: the sticky notes and the frames. */
const RESERVED = new Set(['notes', 'frames']);

/** The list of notes or frames in `layout:` (created when asked for). */
function extras(ctx: Ctx, key: 'notes' | 'frames', create: true): YAMLSeq;
function extras(ctx: Ctx, key: 'notes' | 'frames', create: false): YAMLSeq | undefined;
function extras(ctx: Ctx, key: 'notes' | 'frames', create: boolean): YAMLSeq | undefined {
  const layout = create ? layoutMap(ctx, true) : layoutMap(ctx, false);
  if (!layout) return undefined;
  const p = pairOf(layout, key);
  if (p && isSeq(p.value)) return p.value;
  if (!create) return undefined;
  const seq = ctx.doc.createNode([]) as YAMLSeq;
  if (p) p.value = seq;
  else layout.items.push(ctx.doc.createPair(key, seq));
  return seq;
}

/** Set a list of ids on a map, written on one line: steps: [a, b]. */
function setFlowList(ctx: Ctx, m: YAMLMap, key: string, list: string[]) {
  const node = ctx.doc.createNode(list) as YAMLSeq;
  node.flow = true;
  const p = pairOf(m, key);
  if (p) p.value = node;
  else m.items.push(ctx.doc.createPair(key, node));
}

/** The note or frame with this id (its list and index). */
function extraAt(ctx: Ctx, key: 'notes' | 'frames', id: string): { seq: YAMLSeq; i: number } {
  const seq = extras(ctx, key, false);
  const i = seq ? seq.items.findIndex((x) => isMap(x) && String(valueOf(x, 'id')) === String(id)) : -1;
  const what = key === 'notes' ? 'note' : 'frame';
  if (!seq || i < 0) fail(`No ${what} "${id}" on the canvas${seq?.items.length ? ` (${key}: ${seq.items.map((x) => (isMap(x) ? String(valueOf(x, 'id')) : '?')).join(', ')})` : ''}`);
  return { seq: seq!, i };
}

function newExtraId(ctx: Ctx, key: 'notes' | 'frames', wanted?: string): string {
  const taken = new Set((extras(ctx, key, false)?.items ?? []).map((x) => (isMap(x) ? String(valueOf(x, 'id')) : '')));
  if (wanted && !taken.has(wanted)) return wanted;
  const base = key === 'notes' ? 'note' : 'frame';
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const checkColor = (c: unknown) => {
  if (c === undefined || c === null) return;
  if (!(FLOW_COLORS as readonly string[]).includes(String(c))) fail(`"${String(c)}" is not a colour of the canvas: ${FLOW_COLORS.join(', ')}`);
};

/** A note's keys, checked: numbers rounded (its size at least 80 × 48), a colour of the palette, text of at most 20000 characters. */
function noteValues(set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if (!['x', 'y', 'w', 'h', 'color', 'text'].includes(k)) fail(`A note has x, y, w, h, color and text, not "${k}"`);
    if (['x', 'y', 'w', 'h'].includes(k)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`A note's ${k} is a number`);
      const n = Math.round(v as number);
      out[k] = k === 'w' ? Math.min(2000, Math.max(80, n)) : k === 'h' ? Math.min(2000, Math.max(48, n)) : n;
    } else if (k === 'color') {
      checkColor(v);
      out[k] = v === null || v === undefined ? null : String(v);
    } else {
      const t = v === null || v === undefined ? '' : String(v);
      if (t.length > 20000) fail('A note holds at most 20000 characters');
      out[k] = t;
    }
  }
  return out;
}

/** Steps named by id or name, as their own ids (a step without an id of its own gets one, as connect does). */
function frameSteps(ctx: Ctx, refs: unknown): string[] {
  if (!Array.isArray(refs) || !refs.length) fail('A frame needs steps: the ids of the steps it goes around');
  const at = (refs as unknown[]).map((r) => indexOf(ctx, String(r)));
  return [...new Set(at.map((i) => ensureId(ctx, i)))];
}

type AnnotateOp = Extract<FlowEditOp, { op: 'addNote' | 'updateNote' | 'removeNote' | 'addFrame' | 'updateFrame' | 'removeFrame' }>;

/** Add, change or remove a note or a frame; returns the id of what was added. */
function annotate(ctx: Ctx, op: AnnotateOp): string | undefined {
  switch (op.op) {
    case 'addNote': {
      const { id: wanted, ...rest } = (op.note ?? {}) as Record<string, unknown>;
      const v = noteValues({ x: 0, y: 0, w: 220, h: 120, text: '', ...rest });
      const id = newExtraId(ctx, 'notes', wanted ? String(wanted) : undefined);
      extras(ctx, 'notes', true).items.push(ctx.doc.createNode({ id, x: v.x, y: v.y, w: v.w, h: v.h, ...(v.color ? { color: v.color } : {}), text: v.text }) as YAMLMap);
      return id;
    }
    case 'updateNote': {
      if (!op.set || typeof op.set !== 'object') fail('updateNote needs set: { x, y, w, h, color, text }');
      const { seq, i } = extraAt(ctx, 'notes', op.id);
      const m = seq.items[i] as YAMLMap;
      for (const [k, v] of Object.entries(noteValues(op.set as Record<string, unknown>))) {
        const p = pairOf(m, k);
        if (v === null) {
          if (p) m.items.splice(m.items.indexOf(p), 1);
        } else if (p) p.value = ctx.doc.createNode(v) as Node;
        else {
          // a new colour goes before the text (the text, often long, stays last)
          const text = m.items.findIndex((x) => keyOf(x as Pair) === 'text');
          m.items.splice(text >= 0 ? text : m.items.length, 0, ctx.doc.createPair(k, v));
        }
      }
      return undefined;
    }
    case 'removeNote': {
      const { seq, i } = extraAt(ctx, 'notes', op.id);
      seq.items.splice(i, 1);
      return undefined;
    }
    case 'addFrame': {
      checkColor(op.color);
      const steps = frameSteps(ctx, op.steps);
      const id = newExtraId(ctx, 'frames', op.id ? String(op.id) : undefined);
      const title = String(op.title ?? '').trim() || 'Group';
      const node = ctx.doc.createNode({ id, title, ...(op.color ? { color: op.color } : {}) }) as YAMLMap;
      setFlowList(ctx, node, 'steps', steps);
      extras(ctx, 'frames', true).items.push(node);
      return id;
    }
    case 'updateFrame': {
      if (!op.set || typeof op.set !== 'object') fail('updateFrame needs set: { title, color, steps }');
      const { seq, i } = extraAt(ctx, 'frames', op.id);
      const m = seq.items[i] as YAMLMap;
      for (const [k, v] of Object.entries(op.set)) {
        const p = pairOf(m, k);
        const before = (key: string) => {
          const at = m.items.findIndex((x) => keyOf(x as Pair) === key);
          return at >= 0 ? at : m.items.length;
        };
        if (k === 'title') {
          const t = String(v ?? '').trim();
          if (!t) fail('A frame needs a title');
          if (p) p.value = ctx.doc.createNode(t) as Node;
          else m.items.splice(before('steps'), 0, ctx.doc.createPair('title', t));
        } else if (k === 'color') {
          checkColor(v);
          if (v === null || v === undefined) {
            if (p) m.items.splice(m.items.indexOf(p), 1);
          } else if (p) p.value = ctx.doc.createNode(String(v)) as Node;
          else m.items.splice(before('steps'), 0, ctx.doc.createPair('color', String(v)));
        } else if (k === 'steps') setFlowList(ctx, m, 'steps', frameSteps(ctx, v));
        else fail(`A frame has title, color and steps, not "${k}"`);
      }
      return undefined;
    }
    case 'removeFrame': {
      const { seq, i } = extraAt(ctx, 'frames', op.id);
      seq.items.splice(i, 1);
      return undefined;
    }
  }
}

/** Steps that are gone leave the frames; a frame left without steps goes. */
function pruneFrames(ctx: Ctx) {
  const seq = extras(ctx, 'frames', false);
  if (!seq) return;
  const ids = new Set(idsOf(ctx));
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const f = seq.items[i];
    if (!isMap(f)) continue;
    const list = valueOf(f, 'steps');
    const steps = Array.isArray(list) ? list.map(String) : [];
    const kept = steps.filter((s) => ids.has(s));
    if (!kept.length) seq.items.splice(i, 1);
    else if (kept.length !== steps.length) setFlowList(ctx, f, 'steps', kept);
  }
}

/** The boxes of the steps the layout places (but `except`): what a new step must not land on. */
function placedBoxes(ctx: Ctx, except?: string): Array<{ x: number; y: number; w: number; h: number }> {
  const layout = layoutMap(ctx, false);
  if (!layout) return [];
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const p of layout.items as Pair[]) {
    const k = keyOf(p);
    if (RESERVED.has(k) || k === except) continue;
    const v = isSeq(p.value) ? (p.value.toJSON() as unknown[]) : undefined;
    if (v && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') out.push({ x: v[0], y: v[1], w: STEP_SIZE.w, h: STEP_SIZE.h });
  }
  // a step never goes under a note either (the notes lie on top: the step would be hidden)
  return [...out, ...noteBoxes(ctx).map((n) => n.box)];
}

/** The notes' boxes, with their YAML nodes (to move them). */
function noteBoxes(ctx: Ctx): Array<{ node: YAMLMap; box: { x: number; y: number; w: number; h: number } }> {
  const seq = extras(ctx, 'notes', false);
  const out: Array<{ node: YAMLMap; box: { x: number; y: number; w: number; h: number } }> = [];
  for (const n of seq?.items ?? []) {
    if (!isMap(n)) continue;
    const v = n.toJSON() as Record<string, unknown>;
    const num = (k: string, d: number) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : d);
    out.push({ node: n, box: { x: num('x', 0), y: num('y', 0), w: num('w', 220), h: num('h', 120) } });
  }
  return out;
}

/** After auto-arrange: a note the new layout put a step under moves to the nearest free place beside the steps. */
function uncoverSteps(ctx: Ctx) {
  const notes = noteBoxes(ctx);
  if (!notes.length) return;
  const g = flowGraph(flowStepsOfText(ctx.doc.toString(), ctx.file).map(({ position: _p, ...s }) => s));
  const taken: Array<{ x: number; y: number; w: number; h: number }> = g.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const covers = (b: { x: number; y: number; w: number; h: number }) => g.nodes.some((n) => b.x < n.x + n.w && b.x + b.w > n.x && b.y < n.y + n.h && b.y + b.h > n.y);
  for (const { node, box } of notes) {
    if (covers(box)) {
      const [x, y] = freeSpot(taken, [box.x, box.y], { w: box.w, h: box.h }, 16, true);
      node.set('x', x);
      node.set('y', y);
      taken.push({ ...box, x, y });
    } else taken.push(box);
  }
}

function place(ctx: Ctx, id: string, at: [number, number] | null) {
  // a step with the id "notes" or "frames" keeps no place of its own: those keys hold the canvas's notes and frames
  if (RESERVED.has(id)) return;
  if (!at) {
    const m = layoutMap(ctx, false);
    const p = m && pairOf(m, id);
    if (p) m!.items.splice(m!.items.indexOf(p), 1);
    return;
  }
  if (!at.every((n) => typeof n === 'number' && Number.isFinite(n))) fail(`A position is [x, y] in numbers (${id})`);
  const node = ctx.doc.createNode([Math.round(at[0]), Math.round(at[1])]) as YAMLSeq;
  node.flow = true;
  const m = layoutMap(ctx, true);
  const p = pairOf(m, id);
  if (p) p.value = node;
  else m.items.push(ctx.doc.createPair(id, node));
}

function dropEmptyLayout(ctx: Ctx) {
  const root = ctx.doc.contents;
  if (!isMap(root)) return;
  const layout = layoutMap(ctx, false);
  for (const k of RESERVED) {
    const e = layout ? pairOf(layout, k) : undefined;
    if (e && isSeq(e.value) && !e.value.items.length) layout!.items.splice(layout!.items.indexOf(e), 1);
  }
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
  // a new step never lands on one already placed: the free place nearest below where it was asked for
  if (at) place(ctx, id, freeSpot(placedBoxes(ctx, id), at));
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
    fail('An edit is { op: addStep | addSteps | updateStep | removeStep | renameStep | connect | disconnect | setLayout | duplicateStep | setOutput | setWebhook | group | addNote | updateNote | removeNote | addFrame | updateFrame | removeFrame | setInputs | replace, … }');
  if (opts.file && isSuiteFile(opts.file)) fail('A suite names other test files; open one of them to design its flow');
  if (op.op === 'batch') {
    if (!Array.isArray(op.ops) || !op.ops.length) fail('batch needs ops: [ … ]');
    let t = text;
    const added: string[] = [];
    for (const o of op.ops) {
      if (o?.op === 'batch') fail('A batch holds edits, not batches');
      const r = applyFlowEdit(t, o, opts);
      t = r.text;
      added.push(...(r.added ?? []));
    }
    return { text: t, ...(added.length ? { added } : {}) };
  }
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
      dropStrayWhen(ctx);
      pruneFrames(ctx);
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
      if (isFinally(ctx, from) && !isFinally(ctx, to)) fail(`"${from}" is a finally step: it runs after every other step, so "${to}" cannot wait for it`);
      const own = ensureId(ctx, idsOf(ctx).indexOf(from));
      const m = items(ctx)[indexOf(ctx, to)]!;
      setDeps(ctx, m, [...depsOf(m), own]);
      if (op.when !== undefined && op.when !== null) {
        if (!conditionIds(ctx).has(own)) fail(`when: picks a branch of a condition step; "${from}" is not one`);
        setKey(ctx, m, 'when', op.when === true || String(op.when) === 'true');
      }
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
      dropStrayWhen(ctx);
      break;
    }
    case 'setInputs':
      setInputs(ctx, op.inputs);
      break;
    case 'insertSteps':
      added = insertSteps(ctx, op);
      break;
    case 'setOutput':
      setOutput(ctx, op.output);
      break;
    case 'setWebhook':
      setWebhook(ctx, op.webhook);
      break;
    case 'setLayout': {
      if (op.positions === null) {
        // auto-arrange forgets where the steps were dragged; the notes and frames stay
        const layout = layoutMap(ctx, false);
        if (layout) for (let i = layout.items.length - 1; i >= 0; i--) if (!RESERVED.has(keyOf(layout.items[i] as Pair))) layout.items.splice(i, 1);
        uncoverSteps(ctx);
        dropEmptyLayout(ctx);
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
        if (Array.isArray(pos) && pos.length === 2) place(ctx, id, freeSpot(placedBoxes(ctx, id), [Number(pos[0]) + 32, Number(pos[1]) + 32]));
        added.push(id);
      }
      break;
    }
    case 'group':
      group(ctx, op);
      break;
    case 'addNote':
    case 'updateNote':
    case 'removeNote':
    case 'addFrame':
    case 'updateFrame':
    case 'removeFrame': {
      const id = annotate(ctx, op);
      if (id) added = [id];
      dropEmptyLayout(ctx);
      break;
    }
    case 'addFromCollection':
    case 'pasteSteps':
      fail(`${op.op} reads the workspace: use editFlowFile`);
      break;
    default:
      fail(
        `Unknown flow edit "${(op as { op: string }).op}": addStep, addSteps, updateStep, removeStep, renameStep, connect, disconnect, setLayout, duplicateStep, setOutput, setWebhook, group, addNote, updateNote, removeNote, addFrame, updateFrame, removeFrame, setInputs, insertSteps, replace, addFromCollection, pasteSteps`,
      );
  }
  return { text: finish(ctx, text), ...(added ? { added } : {}) };
}

const isFinally = (ctx: Ctx, id: string): boolean => {
  const v = valueOf(items(ctx)[idsOf(ctx).indexOf(id)]!, 'finally');
  return v === true || v === 'true';
};

/** A name of a parallel group nobody in the flow uses yet: group-1, group-2 … */
export function newGroupName(text: string): string {
  const used = new Set([...text.matchAll(/^\s*-?\s*parallel:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]));
  let n = 1;
  while (used.has(`group-${n}`)) n++;
  return `group-${n}`;
}

/**
 * Put steps in a parallel group or the Finally lane, or take them out. A finally step runs after every other step, so
 * steps that wait for one are refused; a step in the Finally lane leaves its parallel group (and the other way round).
 */
function group(ctx: Ctx, op: { ids: string | string[]; parallel?: string | null; finally?: boolean }) {
  const refs = Array.isArray(op.ids) ? op.ids : [op.ids];
  if (!refs.length) fail('group needs ids: the steps to put in (or take out of) a group');
  if (op.parallel === undefined && op.finally === undefined) fail('group needs parallel: <group name> (null takes the steps out) or finally: true | false');
  const ids = refs.map((r) => idsOf(ctx)[indexOf(ctx, r)]!);
  const name = op.parallel === null || op.parallel === undefined ? op.parallel : String(op.parallel).trim();
  if (name !== undefined && name !== null && !name) fail('A parallel group needs a name');
  if (op.finally === true) {
    const all = idsOf(ctx);
    for (const id of ids) {
      const waiting = items(ctx)
        .map((m, i) => (depsOf(m).includes(id) && !ids.includes(all[i]!) ? all[i]! : ''))
        .filter(Boolean);
      if (waiting.length) fail(`"${id}" cannot be a finally step: ${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} for it, and a finally step runs after every other step`);
    }
  }
  for (const id of ids) {
    const m = items(ctx)[indexOf(ctx, id)]!;
    if (op.finally !== undefined) {
      setKey(ctx, m, 'finally', op.finally ? true : null);
      if (op.finally) setKey(ctx, m, 'parallel', null);
    }
    if (name !== undefined) {
      setKey(ctx, m, 'parallel', name);
      if (name) setKey(ctx, m, 'finally', null);
    }
  }
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
