/** Where steps sit on the canvas (`layout:`), notes and frames, and renaming a step everywhere it is named. See flow-edit.ts. */
import type { FlowEditOp } from './flow-edit.js';
import type { Node, Pair, YAMLMap, YAMLSeq } from 'yaml';
import { isMap, isSeq } from '../util/lazy-yaml.js';
import { FLOW_COLORS, flowGraph, freeSpot, STEP_SIZE } from '@testpion/shared';
import { type Ctx, depsOf, fail, flowStepsOfText, idsOf, indexOf, items, keyOf, pairOf, setDeps, setKey, uniqueId, valueOf } from './flow-edit-ctx.js';


/** Replace a step id everywhere it is named: dependsOn of every step and the layout. */
export function renameRefs(ctx: Ctx, from: string, to: string) {
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

/** Give the step an id: of its own (so dependsOn names stay short and survive a rename); references follow. */
export function ensureId(ctx: Ctx, i: number): string {
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

export function layoutMap(ctx: Ctx, create: true): YAMLMap;

export function layoutMap(ctx: Ctx, create: false): YAMLMap | undefined;

export function layoutMap(ctx: Ctx, create: boolean): YAMLMap | undefined {
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
export const RESERVED = new Set(['notes', 'frames']);

/** The list of notes or frames in `layout:` (created when asked for). */
export function extras(ctx: Ctx, key: 'notes' | 'frames', create: true): YAMLSeq;

export function extras(ctx: Ctx, key: 'notes' | 'frames', create: false): YAMLSeq | undefined;

export function extras(ctx: Ctx, key: 'notes' | 'frames', create: boolean): YAMLSeq | undefined {
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
export function annotate(ctx: Ctx, op: AnnotateOp): string | undefined {
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
export function pruneFrames(ctx: Ctx) {
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
export function placedBoxes(ctx: Ctx, except?: string): Array<{ x: number; y: number; w: number; h: number }> {
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
export function uncoverSteps(ctx: Ctx) {
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

export function place(ctx: Ctx, id: string, at: [number, number] | null) {
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

export function dropEmptyLayout(ctx: Ctx) {
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
