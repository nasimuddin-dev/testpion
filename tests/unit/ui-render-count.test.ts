import '../helpers-render-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, memo, useState, type ReactElement, type ReactNode } from 'react';

/**
 * Render counts of the window's hot components (UI audit 2026-10-21, performance: F-1, F-2, F-5, F-17): a minimal React
 * DevTools hook (tests/helpers-render.ts, the e2e suite's render-count.cjs) counts what mounted and what rendered again,
 * so a change that must not render a part of the window is pinned as a number.
 */
const { handlers, answers } = vi.hoisted(() => ({ handlers: new Map<string, Set<(p: unknown) => void>>(), answers: {} as Record<string, unknown> }));
vi.mock('../../apps/desktop/src/api', () => ({
  call: vi.fn(async (method: string) => answers[method]),
  on: vi.fn((channel: string, cb: (p: unknown) => void) => {
    const set = handlers.get(channel) ?? handlers.set(channel, new Set()).get(channel)!;
    set.add(cb);
    return () => set.delete(cb);
  }),
  asError: (e: unknown) => ({ kind: 'Error', message: String(e), what: '', why: '', suggestions: [] }),
  modKey: 'Ctrl',
  isMac: false,
}));
vi.mock('sonner', () => ({ toast: Object.assign(() => undefined, { error: () => undefined, success: () => undefined, warning: () => undefined, dismiss: () => undefined }), Toaster: () => null }));

import { act, findAll, render as renderBare, renders } from '../helpers-render';
import { ConsolePanel, consoleKey, type ConsoleEntry } from '../../apps/desktop/src/components/ConsolePanel';
import { JsonTree } from '../../apps/desktop/src/components/JsonView';
import { TooltipProvider } from '../../apps/desktop/src/components/ui';
import { lazyMemoView } from '../../apps/desktop/src/lib/memo-view';
import { DocScope } from '../../apps/desktop/src/lib/docs';
import { useIntent } from '../../apps/desktop/src/hooks';
import { useApp } from '../../apps/desktop/src/store';

const emit = (channel: string, payload: unknown) => handlers.get(channel)?.forEach((cb) => cb(payload));
/** Rendered as in the window: under the tooltip provider App mounts. */
const render = (el: ReactElement) => renderBare(h(TooltipProvider, null, el));
const flush = () => act(async () => {});

const entry = (i: number, over: Partial<ConsoleEntry> = {}): ConsoleEntry => ({ id: `c-${i}`, time: new Date(1_700_000_000_000 + i * 1000).toISOString(), source: 'request', name: `Request ${i}`, method: 'GET', url: `https://api.test/items/${i}`, status: 200, durationMs: 12, size: 100, logs: [], request: { headers: [['accept', 'application/json']] }, ...over });

beforeEach(() => {
  handlers.clear();
  for (const k of Object.keys(answers)) delete answers[k];
  renders.reset();
});
afterEach(() => void (answers['console.recent'] = undefined));

describe('the console (F-5)', () => {
  it('appending entries mounts only the new rows; a full buffer that slides remounts none, and an expanded row stays expanded', async () => {
    answers['console.recent'] = Array.from({ length: 500 }, (_, i) => entry(i));
    const r = await render(h(ConsolePanel));
    await flush();
    expect(findAll(r, (i) => typeof i.type === 'string' && 'data-console-row' in i.props)).toHaveLength(500);
    // expand a row in the middle (its request is shown)
    const row = findAll(r, (i) => i.props['data-console-row'] === consoleKey(entry(250)))[0]!;
    await act(async () => row.findByType('button').props.onClick());
    expect(row.findByType('button').props['aria-expanded']).toBe(true);
    renders.reset();
    // one batch of three more: the 500 rows slide by three; the three new rows mount, no row that stays is mounted again
    await act(async () => emit('console', [entry(500), entry(501), entry(502)]));
    const rows = findAll(r, (i) => typeof i.type === 'string' && 'data-console-row' in i.props);
    expect(rows).toHaveLength(500);
    expect(rows[0]!.props['data-console-row']).toBe(consoleKey(entry(3)));
    expect(rows[499]!.props['data-console-row']).toBe(consoleKey(entry(502)));
    expect(renders.mounts('ConsoleRow'), renders.report()).toBe(3);
    // the rows that stayed were not rendered again either (memoised; the entries keep their identity)
    expect(renders.updates('ConsoleRow'), renders.report()).toBe(0);
    const still = findAll(r, (i) => i.props['data-console-row'] === consoleKey(entry(250)))[0]!;
    expect(still.findByType('button').props['aria-expanded']).toBe(true);
    // a single (unbatched) entry is taken too
    await act(async () => emit('console', entry(503)));
    expect(findAll(r, (i) => i.props['data-console-row'] === consoleKey(entry(503)))).toHaveLength(1);
    r.unmount();
  });
});

