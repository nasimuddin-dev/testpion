import { ApsError, normalizeError } from './errors.js';

/** Kinds where trying the same call again may work (network, timeouts, rate limits, server errors). */
export const RETRYABLE_KINDS: ReadonlySet<string> = new Set(['NetworkError', 'TimeoutError', 'RateLimitError', 'ServerError']);

/** An error as machines read it (the CLI's --json envelope, an MCP tool result): a stable code, the message, the next step, whether retrying may help. */
export interface ErrorEnvelope {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * The one mapping from an error to its machine form; the CLI envelope and the MCP server's structured errors both use it.
 * `cli` is the CLI's reading: an error nobody typed (a bug) is a ConfigurationError (exit 2) or an ExecutionError, and carries only
 * its own hint, never the engine's "report a bug" suggestion.
 */
export function errorEnvelope(e: unknown, o: { cli?: { exitCode?: number } } = {}): ErrorEnvelope {
  const n = normalizeError(e);
  const typed = e instanceof ApsError || n.kind !== 'InternalError';
  const code = !o.cli || typed ? n.kind : o.cli.exitCode === 2 ? 'ConfigurationError' : 'ExecutionError';
  const own = (e as { hint?: unknown } | undefined)?.hint;
  const engine = !o.cli || e instanceof ApsError ? n.suggestions?.join(' ') : undefined;
  const hint = o.cli && typeof own === 'string' ? own : engine || undefined;
  return { code, message: n.message, ...(hint ? { hint } : {}), retryable: RETRYABLE_KINDS.has(code), ...(!o.cli && n.details ? { details: n.details } : {}) };
}
