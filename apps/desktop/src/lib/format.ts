export { formatBytes, formatMs, plural } from '@testpion/shared';

/** Dollars, as everywhere (the shared `formatUsd`: "$2.00", "$0.0123", "$0.00015"). */
export { formatUsd as formatCost } from '@testpion/shared';

export function timeAgo(iso: string | number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

/** Postman-style day heading for history: "Today", "Yesterday", a weekday within the last week, else the date. */
export function dayLabel(iso: string | number, now: Date = new Date()): string {
  const d = new Date(typeof iso === 'number' ? iso : Date.parse(iso));
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}

/** Interleave day headings with items (sorted newest first), for grouped lists. */
export function groupByDay<T>(items: T[], time: (item: T) => string | number, now: Date = new Date()): Array<{ header: string } | { item: T }> {
  const out: Array<{ header: string } | { item: T }> = [];
  let last: string | undefined;
  for (const item of items) {
    const label = dayLabel(time(item), now);
    if (label !== last) out.push({ header: label });
    last = label;
    out.push({ item });
  }
  return out;
}

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export { templateVariables as templateVars } from '@testpion/shared';

/** A model's name without the snapshot date a provider answers with (gpt-4o-mini-2024-07-18 → gpt-4o-mini). */
export const undatedModel = (m: string) => m.replace(/(-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/, '');

/**
 * A name read from a user's file, as text: a hand edit or a bad merge can leave an object, a number or nothing where a
 * name belongs, and React cannot render an object (the window would go blank).
 */
export function displayName(name: unknown, fallback = 'Untitled'): string {
  if (typeof name === 'string') return name;
  if (name === undefined || name === null || name === '') return fallback;
  if (typeof name === 'object') {
    try {
      return JSON.stringify(name);
    } catch {
      return fallback;
    }
  }
  return String(name);
}
