import type { ErrorKind, NormalizedError } from './model/types.js';

/** Error type used throughout the engine. Carries a normalised, user-facing explanation. */
export class ApsError extends Error {
  readonly kind: ErrorKind;
  readonly why: string;
  readonly suggestions: string[];
  readonly details?: Record<string, unknown>;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { why?: string; suggestions?: string[]; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = kind;
    this.kind = kind;
    this.why = opts.why ?? defaultWhy[kind];
    this.suggestions = opts.suggestions ?? defaultSuggestions[kind];
    this.details = opts.details;
  }

  toJSON(): NormalizedError {
    return {
      kind: this.kind,
      message: this.message,
      what: this.message,
      why: this.why,
      suggestions: this.suggestions,
      details: this.details,
    };
  }
}

const defaultWhy: Record<ErrorKind, string> = {
  NetworkError: 'The request could not reach the server.',
  TimeoutError: 'The operation did not complete within the configured timeout.',
  AuthenticationError: 'The server rejected the supplied credentials.',
  AuthorizationError: 'The credentials are valid but lack permission for this operation.',
  ValidationError: 'The request or response did not match the expected shape.',
  RateLimitError: 'The server is throttling requests.',
  ServerError: 'The server encountered an internal error.',
  ProtocolError: 'The peer sent a message that violates the protocol.',
  SchemaError: 'A schema could not be loaded or is invalid.',
  EvaluationError: 'An evaluator could not produce a result.',
  ConfigurationError: 'The configuration is incomplete or invalid.',
  CancelledError: 'The operation was cancelled.',
  ScriptError: 'A user script threw an exception.',
  InternalError: 'Something went wrong inside TestPion.',
};

const defaultSuggestions: Record<ErrorKind, string[]> = {
  NetworkError: [
    'Check that the host and port are correct and the server is running.',
    'Check VPN, proxy and firewall settings.',
    'For local servers, try 127.0.0.1 instead of localhost (IPv4 vs IPv6).',
  ],
  TimeoutError: ['Increase the timeout in the request settings.', 'Check whether the server is overloaded.'],
  AuthenticationError: [
    'Verify the token or API key for the selected environment.',
    'Check that the Authorization header is being sent (see the request timeline).',
    'Tokens may have expired — refresh them.',
  ],
  AuthorizationError: ['Check the scopes/roles granted to the credentials.', 'Confirm you are targeting the right tenant.'],
  ValidationError: ['Check the value the message names.', 'Compare it with what is expected (the schema or the documentation).'],
  RateLimitError: [
    'Lower concurrency or configure a rate limit for this provider.',
    'Respect the Retry-After header if present.',
  ],
  ServerError: ['Check the server logs.', 'Retry — the error may be transient.'],
  ProtocolError: ['Check that client and server support compatible protocol versions.', 'Inspect the raw trace events.'],
  SchemaError: ['Re-run schema introspection.', 'Check that the schema document is valid.'],
  EvaluationError: ['Check the evaluator configuration.', 'Judge models may return malformed output — inspect the raw response.'],
  ConfigurationError: ['Review the configuration referenced in the message.'],
  CancelledError: [],
  ScriptError: ['Check the script for exceptions; scripts run in a sandbox without filesystem or process access.'],
  InternalError: ['Report the problem (Help ▸ Report a problem) with the steps that led to it.'],
};

/** Map an HTTP status code to a normalised error kind (or undefined for success codes). */
export function errorKindForStatus(status: number): ErrorKind | undefined {
  if (status === 401) return 'AuthenticationError';
  if (status === 403) return 'AuthorizationError';
  if (status === 408) return 'TimeoutError';
  if (status === 429) return 'RateLimitError';
  if (status === 400 || status === 422) return 'ValidationError';
  if (status >= 500) return 'ServerError';
  return undefined;
}

