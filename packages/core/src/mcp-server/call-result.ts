import { normalizeError } from '../errors.js';
import { errorEnvelope } from '../errors-envelope.js';

/** What a tool returned, as a tools/call result (a contract result is shaped by tool-contract.ts before this). */
export function plainCallResult(r: unknown): Record<string, unknown> {
  if (typeof r === 'string') return { content: [{ type: 'text', text: r }] };
  // the JSON as text for every client, and as structured content for clients that read it (a list is wrapped: structured content is an object)
  const structured = Array.isArray(r) ? { items: r } : r && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r };
  // a result that says so (a flow with a failed step) is an error result for the client, with the details kept
  return { ...(structured.isError === true ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: structured };
}

/** A tool's error as a tools/call result. `declared`: the tool declares an outputSchema. */
export function errorCallResult(e: unknown, declared: boolean): Record<string, unknown> {
  const err = normalizeError(e);
  // the text for every client, and { error: { code, message, hint, retryable } } (the CLI envelope's mapping) for the ones that read structured content.
  // A tool that declares an outputSchema cannot carry it there (clients validate structuredContent against the schema): it goes in _meta.error.
  const envelope = errorEnvelope(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `${err.kind}: ${err.message}${err.suggestions.length ? `\n${err.suggestions.join('\n')}` : ''}` }],
    ...(declared ? {} : { structuredContent: { error: envelope } }),
    _meta: { error: envelope },
  };
}
