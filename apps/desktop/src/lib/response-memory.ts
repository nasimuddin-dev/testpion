import type { ComparableResponse } from '@testpion/shared';
import type { HttpResponseData } from '../types';

/**
 * The last two responses of each request this session (Diff vs previous): kept in memory only, for the latest few
 * requests, with bodies cut at 512 KB, so a long session never grows without bound. History covers saved requests
 * across restarts (ResponseDiffPanel asks it when this has nothing).
 */
const MAX_REQUESTS = 20;
const MAX_BODY = 512 * 1024;

export interface KeptResponse {
  /** The send it came from (its trace or history id). */
  id: string;
  at: string;
  response: ComparableResponse;
  /** The body was longer than what is kept: only its start is compared. */
  cut: boolean;
}

const kept = new Map<string, { current?: KeptResponse; previous?: KeptResponse }>();

export function comparable(r: HttpResponseData): { response: ComparableResponse; cut: boolean } {
  const cut = r.truncated || r.bodyPreview.length > MAX_BODY;
  return { response: { status: r.status, durationMs: r.durationMs, size: r.size, headers: r.headers, body: r.bodyPreview.length > MAX_BODY ? r.bodyPreview.slice(0, MAX_BODY) : r.bodyPreview }, cut };
}

/** Note a response of a request (`key`: its saved id, else its tab); the same send noted again changes nothing. */
export function rememberResponse(key: string, id: string, r: HttpResponseData): void {
  const slot = kept.get(key) ?? {};
  if (slot.current?.id === id || slot.previous?.id === id) return;
  const next = { current: { id, at: new Date().toISOString(), ...comparable(r) }, previous: slot.current };
  // most recently used last: the oldest request goes first when there are too many
  kept.delete(key);
  kept.set(key, next);
  while (kept.size > MAX_REQUESTS) kept.delete(kept.keys().next().value!);
}

/** The response before send `id` of a request, if this session saw it. */
export function previousResponse(key: string, id: string): KeptResponse | undefined {
  const slot = kept.get(key);
  return slot?.current?.id === id ? slot.previous : undefined;
}

/** How many requests are kept (tests, the soak check). */
export const keptRequests = () => kept.size;
/** Forget everything (tests; a workspace switch keeps it: keys are ids of that workspace's items or tabs). */
export const forgetResponses = () => kept.clear();

const ids = new WeakMap<object, string>();
let next = 0;
/** An id for a response without a trace or history id (the same object, the same id). */
export function responseId(r: object): string {
  let id = ids.get(r);
  if (!id) ids.set(r, (id = `r${++next}`));
  return id;
}
