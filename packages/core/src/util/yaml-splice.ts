/**
 * Writing an edited YAML document back without touching what the edit did not change. `doc.toString()` renders the
 * whole file again: a flow list elsewhere (`assertions: [{type: status}]`) comes back as `[ { type: status } ]`, and
 * indentation and spacing follow the library, not the author. Here only the nodes that differ between the original
 * text and the edited document are rendered: each changed value (or key/value pair, or list item) is cut from the
 * rendered text and spliced into the original at its place, re-indented to the original's columns. Everything else —
 * comments, flow-style collections, quoting, blank lines — stays byte for byte. When a change cannot be placed this way
 * (a key added at the top, a list that grew) or the result would not read back as the edited document, the whole
 * rendering is used, as before.
 */
import type { Document, Node, Pair, YAMLMap, YAMLSeq } from 'yaml';
import { isMap, isScalar, isSeq, parseDocument } from './lazy-yaml.js';

type Edit = [start: number, end: number, text: string];

const js = (n: unknown): string => JSON.stringify(n && typeof n === 'object' && 'toJSON' in n ? (n as Node).toJSON() : n) ?? 'undefined';
const keyOf = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : String(p.key));
const isBlock = (n: unknown): n is YAMLMap | YAMLSeq => (isMap(n) || isSeq(n)) && !(n as YAMLMap).flow;
const column = (text: string, at: number) => at - (text.lastIndexOf('\n', at - 1) + 1);

/** `B`'s text from `start` to `end`, its later lines moved from `from` columns to `to` columns (undefined when it can't be). */
function moved(B: string, start: number, end: number, from: number, to: number): string | undefined {
  const lines = B.slice(start, end).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const lead = /^ */.exec(l)![0].length;
    if (lead < from - to) return undefined;
    lines[i] = to >= from ? ' '.repeat(to - from) + l : l.slice(from - to);
  }
  return lines.join('\n');
}

/** Replace `a` (in A) with `b` (in B) between the given offsets; false when a range is missing or can't be moved. */
function replace(A: string, B: string, a: [number, number] | undefined, b: [number, number] | undefined, edits: Edit[]): boolean {
  if (!a || !b) return false;
  // a block value's range ends after its last line break: compare and replace the text up to its last character
  const trim = (t: string, r: [number, number]): [number, number] => {
    let e = r[1];
    while (e > r[0] && /[\s]/.test(t[e - 1]!)) e--;
    return [r[0], e];
  };
  a = trim(A, a);
  b = trim(B, b);
  const text = moved(B, b[0], b[1], column(B, b[0]), column(A, a[0]));
  if (text === undefined) return false;
  edits.push([a[0], a[1], text]);
  return true;
}

const range = (n: Node | null | undefined): [number, number] | undefined => (n?.range ? [n.range[0], n.range[1]] : undefined);
const pairRange = (p: Pair): [number, number] | undefined => {
  const k = range(p.key as Node);
  const v = range(p.value as Node);
  return k ? [k[0], v ? v[1] : k[1]] : undefined;
};

/** The edits that turn node `a` of A into node `b` of B (false: it can't be done by splicing). */
function diff(a: Node, b: Node, A: string, B: string, edits: Edit[]): boolean {
  if (js(a) === js(b)) return true;
  if (isMap(a) && isMap(b) && isBlock(a) && isBlock(b) && a.items.length === b.items.length && a.items.every((p, i) => keyOf(p as Pair) === keyOf(b.items[i] as Pair))) {
    for (const [i, pa] of (a.items as Pair[]).entries()) {
      const pb = b.items[i] as Pair;
      if (js(pa.value) === js(pb.value)) continue;
      const va = pa.value as Node | null;
      const vb = pb.value as Node | null;
      // a block collection both sides: what changed inside it; the same shape of value (a scalar, a flow list): the
      // value alone; else (a flow list becomes a block one) the whole `key: value`
      if (va && vb && isBlock(va) && isBlock(vb) && isMap(va) === isMap(vb)) {
        if (!diff(va, vb, A, B, edits)) return false;
      } else if (va && vb && !isBlock(va) && !isBlock(vb)) {
        if (!replace(A, B, range(va), range(vb), edits)) return false;
      } else if (!replace(A, B, pairRange(pa), pairRange(pb), edits)) return false;
    }
    return true;
  }
  if (isSeq(a) && isSeq(b) && isBlock(a) && isBlock(b) && a.items.length === b.items.length) {
    for (const [i, ia] of (a.items as Node[]).entries()) {
      const ib = b.items[i] as Node;
      if (js(ia) === js(ib)) continue;
      if (isBlock(ia) && isBlock(ib) && isMap(ia) === isMap(ib)) {
        if (!diff(ia, ib, A, B, edits)) return false;
      } else if (!replace(A, B, range(ia), range(ib), edits)) return false;
    }
    return true;
  }
  return replace(A, B, range(a), range(b), edits);
}

/**
 * The text of `doc` (an edit of the document parsed from `original`, with `\n` line endings) that keeps `original`
 * wherever the two agree. `render` is the whole document as text (`doc.toString(…)`), used for the changed parts and
 * as the answer when they can't be spliced in.
 */
export function spliceYaml(original: string, doc: Document, render: string): string {
  try {
    const before = parseDocument(original);
    const after = parseDocument(render);
    if (before.errors.length || after.errors.length || !before.contents || !after.contents) return render;
    const edits: Edit[] = [];
    if (!diff(before.contents as Node, after.contents as Node, original, render, edits)) return render;
    let out = original;
    for (const [s, e, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, s) + t + out.slice(e);
    // the spliced text must read back as the edited document, else the whole rendering is the safe answer
    const check = parseDocument(out);
    return !check.errors.length && js(check.contents) === js(doc.contents) ? out : render;
  } catch {
    return render;
  }
}
