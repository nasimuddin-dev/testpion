// The operations of the decision-tree editor of a `dag` custom metric, on the tree as the metric file holds it. Pure functions:
// each returns a new tree and leaves the one it was given alone. The engine checks the result (the editor shows what it says);
// these only keep a tree well formed while it is edited (no reference to a node that is gone, no two nodes with one id).

export type Branch = string | { score: number; reason?: string };
export type NodeType = 'binary' | 'choice' | 'task' | 'rule';
export type TreeNode =
  | { type: 'binary'; question: string; yes: Branch; no: Branch }
  | { type: 'choice'; question: string; options: Record<string, Branch> }
  | { type: 'task'; instruction: string; next: Branch }
  | { type: 'rule'; check: { type: string; [option: string]: unknown }; yes: Branch; no: Branch };
export interface Tree {
  root: string;
  nodes: Record<string, TreeNode>;
}

/** A place a branch is written: yes, no, next, or `option:<label>` of a choice. */
export type Slot = 'yes' | 'no' | 'next' | `option:${string}`;

export const NODE_LABEL: Record<NodeType, string> = { binary: 'Yes / no question', choice: 'Choice', task: 'Write down', rule: 'Rule' };
export const MAX_NODES = 40;

export const isLeaf = (b: unknown): b is { score: number; reason?: string } => !!b && typeof b === 'object' && typeof (b as { score?: unknown }).score === 'number';

/** The slots of a node with the branch each holds. */
export function slotsOf(n: TreeNode): Array<{ slot: Slot; label: string; branch: Branch }> {
  if (n.type === 'binary' || n.type === 'rule')
    return [
      { slot: 'yes', label: n.type === 'rule' ? 'passes' : 'yes', branch: n.yes },
      { slot: 'no', label: n.type === 'rule' ? 'fails' : 'no', branch: n.no },
    ];
  if (n.type === 'choice') return Object.entries(n.options).map(([k, branch]) => ({ slot: `option:${k}` as Slot, label: k, branch }));
  return [{ slot: 'next', label: 'then', branch: n.next }];
}

/** The nodes the branches of a node lead to. */
export const refsOf = (n: TreeNode): string[] => slotsOf(n).flatMap((s) => (typeof s.branch === 'string' ? [s.branch] : []));

/** The nodes in the order the questions are asked (depth first from the root), then the ones no answer leads to. */
export function outline(t: Tree): Array<{ id: string; depth: number; reached: boolean }> {
  const out: Array<{ id: string; depth: number; reached: boolean }> = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || !t.nodes[id]) return;
    seen.add(id);
    out.push({ id, depth, reached: true });
    for (const r of refsOf(t.nodes[id]!)) visit(r, depth + 1);
  };
  visit(t.root, 0);
  for (const id of Object.keys(t.nodes)) if (!seen.has(id)) out.push({ id, depth: 0, reached: false });
  return out;
}

export function newNode(type: NodeType): TreeNode {
  switch (type) {
    case 'binary':
      return { type, question: '', yes: { score: 10 }, no: { score: 0 } };
    case 'choice':
      return { type, question: '', options: { 'option 1': { score: 10 }, 'option 2': { score: 0 } } };
    case 'task':
      return { type, instruction: '', next: { score: 0 } };
    case 'rule':
      return { type, check: { type: 'contains', expected: '' }, yes: { score: 10 }, no: { score: 0 } };
  }
}

/** An id no node has: `question`, `question-2` … for the base, `n1`, `n2` … without one. */
export function freeId(t: Tree, base = 'n'): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'n';
  if (!t.nodes[clean]) return clean;
  for (let i = 2; ; i++) if (!t.nodes[`${clean}${clean === 'n' ? '' : '-'}${i}`]) return `${clean}${clean === 'n' ? '' : '-'}${i}`;
}

export function emptyTree(): Tree {
  return { root: 'n1', nodes: { n1: { type: 'binary', question: '', yes: { score: 10 }, no: { score: 0 } } } };
}

/** A new node; the first node of an empty tree becomes the root. It is not attached anywhere: pick it as a branch of another node. */
export function addNode(t: Tree, type: NodeType): { tree: Tree; id: string } {
  if (Object.keys(t.nodes).length >= MAX_NODES) return { tree: t, id: '' };
  let i = Object.keys(t.nodes).length + 1;
  while (t.nodes[`n${i}`]) i++;
  const id = `n${i}`;
  return { tree: { root: t.nodes[t.root] ? t.root : id, nodes: { ...t.nodes, [id]: newNode(type) } }, id };
}

const mapBranches = (n: TreeNode, f: (b: Branch) => Branch): TreeNode => {
  if (n.type === 'binary' || n.type === 'rule') return { ...n, yes: f(n.yes), no: f(n.no) };
  if (n.type === 'choice') return { ...n, options: Object.fromEntries(Object.entries(n.options).map(([k, b]) => [k, f(b)])) };
  return { ...n, next: f(n.next) };
};

