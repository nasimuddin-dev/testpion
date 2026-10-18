import { createElement } from 'react';
import { Sparkles } from 'lucide-react';
import { useApp, type AiAnalysisRequest } from '../../store';
import type { MenuItem } from '../ui';
import { LABEL } from '../../lib/vocabulary';

/** Open an AI analysis (AI-2 / AI-5): the one way, from every run view, the Problems list and the test history. */
export function startAiAnalysis(req: AiAnalysisRequest): void {
  useApp.getState().set({ aiAnalysis: req });
}

export const TRIAGE_LABEL = LABEL.triageWithAi;
export const FLAKY_LABEL = 'Why is this flaky?';

/** The ⋯ / right-click item of a failed run (run header, runs list, Problems, a monitor's failing run): the same label and icon everywhere. */
export function triageRunItem(runId: string, opts: { title?: string; separator?: boolean } = {}): MenuItem {
  return { label: TRIAGE_LABEL, icon: createElement(Sparkles, { size: 14 }), separator: opts.separator, onSelect: () => startAiAnalysis({ kind: 'triage', runId, title: opts.title }) };
}

/** The item of a flaky test (Problems, the test history). */
export function flakyTestItem(testId: string, opts: { title?: string; separator?: boolean } = {}): MenuItem {
  return { label: FLAKY_LABEL, icon: createElement(Sparkles, { size: 14 }), separator: opts.separator, onSelect: () => startAiAnalysis({ kind: 'flaky', testId, title: opts.title }) };
}
