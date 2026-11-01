/**
 * An endpoint that is going away says so in its response: the `Deprecation` header (RFC 9745: `true`, or the date it was
 * deprecated), `Sunset` (RFC 8594: the date after which it stops answering), a `Link` with `rel="deprecation"` or
 * `rel="sunset"` (where to read about it), or a `Warning: 299 …` text. A client that keeps calling it breaks one day
 * without a word; TestPion reads these headers on every response and says so.
 */

export interface DeprecationInfo {
  /** The `Deprecation` header: an ISO date when it gave one, else `true`. */
  deprecation?: string | true;
  /** The `Sunset` date (ISO), after which the endpoint stops answering. */
  sunset?: string;
  /** Days until the sunset (negative when past); absent without a sunset. */
  sunsetInDays?: number;
  /** Where to read about it (`Link rel="deprecation"` or `rel="sunset"`). */
  link?: string;
  /** A `Warning: 299` text, when the server gave one. */
  warning?: string;
  /** One line for people: "Deprecated; sunset 2027-01-01 (in 61 days)". */
  text: string;
}

const date = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  const t = v.trim().replace(/^@/, '');
  // "@1735689600" (RFC 9745) or an HTTP-date / ISO date
  const ms = /^\d{9,11}$/.test(t) ? Number(t) * 1000 : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
};

/** What a response says about its endpoint going away, or undefined when it says nothing. */
export function deprecationOf(headers: Iterable<[string, string]> | Record<string, string | string[] | undefined>, now = Date.now()): DeprecationInfo | undefined {
  const list: Array<[string, string]> = Symbol.iterator in Object(headers) ? [...(headers as Iterable<[string, string]>)] : Object.entries(headers as Record<string, string | string[] | undefined>).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x] as [string, string]) : [[k, v] as [string, string]]));
  const get = (name: string) => list.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
  const dep = get('deprecation')[0];
  const sunsetRaw = get('sunset')[0];
  const warning = get('warning').find((w) => /^299\b/.test(w.trim()));
  const link = get('link')
    .flatMap((l) => l.split(','))
    .map((l) => /<([^>]+)>[^,]*rel="?(?:[^"]*\s)?(deprecation|sunset)\b/i.exec(l))
    .find(Boolean)?.[1];
  if (dep === undefined && !sunsetRaw && !warning && !link) return undefined;
  const info: DeprecationInfo = { text: '' };
  if (dep !== undefined) info.deprecation = date(dep) ?? true;
  const sunset = date(sunsetRaw);
  if (sunset) {
    info.sunset = sunset;
    info.sunsetInDays = Math.floor((Date.parse(sunset) - now) / 864e5);
  }
  if (link) info.link = link;
  if (warning) info.warning = warning.replace(/^299\s+\S*\s*/, '').replace(/^"|"$/g, '').trim();
  const parts = [
    info.deprecation ? `Deprecated${typeof info.deprecation === 'string' ? ` since ${info.deprecation}` : ''}` : sunset ? 'Going away' : 'The server warns',
    sunset ? `sunset ${sunset} (${info.sunsetInDays! < 0 ? `${-info.sunsetInDays!} days ago` : info.sunsetInDays === 0 ? 'today' : `in ${info.sunsetInDays} days`})` : '',
    info.warning ?? '',
  ].filter(Boolean);
  info.text = parts.join('; ');
  return info;
}
