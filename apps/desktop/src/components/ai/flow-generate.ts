import { useApp, type FlowGenerateRequest, type TidyImportRequest } from '../../store';
import type { MenuItem } from '../ui';
import { aiMenuItems } from '../../lib/ai-menu';

/** Open "Generate integration flow with AI" (AI-1), "Generate tests from a spec" (AI-4) or "Generate security tests" (AI-8): the one way, from the explorer's menus and the flow canvas. */
export function startFlowGenerate(req: FlowGenerateRequest = {}): void {
  useApp.getState().set({ flowGenerate: req });
}

/** Open "Tidy this import with AI" (AI-10): the explorer's collection menu, and the import's own notice. */
export function startTidyImport(req: TidyImportRequest): void {
  useApp.getState().set({ tidyImport: req });
}

/** The right-click / ⋯ item of a collection or a folder: from the one AI table, the same label and icon everywhere; none while AI is hidden. */
export function generateFlowItems(source: { collectionId: string; folderId?: string }, opts: { separator?: boolean } = {}): MenuItem[] {
  return aiMenuItems('flow', () => startFlowGenerate({ source, mode: 'collection' }), opts);
}
