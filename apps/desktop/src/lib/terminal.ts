import { create } from 'zustand';
import { useApp } from '../store';
import { afterScopeChange } from './ws-scope';

/**
 * The Terminal tab of the bottom panel, as the rest of the window sees it: open it, start a terminal, put a command
 * in one. The terminals themselves (xterm, components/TerminalPanel.tsx) load with the tab, the first time it opens;
 * what is asked before that waits in a queue the panel takes when it is ready.
 */
export interface TerminalSessionInfo {
  id: string;
  shell: string;
  label: string;
  pid: number;
  cwd: string;
  exitCode?: number;
  /** Output characters sent to the window so far (flow control counts from here). */
  sent?: number;
}

export type TerminalRequest = { kind: 'new' } | { kind: 'focus' } | { kind: 'run'; command: string; execute: boolean };

interface TerminalState {
  sessions: TerminalSessionInfo[];
  active?: string;
  /** What the window asked for and the panel has not done yet. */
  queue: TerminalRequest[];
}

export const useTerminals = create<TerminalState>(() => ({ sessions: [], queue: [] }));

// what was asked in one workspace (Run in terminal …) is not done in the next one
afterScopeChange(() => void (useTerminals.getState().queue.length && useTerminals.setState({ queue: [] })));

function ask(r: TerminalRequest): void {
  useTerminals.setState((s) => ({ queue: [...s.queue, r] }));
  useApp.getState().set({ logsOpen: true, bottomTab: 'terminal' });
}

/**
 * Put a command in the terminal (the active one, else a new one) and show it. The command is typed, not run: the user
 * reads it and presses Enter, unless `execute` says to. The one shared "Run in terminal" action (RunInTerminalButton).
 */
export function runInTerminal(command: string, opts: { execute?: boolean } = {}): void {
  ask({ kind: 'run', command, execute: !!opts.execute });
}

/** Terminal: New (command palette). */
export const newTerminal = () => ask({ kind: 'new' });
/** Terminal: Focus (command palette): the Terminal tab, its active terminal focused (a new one when there is none). */
export const focusTerminal = () => ask({ kind: 'focus' });

/** Whether this host runs shells (the desktop app); the browser bridge and a cloud server don't. */
export const useShellCapable = () => useApp((s) => !!s.info?.capabilities?.shell);
