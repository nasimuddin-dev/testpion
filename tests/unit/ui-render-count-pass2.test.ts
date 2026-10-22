import '../helpers-render-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, useState, type ReactElement } from 'react';

/**
 * The second pass of the UI performance audit (2026-10-21): what the Git view reads after a save (F-25), the HTTP tabs
 * without the HTTP view (F-24), the long Git changes list (F-10), rows that keep their state (F-13), the request's
 * variables once typing paused (F-21), menus built when they open (F-23) and reads asked for twice at startup (F-33).
 * Counted in calls and renders, as tests/unit/ui-render-count.test.ts does.
 */
const { handlers, answers, scanned } = vi.hoisted(() => ({ handlers: new Map<string, Set<(p: unknown) => void>>(), answers: {} as Record<string, unknown>, scanned: { n: 0 } }));
vi.mock('../../apps/desktop/src/api', () => ({
  call: vi.fn(async (method: string) => {
    const a = answers[method];
    return typeof a === 'function' ? (a as () => unknown)() : a;
  }),
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
// how often a request is scanned for its {{variables}} (F-21)
vi.mock('@testpion/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@testpion/shared')>();
  return { ...real, templatedText: (x: unknown) => (scanned.n++, real.templatedText(x as never)) };
});

import { act, findAll, render as renderBare, renders } from '../helpers-render';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { call } from '../../apps/desktop/src/api';
import { TooltipProvider } from '../../apps/desktop/src/components/ui';
import { DocScope } from '../../apps/desktop/src/lib/docs';
import { resetGitForTest } from '../../apps/desktop/src/lib/git';
import { GitView, type GitFile, type SemanticChange } from '../../apps/desktop/src/views/GitView';
import { GitChanges } from '../../apps/desktop/src/components/GitChanges';
import { KeyValueEditor } from '../../apps/desktop/src/components/KeyValueEditor';
import { problemKeys } from '../../apps/desktop/src/components/ProblemList';
import { Menu } from '../../apps/desktop/src/components/Menu';
import { usePublishRequest } from '../../apps/desktop/src/lib/request-variables';
import { sharedCall } from '../../apps/desktop/src/lib/shared-call';
import { setDraftScope } from '../../apps/desktop/src/lib/ws-scope';
import { useEditorTabsStore } from '../../apps/desktop/src/components/EditorTabs';
import { closeRestTabs, useRestTabs } from '../../apps/desktop/src/views/rest/tabs-store';
import { blankRequest } from '../../apps/desktop/src/views/rest/types';
import type { KeyValue } from '../../apps/desktop/src/types';

// the auto-growing text box measures its line height
(globalThis as { getComputedStyle?: unknown }).getComputedStyle ??= () => ({
  lineHeight: '16px',
  fontSize: '13px',
  paddingTop: '4px',
  paddingBottom: '4px',
  borderTopWidth: '1px',
  borderBottomWidth: '1px',
  overflowY: 'visible',
});

const emit = (channel: string, payload: unknown) => handlers.get(channel)?.forEach((cb) => cb(payload));
const render = (el: ReactElement) => renderBare(h(TooltipProvider, null, el));
/** With host nodes that have a style (the text box of the commit message sizes itself). */
async function renderStyled(el: ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(h(TooltipProvider, null, el), {
      createNodeMock: () => ({
        style: {},
        scrollIntoView() {},
        focus() {},
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
        clientHeight: 600,
        clientWidth: 800,
        scrollTop: 0,
        scrollHeight: 40,
      }),
    });
  });
  return r;
}
const settle = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const calls = () => vi.mocked(call).mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  vi.mocked(call).mockClear();
  renders.reset();
});

