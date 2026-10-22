import { normalizeError } from './errors.js';

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

/** The one mapping from an error to its machine form; the CLI envelope and the MCP server's structured errors both use it. */
export function errorEnvelope(e: unknown): ErrorEnvelope {
  const n = normalizeError(e);
  const hint = n.suggestions?.length ? n.suggestions.join(' ') : undefined;
  return { code: n.kind, message: n.message, ...(hint ? { hint } : {}), retryable: RETRYABLE_KINDS.has(n.kind), ...(n.details ? { details: n.details } : {}) };
}
