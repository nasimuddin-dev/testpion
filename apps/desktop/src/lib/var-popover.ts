import { create } from 'zustand';
import { isTemplateBlock } from '@testpion/shared';

/**
 * The {{variable}} popover, one for the whole app: what a variable holds, where it comes from, edit or add it. A click
 * on a variable in a field with variable highlighting opens it, and so does a double-click on a variable in any text
 * field or code editor (VarPopoverHost listens).
 */
export interface VarPopoverRequest {
  name: string;
  /** Where to show it (viewport coordinates: under the variable). */
  x: number;
  y: number;
  /** The collection of the request on screen: its variables count (from the nearest [data-collection-id]). */
  collectionId?: string;
  /** The field that opened it (so the field knows its popover is open). */
  owner?: Element;
}

export const useVarPopover = create<{ open?: VarPopoverRequest; show(r: VarPopoverRequest): void; hide(): void }>((set) => ({
  open: undefined,
  show: (open) => set({ open }),
  hide: () => set({ open: undefined }),
}));

/** The {{variable}} around position `at` in a line of text (the name inside the braces), if any. */
export function variableAt(text: string, at: number): string | undefined {
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (isTemplateBlock(m[1]!)) continue;
    const start = m.index ?? 0;
    if (at >= start && at <= start + m[0].length) return m[1]!.trim();
  }
  return undefined;
}

/** The collection a page element belongs to (views mark their editor with data-collection-id). */
export const collectionOf = (el: Element | null | undefined): string | undefined => (el?.closest('[data-collection-id]') as HTMLElement | null)?.dataset.collectionId || undefined;

/** A variable's value changed (saved from the popover): fields that show variables look again. */
export const VARS_CHANGED = 'testpion:vars-changed';

/** The collection of the request on screen (the visible editor marked with data-collection-id), if any. */
export const activeCollectionId = (): string | undefined =>
  ([...document.querySelectorAll<HTMLElement>('main [data-collection-id]')].find((e) => e.offsetParent && e.dataset.collectionId)?.dataset.collectionId) || undefined;
