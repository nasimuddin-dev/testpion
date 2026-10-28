import { annotate, cleanAnnotation } from './auto-breakpoint.js';

/**
 * A note and a colour mark on one entry of a HAR file (FG-11), edited in the JSON itself so nothing else in the file changes.
 * The note is the entry's `comment` (HAR 1.2); the mark is `_testpion.mark`. The entry is found by TestPion's exchange id
 * (`_testpion.id`) or by its place (`#3`, counted from 1). Returns the entry's id (or place) and what it carries now.
 */
export function annotateHarEntry(har: unknown, ref: string, a: { note?: unknown; mark?: unknown }): { entry: string; note?: string; mark?: string } {
  const entries = (har as { log?: { entries?: unknown } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file: log.entries is missing');
  const byPlace = /^#(\d+)$/.exec(ref);
  const found = byPlace ? (entries[Number(byPlace[1]) - 1] as Record<string, any> | undefined) : (entries.find((x) => (x as Record<string, any> | undefined)?._testpion?.id === ref) as Record<string, any> | undefined);
  if (!found) throw new Error(`No entry ${ref} in the HAR file (use an exchange id, or #1 for the first entry)`);
  const clean = cleanAnnotation(a);
  const t = (found._testpion ??= {});
  const now: { note?: string; mark?: string } = { note: typeof found.comment === 'string' && !found.comment.startsWith('application: ') ? found.comment : undefined, mark: typeof t.mark === 'string' ? t.mark : undefined };
  annotate(now, clean);
  if (now.note) found.comment = now.note;
  else if (typeof found.comment === 'string' && !found.comment.startsWith('application: ')) delete found.comment;
  if (now.mark) t.mark = now.mark;
  else delete t.mark;
  return { entry: typeof t.id === 'string' ? t.id : ref, ...now };
}
