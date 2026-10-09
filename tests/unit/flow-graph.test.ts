import { describe, expect, it } from 'vitest';
import { flowGraph, stepLine, toDot, type FlowStep } from '../../packages/shared/src/flow-graph';

const step = (id: string, dependsOn?: string[], extra: Partial<FlowStep> = {}): FlowStep => ({ id, name: id, type: 'http', method: 'GET', url: `/${id}`, dependsOn, ...extra });

describe('flowGraph', () => {
  it('lays a chain out left to right, one column per step', () => {
    const g = flowGraph([step('a'), step('b', ['a']), step('c', ['b'])]);
    expect(g.nodes.map((n) => [n.id, n.layer, n.row])).toEqual([
      ['a', 0, 0],
      ['b', 1, 0],
      ['c', 2, 0],
    ]);
    expect(g.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);
    expect(g.problems).toEqual([]);
    const [a, b] = g.nodes;
    expect(b!.x).toBeGreaterThan(a!.x + a!.w);
    expect(g.width).toBe(3 * 220 + 2 * 64);
    expect(g.height).toBe(72);
  });

  it('a diamond: the two middle steps share a column and the join sits after both', () => {
    const g = flowGraph([step('login'), step('create', ['login']), step('list', ['login']), step('delete', ['create', 'list'])]);
    const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(at.create!.layer).toBe(1);
    expect(at.list!.layer).toBe(1);
    expect(at.delete!.layer).toBe(2);
    expect(at.create!.row).not.toBe(at.list!.row);
    // the single nodes of the first and last column are centred on the two in the middle
    expect(at.login!.y).toBeCloseTo((at.create!.y + at.list!.y) / 2);
    expect(at.delete!.y).toBe(at.login!.y);
    expect(g.edges).toHaveLength(4);
  });

  it('independent steps stack in the first column in file order', () => {
    const g = flowGraph([step('z'), step('m'), step('a')]);
    expect(g.nodes.map((n) => [n.id, n.layer, n.row])).toEqual([
      ['z', 0, 0],
      ['m', 0, 1],
      ['a', 0, 2],
    ]);
    expect(g.edges).toEqual([]);
    expect(g.height).toBe(3 * 72 + 2 * 20);
  });

  it('a longest-path layering: a step after a long chain and a short one sits after the long one', () => {
    const g = flowGraph([step('a'), step('b', ['a']), step('c', ['b']), step('d', ['a', 'c'])]);
    expect(g.nodes.find((n) => n.id === 'd')!.layer).toBe(3);
  });

  it('a missing dependency and a cycle are reported, not crashed on', () => {
    const g = flowGraph([step('a', ['nothing']), step('b', ['c']), step('c', ['b']), step('d', ['d'])]);
    expect(g.nodes).toHaveLength(4);
    expect(g.problems.map((p) => p.message)).toEqual([
      '"a" depends on "nothing", which no step of the file defines',
      '"d" depends on itself',
      '"c" and "b" depend on each other (a cycle); neither can run first',
    ]);
    // one edge of the cycle is kept so the two still read as a pair
    expect(g.edges).toEqual([{ from: 'c', to: 'b' }]);
    expect(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it('two steps with one id are reported', () => {
    const g = flowGraph([step('a'), step('a')]);
    expect(g.nodes).toHaveLength(1);
    expect(g.problems[0]!.message).toContain('Two steps have the id "a"');
  });

  it('nothing in, nothing out', () => {
    expect(flowGraph([])).toEqual({ nodes: [], edges: [], problems: [], width: 0, height: 0 });
  });
});

describe('toDot', () => {
  it('writes one node per step and one edge per dependency, with the result colour', () => {
    const dot = toDot([step('a', undefined, { name: 'Log "in"', extract: ['token'], status: 'passed', durationMs: 12 }), step('b', ['a'], { status: 'failed' })], 'auth');
    expect(dot).toContain('digraph "auth" {');
    expect(dot).toContain('rankdir=LR');
    expect(dot).toContain('"a" [label="Log \\"in\\"\\nGET /a\\n→ token\\npassed · 12 ms", color="#2e8b57"];');
    expect(dot).toContain('"b" [label="b\\nGET /b\\nfailed", color="#c0392b"];');
    expect(dot).toContain('"a" -> "b";');
    expect(dot.endsWith('}\n')).toBe(true);
  });
});

describe('stepLine', () => {
  it('finds the name: line of a step, quoted or not, with or without a list dash', () => {
    const text = ['tests:', '  - id: a', '    name: Log in', '  - name: "Create a pet"  # the second', '    url: /pets', '  - name: Log in again'].join('\n');
    expect(stepLine(text, 'Log in')).toBe(3);
    expect(stepLine(text, 'Create a pet')).toBe(4);
    expect(stepLine(text, 'Log in again')).toBe(6);
    expect(stepLine(text.replace(/\n/g, '\r\n'), 'Log in again')).toBe(6);
    expect(stepLine(text, 'Nothing')).toBeUndefined();
  });
});