describe('the Git view after a save (F-25)', () => {
  const head1 = 'a'.repeat(40);
  const status = (over: Record<string, unknown> = {}) => ({
    available: true,
    version: '2.45',
    repository: true,
    root: '/ws',
    branch: 'main',
    ahead: 0,
    behind: 0,
    files: [] as GitFile[],
    conflicted: false,
    head: head1,
    refs: 'r1',
    changes: [],
    ...over,
  });
  beforeEach(() => {
    resetGitForTest();
    Object.assign(answers, {
      'git.changes': status(),
      'git.branches': { current: 'main', local: ['main'], remote: [] },
      'git.log': [],
      'git.pullRequestUrl': { url: undefined },
      'git.proposal': null,
      'git.fixPlan': { steps: [] },
      'git.autoFetch': undefined,
      'git.large': [],
      'git.stashList': [],
    });
  });
  afterEach(() => resetGitForTest());

  it('a save that moved nothing reads the status once and nothing else; a changed file reads only what follows the files', async () => {
    const r = await renderStyled(h(DocScope, { active: true }, h(GitView)));
    await settle();
    expect(calls()).toEqual(expect.arrayContaining(['git.changes', 'git.branches', 'git.log', 'git.pullRequestUrl', 'git.proposal', 'git.large']));
    vi.mocked(call).mockClear();
    // a burst of saves: one status read once they settled, nothing else (the answer is the same). It was 11 calls per save.
    for (let i = 0; i < 3; i++) await act(async () => emit('data.changed', { method: 'col.save' }));
    await settle(2200);
    expect(calls()).toEqual(['git.changes']);
    // a save that changed a file: the status, and the big-files check (it follows the files); not the branches, the log or the pull request
    vi.mocked(call).mockClear();
    answers['git.changes'] = status({ files: [{ path: 'collections/a.json', state: 'modified', staged: false }] });
    await act(async () => emit('data.changed', { method: 'col.save' }));
    await settle(2200);
    expect(calls().sort()).toEqual(['git.changes', 'git.large']);
    await act(async () => r.unmount());
  });

  it('HEAD or a branch that moved (a merge or a commit made outside the app) reads the branches, the log and the pull request once', async () => {
    const r = await renderStyled(h(DocScope, { active: true }, h(GitView)));
    await settle();
    vi.mocked(call).mockClear();
    answers['git.changes'] = status({ head: 'b'.repeat(40) });
    await act(async () => emit('git.changed', {}));
    await settle();
    expect(
      calls()
        .filter((m) => m === 'git.branches' || m === 'git.log' || m === 'git.pullRequestUrl')
        .sort(),
    ).toEqual(['git.branches', 'git.log', 'git.pullRequestUrl']);
    // a branch made in a terminal: the stamp of the branches moved, HEAD did not
    vi.mocked(call).mockClear();
    answers['git.changes'] = status({ head: 'b'.repeat(40), refs: 'r2' });
    await act(async () => emit('workspace.changedOnDisk', { kinds: [] }));
    await settle(2200);
    expect(calls().filter((m) => m === 'git.branches').length).toBe(1);
    await act(async () => r.unmount());
  });

  it('hidden, it reads nothing of its own; shown again, it reads what moved meanwhile once', async () => {
    let show!: (on: boolean) => void;
    function Host() {
      const [active, setActive] = useState(true);
      show = setActive;
      return h(DocScope, { active }, h(GitView));
    }
    const r = await renderStyled(h(Host));
    await settle();
    await act(async () => show(false));
    vi.mocked(call).mockClear();
    answers['git.changes'] = status({ head: 'c'.repeat(40), files: [{ path: 'x.json', state: 'added', staged: true }] });
    await act(async () => emit('git.changed', {}));
    await settle();
    // the shared status is read (the status bar shows it); the view itself asks git for nothing
    expect(calls()).toEqual(['git.changes']);
    vi.mocked(call).mockClear();
    await act(async () => show(true));
    await settle();
    expect(calls().sort()).toEqual(['git.branches', 'git.large', 'git.log', 'git.proposal', 'git.pullRequestUrl', 'git.stashList']);
    await act(async () => r.unmount());
  });
});

describe('the Git changes list (F-10)', () => {
  const files = (n: number): GitFile[] => Array.from({ length: n }, (_, i) => ({ path: `collections/c${i}.json`, state: 'modified', staged: false }));
  const changes = (n: number): SemanticChange[] =>
    Array.from({ length: n }, (_, i) => ({ file: `collections/c${i}.json`, kind: 'request', change: 'changed', title: `Request ${i}`, details: ['URL'] }));
  const props = { run: async () => undefined, onCompare: () => undefined, setDiff: () => undefined };

  it('2,000 changed files draw a window of rows; a few draw whole, as before', async () => {
    const big = await render(h(GitChanges, { files: files(2000), changes: changes(2000), ...props }));
    const list = findAll(big, (i) => i.props['data-virtual-list'] === 'GitChanges');
    expect(list).toHaveLength(1);
    const drawn = findAll(big, (i) => typeof i.type === 'string' && 'data-vl-key' in i.props).length;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn, 'rows drawn of 2,000').toBeLessThan(60);
    await act(async () => big.unmount());
    const small = await render(h(GitChanges, { files: files(12), changes: changes(12), ...props }));
    expect(findAll(small, (i) => i.props['data-virtual-list'] === 'GitChanges')).toHaveLength(0);
    expect(findAll(small, (i) => typeof i.type === 'string' && 'data-change-file' in i.props)).toHaveLength(12);
    await act(async () => small.unmount());
  });
});

