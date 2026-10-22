import { SquareTerminal } from 'lucide-react';
import { runInTerminal, useShellCapable } from '../lib/terminal';
import { IconButton } from './ui';

/**
 * The one "Run in terminal" action, next to the Copy of a command line: the command goes into the Terminal tab of the
 * bottom panel (typed, not run, unless `execute`). Shown only where the app runs shells (the desktop app).
 */
export function RunInTerminalButton({ command, execute, className }: { command: string; execute?: boolean; className?: string }) {
  if (!useShellCapable() || !command.trim() || command.includes('\n')) return null;
  return (
    <IconButton label="Run in terminal" className={className} data-run-in-terminal="" onClick={() => runInTerminal(command, { execute })}>
      <SquareTerminal />
    </IconButton>
  );
}