/** Convert any thrown value into a NormalizedError suitable for display or persistence. */
export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof ApsError) return err.toJSON();
  // already normalized (the backend normalizes before the IPC layer does again): keep its kind, why, suggestions and details
  const n = err as Partial<NormalizedError> | undefined;
  if (n && typeof n === 'object' && typeof n.kind === 'string' && typeof n.message === 'string' && Array.isArray(n.suggestions))
    return { kind: n.kind, message: n.message, what: n.what ?? n.message, why: n.why ?? '', suggestions: n.suggestions, ...(n.details ? { details: n.details } : {}) };
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string; errors?: Array<{ code?: string }> } };
  const message = e?.message ?? String(err);
  // undici wraps socket errors in `cause`; dual-stack connects report an AggregateError
  // Node codes are strings (ECONNREFUSED); JSON-RPC / MCP errors have numeric codes (-32602)
  const rawCode: unknown = e?.code ?? e?.cause?.code ?? e?.cause?.errors?.find((x) => x?.code)?.code;
  const code = rawCode === undefined || rawCode === null ? undefined : String(rawCode);

  const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CLOSED)$/;
  const looksNetwork = (code && (NETWORK_CODES.test(code) || /CERT|SSL|TLS/i.test(code))) || (e?.name === 'TypeError' && /fetch failed/i.test(message));
  let kind: ErrorKind = looksNetwork ? 'NetworkError' : 'ProtocolError';
  let why: string | undefined;
  let text: string | undefined;
  if (e?.name === 'AbortError' || code === 'ABORT_ERR') {
    kind = 'CancelledError';
    // the DOMException's own text ("This operation was aborted") and code (20) say nothing to a user
    text = !message || /operation was aborted/i.test(message) ? 'Request cancelled' : message;
  } else if (e?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT')
    kind = 'TimeoutError';
  else if (code === 'ECONNREFUSED') {
    kind = 'NetworkError';
    why = 'The connection was refused — nothing is listening on that host/port.';
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    kind = 'NetworkError';
    why = 'The hostname could not be resolved (DNS lookup failed).';
  } else if (code === 'ECONNRESET') {
    kind = 'NetworkError';
    why = 'The server closed the connection unexpectedly.';
  } else if (code && /CERT|SSL|TLS/i.test(code)) {
    kind = 'NetworkError';
    why = `TLS handshake failed (${code}). The certificate may be self-signed or invalid.`;
  } else if (code && /^Z_/.test(code)) {
    // zlib: a Content-Encoding (gzip, deflate, br) body that does not decode
    kind = 'ProtocolError';
    text = "The server's compressed response body is invalid";
    why = `The body could not be decoded with its Content-Encoding (${e?.cause?.message || message}).`;
  } else if (e?.name === 'TypeError' && /^terminated$/i.test(message)) {
    kind = 'NetworkError';
    text = 'The connection closed before the response was complete';
    why = 'The server (or something in between) closed the connection while the body was being received.';
  } else if (err instanceof SyntaxError) kind = 'ValidationError';
  else if (code === 'ERR_INVALID_URL' || code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || (code?.startsWith('ERR_INVALID') && code !== 'ERR_INVALID_ARG_TYPE' && code !== 'ERR_INVALID_ARG_VALUE')) {
    kind = 'ConfigurationError';
    why =
      code === 'ENOENT' ? 'A referenced file or command does not exist.' : code === 'EACCES' || code === 'EPERM' ? 'Permission denied.' : code === 'ERR_INVALID_URL' ? 'The URL is not valid.' : 'An invalid argument or configuration value was supplied.';
  } else if (!looksNetwork && isInternal(err, e, code, message)) kind = 'InternalError';
  else if (!looksNetwork) why = 'An unexpected error occurred while executing the operation.';

  const causeMsg = kind === 'CancelledError' ? '' : e?.cause?.message || (code ? code : '');
  const msg = text ?? message;
  const base = new ApsError(kind, causeMsg && !msg.includes(causeMsg) && !(why ?? '').includes(causeMsg) ? `${msg}: ${causeMsg}` : msg, why ? { why } : {});
  const out = base.toJSON();
  if (code && kind !== 'CancelledError') out.details = { code };
  if (kind === 'NetworkError' && code && /CERT|SSL|TLS/i.test(code))
    out.suggestions = ['Provide the CA certificate in request settings.', 'For local development only, enable "Disable TLS verification".'];
  return out;
}

/**
 * A bug rather than a failure of the request, the server or the user's input: JavaScript's own errors (TypeError,
 * RangeError, ReferenceError), Node's wrong-argument errors, and plain Errors without a code that do not read like a
 * protocol failure. Errors with a code (a protocol's, a JSON-RPC number) and named errors of libraries stay ProtocolError.
 */
function isInternal(err: unknown, e: { name?: string } | undefined, code: string | undefined, message: string): boolean {
  if (!(err instanceof Error)) return typeof err !== 'object' || err === null;
  if (code === 'ERR_INVALID_ARG_TYPE' || code === 'ERR_INVALID_ARG_VALUE') return true;
  if (code) return false;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) return true;
  if (e?.name !== 'Error') return false;
  return !/protocol|handshake|frame|unexpected server response|status code|stream|socket|connection|closed|grpc|websocket|server/i.test(message);
}

export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; kind?: string };
  return e?.name === 'AbortError' || e?.kind === 'CancelledError';
}
