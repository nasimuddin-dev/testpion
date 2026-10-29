import { readFileSync } from 'node:fs';
import { ApsError } from '../errors.js';
import { exchangesFromHar } from './har.js';
import { exchangesFromSaz } from './saz.js';
import { looksLikeShareBundle, openShareBundle } from './bundle.js';
import { describeDiff, diffSessions } from './session-diff.js';
import type { DebuggerExchange } from './proxy.js';
import type { Redactor } from '../util/redact.js';

/** The exchanges of a session file: a HAR, a Fiddler SAZ or a TestPion bundle. */
export function exchangesFromFile(path: string): { exchanges: DebuggerExchange[]; kind: 'har' | 'saz' | 'bundle'; bundle?: ReturnType<typeof openShareBundle> } {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 2).toString('latin1') === 'PK') {
    if (looksLikeShareBundle(bytes)) {
      const bundle = openShareBundle(bytes);
      return { exchanges: bundle.exchanges, kind: 'bundle', bundle };
    }
    return { exchanges: exchangesFromSaz(bytes), kind: 'saz' };
  }
  let har: unknown;
  try {
    har = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new ApsError('ValidationError', `Not a HAR, SAZ or bundle file: ${(e as Error).message}`);
  }
  return { exchanges: exchangesFromHar(har), kind: 'har' };
}

const CAP = 200;
/** Two sessions compared, as an agent reads it: URLs masked, each list cut at 200. */
export function diffForAgent(before: DebuggerExchange[], after: DebuggerExchange[], red: Redactor, o: { ignoreQuery?: boolean; includeSize?: boolean }) {
  const d = diffSessions(before, after, o);
  const cut = <T extends { url: string }>(list: T[]) => list.slice(0, CAP).map((x) => ({ ...x, url: red.redactUrl(x.url) }));
  return {
    summary: describeDiff(d),
    totals: d.totals,
    unchanged: d.unchanged,
    added: cut(d.added),
    removed: cut(d.removed),
    changed: cut(d.changed),
    ...(d.added.length > CAP || d.removed.length > CAP || d.changed.length > CAP ? { truncated: `each list is cut at ${CAP}` } : {}),
  };
}
