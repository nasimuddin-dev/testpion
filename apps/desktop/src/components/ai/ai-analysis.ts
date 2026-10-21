import { useApp, type AiAnalysisRequest } from '../../store';
import type { MenuItem } from '../ui';
import { aiMenuItems } from '../../lib/ai-menu';

/** Open an AI analysis (AI-2 / AI-5 / AI-9): the one way, from every run view, the Problems list, the test history and the API definitions. */
export function startAiAnalysis(req: AiAnalysisRequest): void {
  useApp.getState().set({ aiAnalysis: req });
}

/** The ⋯ / right-click item of a failed run (run header, runs list, Problems, a monitor's failing run): the same label and icon everywhere; none while AI is hidden. */
export function triageRunItems(runId: string, opts: { title?: string; separator?: boolean } = {}): MenuItem[] {
  return aiMenuItems('triage', () => startAiAnalysis({ kind: 'triage', runId, title: opts.title }), opts);
}

/** The item of a flaky test (Problems, the test history). */
export function flakyTestItems(testId: string, opts: { title?: string; separator?: boolean } = {}): MenuItem[] {
  return aiMenuItems('analyzeFlaky', () => startAiAnalysis({ kind: 'flaky', testId, title: opts.title }), opts);
}
