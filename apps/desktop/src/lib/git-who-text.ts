/** The words of the who-last-changed card (lib/git-who.ts): pure, so they are tested without a window. */
export interface LastChange {
  author: string;
  date: string;
  subject: string;
  changed: string[];
}

/** "Ana, 2 days ago": the day count in words for a few days, the date after that. */
export function whenWords(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) {
    const s = Math.max(0, (now - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return `on ${new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

/** The card text of a last change. */
export function cardOf(c: LastChange, now = Date.now()): { headline: string; lines: string[] } {
  const when = whenWords(c.date, now);
  const what = c.changed.length ? `Changed: ${c.changed.slice(0, 4).join(', ')}${c.changed.length > 4 ? ` and ${c.changed.length - 4} more` : ''}` : '';
  return { headline: `${c.author}${when ? `, ${when}` : ''}`, lines: [c.subject ? `“${c.subject}”` : '', what].filter(Boolean) };
}