describe('the HTTP tabs without the HTTP view (F-24)', () => {
  it('the tab strip has them and Close all closes them, with the view never mounted', async () => {
    setDraftScope('ws-tabs');
    const a = { ...blankRequest(), name: 'A' };
    const b = { ...blankRequest(), name: 'B' };
    useRestTabs.setState({ tabs: [a, b], active: a.id, results: {} });
    const strip = useEditorTabsStore.getState().byView.rest ?? [];
    expect(strip.map((t) => t.title)).toEqual(['A', 'B']);
    // "Close all" from another editor's tab: the strip asks the HTTP tabs' own batch close
    strip[0]!.closeMany!(strip.map((t) => t.key));
    await settle();
    expect(useRestTabs.getState().tabs).toHaveLength(0);
    expect(useEditorTabsStore.getState().byView.rest).toEqual([]);
    // and the draft says so: a restart does not bring a tab back
    await closeRestTabs([]);
    setDraftScope(undefined);
  });
});

describe('rows keep their state (F-13)', () => {
  it('a revealed secret stays with its row when the row above is removed', async () => {
    function Host() {
      const [rows, setRows] = useState<KeyValue[]>([
        { key: 'a', value: '1', enabled: true, secret: true },
        { key: 'b', value: '2', enabled: true, secret: true },
      ]);
      return h(KeyValueEditor, { rows, onChange: setRows, allowSecret: true });
    }
    const r = await render(h(Host));
    const reveal = () => findAll(r, (i) => i.type === 'button' && (i.props['aria-label'] === 'Reveal' || i.props['aria-label'] === 'Hide'));
    // reveal b
    await act(async () => reveal()[1]!.props.onClick());
    expect(reveal().map((b) => b.props['aria-label'])).toEqual(['Reveal', 'Hide']);
    // remove a: b is still revealed (with index keys it went back to hidden, and the next row would have been revealed)
    await act(async () => findAll(r, (i) => i.type === 'button' && i.props['aria-label'] === 'Remove')[0]!.props.onClick());
    expect(reveal().map((b) => b.props['aria-label'])).toEqual(['Hide']);
    await act(async () => r.unmount());
  });

  it('a problem keeps its key when one above it is fixed', () => {
    const p = (n: number) =>
      ({ kind: 'failing-request', ref: { kind: 'request', collectionId: 'c', requestId: `r${n}` }, message: `R${n} fails`, severity: 'error', type: 'failure', group: 'Requests' }) as never;
    const before = problemKeys([p(1), p(2), p(3)]);
    const after = problemKeys([p(2), p(3)]);
    expect(after).toEqual(before.slice(1));
    expect(new Set(problemKeys([p(1), p(1)])).size).toBe(2);
  });
});

describe('work done once typing paused, menus built when they open (F-21, F-23)', () => {
  it('a request on screen is scanned for its variables once per pause, not per keystroke', async () => {
    let type!: (s: string) => void;
    function Editor() {
      const [url, setUrl] = useState('{{baseUrl}}/a');
      type = setUrl;
      const request = { request: { method: 'POST', url, body: { type: 'json', content: JSON.stringify({ big: 'x'.repeat(200_000) }) } } };
      usePublishRequest('rest', request, undefined);
      return h('div', null, url);
    }
    const r = await render(h(Editor));
    scanned.n = 0;
    for (let i = 0; i < 10; i++) await act(async () => type(`{{baseUrl}}/a${i}`));
    expect(scanned.n, 'scans while typing').toBe(0);
    await settle(400);
    expect(scanned.n).toBe(1);
    await act(async () => r.unmount());
  });

  it('a closed menu does not build its items', async () => {
    const items = vi.fn(() => [{ label: 'Copy', onSelect: () => undefined }]);
    const r = await render(h(Menu, { trigger: h('button', null, 'key'), items }));
    expect(items).not.toHaveBeenCalled();
    await act(async () => r.unmount());
  });
});

describe('reads asked for twice at startup share one call (F-33)', () => {
  it('identical reads in flight share it; one asked after a change gets its own', async () => {
    answers['certificates.list'] = () => new Promise((res) => setTimeout(() => res([{ host: 'a' }]), 10));
    const [x, y] = await Promise.all([sharedCall('certificates.list'), sharedCall('certificates.list')]);
    expect(x).toBe(y);
    expect(calls()).toEqual(['certificates.list']);
    vi.mocked(call).mockClear();
    const first = sharedCall('certificates.list');
    emit('data.changed', { method: 'col.save' });
    const second = sharedCall('certificates.list');
    await Promise.all([first, second]);
    expect(calls()).toEqual(['certificates.list', 'certificates.list']);
  });
});
