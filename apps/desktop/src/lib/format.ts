export { formatBytes, formatMs } from '@testpion/shared';

export function formatCost(c: number | undefined): string {
  if (c === undefined || c === null) return '–';
  if (c === 0) return '$0';
  return c < 0.01 ? `$${c.toFixed(6)}` : `$${c.toFixed(4)}`;
}

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

/** "1 request", "3 requests" (irregular plurals can be passed: plural(n, 'entry', 'entries')). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

/** A model's name without the snapshot date a provider answers with (gpt-4o-mini-2024-07-18 → gpt-4o-mini). */
export const undatedModel = (m: string) => m.replace(/(-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/, '');
