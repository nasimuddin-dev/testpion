import { randomFillSync, randomUUID } from 'node:crypto';

/**
 * Random hex for ids that name things (runs, spans, messages, files), not for secrets: the bytes come from a pool refilled
 * by the system in one call per 4,096 bytes, instead of a call per id (a run makes about ten ids per step).
 */
const POOL = Buffer.allocUnsafe(4096);
let poolAt = POOL.length;
function randomHex(bytes: number): string {
  if (poolAt + bytes > POOL.length) {
    randomFillSync(POOL);
    poolAt = 0;
  }
  const hex = POOL.toString('hex', poolAt, poolAt + bytes);
  poolAt += bytes;
  return hex;
}

export function uuid(): string {
  return randomUUID();
}

/** Short, URL-safe, sortable-ish id: time prefix + random suffix. */
export function shortId(prefix = ''): string {
  const t = Date.now().toString(36);
  return `${prefix}${t}${randomHex(5)}`;
}

/** 16-hex-char span id / 32-hex-char trace id (OpenTelemetry-compatible sizes). */
export function spanId(): string {
  return randomHex(8);
}

export function traceId(): string {
  return randomHex(16);
}

/** `base`, or `base-2`, `base-3` … when `used` has it already; the id is added to `used`. */
export function uniqueId(used: Set<string>, base: string): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
  used.add(id);
  return id;
}

/** Lower-case words joined by `-`: at most `max` characters (64), `fallback` ('item') when nothing is left. */
export function slugify(name: string, o: { max?: number; fallback?: string } = {}): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, o.max ?? 64) || (o.fallback ?? 'item')
  );
}
