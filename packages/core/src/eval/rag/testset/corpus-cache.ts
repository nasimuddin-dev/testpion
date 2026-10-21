/**
 * The corpus of a run, kept in memory for the verifiers. A proposal is stored on disk and must stay small, so it does not
 * hold the documents; the verifiers (which run in the same process, right after the model answered) find the corpus here by
 * the token the task put into the record's generator metadata. A process that restarted has none: the verifiers say so.
 */
import type { Corpus } from './types.js';

const MAX = 4;
const cache = new Map<string, Corpus>();

export function rememberCorpus(token: string, c: Corpus): void {
  cache.delete(token);
  cache.set(token, c);
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
}

export const corpusOf = (token: string | undefined): Corpus | undefined => (token ? cache.get(token) : undefined);

/** A token for a corpus: it names the chunks (ids and hashes), so the same documents share one entry. */
export function corpusToken(c: Corpus, seed: string): string {
  let h = 5381;
  for (const k of c.chunks) for (let i = 0; i < k.hash.length; i++) h = ((h * 33) ^ k.hash.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}-${c.chunks.length}-${seed.slice(0, 12)}`;
}
