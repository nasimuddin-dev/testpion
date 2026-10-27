import { ApsError } from '../errors.js';

/**
 * Whether this process may start programs (git, secret-manager CLIs, browsers, MCP stdio servers). A leaf module on purpose:
 * `net/process.ts` (the one place programs are started) must be importable from the storage layer without a cycle, so the
 * flag lives here and `net/policy.ts` keeps it in step with the rest of the network policy (`setNetworkPolicy`).
 * It starts from TESTPION_ALLOW_PROCESSES, so a server that sets it is closed from the first call, whatever loads first.
 */
const fromEnv = process.env.TESTPION_ALLOW_PROCESSES;
let allowed = fromEnv === undefined ? true : /^(1|true|yes)$/i.test(fromEnv);

export function setProcessesAllowed(value: boolean): void {
  allowed = value;
}

/** Refuse to start local processes when the policy forbids it (git, secret managers, browsers, MCP stdio servers on a shared server). */
export function assertProcessesAllowed(what: string): void {
  if (!allowed) throw new ApsError('ConfigurationError', `Blocked by the network policy: starting local programs (${what}) is disabled on this server`, { suggestions: ['Use an MCP server over Streamable HTTP or SSE instead of stdio.'] });
}
