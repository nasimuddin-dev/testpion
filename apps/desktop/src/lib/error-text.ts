import type { NormalizedError } from '../api';

/** Reasons that only repeat "it failed": not worth a second line. */
const GENERIC_WHY = /^(An unexpected error|Something went wrong|The operation was cancelled)/i;

const sentence = (t: string) => t.trim().replace(/([^.!?…])$/, '$1.');

/**
 * What a failure toast says after the message: why it happened (when that adds something) and the first thing to try.
 * The engine gives every error a `why` and `suggestions` (packages/core/src/errors.ts); this is the one place that turns
 * them into the toast's second line, so no failure ends at the bare message.
 */
export function errorNextStep(err: Pick<NormalizedError, 'message' | 'why' | 'suggestions'>): string | undefined {
  const message = err.message.toLowerCase();
  const parts: string[] = [];
  const why = err.why?.trim();
  if (why && !GENERIC_WHY.test(why) && !message.includes(why.toLowerCase().replace(/\.$/, ''))) parts.push(sentence(why));
  const next = err.suggestions?.find((s) => s.trim() && !message.includes(s.toLowerCase().replace(/\.$/, '')));
  if (next) parts.push(sentence(next));
  return parts.length ? parts.join(' ') : undefined;
}
