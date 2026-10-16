import type { MouseEvent } from 'react';

/**
 * The props that let the mouse pick a row of a keyboard list (the command palette, Quick Open, search, suggestions)
 * only when it really moves over it. A list that opens or changes under a resting pointer gets mouse-over events for
 * the row that lands under it (Chromium updates the hover after a layout); taking those as a choice moved the
 * selection away from what the keyboard chose, so Enter opened whatever happened to be under the pointer.
 */
export function hoverSelect(select: () => void): { onMouseMove(e: MouseEvent): void } {
  return {
    onMouseMove: (e) => {
      if (e.movementX || e.movementY) select();
    },
  };
}
