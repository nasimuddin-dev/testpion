import { aiActionOf, type AiActionId } from '@testpion/shared';
import type { MenuItem } from '../components/ui';
import { aiHidden } from './ai-visible';
import { icon } from './node-menu-actions';
import { LABEL } from './vocabulary';

/**
 * An AI item of a ⋯ or context menu that is not a tree node's (the Problems list, a run's header): its label and icon come
 * from the one AI table (packages/shared/src/ai-actions.ts), exactly as the node menus take theirs, and it is not there at
 * all while "Hide all AI actions" is on. A view never writes an AI menu item itself (tests/unit/ai-hidden.test.ts).
 */
export function aiMenuItems(id: AiActionId, onSelect: () => void, opts: { separator?: boolean } = {}): MenuItem[] {
  if (aiHidden()) return [];
  const a = aiActionOf(id);
  if (!a) throw new Error(`No AI action "${id}" in the AI table`);
  return [{ label: LABEL[a.label], icon: icon(a.icon), separator: opts.separator, onSelect }];
}
