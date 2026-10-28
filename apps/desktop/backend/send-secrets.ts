/** What a send learns about secrets from the request it sent (kept out of send.ts so the bounds can be tested on their own). */
import type { HttpRequestSpec, Redactor } from '@testpion/core';

/**
 * A text body is parsed for sensitive fields (servers often echo them back) only up to this many characters. Parsing 14 MB took
 * 73 ms of the main thread on every send. A bigger body is not scanned, and then nothing of it is recorded in the trace or the
 * console (only its size): a preview that could not be checked for secrets is not shown.
 */
export const SECRET_SCAN_CHARS = 256 * 1024;

type Body = HttpRequestSpec['body'];

/** True when the body is a text body too big to scan for secrets. */
export function bodyTooBigToScan(body: Body): boolean {
  return !!body && 'content' in body && typeof body.content === 'string' && body.content.length > SECRET_SCAN_CHARS;
}

/** What is shown in place of the body preview of a body that was not scanned. */
export function unscannedBodyNote(body: Body): string {
  const n = body && 'content' in body ? body.content.length : 0;
  return `[request body of ${n} characters not recorded: too large to check for secrets]`;
}

/** Registers the values of sensitive fields of the request body as secrets of the redactor. Returns whether the scan was skipped for size. */
export function collectBodySecrets(redactor: Redactor, body: Body): { skipped: boolean } {
  const collect = (v: unknown, key = '', depth = 0): void => {
    if (depth > 20 || v == null) return;
    if (typeof v === 'string') {
      if (key && redactor.isSensitiveKey(key) && v.length >= 4) redactor.addSecret(v);
    } else if (Array.isArray(v)) v.forEach((x) => collect(x, key, depth + 1));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) collect(x, k, depth + 1);
  };
  if (!body) return { skipped: false };
  if ('content' in body) {
    if (bodyTooBigToScan(body)) return { skipped: true };
    try {
      collect(JSON.parse(body.content));
    } catch {
      /* not JSON */
    }
  } else if ('fields' in body) for (const f of body.fields) collect(f.value, f.key);
  return { skipped: false };
}
