/**
 * Multi-valued headers (Node's IncomingMessage, HTTP/2, Kafka) as one string per name: a list is joined with
 * `, `, a Buffer decoded, a null value is empty. Undefined values and HTTP/2 pseudo-headers (`:path`) are left out.
 */
export function flattenHeaders(h: Record<string, unknown>): Record<string, string> {
  const one = (v: unknown): string => (v == null ? '' : Array.isArray(v) ? v.map(one).join(', ') : String(v));
  return Object.fromEntries(
    Object.entries(h)
      .filter(([k, v]) => v !== undefined && !k.startsWith(':'))
      .map(([k, v]) => [k, one(v)]),
  );
}
