import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, readJson } from './fsutil.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * Programs a workspace may start on this computer. A workspace's MCP servers can be stdio commands, and a workspace
 * comes from git, an import or a teammate: the first time one would run, the user sees the exact command line and
 * decides. Decisions live in `.local/trust.json`, which is per computer and never committed.
 */
export interface TrustedCommand {
  command: string;
  args: string[];
  /** When the user allowed it. */
  at: string;
}

const file = (store: Pick<WorkspaceStore, 'root'>) => join(store.root, '.local', 'trust.json');

function load(store: Pick<WorkspaceStore, 'root'>): { commands: TrustedCommand[] } {
  try {
    return readJson<{ commands: TrustedCommand[] }>(file(store), { commands: [] });
  } catch {
    return { commands: [] };
  }
}

/** One line a person can read and judge: the program and its arguments, quoted where needed. */
export function commandLine(command: string, args: string[] = []): string {
  return [command, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** Whether this exact program and arguments were allowed for the workspace on this computer. */
export function isCommandTrusted(store: Pick<WorkspaceStore, 'root'>, command: string, args: string[] = []): boolean {
  const line = commandLine(command, args);
  return load(store).commands.some((c) => commandLine(c.command, c.args) === line);
}

/** Remember that the user allowed this program and arguments for the workspace on this computer. */
export function trustCommand(store: Pick<WorkspaceStore, 'root'>, command: string, args: string[] = []): void {
  if (isCommandTrusted(store, command, args)) return;
  const t = load(store);
  t.commands.push({ command, args, at: new Date().toISOString() });
  mkdirSync(join(store.root, '.local'), { recursive: true });
  atomicWrite(file(store), JSON.stringify(t, null, 2) + '\n');
}

export function trustedCommands(store: Pick<WorkspaceStore, 'root'>): TrustedCommand[] {
  return load(store).commands;
}

/** Forget every allowed program of the workspace (Settings, or after a suspicious change). */
export function forgetTrustedCommands(store: Pick<WorkspaceStore, 'root'>): void {
  atomicWrite(file(store), JSON.stringify({ commands: [] }, null, 2) + '\n');
}
