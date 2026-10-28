import { createHash } from 'node:crypto';
import type { Backend } from './backend.js';

/**
 * A double click, or an Enter that arrives twice, sends the same request with the same id twice within a few milliseconds. The
 * second call must not run the request again (two requests to the server, the first one's controller replaced so that Cancel
 * stops only the second): it takes the first call's answer. Same id and same content (a hash of the whole parameters) within
 * 250 ms is the same send; the same id with other content, or the same send a moment later, is a new one.
 * (planning/review-2026-10-27-robustness.md C-5.)
 */
export const DEDUPE_MS = 250;

interface Recent {
  at: number;
  hash: string;
  answer: Promise<unknown>;
}

const recentOf = new WeakMap<Backend, Map<string, Recent>>(); // registry: per session; entries leave after 250 ms

export function dedupeSend<P extends { id?: string }, R>(be: Backend, p: P, run: (p: P) => Promise<R>, now: () => number = Date.now): Promise<R> {
  if (!p.id) return run(p);
  let recent = recentOf.get(be);
  if (!recent) recentOf.set(be, (recent = new Map()));
  const t = now();
  for (const [id, r] of recent) if (t - r.at > DEDUPE_MS) recent.delete(id);
  const hash = createHash('sha1').update(JSON.stringify(p)).digest('hex');
  const same = recent.get(p.id);
  if (same && same.hash === hash) return same.answer as Promise<R>;
  const answer = run(p);
  const id = p.id;
  recent.set(id, { at: t, hash, answer });
  setTimeout(() => recent!.get(id)?.answer === answer && recent!.delete(id), DEDUPE_MS + 10).unref(); // the answer (a response body) is not kept
  return answer;
}
