import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, readJson, realPathOf } from './fsutil.js';
import { defaultAppDir } from './app-dir.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * What a workspace may do on this computer beyond reading and sending its own requests: start programs (stdio MCP
 * servers, secret-manager CLIs), let its scripts reach hosts with `tp.sendRequest`, and let them read stored secrets. A
 * workspace comes from git, an import or a teammate, so the first time one of these would happen the user sees the exact
 * program, host or secret read and decides.
 *
 * Decisions live in the app's data folder (`<app data>/trust/<hash of the workspace's real path>.json`), never in the
 * workspace: a repository or bundle cannot ship its own trust. A `.local/trust.json` inside a workspace (what versions
 * before 0.55 wrote) is ignored; the person is asked again the next time it matters, which is the one-time migration.
 */
interface TrustedCommand {
  command: string;
  args: string[];
  /** When the user allowed it. */
  at: string;
}

interface TrustFile {
  /** The real path of the workspace the decisions are for (informational: the file name is the key). */
  workspace?: string;
  commands: TrustedCommand[];
  /** Hosts the workspace's scripts may send requests to (`tp.sendRequest`, `tp.execution.runRequest`). */
  hosts?: Array<{ host: string; at: string }>;
  /** Whether the workspace's scripts may read stored secrets (`tp.vault.get`, `tp.environment.get` of a secret). */
  secretReads?: { at: string };
}

type Store = Pick<WorkspaceStore, 'root'>;

/** The key of a workspace: its real path (links resolved), folded to lower case where the file system ignores case. */
export function workspaceTrustKey(store: Store): string {
  const real = realPathOf(store.root);
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/** The decisions file of a workspace, in the app's data folder. */
export function trustFile(store: Store, appDir = defaultAppDir()): string {
  return join(appDir, 'trust', `${createHash('sha256').update(workspaceTrustKey(store)).digest('hex').slice(0, 32)}.json`);
}

function load(store: Store): TrustFile {
  try {
    const t = readJson<TrustFile>(trustFile(store), { commands: [] });
    return { ...t, commands: Array.isArray(t.commands) ? t.commands : [] };
  } catch {
    return { commands: [] };
  }
}

function save(store: Store, t: TrustFile): void {
  atomicWrite(trustFile(store), JSON.stringify({ ...t, workspace: realPathOf(store.root) }, null, 2) + '\n');
}

/** One line a person can read and judge: the program and its arguments, quoted where needed. */
export function commandLine(command: string, args: string[] = []): string {
  return [command, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** Whether this exact program and arguments were allowed for the workspace on this computer. */
export function isCommandTrusted(store: Store, command: string, args: string[] = []): boolean {
  const line = commandLine(command, args);
  return load(store).commands.some((c) => commandLine(c.command, c.args) === line);
}

/** Remember that the user allowed this program and arguments for the workspace on this computer. */
export function trustCommand(store: Store, command: string, args: string[] = []): void {
  if (isCommandTrusted(store, command, args)) return;
  const t = load(store);
  t.commands.push({ command, args, at: new Date().toISOString() });
  save(store, t);
}

export function trustedCommands(store: Store): TrustedCommand[] {
  return load(store).commands;
}

const hostKey = (host: string) => host.trim().toLowerCase().replace(/^\[|\]$/g, '');

/** The host (without port) of a URL, lower case; undefined for text that is not a URL. */
export function hostOfUrl(url: string): string | undefined {
  try {
    return hostKey(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** Whether the workspace's scripts may send requests to this host on this computer. */
export function isHostTrusted(store: Store, host: string): boolean {
  const h = hostKey(host);
  return (load(store).hosts ?? []).some((e) => e.host === h);
}

/** Remember that the user allowed the workspace's scripts to send requests to this host. */
export function trustHost(store: Store, host: string): void {
  if (isHostTrusted(store, host)) return;
  const t = load(store);
  (t.hosts ??= []).push({ host: hostKey(host), at: new Date().toISOString() });
  save(store, t);
}

export function trustedHosts(store: Store): Array<{ host: string; at: string }> {
  return load(store).hosts ?? [];
}

/** Whether the workspace's scripts may read stored secrets on this computer. */
export function areSecretReadsTrusted(store: Store): boolean {
  return !!load(store).secretReads;
}

/** Remember that the user allowed the workspace's scripts to read stored secrets. */
export function trustSecretReads(store: Store): void {
  if (areSecretReadsTrusted(store)) return;
  const t = load(store);
  t.secretReads = { at: new Date().toISOString() };
  save(store, t);
}

/** Forget every decision of the workspace (Settings, or after a suspicious change). */
export function forgetTrustedCommands(store: Store): void {
  save(store, { commands: [] });
}