/** A node gone: what led to it ends at a leaf of 0 instead, and the root moves to the first node left. */
export function removeNode(t: Tree, id: string): Tree {
  const nodes = Object.fromEntries(Object.entries(t.nodes).filter(([k]) => k !== id).map(([k, n]) => [k, mapBranches(n, (b) => (b === id ? { score: 0, reason: 'a node was removed' } : b))]));
  return { root: t.root === id ? (Object.keys(nodes)[0] ?? '') : t.root, nodes };
}

/** A node under another id, with every branch and the root that named it following. Returns the same tree (and a reason) when the id is taken or empty. */
export function renameNode(t: Tree, from: string, to: string): { tree: Tree; problem?: string } {
  const next = to.trim();
  if (next === from) return { tree: t };
  if (!next) return { tree: t, problem: 'A node needs an id.' };
  if (t.nodes[next]) return { tree: t, problem: `There is a node called “${next}” already.` };
  const nodes = Object.fromEntries(Object.entries(t.nodes).map(([k, n]) => [k === from ? next : k, mapBranches(n, (b) => (b === from ? next : b))]));
  return { tree: { root: t.root === from ? next : t.root, nodes } };
}

export function setRoot(t: Tree, id: string): Tree {
  return t.nodes[id] ? { ...t, root: id } : t;
}

/** Changes the text of a node (its question, its task, or the type and options of its rule). */
export function setNodeText(t: Tree, id: string, text: string): Tree {
  const n = t.nodes[id];
  if (!n) return t;
  const next: TreeNode = n.type === 'task' ? { ...n, instruction: text } : n.type === 'rule' ? n : { ...n, question: text };
  return { ...t, nodes: { ...t.nodes, [id]: next } };
}

export function setRule(t: Tree, id: string, check: { type: string; [option: string]: unknown }): Tree {
  const n = t.nodes[id];
  return n?.type === 'rule' ? { ...t, nodes: { ...t.nodes, [id]: { ...n, check } } } : t;
}

/** Where a branch leads: a node, or a leaf with a score. */
export function setBranch(t: Tree, id: string, slot: Slot, b: Branch): Tree {
  const n = t.nodes[id];
  if (!n) return t;
  let next: TreeNode = n;
  if (slot === 'yes' && (n.type === 'binary' || n.type === 'rule')) next = { ...n, yes: b };
  else if (slot === 'no' && (n.type === 'binary' || n.type === 'rule')) next = { ...n, no: b };
  else if (slot === 'next' && n.type === 'task') next = { ...n, next: b };
  else if (slot.startsWith('option:') && n.type === 'choice') next = { ...n, options: { ...n.options, [slot.slice(7)]: b } };
  return { ...t, nodes: { ...t.nodes, [id]: next } };
}

export function addOption(t: Tree, id: string): Tree {
  const n = t.nodes[id];
  if (n?.type !== 'choice' || Object.keys(n.options).length >= 8) return t;
  let i = Object.keys(n.options).length + 1;
  while (n.options[`option ${i}`]) i++;
  return { ...t, nodes: { ...t.nodes, [id]: { ...n, options: { ...n.options, [`option ${i}`]: { score: 0 } } } } };
}

export function removeOption(t: Tree, id: string, label: string): Tree {
  const n = t.nodes[id];
  if (n?.type !== 'choice' || Object.keys(n.options).length <= 2) return t;
  return { ...t, nodes: { ...t.nodes, [id]: { ...n, options: Object.fromEntries(Object.entries(n.options).filter(([k]) => k !== label)) } } };
}

/** The label of an option changed (the order is kept). An empty or taken label is refused. */
export function renameOption(t: Tree, id: string, from: string, to: string): { tree: Tree; problem?: string } {
  const n = t.nodes[id];
  const next = to.trim();
  if (n?.type !== 'choice' || next === from) return { tree: t };
  if (!next) return { tree: t, problem: 'An option needs a label.' };
  if (n.options[next]) return { tree: t, problem: `There is an option “${next}” already.` };
  return { tree: { ...t, nodes: { ...t.nodes, [id]: { ...n, options: Object.fromEntries(Object.entries(n.options).map(([k, b]) => [k === from ? next : k, b])) } } } };
}

/** The tree as the file holds it, or undefined when the value is not one (the editor then offers to start a tree). */
export function treeOf(v: unknown): Tree | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as { root?: unknown; nodes?: unknown };
  if (typeof t.root !== 'string' || !t.nodes || typeof t.nodes !== 'object' || Array.isArray(t.nodes)) return undefined;
  return { root: t.root, nodes: t.nodes as Record<string, TreeNode> };
}
