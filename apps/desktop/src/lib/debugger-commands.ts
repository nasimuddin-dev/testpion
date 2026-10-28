import type { DebuggerCommand } from '@testpion/shared';

/**
 * The Debugger's command bar lives in the command palette (the `!` prefix, lib/quick-open.ts). The Debugger view says
 * what each command does while it is on screen; the palette only reads and runs the line. One handler at a time.
 */
export interface DebuggerCommandHandler {
  /** What running the command would do, in words (the palette row), or why it cannot. */
  describe(c: DebuggerCommand): string;
  run(c: DebuggerCommand): void;
}

let handler: DebuggerCommandHandler | undefined;

/** The Debugger view registers itself while it is mounted; returns the unregister. */
export function setDebuggerCommandHandler(h: DebuggerCommandHandler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = undefined;
  };
}

export const debuggerCommandHandler = (): DebuggerCommandHandler | undefined => handler;
