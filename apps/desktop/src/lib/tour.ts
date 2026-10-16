import { create } from 'zustand';
import type { ViewId } from '../store';
import { LOOP_STEPS, type OnboardingStep } from './onboarding';
import { scopedKey } from './ws-scope';

/**
 * The guided tour of the first loop (Home ▸ Get started ▸ Take the tour): Send → Save → Save as test → Run → Run in CI,
 * one coachmark per step on the control that does it, built from the workspace's onboarding progress (core
 * onboardingProgress: a done step says so). It shows itself once per workspace, never again after it was finished or
 * skipped; Take the tour starts it again at any time.
 */
export interface TourStep {
  /** A step of the loop, or the opening card (on Home: what the tour is, before it goes anywhere). */
  id: OnboardingStep['id'] | 'intro';
  /** Where the control is. */
  view: ViewId;
  /** The control, by its data-tour mark, tried in order (the first one on screen). */
  targets: string[];
  title: string;
  text: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'intro',
    view: 'home',
    targets: ['[data-get-started]'],
    title: 'A quick tour',
    text: 'Five steps from a first request to tests running in CI: send, save, save as test, run, run in CI. Next shows where each one is; Skip ends it (Take the tour on Get started brings it back).',
  },
  {
    id: 'send',
    view: 'rest',
    targets: ['[data-tour="send"]'],
    title: LOOP_STEPS.send.label,
    text: 'Type a URL (or paste a cURL command) and press Send, or Ctrl+Enter. The response, its timing and its trace appear below.',
  },
  {
    id: 'save',
    view: 'rest',
    targets: ['[data-tour="save"]', '[data-tour="request-line"]'],
    title: LOOP_STEPS.save.label,
    text: 'Save (Ctrl+S) keeps the request in a collection, with its auth, scripts and examples, to send again or share through git.',
  },
  {
    id: 'test',
    view: 'rest',
    targets: ['[data-tour="request-more"]', '[data-tour="request-line"]'],
    title: LOOP_STEPS.test.label,
    text: 'Save as test… in this ⋯ turns the request and its checks into a YAML test file that you (and CI) can run again.',
  },
  {
    id: 'run',
    view: 'tests',
    targets: ['[data-tour="run-all"]'],
    title: LOOP_STEPS.run.label,
    text: 'Run all tests runs every test file with the active environment; a file of its own runs from its tab. Ctrl+Shift+R runs the last run again.',
  },
  {
    id: 'ci',
    view: 'tests',
    targets: ['[data-tour="run-ci"]', '[data-tour="run-all"]'],
    title: LOOP_STEPS.ci.label,
    text: 'Run in CI… (in the Tests list’s ⋯ and a run’s menu) writes one pipeline file for GitHub Actions, GitLab, Azure or Jenkins that runs these tests on every push.',
  },
];

const SEEN = 'tour.firstLoop';

/** The tour was shown in this workspace (finished, skipped or closed): it does not open by itself again. */
export function tourSeen(): boolean {
  const k = scopedKey(SEEN);
  if (!k) return true; // no workspace yet: never auto-open
  try {
    return localStorage.getItem(`aps.${k}`) !== null;
  } catch {
    return true;
  }
}

function markSeen(): void {
  const k = scopedKey(SEEN);
  if (!k) return;
  try {
    localStorage.setItem(`aps.${k}`, new Date().toISOString());
  } catch {
    /* storage unavailable: it may show again, which is harmless */
  }
}

interface TourState {
  open: boolean;
  index: number;
  /** Start: at the opening card (`intro`), else at the first loop step not done yet (all done: the first). */
  start(progress: OnboardingStep[], o?: { intro?: boolean }): void;
  go(index: number): void;
  close(): void;
}

export const useTour = create<TourState>((set) => ({
  open: false,
  index: 0,
  start: (progress, o = {}) => {
    markSeen();
    const first = TOUR_STEPS.findIndex((s) => s.id !== 'intro' && !progress.find((p) => p.id === s.id)?.done);
    set({ open: true, index: o.intro ? 0 : first < 0 ? 1 : first });
  },
  go: (index) => set({ index: Math.max(0, Math.min(TOUR_STEPS.length - 1, index)) }),
  close: () => (markSeen(), set({ open: false })),
}));

/** Whether Home should open the tour by itself: a workspace whose first loop is not done, the tour never shown here. */
export function shouldAutoStart(progress: OnboardingStep[], opts: { examples: boolean }): boolean {
  return !opts.examples && progress.length > 0 && progress.some((s) => !s.done) && !tourSeen();
}
