import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guided tour of the first loop (Home ▸ Get started): built from the onboarding progress, it opens by itself once
// per workspace (never again after it was shown there), starts at the first step not done, and Take the tour reopens it.
vi.mock('../../apps/desktop/src/lib/onboarding', () => ({
  LOOP_STEPS: Object.fromEntries(['send', 'save', 'test', 'run', 'ci'].map((id) => [id, { label: id, text: '' }])),
}));

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};

const { TOUR_STEPS, shouldAutoStart, tourSeen, useTour } = await import('../../apps/desktop/src/lib/tour');
const { setDraftScope } = await import('../../apps/desktop/src/lib/ws-scope');

const progress = (done: string[]) => (['send', 'save', 'test', 'run', 'ci'] as const).map((id) => ({ id, done: done.includes(id) }));

describe('guided tour', () => {
  beforeEach(() => {
    mem.clear();
    useTour.setState({ open: false, index: 0 });
  });

  it('the loop in order, after an opening card: Send → Save → Save as test → Run → Run in CI', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['intro', 'send', 'save', 'test', 'run', 'ci']);
    expect(TOUR_STEPS.every((s) => s.targets.length > 0)).toBe(true);
  });

  it('opens by itself once per workspace (the examples too: a new window starts there), not when the loop is done, never without a workspace', () => {
    setDraftScope(undefined);
    expect(shouldAutoStart(progress([]), { examples: false })).toBe(false);
    setDraftScope('ws-a');
    expect(shouldAutoStart(progress([]), { examples: true })).toBe(true);
    expect(shouldAutoStart(progress(['send', 'save', 'test', 'run', 'ci']), { examples: false })).toBe(false);
    expect(shouldAutoStart(progress(['send']), { examples: false })).toBe(true);
    useTour.getState().start(progress(['send']), { intro: true });
    expect(useTour.getState()).toMatchObject({ open: true, index: 0 });
    useTour.getState().close();
    expect(tourSeen()).toBe(true);
    expect(shouldAutoStart(progress(['send']), { examples: false })).toBe(false);
    // another workspace: its own first time
    setDraftScope('ws-b');
    expect(shouldAutoStart(progress([]), { examples: false })).toBe(true);
  });

  it('Take the tour starts at the first step not done (all done: the first step)', () => {
    setDraftScope('ws-c');
    useTour.getState().start(progress(['send', 'save']));
    expect(TOUR_STEPS[useTour.getState().index]!.id).toBe('test');
    useTour.getState().start(progress(['send', 'save', 'test', 'run', 'ci']));
    expect(TOUR_STEPS[useTour.getState().index]!.id).toBe('send');
    useTour.getState().go(99);
    expect(TOUR_STEPS[useTour.getState().index]!.id).toBe('ci');
  });
});
