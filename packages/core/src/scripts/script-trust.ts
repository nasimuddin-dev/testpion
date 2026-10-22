import { areSecretReadsTrusted, hostOfUrl, isHostTrusted, trustHost, trustSecretReads } from '../storage/trust.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * What a workspace's scripts may do beyond computing: a script comes from git, an import or a teammate, so it can read
 * the stored secrets (`tp.environment.get`, `tp.vault.get`) and send them anywhere with `tp.sendRequest`. Both need the
 * person's say, per workspace and per computer (the trust list in the app's data folder, like a stdio MCP server's
 * command): hosts a script may reach (the request's own host and this computer's loopback need no decision) and whether
 * it may read secrets. Without a gate on the services (`scriptTrust` unset) nothing is restricted.
 */
export interface ScriptTrust {
  /** Whether scripts may send requests to this host. */
  hostAllowed(host: string): boolean;
  /** Whether scripts may read variables flagged secret. */
  secretsAllowed(): boolean;
  /** Told when a script was refused (the desktop app offers an "Allow…" action, the CLI names the flag). */
  onBlocked?(b: { kind: 'host'; host: string } | { kind: 'secrets'; keys: string[] }): void;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** The environment switch headless runs (CI, the CLI, an agent) set instead of answering a prompt. */
export const TRUST_SCRIPTS_ENV = 'TESTPION_TRUST_SCRIPTS';

/** Everything allowed: a workspace the person trusts as a whole, a run that passed `--trust-scripts`, or tests. */
export const trustAllScripts: ScriptTrust = { hostAllowed: () => true, secretsAllowed: () => true };

/**
 * The gate for a workspace on this computer. `all` (or TESTPION_TRUST_SCRIPTS=1) lifts it; otherwise the workspace's trust
 * list decides: `*` among its hosts means any host.
 */
export function scriptTrustFor(store: Pick<WorkspaceStore, 'root'>, o: { all?: boolean; onBlocked?: ScriptTrust['onBlocked'] } = {}): ScriptTrust {
  if (o.all || process.env[TRUST_SCRIPTS_ENV] === '1') return trustAllScripts;
  return {
    hostAllowed: (host) => LOOPBACK.has(host.toLowerCase()) || isHostTrusted(store, '*') || isHostTrusted(store, host),
    secretsAllowed: () => areSecretReadsTrusted(store),
    onBlocked: o.onBlocked,
  };
}

/** The refusal a script sees when it sends to a host that was not allowed. */
export function hostRefusal(host: string): string {
  return `tp.sendRequest to ${host} is not allowed for this workspace on this computer. Allow the host in TestPion (the prompt after a script is refused), or run with --trust-scripts / ${TRUST_SCRIPTS_ENV}=1.`;
}

export function checkScriptHost(trust: ScriptTrust | undefined, url: string, ownHost?: string): void {
  if (!trust) return;
  const host = hostOfUrl(url);
  if (!host || host === ownHost || trust.hostAllowed(host)) return;
  trust.onBlocked?.({ kind: 'host', host });
  throw new Error(hostRefusal(host));
}

/** Allow scripts of the workspace to reach a host (`*` = any) or to read secrets: the person's answer to a prompt. */
export function allowScripts(store: Pick<WorkspaceStore, 'root'>, what: { host: string } | { secrets: true }): void {
  if ('host' in what) trustHost(store, what.host);
  else trustSecretReads(store);
}
