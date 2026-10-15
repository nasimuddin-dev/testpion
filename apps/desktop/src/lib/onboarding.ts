import type { ItemRef } from '@testpion/shared';
import { useApp } from '../store';
import { runMenuCommand } from '../menu-commands';
import { openRef } from './open-ref';
import { DOCS_URL } from './docs-link';

/** A step of Get started as the backend reads it (`ws.onboarding`, core onboardingProgress). */
export interface OnboardingStep {
  id: 'send' | 'save' | 'test' | 'run' | 'ci';
  done: boolean;
  ref?: ItemRef;
}

/** WF-22 the first loop, explore → save → test → run → CI: each step's words and what its button does. */
export const LOOP_STEPS: Record<OnboardingStep['id'], { label: string; text: string }> = {
  send: { label: 'Send a request', text: 'A URL, or paste a cURL command.' },
  save: { label: 'Save it in a collection', text: 'Ctrl+S keeps it, with its auth and scripts.' },
  test: { label: 'Save it as a test', text: 'Save as test… in its ⋯: checks you can run again.' },
  run: { label: 'Run the tests', text: 'In Tests, or Ctrl+Shift+R for the last run.' },
  ci: { label: 'Run them in CI', text: 'GitHub Actions, GitLab, Azure or Jenkins: one file.' },
};

/** What a step's button does: open what it builds on (through openRef), or where to start. */
export function runStep(s: OnboardingStep): void {
  const app = useApp.getState();
  switch (s.id) {
    case 'send':
      return s.ref ? void openRef(s.ref, { edit: true }) : app.openIntent('rest', { newTab: true });
    case 'save':
      // the request sent last, in its editor: Ctrl+S saves it
      return s.ref ? void openRef(s.ref, s.ref.kind === 'history' ? { edit: true } : {}) : app.openIntent('rest', { newTab: true });
    case 'test':
      if (s.ref?.kind === 'request') app.toast('Use Save as test… in the ⋯ at the end of the request’s breadcrumb', 'info');
      return s.ref ? void openRef(s.ref) : app.setView('tests');
    case 'run':
      return s.ref ? void openRef(s.ref) : app.setView('tests');
    case 'ci':
      return app.set({ ci: s.ref?.kind === 'test' ? { tests: [s.ref.path] } : {} });
  }
}

/** The other loops, as walk-throughs in the Examples workspace (each opens it, then where the loop starts). */
export const WALKTHROUGHS: Array<{ id: string; title: string; text: string; start(): Promise<void> | void; docs: string }> = [
  {
    id: 'debug',
    title: 'Debug a failing test',
    text: 'Run the Offline suite, open a failure, fix it, run it again (F8 steps through problems).',
    docs: 'getting-started/finding-your-way#problems',
    start: async () => {
      await runMenuCommand('open-examples');
      useApp.getState().setView('tests');
    },
  },
  {
    id: 'capture',
    title: 'Capture traffic into requests',
    text: 'Send traffic through the HTTP Debugger, select it, Save to collection or Create flow.',
    docs: 'api-testing/http-debugger',
    start: async () => {
      await runMenuCommand('open-examples');
      useApp.getState().setView('debugger');
    },
  },
  {
    id: 'git',
    title: 'Collaborate through git',
    text: 'See changes by meaning, commit, pull: open editors follow what changed.',
    docs: 'getting-started/finding-your-way#the-git-view',
    start: () => useApp.getState().setView('git'),
  },
];

/** A walk-through's guide, as a doc ref (opened in the browser like every docs link). */
export const walkthroughDocs = (path: string): ItemRef => ({ kind: 'doc', url: DOCS_URL + path });