describe('the shell and its views (F-1, F-2)', () => {
  let stubRenders = 0;
  const Stub = () => {
    stubRenders++;
    useIntent('home', () => undefined);
    return h('div', { 'data-stub': true }, 'home');
  };
  const V = lazyMemoView(() => Promise.resolve({ Stub }), 'Stub');
  /** The shell: subscribed to the palette (as App is), hosting the view the way App does (DocScope + the memoised view). */
  function Shell({ active = true }: { active?: boolean }) {
    useApp((s) => s.paletteOpen);
    return h(DocScope, { active }, h(V));
  }

  it('opening the palette (an unrelated store change) renders the shell, not the mounted view', async () => {
    await V.prefetch();
    stubRenders = 0;
    const r = await render(h(Shell));
    expect(stubRenders).toBe(1);
    renders.reset();
    await act(async () => useApp.getState().set({ paletteOpen: true }));
    expect(renders.of('Shell')).toBeGreaterThanOrEqual(1);
    expect(stubRenders, renders.report()).toBe(1);
    await act(async () => useApp.getState().set({ paletteOpen: false }));
    expect(stubRenders).toBe(1);
    r.unmount();
  });

  it("an intent for another view renders nothing in this one; this view's intent renders it once", async () => {
    await V.prefetch();
    const r = await render(h(Shell));
    stubRenders = 0;
    await act(async () => useApp.getState().openIntent('history', { query: 'x' }));
    expect(stubRenders).toBe(0);
    await act(async () => useApp.getState().openIntent('home', { tab: 'x' }));
    expect(stubRenders).toBeGreaterThanOrEqual(1);
    r.unmount();
  });

  it('the scope value is made once per change: a shell render with the same scope reaches no consumer', async () => {
    let consumerRenders = 0;
    const Consumer = memo(function Consumer() {
      consumerRenders++;
      return h('span', null, 'c');
    });
    let rerender!: () => void;
    function Parent() {
      const [n, setN] = useState(0);
      rerender = () => setN((x) => x + 1);
      return h(DocScope, { active: true, docId: 'main' }, h('div', { 'data-n': n }, h(Consumer)));
    }
    const r = await render(h(Parent));
    expect(consumerRenders).toBe(1);
    await act(async () => rerender());
    expect(consumerRenders).toBe(1);
    r.unmount();
  });
});

describe('JsonTree (F-17, F-18)', () => {
  it('keeps what was expanded when the parent renders again with the same value', async () => {
    const data = { items: [{ id: 1, tags: ['a', 'b'] }, { id: 2 }], meta: { total: 2, nested: { deep: true } } };
    let rerender!: () => void;
    function Parent({ children }: { children?: ReactNode }) {
      const [n, setN] = useState(0);
      rerender = () => setN((x) => x + 1);
      return h('div', { 'data-n': n }, children, h(JsonTree, { data }));
    }
    const r = await render(h(Parent));
    const drawn = () => findAll(r, (i) => typeof i.type === 'string' && 'data-vl-key' in i.props).length;
    const before = drawn();
    // open $.meta.nested (its Expand button)
    const expand = findAll(r, (i) => i.type === 'button' && i.props['aria-label'] === 'Expand');
    expect(expand.length).toBeGreaterThan(0);
    await act(async () => expand[expand.length - 1]!.props.onClick());
    const opened = drawn();
    expect(opened).toBeGreaterThan(before);
    renders.reset();
    await act(async () => rerender());
    expect(drawn(), 'the tree folded up again').toBe(opened);
    expect(renders.mounts('JsonTree')).toBe(0);
    r.unmount();
  });
});
