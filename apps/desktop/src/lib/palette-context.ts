/**
 * Commands of the place the keyboard is in, offered first by the command palette (Ctrl+K): the flow designer's canvas
 * registers its actions (Add step ▸ …, Auto-arrange, Find …) and they lead the list while the focus is inside it.
 */
import type { PaletteCommand } from '../components/Shell';

interface PaletteContext {
  /** The element the commands belong to: they are offered only while the focus is inside it. */
  root: HTMLElement;
  /** The commands, read when the palette opens. */
  commands(): PaletteCommand[];
}

const contexts = new Set<PaletteContext>();

/** Offer commands while the focus is inside `root`; returns the unregister (when it unmounts). */
export function setPaletteContext(c: PaletteContext): () => void {
  contexts.add(c);
  return () => void contexts.delete(c);
}

/** The commands of the place that has the focus right now (none when it is elsewhere). */
export function focusedPaletteCommands(): PaletteCommand[] {
  const active = document.activeElement;
  for (const c of contexts) if (c.root.isConnected && active && c.root.contains(active)) return c.commands();
  return [];
}
