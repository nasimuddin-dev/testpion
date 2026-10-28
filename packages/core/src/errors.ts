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
  ValidationError: 'The server rejected what was sent, or the answer was not in the expected form.',
  RateLimitError: 'The server is throttling requests.',
  ServerError: 'The server encountered an internal error.',
  ProtocolError: 'The peer sent a message that violates the protocol.',
  SchemaError: 'The schema (the description of the data) could not be read, or it is not valid.',
  EvaluationError: 'An evaluator could not produce a result.',
  ConfigurationError: 'The configuration is incomplete or invalid.',
  CancelledError: 'The operation was cancelled.',
  ScriptError: 'A user script threw an exception.',
  ConflictError: 'It was changed by someone else since you opened it.',
  Forbidden: 'The signed-in user is not allowed to use this part of TestPion.',
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
  ValidationError: ['Check the value the message names.', 'Compare it with what the API documentation or its schema expects.'],
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
  ConflictError: ['Read it again and apply your change to the new version, or choose which version to keep.'],
  Forbidden: ['Ask the person who runs this server to allow it for your account.'],
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

/** File-system failures that are the user's disk or folder, not a protocol or a bug: what to tell them. */
const STORAGE_CODES: Record<string, { kind: ErrorKind; text: string; why: string; hint: string[] }> = {
  ENOSPC: { kind: 'ConfigurationError', text: 'The disk is full', why: 'There is no space left to write the file.', hint: ['Free some disk space, or move the workspace to another drive.'] },
  EDQUOT: { kind: 'ConfigurationError', text: 'The disk quota is used up', why: 'The disk quota for this account is used up.', hint: ['Free some space or ask for a larger quota.'] },
  EROFS: { kind: 'ConfigurationError', text: 'The folder is read-only', why: 'The file system does not allow writing here.', hint: ['Open a workspace on a writable drive, or remount the folder read-write.'] },
  ENAMETOOLONG: { kind: 'ValidationError', text: 'The file name or path is too long', why: 'The path is longer than the file system allows (260 characters on Windows).', hint: ['Use a shorter name, or move the workspace closer to the drive root.'] },
  EMFILE: { kind: 'ConfigurationError', text: 'Too many files are open', why: 'The process reached its limit of open files.', hint: ['Close other programs, or raise the open-file limit (ulimit -n).'] },
  ENFILE: { kind: 'ConfigurationError', text: 'Too many files are open on this computer', why: 'The system reached its limit of open files.', hint: ['Close other programs and try again.'] },
  EBUSY: { kind: 'ConfigurationError', text: 'A file is in use by another program', why: 'Another program (an editor, an antivirus scan) holds the file open.', hint: ['Close it there and try again.'] },
};
/**
 * What a system error code says in words (the user's text; the code itself goes to `details.code` for support, logs and
 * agents). `at` is the address or path the error names, when it does.
 */
function plainCode(code: string | undefined, at: string | undefined): { text: string; suggestions?: string[] } | undefined {
  const where = at ? ` at ${at}` : '';
  switch (code) {
    case 'ECONNREFUSED':
      return { text: `Nothing is listening${where || ' at that address'}`, suggestions: ['Start the server, or check the host and port in the URL.', 'For a server on this computer, try 127.0.0.1 instead of localhost (IPv4 versus IPv6).'] };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { text: `The host name${at ? ` "${at}"` : ''} could not be found`, suggestions: ['Check the spelling of the host name in the URL or the variable it comes from.', 'Check your internet connection, VPN and DNS.'] };
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ECONNABORTED':
      return { text: 'The server closed the connection unexpectedly', suggestions: ['Send it again: the server may have restarted.', 'Check the server logs, and any proxy or firewall in between.'] };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
      return { text: `The host${where} cannot be reached from this computer`, suggestions: ['Check your network connection, VPN and proxy settings.'] };
    case 'ENOENT':
      return { text: `${at ? `"${at}"` : 'The file or folder'} was not found`, suggestions: ['Check that the path is right and the file still exists (it may have been moved or deleted).'] };
    case 'EACCES':
    case 'EPERM':
      return { text: `TestPion is not allowed to use ${at ? `"${at}"` : 'that file or folder'}`, suggestions: ['Check the permissions of the file or folder, or pick another one.'] };
    case 'EEXIST':
      return { text: `${at ? `"${at}"` : 'That file or folder'} already exists`, suggestions: ['Pick another name, or remove the existing one first.'] };
    default:
      return undefined;
  }
}

/** The address or path a Node system error names: its own fields, else its text ("connect ECONNREFUSED 127.0.0.1:3000", "open '/x/y'"). */
function systemAt(e: { address?: unknown; port?: unknown; path?: unknown; hostname?: unknown; cause?: unknown } | undefined, message: string): string | undefined {
  const c = (e?.cause ?? undefined) as { address?: unknown; port?: unknown; path?: unknown; hostname?: unknown; message?: string } | undefined;
  for (const o of [e, c]) {
    if (!o) continue;
    if (typeof o.hostname === 'string' && o.hostname) return o.hostname;
    if (typeof o.address === 'string' && o.address) return o.port !== undefined ? `${o.address}:${o.port}` : o.address;
    if (typeof o.path === 'string' && o.path) return o.path;
  }
  for (const t of [message, c?.message ?? '']) {
    const m = /E[A-Z]+\s+((?:\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\]|[\w.-]+):\d+)/i.exec(t) ?? /getaddrinfo \w+ ([\w.-]+)/.exec(t) ?? /'([^']+)'/.exec(t);
    if (m) return m[1];
  }
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
  let hint: string[] | undefined;
  const where = (e as { path?: string })?.path;
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
  } else if (code && STORAGE_CODES[code] && !looksNetwork) {
    // the disk, not the server: a full or read-only folder, a path that is too long, too many open files
    const s = STORAGE_CODES[code]!;
    kind = s.kind;
    text = s.text + (where ? ` (${where})` : '');
    why = s.why;
    hint = s.hint;
  } else if (err instanceof SyntaxError) kind = 'ValidationError';
  else if (code === 'ERR_INVALID_URL' || code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || (code?.startsWith('ERR_INVALID') && code !== 'ERR_INVALID_ARG_TYPE' && code !== 'ERR_INVALID_ARG_VALUE')) {
    kind = 'ConfigurationError';
    why =
      code === 'ENOENT' ? 'A referenced file or command does not exist.' : code === 'EACCES' || code === 'EPERM' ? 'Permission denied.' : code === 'ERR_INVALID_URL' ? 'The URL is not valid.' : 'An invalid argument or configuration value was supplied.';
  } else if (!looksNetwork && isInternal(err, e, code, message)) kind = 'InternalError';
  else if (!looksNetwork) why = 'An unexpected error occurred while executing the operation.';

  // a system error code (ECONNREFUSED, ENOENT …) is said in words; the code stays in `details.code`, the raw text in `details.cause`
  const plain = kind === 'CancelledError' || text ? undefined : plainCode(code, systemAt(e as never, message));
  const causeMsg = kind === 'CancelledError' || plain ? '' : e?.cause?.message || (code ? code : '');
  const msg = plain?.text ?? text ?? message;
  const base = new ApsError(kind, causeMsg && !msg.includes(causeMsg) && !(why ?? '').includes(causeMsg) ? `${msg}: ${causeMsg}` : msg, why ? { why } : {});
  const out = base.toJSON();
  if (plain?.suggestions) out.suggestions = plain.suggestions;
  if (hint) out.suggestions = hint;
  if (code && kind !== 'CancelledError') out.details = { code, ...(plain ? { cause: e?.cause?.message ?? message } : {}) };
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
