import { createElement } from 'react';
import { Sparkles } from 'lucide-react';
import { useApp, type FlowGenerateRequest } from '../../store';
import type { MenuItem } from '../ui';

/** Open "Generate integration flow with AI" (AI-1): the one way, from the explorer's menus and the flow canvas. */
export function startFlowGenerate(req: FlowGenerateRequest = {}): void {
  useApp.getState().set({ flowGenerate: req });
}

/** The right-click / ⋯ item of a collection or a folder: the same label and icon everywhere. */
export function generateFlowItem(source: { collectionId: string; folderId?: string }, opts: { separator?: boolean } = {}): MenuItem {
  return {
    label: 'Generate integration flow with AI…',
    icon: createElement(Sparkles, { size: 14 }),
    separator: opts.separator,
    onSelect: () => startFlowGenerate({ source, mode: 'collection' }),
  };
}
