import '../helpers-render-setup';
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { act, findAll, render, renders } from '../helpers-render';
import { StructureTree, STRUCTURE_KIDS, TimelinePanel, TIMELINE_ROWS, timelineTotals } from '../../apps/desktop/src/components/debugger/DockInsights';
import type { Exchange } from '../../apps/desktop/src/components/debugger/model';
import { expectWithin } from '../perf-budget';

/**
 * The Debugger's Timeline and Structure docks under a Shift range of thousands of rows (performance review 2026-10-27,
 * item 2): a sync that changed other rows renders neither, a long selection draws a capped table, and the structure
 * tree takes only the rows that are new.
 */
const T0 = Date.parse('2026-10-01T10:00:00Z');
const ex = (i: number, over: Partial<Exchange> = {}): Exchange =>
  ({
    id: `e-${i}`,
    startedAt: new Date(T0 + i * 37).toISOString(),
    kind: 'http',
    method: 'GET',
    url: `https://api-${i % 40}.example.test/v1/items/${i}?page=${i % 7}`,
    host: `api-${i % 40}.example.test`,
    clientPort: 50000 + i,
    requestHeaders: { accept: 'application/json' },
    requestBodyBytes: 0,
    responseHeaders: { 'content-type': 'application/json' },
    responseBodyBytes: 100 + i,
    status: 200,
    durationMs: 20 + (i % 300),
    ...over,
  }) as Exchange;
const list = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ex(from + i));

describe('Timeline with a long selection', () => {
  it('draws the first rows and says how many more; the totals count them all', async () => {
    const picked = list(2000);
    const r = await render(h(TimelinePanel, { picked }));
    const rows = findAll(r, (i) => i.type === 'tr' && typeof i.props.title === 'string');
    expect(rows).toHaveLength(TIMELINE_ROWS);
    expect(findAll(r, (i) => 'data-timeline-more' in i.props)).toHaveLength(1);
    const t = timelineTotals(picked);
    expect(t.start).toBe(T0);
    expect(findAll(r, (i) => i.type === 'td' && i.props.children === 2000).length).toBe(1);
    r.unmount();
  });

  it('a sync that left the selected exchanges as they were does not render the panel again; a changed one does', async () => {
    const picked = list(2000);
    function Parent({ rows }: { rows: Exchange[] }) {
      return h(TimelinePanel, { picked: rows });
    }
    const r = await render(h(Parent, { rows: picked }));
    renders.reset();
    await act(async () => r.update(h(Parent, { rows: picked.slice() })));
    expect(renders.updates('TimelinePanel'), renders.report()).toBe(0);
    const changed = picked.slice();
    changed[5] = { ...changed[5]!, durationMs: 9999 };
    await act(async () => r.update(h(Parent, { rows: changed })));
    expect(renders.updates('TimelinePanel'), renders.report()).toBeGreaterThan(0);
    r.unmount();
  });

  it('adds 2,000 rows up in one pass, quickly', () => {
    const picked = list(2000);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) timelineTotals(picked);
    expectWithin((performance.now() - t0) / 20, 5, 'timeline totals of 2,000 rows');
  });
});

describe('Structure tree', () => {
  const count = (tree: StructureTree) => tree.root.count;

  it('builds the same totals as a rebuild, and takes the rows that came in without parsing the old ones again', () => {
    const tree = new StructureTree();
    const rows = list(5000);
    tree.update(rows);
    expect(count(tree)).toBe(5000);
    expect(tree.root.children.size).toBe(40);
    const more = [...rows, ...list(100, 5000)];
    const t0 = performance.now();
    tree.update(more);
    const incremental = performance.now() - t0;
    expect(count(tree)).toBe(5100);
    const fresh = new StructureTree();
    fresh.update(more);
    expect(tree.root.bytes).toBe(fresh.root.bytes);
    expect([...tree.root.children.keys()].sort()).toEqual([...fresh.root.children.keys()].sort());
    expectWithin(incremental, 2, '+100 rows into a tree of 5,000');
  });

  it('follows a body that grew, and starts over when rows left', () => {
    const tree = new StructureTree();
    const rows = list(10);
    tree.update(rows);
    const before = tree.root.bytes;
    const grown = rows.slice();
    grown[3] = { ...grown[3]!, responseBodyBytes: grown[3]!.responseBodyBytes + 1000 };
    tree.update(grown);
    expect(tree.root.bytes).toBe(before + 1000);
    expect(count(tree)).toBe(10);
    tree.update(grown.slice(0, 4));
    expect(count(tree)).toBe(4);
    expect(tree.root.bytes).toBe(grown.slice(0, 4).reduce((n, e) => n + e.responseBodyBytes, 0));
    tree.update([]);
    expect(count(tree)).toBe(0);
  });

  it('a full build of 5,000 rows is fast, and the kid cap exists', () => {
    const rows = list(5000);
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now();
      new StructureTree().update(rows);
      times.push(performance.now() - t0);
    }
    console.log('structure tree builds of 5,000 rows (ms):', times.map((t) => t.toFixed(1)).join(', '));
    expectWithin(Math.min(...times), 10, 'a structure tree of 5,000 rows (best of 4)');
    expect(STRUCTURE_KIDS).toBeGreaterThan(50);
  });
});
