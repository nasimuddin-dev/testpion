import { randomBytes, randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

/** Short, URL-safe, sortable-ish id: time prefix + random suffix. */
export function shortId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = randomBytes(5).toString('hex');
  return `${prefix}${t}${r}`;
}

/** 16-hex-char span id / 32-hex-char trace id (OpenTelemetry-compatible sizes). */
export function spanId(): string {
  return randomBytes(8).toString('hex');
}

export function traceId(): string {
  return randomBytes(16).toString('hex');
}

/** `base`, or `base-2`, `base-3` … when `used` has it already; the id is added to `used`. */
export function uniqueId(used: Set<string>, base: string): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
  used.add(id);
  return id;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'item'
  );
}
