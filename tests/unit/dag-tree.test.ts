import { describe, expect, it } from 'vitest';
import { dagProblems } from '../../packages/core/src/index.js';
import {
  addNode,
  addOption,
  emptyTree,
  freeId,
  outline,
  refsOf,
  removeNode,
  removeOption,
  renameNode,
  renameOption,
  setBranch,
  setNodeText,
  setRoot,
  setRule,
  slotsOf,
  treeOf,
  type Tree,
} from '../../apps/desktop/src/lib/dag-tree';

// The operations of the decision-tree editor: each keeps the tree one the engine accepts (no reference to a node that is gone).
const tree = (): Tree => ({
  root: 'cites',
  nodes: {
    cites: { type: 'binary', question: 'Does it cite a source?', yes: 'which', no: { score: 0, reason: 'no citation' } },
    which: { type: 'choice', question: 'Which document?', options: { right: { score: 10 }, wrong: 'check' } },
    check: { type: 'rule', check: { type: 'contains', expected: 'handbook' }, yes: { score: 6 }, no: { score: 2 } },
  },
});

describe('the outline', () => {
  it('lists the nodes in the order they are asked, with their depth, and the ones no answer leads to last', () => {
    const t = { ...tree(), nodes: { ...tree().nodes, lost: { type: 'task' as const, instruction: 'x', next: { score: 0 } } } };
    expect(outline(t)).toEqual([
      { id: 'cites', depth: 0, reached: true },
      { id: 'which', depth: 1, reached: true },
      { id: 'check', depth: 2, reached: true },
      { id: 'lost', depth: 0, reached: false },
    ]);
  });
  it('survives a cycle (the engine reports it; the editor must not hang)', () => {
    const t: Tree = { root: 'a', nodes: { a: { type: 'binary', question: 'q', yes: 'b', no: { score: 0 } }, b: { type: 'binary', question: 'q', yes: 'a', no: { score: 0 } } } };
    expect(outline(t).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('slots and references of a node', () => {
    const n = tree().nodes.which!;
    expect(slotsOf(n).map((s) => [s.slot, s.label])).toEqual([['option:right', 'right'], ['option:wrong', 'wrong']]);
    expect(refsOf(n)).toEqual(['check']);
    expect(slotsOf(tree().nodes.check!).map((s) => s.label)).toEqual(['passes', 'fails']);
  });
});

describe('adding and removing nodes', () => {
  it('a new node of each kind is one the engine accepts once its text is filled in and it is attached', () => {
    let t = emptyTree();
    t = setNodeText(t, 'n1', 'Is the answer polite?');
    for (const kind of ['choice', 'task', 'rule'] as const) {
      const r = addNode(t, kind);
      expect(r.id).toMatch(/^n\d+$/);
      t = r.tree;
    }
    expect(Object.keys(t.nodes)).toEqual(['n1', 'n2', 'n3', 'n4']);
    t = setNodeText(setNodeText(t, 'n2', 'Which tone?'), 'n3', 'Write down the greeting');
    t = setRule(t, 'n4', { type: 'contains', expected: 'please' });
    t = setBranch(t, 'n1', 'yes', 'n2');
    t = setBranch(t, 'n2', 'option:option 1', 'n3');
    t = setBranch(t, 'n3', 'next', 'n4');
    expect(dagProblems(t)).toEqual([]);
  });
  it('the first node of an empty tree becomes the root; the tree stops growing at forty nodes', () => {
    const r = addNode({ root: '', nodes: {} }, 'binary');
    expect(r.tree.root).toBe(r.id);
    let t = r.tree;
    for (let i = 0; i < 60; i++) t = addNode(t, 'task').tree;
    expect(Object.keys(t.nodes)).toHaveLength(40);
    expect(addNode(t, 'task').id).toBe('');
  });
  it('removing a node ends what led to it at a leaf, and moves the root when the root goes', () => {
    const t = removeNode(tree(), 'check');
    expect(t.nodes.which).toMatchObject({ options: { right: { score: 10 }, wrong: { score: 0, reason: 'a node was removed' } } });
    expect(dagProblems(t)).toEqual([]);
    const noRoot = removeNode(tree(), 'cites');
    expect(noRoot.root).toBe('which');
    expect(removeNode({ root: 'a', nodes: { a: { type: 'task', instruction: 'x', next: { score: 1 } } } }, 'a')).toEqual({ root: '', nodes: {} });
  });
  it('free ids avoid the ones taken', () => {
    expect(freeId(tree())).toBe('n');
    expect(freeId(tree(), 'Does it cite?')).toBe('does-it-cite');
    expect(freeId(tree(), 'cites')).toBe('cites-2');
  });
});

describe('renaming and rewiring', () => {
  it('a renamed node keeps every branch and the root that named it', () => {
    const { tree: t, problem } = renameNode(tree(), 'which', 'document');
    expect(problem).toBeUndefined();
    expect(t.nodes.cites).toMatchObject({ yes: 'document' });
    expect(Object.keys(t.nodes)).toEqual(['cites', 'document', 'check']);
    expect(renameNode(tree(), 'cites', 'start').tree.root).toBe('start');
    expect(dagProblems(t)).toEqual([]);
  });
  it('a taken or empty id is refused and the tree is untouched', () => {
    const t = tree();
    expect(renameNode(t, 'cites', 'which')).toEqual({ tree: t, problem: expect.stringMatching(/already/) });
    expect(renameNode(t, 'cites', '  ')).toEqual({ tree: t, problem: expect.stringMatching(/needs an id/) });
    expect(renameNode(t, 'cites', 'cites').tree).toBe(t);
  });
  it('a branch goes to a node or a leaf; the root can be chosen; the input is never changed', () => {
    const t = tree();
    const before = JSON.stringify(t);
    expect(setBranch(t, 'cites', 'no', 'check').nodes.cites).toMatchObject({ no: 'check' });
    expect(setBranch(t, 'cites', 'yes', { score: 7, reason: 'fine' }).nodes.cites).toMatchObject({ yes: { score: 7, reason: 'fine' } });
    expect(setRoot(t, 'which').root).toBe('which');
    expect(setRoot(t, 'ghost').root).toBe('cites');
    expect(setBranch(t, 'cites', 'next', 'check')).toEqual(t);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('the options of a choice', () => {
  it('are added up to eight, removed down to two, and renamed in place', () => {
    let t = tree();
    for (let i = 0; i < 10; i++) t = addOption(t, 'which');
    expect(Object.keys((t.nodes.which as { options: object }).options)).toHaveLength(8);
    for (let i = 0; i < 10; i++) t = removeOption(t, 'which', Object.keys((t.nodes.which as { options: Record<string, unknown> }).options)[0]!);
    expect(Object.keys((t.nodes.which as { options: object }).options)).toHaveLength(2);
    const r = renameOption(tree(), 'which', 'right', 'the right one');
    expect(Object.keys((r.tree.nodes.which as { options: object }).options)).toEqual(['the right one', 'wrong']);
    expect(renameOption(tree(), 'which', 'right', 'wrong').problem).toMatch(/already/);
    expect(renameOption(tree(), 'which', 'right', '').problem).toMatch(/needs a label/);
  });
});

describe('treeOf', () => {
  it('reads a tree from what the file holds, and nothing from what is not one', () => {
    expect(treeOf(tree())?.root).toBe('cites');
    expect(treeOf(undefined)).toBeUndefined();
    expect(treeOf('text')).toBeUndefined();
    expect(treeOf({ root: 'a', nodes: [] })).toBeUndefined();
    expect(treeOf({ nodes: {} })).toBeUndefined();
  });
});
